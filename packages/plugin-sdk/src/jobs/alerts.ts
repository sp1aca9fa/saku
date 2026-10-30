// Alerts (requirements 11, A2): strategy state changes, data health (yellow warning, red with the
// safe state's exact instructions) and job failures for admins. Every alert states the data
// health, is written in the recipient's language, and is sent once per (channel, subject, date,
// type). A state change compares the day's allocation with what the channel was last told, so a
// run that caught up several days still reports the change, and a new channel gets the current
// state first.
import { CASH_USD, SAFE_STATE, type Strategy, type TradingDate } from '@saku/core';
import { type Translate, hasText, translator } from '@saku/content';
import type { Sessions } from '@saku/data';
import {
  type AlertKey,
  type Channel,
  type Db,
  alertSent,
  allVersions,
  annotationsOf,
  deliveryTargets,
  getSetting,
  lastEntry,
  lastToldAllocation,
  recordAlertSent,
  schema,
} from '@saku/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Logger, Notifier, PluginContext } from '../types';
import { parseVersion } from './forward';

export type AlertType =
  | 'state_change'
  | 'data_yellow'
  | 'data_red'
  | 'job_failure'
  | 'data_health'
  | 'update_failed'
  | 'recompute_differs'
  | 'revisions'
  | 'integrity'
  | 'stand_in_corrected';
const TOLD: AlertType[] = ['state_change', 'data_yellow', 'data_red'];

export interface Alert {
  key: AlertKey & { type: AlertType };
  /** The allocation the alert tells (kept to detect the next change). */
  allocation?: string;
  /** Every key the message covers (default: `key`), all recorded once it is delivered. */
  keys?: (AlertKey & { type: AlertType })[];
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
  /**
   * A drill (`pnpm drill`, on a throwaway copy of the database): every message is marked as one
   * in its first line, followed by a line saying nothing was recorded, and is sent whatever was
   * sent before; nothing is read from or written to `alerts_sent`. The mark and its line take
   * their room in the channel's longest message first, so the alert keeps its end as it would.
   */
  drill?: boolean;
  /** Told of each delivered message: the channel, the alert type and the message's first line. */
  onDelivered?: (d: { channel: string; type: AlertType; title: string }) => void;
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
  const owners: Owners = new Map();
  for (const version of await allVersions(db)) {
    if (!version.ownerId) continue;
    const entry = await lastEntry(db, version.id);
    if (!entry || entry.date !== o.date) continue;
    const parsed = parseVersion(version);
    if ('error' in parsed) {
      // Its timing is unknown: no alert is guessed; the run is incomplete. The admins are told
      // which version and why by the forward step, which parses every version before this.
      summary.failed.push(
        `${version.name} (${version.id}): definition does not parse: ${parsed.error}`,
      );
      continue;
    }
    const day: DayEntry = {
      date: entry.date,
      allocation: entry.allocation,
      holdings: entry.holdings as DayEntry['holdings'],
      dataStatus: entry.dataStatus,
      safeStateApplied: entry.safeStateApplied,
      reasons: (JSON.parse(entry.payload) as { reasons?: string[] }).reasons ?? [],
    };
    await sendDayAlert(db, o, { version, strategy: parsed.strategy, day, owners }, summary);
  }
  return summary;
}

/** Each owner's language, translator and channels, read once per run. */
type Owners = Map<
  string,
  { language: string; t: Translate; targets: Awaited<ReturnType<typeof deliveryTargets>> }
>;

/**
 * One version's alert for a day to each of its owner's channels (none for a library version).
 * The daily run passes the day's forward entry; `pnpm drill` passes a decision it made on a copy
 * of the database without recording it (`o.drill`).
 */
