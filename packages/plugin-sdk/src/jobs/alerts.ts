// Alerts (requirements 11, A2): strategy state changes, data health (yellow warning, red with the
// safe state's exact instructions) and job failures for admins. Every alert states the data
// health, is written in the recipient's language, and is sent once per (channel, subject, date,
// type). A state change compares the day's allocation with what the channel was last told, so a
// run that caught up several days still reports the change, and a new channel gets the current
// state first.
import { CASH_USD, SAFE_STATE, Strategy, type TradingDate } from '@saku/core';
import { type Translate, hasText, translator } from '@saku/content';
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
import { desc, eq, isNull } from 'drizzle-orm';
import type { Logger, Notifier, PluginContext } from '../types';
import type { RecomputeSummary } from './forward';

export type AlertType =
  | 'state_change'
  | 'data_yellow'
  | 'data_red'
  | 'job_failure'
  | 'data_health'
  | 'update_failed'
  | 'recompute_differs';
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
  const reasons = e.reasons.length
    ? [t('alerts.reasons', { reasons: describeReasons(t, e.reasons) })]
    : [];
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
  context: (notifier: Notifier, channelId: string) => PluginContext;
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
  const owners = new Map<
    string,
    { language: string; t: Translate; targets: Awaited<ReturnType<typeof deliveryTargets>> }
  >();
  for (const version of await allVersions(db)) {
    if (!version.ownerId) continue;
    const entry = await lastEntry(db, version.id);
    if (!entry || entry.date !== o.date) continue;
    const strategy = Strategy.parse(JSON.parse(version.canonicalJson).strategy);
    let owner = owners.get(version.ownerId);
    if (!owner) {
      const language = await languageOf(db, version.ownerId);
      const targets = await deliveryTargets(db, version.ownerId, o.authSecret);
      owner = { language, t: translator(language), targets };
      owners.set(version.ownerId, owner);
    }
    const { language, t } = owner;
    const day: DayEntry = {
      date: entry.date,
      allocation: entry.allocation,
      holdings: entry.holdings as DayEntry['holdings'],
      dataStatus: entry.dataStatus,
      safeStateApplied: entry.safeStateApplied,
      reasons: (JSON.parse(entry.payload) as { reasons?: string[] }).reasons ?? [],
    };
    for (const channel of owner.targets) {
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

/**
 * An operational alert to every admin channel, once per (subject, date, type). Nothing is sent
 * before forward records start (the A1 gate): stage A allows no production alerts before it.
 */
export async function sendAdminAlert(
  db: Db,
  o: AlertOptions & {
    subject: string;
    type: AlertType;
    lines: (t: Translate) => string[];
    /** The data health it states; default: the latest overall grade on record. */
    health?: string;
  },
): Promise<AlertSummary> {
  const summary: AlertSummary = { sent: 0, failed: [] };
  if (!(await getSetting(db, 'forward_records_from'))) return summary;
  const latest = o.health ? undefined : await latestOverallHealth(db);
  const health = o.health ?? latest?.status ?? 'unknown';
  const admins = await db.select().from(schema.users).where(eq(schema.users.isAdmin, true));
  for (const admin of admins) {
    const t = translator(await languageOf(db, admin.id));
    const healthLine = latest
      ? `${t(`alerts.health.${health}`)} ${t('alerts.healthDate', { date: latest.date })}`
      : t(`alerts.health.${health}`);
    const text = [...o.lines(t), healthLine].join('\n');
    for (const channel of await deliveryTargets(db, admin.id, o.authSecret)) {
      if (!channel.admin) continue;
      const key = { subject: o.subject, date: o.date, type: o.type };
      await deliver(db, o, channel, { key, text }, summary);
    }
  }
  return summary;
}

/** A job that did not finish, once per job and day. */
export function sendJobFailure(
  db: Db,
  o: AlertOptions & { job: string; error: string; health?: string },
): Promise<AlertSummary> {
  return sendAdminAlert(db, {
    ...o,
    subject: o.job,
    type: 'job_failure',
    health: o.health ?? 'unknown',
    lines: (t) => [
      t('alerts.jobFailure.title', { job: o.job, date: o.date }),
      t('alerts.jobFailure.body', { error: o.error.split('\n')[0]!.slice(0, 300) }),
    ],
  });
}

/** The day's data is not green overall: what is not, for the admins. */
export function sendDataHealthAdmin(
  db: Db,
  o: AlertOptions & { health: string; reasons: string[] },
): Promise<AlertSummary> {
  return sendAdminAlert(db, {
    ...o,
    subject: 'data',
    type: 'data_health',
    lines: (t) => [
      t('alerts.dataAdmin.title', { date: o.date }),
      t('alerts.dataAdmin.body', { reasons: describeReasons(t, o.reasons) }),
    ],
  });
}

/** A self-update that failed, once per target version and day. */
export function sendUpdateFailed(
  db: Db,
  o: AlertOptions & { from: string; to: string; step: string; stuck: boolean },
): Promise<AlertSummary> {
  return sendAdminAlert(db, {
    ...o,
    subject: `update:${o.to}`,
    type: 'update_failed',
    lines: (t) => [
      t('alerts.update.title', { to: o.to, step: o.step }),
      t(o.stuck ? 'alerts.update.stuck' : 'alerts.update.back', { from: o.from }),
    ],
  });
}

/** The current engine decides recorded days differently (each one is annotated). */
export function sendRecomputeDiffers(
  db: Db,
  o: AlertOptions & { differences: RecomputeSummary['differences'] },
): Promise<AlertSummary> {
  const first = o.differences[0]!;
  return sendAdminAlert(db, {
    ...o,
    subject: 'recompute',
    type: 'recompute_differs',
    lines: (t) => [
      t('alerts.recompute.title', { count: o.differences.length }),
      t('alerts.recompute.body', { ...first }),
    ],
  });
}

async function latestOverallHealth(db: Db) {
  const [row] = await db
    .select({ status: schema.dataHealth.status, date: schema.dataHealth.date })
    .from(schema.dataHealth)
    .where(isNull(schema.dataHealth.symbolId))
    .orderBy(desc(schema.dataHealth.date), desc(schema.dataHealth.id))
    .limit(1);
  return row;
}

async function deliver(
  db: Db,
  o: AlertOptions,
  channel: Channel & { target: string | null },
  alert: Alert,
  summary: AlertSummary,
) {
  if (await alertSent(db, channel, alert.key)) return;
  const notifier = o.notifiers.find((n) => n.info.key === channel.type);
  const label = `${channel.type} channel ${channel.id}`;
  if (channel.target === null) {
    summary.failed.push(`${label}: target does not decrypt (AUTH_SECRET missing or changed)`);
    return;
  }
  if (!notifier) {
    summary.failed.push(`${label}: no ${channel.type} plug-in`);
    return;
  }
  const max = notifier.info.maxLength;
  const text = alert.text.length > max ? `${alert.text.slice(0, max - 1)}…` : alert.text;
  try {
    await notifier.send(channel.target, text, o.context(notifier, channel.id));
    await recordAlertSent(db, channel, alert.key, alert.allocation);
    summary.sent++;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    o.log.warn(`Alert not delivered (${label})`, { key: alert.key, reason });
    summary.failed.push(`${label}: ${reason}`);
  }
}

const SIMPLE_REASONS = [
  'single_source',
  'primary_missing',
  'no_data',
  'no_decision',
  'decision_margin',
];

/**
 * Reason codes in words, e.g. `AAA2:B.close_match@alpaca` as "AAA2: closes differ between sources
 * (alpaca)". A code without a text stays as it is (it is still exact, only less readable).
 */
export function describeReasons(t: Translate, codes: string[]): string {
  return codes.map((code) => describeReason(t, code)).join('; ');
}

export function describeReason(t: Translate, code: string): string {
  const i = code.indexOf(':');
  const hasSubject = i > 0 && !code.startsWith('stand_in_refused:');
  const subject = hasSubject ? code.slice(0, i) : undefined;
  const rest = hasSubject ? code.slice(i + 1) : code;
  let m: RegExpExecArray | null;
  let text: string | undefined;
  if (subject === 'evaluation') text = `${t('alerts.reason.evaluation')} (${rest})`;
  else if ((m = /^[A-E]\.(\w+)@(.+)$/.exec(rest)) && hasText(`alerts.reason.check.${m[1]}`)) {
    text = t(`alerts.reason.check.${m[1]}`, { source: m[2]! });
  } else if ((m = /^stand_in@(.+)$/.exec(rest))) {
    text = t('alerts.reason.standIn', { source: m[1]! });
  } else if (rest.startsWith('stand_in_refused:')) text = t('alerts.reason.standInRefused');
  else if ((m = /^stale\((\d+)\)@(.+)$/.exec(rest))) {
    text = t('alerts.reason.stale', { days: m[1]!, source: m[2]! });
  } else if ((m = /^missing@(.+)$/.exec(rest))) {
    text = t('alerts.reason.seriesMissing', { source: m[1]! });
  } else if (SIMPLE_REASONS.includes(rest)) text = t(`alerts.reason.${rest}`);
  else if (!subject && /^[^:@\s]+$/.test(rest)) {
    return `${rest}: ${t('alerts.reason.notGreen')}`;
  }
  if (text === undefined) return code;
  return subject && subject !== 'evaluation' ? `${subject}: ${text}` : text;
}

async function languageOf(db: Db, userId: string): Promise<string> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return user?.language ?? (await getSetting(db, 'primary_language')) ?? 'en';
}
