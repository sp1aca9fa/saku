// Alerts (requirements 11, A2): strategy state changes, data health (yellow warning, red with the
// safe state's exact instructions) and job failures for admins. Every alert states the data
// health, is written in the recipient's language, and is sent once per (channel, subject, date,
// type). A state change compares the day's allocation with what the channel was last told, so a
// run that caught up several days still reports the change, and a new channel gets the current
// state first.
import { CASH_USD, SAFE_STATE, Strategy, type TradingDate } from '@saku/core';
import { type Translate, translator } from '@saku/content';
import type { Sessions } from '@saku/data';
import {
  type AlertKey,
  type Channel,
  type Db,
  alertSent,
  allVersions,
  deliveryTargets,
  getSetting,
  lastEntry,
  lastToldAllocation,
  recordAlertSent,
  schema,
} from '@saku/db';
import { eq } from 'drizzle-orm';
import type { Logger, Notifier, PluginContext } from '../types';

export type AlertType = 'state_change' | 'data_yellow' | 'data_red' | 'job_failure';
const TOLD: AlertType[] = ['state_change', 'data_yellow', 'data_red'];

export interface Alert {
  key: AlertKey & { type: AlertType };
  /** The allocation the alert tells (kept to detect the next change). */
  allocation?: string;
  text: string;
}

export interface DayEntry {
  date: TradingDate;
  allocation: string;
  holdings: { ticker: string; weight: number }[];
  dataStatus: string;
  safeStateApplied: boolean;
  reasons: string[];
}

/** The day's alert for one strategy and one recipient, or null when there is nothing to say. */
export function strategyAlert(
  t: Translate,
  language: string,
  o: {
    versionId: string;
    name: string;
    execution: Strategy['execution'];
    entry: DayEntry;
    nextSession: TradingDate;
    lastTold?: string;
  },
): Alert | null {
  const e = o.entry;
  const name = (allocation: string) =>
    allocation === SAFE_STATE ? t('alerts.safeStateName') : allocation;
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 2 });
  const holdings = e.holdings
    .map(
      (h) =>
        `${h.ticker === CASH_USD ? t('alerts.cash', { currency: 'USD' }) : h.ticker} ${percent.format(h.weight / 100)}`,
    )
    .join(', ');
  const timing = t(`alerts.timing.${o.execution}`, {
    date: o.execution === 'same_close' ? e.date : o.nextSession,
  });
  const health = t(`alerts.health.${e.dataStatus}`);
  const reasons = e.reasons.length ? [t('alerts.reasons', { reasons: e.reasons.join(', ') })] : [];
  const values = { strategy: o.name, date: e.date };
  const alert = (type: AlertType, lines: string[]): Alert => ({
    key: { subject: o.versionId, date: e.date, type },
    allocation: e.safeStateApplied ? SAFE_STATE : e.allocation,
    text: lines.join('\n'),
  });

  if (e.safeStateApplied) {
    return alert('data_red', [
      t('alerts.dataRed.title', values),
      t('alerts.dataRed.body'),
      t('alerts.holdings', { holdings }),
      timing,
      health,
      ...reasons,
    ]);
  }
  if (o.lastTold !== e.allocation) {
    return alert('state_change', [
      t('alerts.stateChange.title', values),
      o.lastTold === undefined
        ? t('alerts.stateChange.first', { to: name(e.allocation), date: e.date })
        : t('alerts.stateChange.body', {
            from: name(o.lastTold),
            to: name(e.allocation),
            date: e.date,
          }),
      t('alerts.holdings', { holdings }),
      timing,
      health,
      ...reasons,
    ]);
  }
  if (e.dataStatus === 'yellow') {
    return alert('data_yellow', [
      t('alerts.dataYellow.title', values),
      t('alerts.dataYellow.body', { allocation: name(e.allocation) }),
      health,
      ...reasons,
    ]);
  }
  return null;
}

export interface AlertOptions {
  date: TradingDate;
  notifiers: Notifier[];
  authSecret: string;
  context: (notifier: Notifier) => PluginContext;
  log: Logger;
}

export interface AlertSummary {
  sent: number;
  failed: string[];
}

/** Today's strategy alerts to each owner's channels (library versions have no recipient). */
export async function sendStrategyAlerts(
  db: Db,
  o: AlertOptions & { sessions: Sessions },
): Promise<AlertSummary> {
  const summary: AlertSummary = { sent: 0, failed: [] };
  for (const version of await allVersions(db)) {
    if (!version.ownerId) continue;
    const entry = await lastEntry(db, version.id);
    if (!entry || entry.date !== o.date) continue;
    const strategy = Strategy.parse(JSON.parse(version.canonicalJson).strategy);
    const language = await languageOf(db, version.ownerId);
    const t = translator(language);
    const day: DayEntry = {
      date: entry.date,
      allocation: entry.allocation,
      holdings: entry.holdings as DayEntry['holdings'],
      dataStatus: entry.dataStatus,
      safeStateApplied: entry.safeStateApplied,
      reasons: (JSON.parse(entry.payload) as { reasons?: string[] }).reasons ?? [],
    };
    for (const channel of await deliveryTargets(db, version.ownerId, o.authSecret)) {
      const alert = strategyAlert(t, language, {
        versionId: version.id,
        name: version.name,
        execution: strategy.execution,
        entry: day,
        nextSession: o.sessions.after(o.date),
        lastTold: await lastToldAllocation(db, channel, version.id, TOLD),
      });
      if (alert) await deliver(db, o, channel, alert, summary);
    }
  }
  return summary;
}

/** A job that did not finish, to every admin channel, once per job and day. */
export async function sendJobFailure(
  db: Db,
  o: AlertOptions & { job: string; error: string; health?: string },
): Promise<AlertSummary> {
  const summary: AlertSummary = { sent: 0, failed: [] };
  const admins = await db.select().from(schema.users).where(eq(schema.users.isAdmin, true));
  for (const admin of admins) {
    const t = translator(await languageOf(db, admin.id));
    const text = [
      t('alerts.jobFailure.title', { job: o.job, date: o.date }),
      t('alerts.jobFailure.body', { error: o.error.split('\n')[0]!.slice(0, 300) }),
      t(`alerts.health.${o.health ?? 'unknown'}`),
    ].join('\n');
    for (const channel of await deliveryTargets(db, admin.id, o.authSecret)) {
      if (!channel.admin) continue;
      const key = { subject: o.job, date: o.date, type: 'job_failure' as const };
      await deliver(db, o, channel, { key, text }, summary);
    }
  }
  return summary;
}

async function deliver(
  db: Db,
  o: AlertOptions,
  channel: Channel & { target: string },
  alert: Alert,
  summary: AlertSummary,
) {
  if (await alertSent(db, channel, alert.key)) return;
  const notifier = o.notifiers.find((n) => n.info.key === channel.type);
  const label = `${channel.type} channel ${channel.id}`;
  if (!notifier) {
    summary.failed.push(`${label}: no ${channel.type} plug-in`);
    return;
  }
  const max = notifier.info.maxLength;
  const text = alert.text.length > max ? `${alert.text.slice(0, max - 1)}…` : alert.text;
  try {
    await notifier.send(channel.target, text, o.context(notifier));
    await recordAlertSent(db, channel, alert.key, alert.allocation);
    summary.sent++;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    o.log.warn(`Alert not delivered (${label})`, { key: alert.key, reason });
    summary.failed.push(`${label}: ${reason}`);
  }
}

async function languageOf(db: Db, userId: string): Promise<string> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return user?.language ?? (await getSetting(db, 'primary_language')) ?? 'en';
}