export async function sendDayAlert(
  db: Db,
  o: AlertOptions & { sessions: Sessions },
  d: {
    version: { id: string; name: string; ownerId: string | null };
    strategy: Strategy;
    day: DayEntry;
    owners?: Owners;
  },
  summary: AlertSummary = { sent: 0, failed: [] },
): Promise<AlertSummary> {
  const { version, strategy, day } = d;
  if (!version.ownerId) return summary;
  const owner = await ownerOf(db, o, d.owners ?? new Map(), version.ownerId);
  const { language, t } = owner;
  for (const channel of owner.targets) {
    const alert = strategyAlert(t, language, {
      versionId: version.id,
      name: version.name,
      execution: strategy.execution,
      entry: day,
      nextSession: o.sessions.after(day.date),
      // A drill reads nothing told before (the safe-state alert does not depend on it).
      lastTold: o.drill ? undefined : await lastToldAllocation(db, channel, version.id, TOLD),
    });
    if (alert) await deliver(db, o, channel, alert, summary, t);
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
    /**
     * The message's lines before the health line. `room`: the characters they may take on this
     * channel (its notifier's longest message less the health line), for a message that fits
     * itself rather than being cut at the end.
     */
    lines: (t: Translate, room: number) => string[];
    /** The data health it states; default: the latest overall grade on record. */
    health?: string;
  },
): Promise<AlertSummary> {
  const summary: AlertSummary = { sent: 0, failed: [] };
  const key = { subject: o.subject, date: o.date, type: o.type };
  await eachAdminChannel(db, o, o.health, async (t, channel, healthLine) => {
    // No notifier for the channel: deliver reports it; the room is then irrelevant.
    const max = o.notifiers.find((n) => n.info.key === channel.type)?.info.maxLength ?? Infinity;
    const room = max - healthLine.length - 1 - (o.drill ? drillOverhead(t) : 0);
    const text = [...o.lines(t, room), healthLine].join('\n');
    await deliver(db, o, channel, { key, text }, summary, t);
  });
  return summary;
}

/** Every admin channel with its owner's translator and the health line (after the A1 gate). */
async function eachAdminChannel(
  db: Db,
  o: AlertOptions,
  health: string | undefined,
  fn: (t: Translate, channel: Target, healthLine: string, language: string) => Promise<void>,
) {
  if (!(await getSetting(db, 'forward_records_from'))) return;
  const latest = health ? undefined : await latestOverallHealth(db);
  const status = health ?? latest?.status ?? 'unknown';
  const admins = await db.select().from(schema.users).where(eq(schema.users.isAdmin, true));
  for (const admin of admins) {
    const language = await languageOf(db, admin.id);
    const t = translator(language);
    const healthLine = latest
      ? `${t(`alerts.health.${status}`)} ${t('alerts.healthDate', { date: latest.date })}`
      : t(`alerts.health.${status}`);
    for (const channel of await deliveryTargets(db, admin.id, o.authSecret)) {
      if (channel.admin) await fn(t, channel, healthLine, language);
    }
  }
}

/** Failures listed one per line in the job-failure alert; the rest are counted. */
export const JOB_FAILURE_LINES = 5;
/** The longest failure line (with its mark), so one long reason cannot crowd out the others. */
export const JOB_FAILURE_LINE_LENGTH = 200;

/**
 * A job that did not finish, once per job and day (requirements 11: job failures to admins).
 * Each failure is one line, in the run's order, up to JOB_FAILURE_LINES of at most
 * JOB_FAILURE_LINE_LENGTH characters (a longer one ends with "…"); the rest are counted exactly
 * ("and N more"), never dropped silently. The full list stays in job_runs.error and the log.
 */
export function sendJobFailure(
  db: Db,
  o: AlertOptions & { job: string; failures: string[]; health?: string },
): Promise<AlertSummary> {
  return sendAdminAlert(db, {
    ...o,
    subject: o.job,
    type: 'job_failure',
    health: o.health ?? 'unknown',
    lines: (t, room) =>
      jobFailureLines(t, { job: o.job, date: o.date, failures: o.failures }, room),
  });
}

/**
 * The job-failure lines within `room` characters (joined by newlines). When the listed lines do
 * not fit the channel, fewer are listed and more are counted, so the count line always arrives;
 * only a channel too small for the title, count and closing line is cut by `deliver`.
 */
export function jobFailureLines(
  t: Translate,
  o: { job: string; date: TradingDate; failures: string[] },
  room: number,
): string[] {
  // A run that failed without a stated reason still failed: it is never shown as nothing.
  const failures = o.failures.length > 0 ? o.failures : ['unknown'];
  const items = failures.map((f) => `- ${oneLine(f, JOB_FAILURE_LINE_LENGTH - 2)}`);
  let shown = Math.min(items.length, JOB_FAILURE_LINES);
  for (;;) {
    const hidden = items.length - shown;
    const lines = [
      t('alerts.jobFailure.title', { job: o.job, date: o.date }),
      t('alerts.jobFailure.failed', { count: items.length }),
      ...items.slice(0, shown),
      ...(hidden > 0 ? [t('alerts.jobFailure.more', { count: hidden })] : []),
      t('alerts.jobFailure.body'),
    ];
    if (shown === 0 || lines.join('\n').length <= room) return lines;
    shown--;
  }
}

/** One line of at most `max` characters: whitespace runs (newlines too) as one space, "…" if cut. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim() || 'unknown';
  if (flat.length <= max) return flat;
  // Not between the halves of a surrogate pair.
  return `${flat.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
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

/**
 * What a weekly refetch revised, once per run: changed values (bars, series, FX), and values the
 * source withdrew (`kind: 'withdrawn'`: it no longer has a value for those dates; spec 2026-10-30
 * withdrawn-values), each kind in its own line so a withdrawal never reads as a new value.
 */
export function sendRevisions(
  db: Db,
  o: AlertOptions & {
    runId: string;
    revisions: {
      ticker: string;
      source: string;
      field: string;
      count: number;
      from: string;
      to: string;
      /** Default `changed`. */
      kind?: 'changed' | 'withdrawn';
    }[];
  },
): Promise<AlertSummary> {
  const count = o.revisions.reduce((n, r) => n + r.count, 0);
  const listed = (rows: typeof o.revisions) => {
    const items = rows
      .slice(0, 8)
      .map(
        (r) =>
          `${r.ticker} ${r.field}@${r.source} ${r.count} (${r.from === r.to ? r.from : `${r.from}..${r.to}`})`,
      )
      .join(', ');
    return rows.length > 8 ? `${items}, ...` : items;
  };
  const changed = o.revisions.filter((r) => r.kind !== 'withdrawn');
  const withdrawn = o.revisions.filter((r) => r.kind === 'withdrawn');
  return sendAdminAlert(db, {
    ...o,
    subject: `revisions:${o.runId}`,
    type: 'revisions',
    lines: (t) => [
      t('alerts.revisions.title', { count }),
      ...(changed.length > 0 ? [t('alerts.revisions.body', { items: listed(changed) })] : []),
      ...(withdrawn.length > 0
        ? [t('alerts.revisions.withdrawn', { items: listed(withdrawn) })]
        : []),
    ],
  });
}

/** A failed layer E check (core vs reference, incremental vs full), once per version, check and day. */
export function sendIntegrityFailed(
  db: Db,
  o: AlertOptions & { check: string; versionId: string; detail: string },
): Promise<AlertSummary> {
  return sendAdminAlert(db, {
    ...o,
    subject: `integrity:${o.check}:${o.versionId}`,
    type: 'integrity',
    lines: (t) => [
      t('alerts.integrity.title', { check: o.check }),
      t('alerts.integrity.body', { detail: o.detail.slice(0, 500) }),
    ],
  });
}

/** A testfol parity case outside a tolerance or unable to run (layer E, requirements 13). */
export function sendParityFailed(
  db: Db,
  o: AlertOptions & { caseName: string; detail: string },
): Promise<AlertSummary> {
  return sendAdminAlert(db, {
    ...o,
    subject: `parity:${o.caseName}`,
    type: 'integrity',
    lines: (t) => [
      t('alerts.parity.title', { name: o.caseName }),
      t('alerts.parity.body', { detail: o.detail.slice(0, 500) }),
    ],
  });
}

/**
 * Recompute differences not yet told, one message per admin channel. Driven by the annotations
 * (one alert key each), so an undelivered alert is tried again at the next run.
 */
export async function sendRecomputeDiffers(db: Db, o: AlertOptions): Promise<AlertSummary> {
  const summary: AlertSummary = { sent: 0, failed: [] };
  const notes: { key: Alert['key']; version: string; date: string; detail: RecomputeDetail }[] = [];
  for (const v of await allVersions(db)) {
    for (const a of await annotationsOf(db, v.id, 'recomputed')) {
      const key = {
        subject: `recompute:${a.id}`,
        date: a.date,
        type: 'recompute_differs' as const,
      };
      notes.push({ key, version: v.name, date: a.date, detail: a.detail as RecomputeDetail });
    }
  }
  if (notes.length === 0) return summary;
  await eachAdminChannel(db, o, undefined, async (t, channel, healthLine) => {
    const told = await sentSubjects(db, channel, 'recompute_differs');
    const pending = notes.filter((n) => !told.has(n.key.subject));
    const first = pending[0];
    if (!first) return;
    const text = [
      t('alerts.recompute.title', { count: pending.length }),
      t('alerts.recompute.body', {
        version: first.version,
        date: first.date,
        recorded: first.detail.recordedAllocation,
        now: first.detail.recomputedAllocation,
        signals: first.detail.signalsDiffer.join(', ') || '-',
      }),
      healthLine,
    ].join('\n');
    await deliver(
      db,
      o,
      channel,
      { key: first.key, keys: pending.map((n) => n.key), text },
      summary,
      t,
    );
  });
  return summary;
}

interface RecomputeDetail {
  recordedAllocation: string;
  recomputedAllocation: string;
  signalsDiffer: string[];
}

/** A `stand_in_corrected` annotation's detail, as `annotateStandInCorrections` writes it. */
export interface StandInCorrectedDetail {
  ticker: string;
  /**
   * The stand-in's date: the entry's own, or an earlier one its lookback read. Annotations
   * written before this field existed were on the stand-in day's entry: read as the entry's date.
   */
  standInDate: TradingDate;
  /** |primary close / stand-in close - 1|, a fraction (above the layer B close tolerance). */
  deviation: number;
  recordedAllocation: string;
  correctedAllocation: string;
  differs: boolean;
}

/**
 * The detail of an annotation on `date` read back, or null when it is not one
 * `annotateStandInCorrections` writes (a deviation that is not a finite non-negative number, a
 * missing allocation, `differs` not matching the two allocations, a stand-in date that is not a
 * date on or before the entry's): such an annotation is reported, never told with a guessed value.
 */
export function standInDetail(detail: unknown, date: TradingDate): StandInCorrectedDetail | null {
  const d = detail as Partial<Record<keyof StandInCorrectedDetail, unknown>> | null;
  if (!d || typeof d !== 'object') return null;
  const { ticker, deviation, recordedAllocation: rec, correctedAllocation: cor, differs } = d;
  const standInDate = d.standInDate ?? date;
  if (typeof ticker !== 'string' || ticker === '') return null;
  if (typeof deviation !== 'number' || !Number.isFinite(deviation) || deviation < 0) return null;
  if (typeof rec !== 'string' || typeof cor !== 'string' || rec === '' || cor === '') return null;
  if (typeof differs !== 'boolean' || differs !== (rec !== cor)) return null;
  if (typeof standInDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(standInDate)) return null;
  if (standInDate > date) return null;
  return {
    ticker,
    standInDate,
    deviation,
    recordedAllocation: rec,
    correctedAllocation: cor,
    differs,
  };
}

/**
 * The stand-in correction alert's text (requirements 04, the stand-in rule 4): "D's signal used a
 * secondary price that was off by X; with the corrected price it would have been Y." X is the
 * stored deviation, |primary / stand-in - 1|, so it is worded as how far the primary's price
 * differed from the stand-in. It is about a past day: the corrected allocation is never given as
 * a signal or an instruction, and the record is said to be annotated, not changed. `more`: other
 * corrections of the version told in the same message (counted, each annotated). The lines before
 * the health line are cut to fit (the first lines kept); the health line (the version's latest
 * recorded day) always ends it. A channel too small even for that is cut at the end by `deliver`.
 */
export function standInCorrectedText(
  t: Translate,
  language: string,
  o: {
    name: string;
    date: TradingDate;
    detail: StandInCorrectedDetail;
    /** The data health of the version's latest recorded day, or undefined without one. */
    health?: { status: string; date: TradingDate };
    more?: number;
  },
  /** The channel's longest message. */
  max: number,
): string {
  const d = o.detail;
  const name = (allocation: string) =>
    allocation === SAFE_STATE ? t('alerts.safeStateName') : allocation;
  // Two decimals, rounded half-expand by Intl (e.g. 0.010101 as "1.01%").
  const deviation = new Intl.NumberFormat(language, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(d.deviation);
  const values = {
    strategy: o.name,
    date: o.date,
    ticker: d.ticker,
    standInDate: d.standInDate,
    deviation,
  };
  const lines = [
    t('alerts.standInCorrected.title', values),
    t(
      d.standInDate === o.date ? 'alerts.standInCorrected.body' : 'alerts.standInCorrected.earlier',
      values,
    ),
    d.differs
      ? t('alerts.standInCorrected.differs', {
          recorded: name(d.recordedAllocation),
          corrected: name(d.correctedAllocation),
        })
      : t('alerts.standInCorrected.same', { recorded: name(d.recordedAllocation) }),
    ...(o.more ? [t('alerts.standInCorrected.more', { count: o.more })] : []),
    t('alerts.standInCorrected.pastDay'),
  ].join('\n');
  // Unknown stays unknown: without a recorded day the status is `unknown`, never green.
  const healthLine = o.health
    ? `${t(`alerts.health.${o.health.status}`)} ${t('alerts.standInCorrected.healthDate', { date: o.health.date })}`
    : t('alerts.health.unknown');
  const room = max - healthLine.length - 1;
  return room > 1 ? `${cut(lines, room)}\n${healthLine}` : `${lines}\n${healthLine}`;
}

export interface StandInAlertSummary extends AlertSummary {
  /**
   * Annotations whose detail does not read back (`standInDetail`) and whose admin alert has not
   * been delivered yet: the run is incomplete until it is.
   */
  errors: string[];
}

/**
 * The `alerts_sent` subject of one correction: version, ticker and, for a later entry than the
 * stand-in day, the stand-in's date (with the date and type: once per version, entry date,
 * ticker and stand-in date, as the annotations are). The stand-in day's own keeps the form it
 * had before later entries were annotated, so what was told then is not told again.
 */
export function standInSubject(versionId: string, d: StandInCorrectedDetail, date: TradingDate) {
  const base = `stand_in:${versionId}:${d.ticker}`;
  return d.standInDate === date ? base : `${base}@${d.standInDate}`;
}

/**
 * Every `stand_in_corrected` annotation not yet told (requirements 04, the stand-in rule 4; 11:
 * every alert states the data health, in the recipient's language, idempotent). Driven by the
 * annotations and `alerts_sent`, so a failed delivery, a run that stopped or a channel added
 * later is caught up at the next run. A user's version goes to its owner's channels (as the
 * strategy alerts do); a library version (no owner) to the admins' channels. Per channel and
 * version one message: the newest correction (latest entry date) in full, the others counted,
 * every key recorded once it is delivered. An annotation that does not read back is told to the
 * admins once (keyed by its id), never with a guessed value. Not sent in a drill.
 */
export async function sendStandInCorrections(
  db: Db,
  o: AlertOptions,
): Promise<StandInAlertSummary> {
  const summary: StandInAlertSummary = { sent: 0, failed: [], errors: [] };
  if (o.drill) return summary;
  const owners: Owners = new Map();
  for (const version of await allVersions(db)) {
    const notes = await annotationsOf(db, version.id, 'stand_in_corrected');
    if (notes.length === 0) continue;
    const last = await lastEntry(db, version.id);
    const health = last && { status: last.dataStatus, date: last.date };
    const readable: {
      id: number;
      date: TradingDate;
      detail: StandInCorrectedDetail;
      key: Alert['key'];
    }[] = [];
    for (const a of notes) {
      const detail = standInDetail(a.detail, a.date);
      if (detail) {
        const subject = standInSubject(version.id, detail, a.date);
        readable.push({
          id: a.id,
          date: a.date,
          detail,
          key: { subject, date: a.date, type: 'stand_in_corrected' },
        });
        continue;
      }
      await reportUnreadable(db, o, summary, { version, id: a.id, date: a.date });
    }
    if (readable.length === 0) continue;
    // Newest first: the latest entry date, then the latest annotation.
    readable.sort((x, y) => (x.date === y.date ? y.id - x.id : x.date < y.date ? 1 : -1));
    const tell = async (t: Translate, language: string, channel: Target) => {
      const pending: typeof readable = [];
      for (const n of readable) if (!(await alertSent(db, channel, n.key))) pending.push(n);
      const [newest] = pending;
      if (!newest) return;
      const max = o.notifiers.find((n) => n.info.key === channel.type)?.info.maxLength ?? Infinity;
      const text = standInCorrectedText(
        t,
        language,
        {
          name: version.name,
          date: newest.date,
          detail: newest.detail,
          more: pending.length - 1,
          ...(health && { health }),
        },
        max,
      );
      const keys = pending.map((n) => n.key);
      await deliver(db, o, channel, { key: newest.key, keys, text }, summary, t);
    };
    if (!version.ownerId) {
      // The status passed only spares the overall-health read: the message states the
      // version's own latest day instead of the admins' health line.
      await eachAdminChannel(db, o, 'unknown', (t, channel, _line, language) =>
        tell(t, language, channel),
      );
      continue;
    }
    const owner = await ownerOf(db, o, owners, version.ownerId);
    for (const channel of owner.targets) await tell(owner.t, owner.language, channel);
  }
  return summary;
}

/**
 * An annotation that does not read back, told to the admins once (keyed by its id). The run is
 * incomplete until that alert is on record for some admin channel (none yet, or every delivery
 * failed): the error names the annotation, so the job-failure alert and job_runs.error do too.
 */
async function reportUnreadable(
  db: Db,
  o: AlertOptions,
  summary: StandInAlertSummary,
  a: { version: { id: string; name: string }; id: number; date: TradingDate },
) {
  const subject = `stand_in_unreadable:${a.id}`;
  const sent = await sendAdminAlert(db, {
    ...o,
    date: a.date,
    subject,
    type: 'stand_in_corrected',
    lines: (t) => [
      t('alerts.standInUnreadable.title'),
      t('alerts.standInUnreadable.body', {
        version: `${a.version.name} (${a.version.id})`,
        date: a.date,
        id: String(a.id),
      }),
    ],
  });
  summary.sent += sent.sent;
  summary.failed.push(...sent.failed);
  const [told] = await db
    .select({ id: schema.alertsSent.id })
    .from(schema.alertsSent)
    .where(
      and(eq(schema.alertsSent.subject, subject), eq(schema.alertsSent.type, 'stand_in_corrected')),
    )
    .limit(1);
  if (!told) {
    summary.errors.push(
      `${a.version.name} (${a.version.id}) ${a.date}: stand-in correction annotation ${a.id} ` +
        'does not read back; not told, and the admins not told yet',
    );
  }
}

async function ownerOf(db: Db, o: AlertOptions, owners: Owners, ownerId: string) {
  let owner = owners.get(ownerId);
  if (!owner) {
    const language = await languageOf(db, ownerId);
    const targets = await deliveryTargets(db, ownerId, o.authSecret);
    owner = { language, t: translator(language), targets };
    owners.set(ownerId, owner);
  }
  return owner;
}

async function sentSubjects(db: Db, channel: Channel, type: AlertType): Promise<Set<string>> {
  const rows = await db
    .select({ subject: schema.alertsSent.subject })
    .from(schema.alertsSent)
    .where(
      and(
        eq(schema.alertsSent.ownerId, channel.ownerId),
        eq(schema.alertsSent.channelId, channel.id),
        eq(schema.alertsSent.type, type),
      ),
    );
  return new Set(rows.map((r) => r.subject));
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

type Target = Channel & { target: string | null };

async function deliver(
  db: Db,
  o: AlertOptions,
  channel: Target,
  alert: Alert,
  summary: AlertSummary,
  t: Translate,
) {
  if (!o.drill && (await alertSent(db, channel, alert.key))) return;
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
  // A drill: the alert is cut to the room its mark and line leave, then marked, so the message
  // fits and keeps the alert's end as the real one would. A channel too small even for those:
  // the marked text is cut at the end (the mark leads, so it stays).
  const room = max - drillOverhead(t);
  const text = !o.drill
    ? cut(alert.text, max)
    : room > 1
      ? drillText(t, cut(alert.text, room))
      : cut(drillText(t, alert.text), max);
  try {
    await notifier.send(channel.target, text, o.context(notifier, channel.id));
    if (!o.drill) {
      for (const key of alert.keys ?? [alert.key]) {
        await recordAlertSent(db, channel, key, alert.allocation);
      }
    }
    summary.sent++;
    o.onDelivered?.({ channel: label, type: alert.key.type, title: text.split('\n')[0]! });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    o.log.warn(`Alert not delivered (${label})`, { key: alert.key, reason });
    summary.failed.push(`${label}: ${reason}`);
  }
}

/** At most `max` characters, "…" at the end when cut (not between a surrogate pair's halves). */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/** The characters `drillText` adds: the mark and a space, the drill line and its newline. */
export function drillOverhead(t: Translate): number {
  return t('alerts.drill.mark').length + 1 + t('alerts.drill.body').length + 1;
}

/**
 * A drill's message: its title marked as a drill, then a line saying nothing was recorded, then
 * the rest of the message as the real alert says it.
 */
export function drillText(t: Translate, text: string): string {
  const [title = '', ...rest] = text.split('\n');
  return [`${t('alerts.drill.mark')} ${title}`, t('alerts.drill.body'), ...rest].join('\n');
}

const SIMPLE_REASONS = [
  'single_source',
  'primary_missing',
  'no_data',
  'no_decision',
  'decision_margin',
  'issuer_nav_tolerance_invalid',
];

/**
 * Reason codes in words, e.g. `AAA2:B.close_match@alpaca` as "AAA2: closes differ between sources
 * (alpaca)". A code without a text stays as it is (it is still exact, only less readable).
 */
export function describeReasons(t: Translate, codes: string[]): string {
  return codes.map((code) => describeReason(t, code)).join('; ');
}

/** A check's text: layer D (issuer data) has its own, other layers share them by check name. */
function checkText(layer: string, check: string): string | undefined {
  const issuer = `alerts.reason.issuer.${check}`;
  if (layer === 'D' && hasText(issuer)) return issuer;
  const shared = `alerts.reason.check.${check}`;
  return layer !== 'D' && hasText(shared) ? shared : undefined;
}

export function describeReason(t: Translate, code: string): string {
  const i = code.indexOf(':');
  const hasSubject = i > 0 && !code.startsWith('stand_in_refused:');
  const subject = hasSubject ? code.slice(0, i) : undefined;
  const rest = hasSubject ? code.slice(i + 1) : code;
  let m: RegExpExecArray | null;
  let text: string | undefined;
  if (subject === 'evaluation') text = `${t('alerts.reason.evaluation')} (${rest})`;
  else if ((m = /^([A-E])\.(\w+)@(.+)$/.exec(rest)) && checkText(m[1]!, m[2]!)) {
    text = t(checkText(m[1]!, m[2]!)!, { source: m[3]! });
  } else if ((m = /^stand_in@(.+)$/.exec(rest))) {
    text = t('alerts.reason.standIn', { source: m[1]! });
  } else if (rest.startsWith('stand_in_refused:')) text = t('alerts.reason.standInRefused');
  else if ((m = /^stale\((\d+)\)@(.+)$/.exec(rest))) {
    text = t('alerts.reason.stale', { days: m[1]!, source: m[2]! });
  } else if ((m = /^issuer_unavailable@(.+)$/.exec(rest))) {
    text = t('alerts.reason.issuerUnavailable', { source: m[1]! });
  } else if ((m = /^missing@(.+)$/.exec(rest))) {
    text = t('alerts.reason.seriesMissing', { source: m[1]! });
  } else if (SIMPLE_REASONS.includes(rest)) text = t(`alerts.reason.${rest}`);
  // A bare symbol (codes are snake_case, so an underscore means an unknown code).
  else if (!subject && /^[^:@\s_]+$/.test(rest)) {
    return `${rest}: ${t('alerts.reason.notGreen')}`;
  }
  if (text === undefined) return code;
  return subject && subject !== 'evaluation' ? `${subject}: ${text}` : text;
}

async function languageOf(db: Db, userId: string): Promise<string> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return user?.language ?? (await getSetting(db, 'primary_language')) ?? 'en';
}
