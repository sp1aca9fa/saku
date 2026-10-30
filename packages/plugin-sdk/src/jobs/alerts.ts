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
import { type DiskUsage, formatBytes } from './disk';
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
  | 'stand_in_corrected'
  | 'disk_space';
const TOLD: AlertType[] = ['state_change', 'data_yellow', 'data_red'];

export interface Alert {
  key: AlertKey & { type: AlertType };
  /** The allocation the alert tells (kept to detect the next change). */
  allocation?: string;
  /** Every key the message covers (default: `key`), all recorded once it is delivered. */
  keys?: (AlertKey & { type: AlertType })[];
  text: string;
  /**
   * Set when the text does not fit the channel with every part never cut whole (`fitMessage`):
   * the characters it needs there. Nothing is sent or recorded; the channel is reported.
   */
  needed?: number;
}

/** The fitted message as an alert's text, with what it needs when it does not fit. */
function fitted(f: Fitted): Pick<Alert, 'text' | 'needed'> {
  return f.fits ? { text: f.text } : { text: f.text, needed: f.needed };
}

export interface DayEntry {
  date: TradingDate;
  allocation: string;
  holdings: { ticker: string; weight: number }[];
  dataStatus: string;
  safeStateApplied: boolean;
  reasons: string[];
}

/**
 * The day's alert for one strategy and one recipient, or null when there is nothing to say,
 * within `max` characters (`fitMessage`): the title, body, holdings, timing and health line
 * whole, the reasons after them shortened with an exact count. A channel too small for those
 * lines gets nothing (`needed`; `deliver` reports it), never a signal without its instructions.
 */
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
  max = Infinity,
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
  const health = { keep: t(`alerts.health.${e.dataStatus}`) };
  const reasons: Part[] = e.reasons.length
    ? [
        {
          items: e.reasons.map((code) => describeReason(t, code)),
          more: (count) => t('alerts.more', { count }),
          inline: { join: REASONS_JOIN, line: (r) => t('alerts.reasons', { reasons: r }) },
        },
      ]
    : [];
  const values = { strategy: o.name, date: e.date };
  const alert = (type: AlertType, parts: Part[]): Alert => ({
    key: { subject: o.versionId, date: e.date, type },
    allocation: e.safeStateApplied ? SAFE_STATE : e.allocation,
    ...fitted(fitMessage(parts, max)),
  });
  const keep = (line: string) => ({ keep: line });

  if (e.safeStateApplied) {
    return alert('data_red', [
      keep(t('alerts.dataRed.title', values)),
      keep(t('alerts.dataRed.body')),
      keep(t('alerts.holdings', { holdings })),
      keep(timing),
      health,
      ...reasons,
    ]);
  }
  if (o.lastTold !== e.allocation) {
    return alert('state_change', [
      keep(t('alerts.stateChange.title', values)),
      keep(
        o.lastTold === undefined
          ? t('alerts.stateChange.first', { to: name(e.allocation), date: e.date })
          : t('alerts.stateChange.body', {
              from: name(o.lastTold),
              to: name(e.allocation),
              date: e.date,
            }),
      ),
      keep(t('alerts.holdings', { holdings })),
      keep(timing),
      health,
      ...reasons,
    ]);
  }
  if (e.dataStatus === 'yellow') {
    return alert('data_yellow', [
      keep(t('alerts.dataYellow.title', values)),
      keep(t('alerts.dataYellow.body', { allocation: name(e.allocation) })),
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
    const alert = strategyAlert(
      t,
      language,
      {
        versionId: version.id,
        name: version.name,
        execution: strategy.execution,
        entry: day,
        nextSession: o.sessions.after(day.date),
        // A drill reads nothing told before (the safe-state alert does not depend on it).
        lastTold: o.drill ? undefined : await lastToldAllocation(db, channel, version.id, TOLD),
      },
      roomOn(o, channel, t),
    );
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
     * The message before the health line, fitted to each channel with it (`fitMessage`). A
     * channel too small for the parts never cut gets nothing and is reported.
     */
    lines: (t: Translate) => Part[];
    /** The data health it states; default: the latest overall grade on record. */
    health?: string;
  },
): Promise<AlertSummary> {
  const summary: AlertSummary = { sent: 0, failed: [] };
  const key = { subject: o.subject, date: o.date, type: o.type };
  await eachAdminChannel(db, o, o.health, async (t, channel, healthLine) => {
    const parts = [...o.lines(t), { keep: healthLine }];
    const alert = { key, ...fitted(fitMessage(parts, roomOn(o, channel, t))) };
    await deliver(db, o, channel, alert, summary, t);
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
    lines: (t) => jobFailureParts(t, { job: o.job, date: o.date, failures: o.failures }),
  });
}

/**
 * The job-failure message before the health line: the title, the count, the failures one per
 * line (fewer listed and more counted when the channel has no room for them, so the count line
 * always arrives) and the closing line.
 */
export function jobFailureParts(
  t: Translate,
  o: { job: string; date: TradingDate; failures: string[] },
): Part[] {
  // A run that failed without a stated reason still failed: it is never shown as nothing.
  const failures = o.failures.length > 0 ? o.failures : ['unknown'];
  return [
    { keep: t('alerts.jobFailure.title', { job: o.job, date: o.date }) },
    { keep: t('alerts.jobFailure.failed', { count: failures.length }) },
    {
      items: failures.map((f) => `- ${oneLine(f, JOB_FAILURE_LINE_LENGTH - 2)}`),
      limit: JOB_FAILURE_LINES,
      more: (count) => t('alerts.jobFailure.more', { count }),
      keep: true,
    },
    t('alerts.jobFailure.body'),
  ];
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
      { keep: t('alerts.dataAdmin.title', { date: o.date }) },
      {
        items: o.reasons.map((code) => describeReason(t, code)),
        more: (count) => t('alerts.more', { count }),
        inline: { join: REASONS_JOIN, line: (reasons) => t('alerts.dataAdmin.body', { reasons }) },
        keep: true,
      },
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
      { keep: t('alerts.update.title', { to: o.to, step: o.step }) },
      { keep: t(o.stuck ? 'alerts.update.stuck' : 'alerts.update.back', { from: o.from }) },
    ],
  });
}

/** The disk holding the database is at or over the warning threshold: once per day. */
export function sendDiskSpace(
  db: Db,
  o: AlertOptions & { disk: DiskUsage },
): Promise<AlertSummary> {
  return sendAdminAlert(db, {
    ...o,
    subject: 'disk',
    type: 'disk_space',
    lines: (t) => [
      { keep: t('alerts.disk.title', { percent: o.disk.usedPercent.toFixed(1) }) },
      {
        keep: t('alerts.disk.body', {
          free: formatBytes(o.disk.freeBytes),
          size: formatBytes(o.disk.databaseBytes),
        }),
      },
    ],
  });
}

/** Revised rows (ticker, field, source) listed per kind in the revisions alert; the rest counted. */
export const REVISION_ITEMS = 8;

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
  // At most REVISION_ITEMS rows per kind, the other rows counted exactly.
  const listed = (t: Translate, rows: typeof o.revisions, key: string): Part[] =>
    rows.length === 0
      ? []
      : [
          {
            items: rows.map(
              (r) =>
                `${r.ticker} ${r.field}@${r.source} ${r.count} (${r.from === r.to ? r.from : `${r.from}..${r.to}`})`,
            ),
            limit: REVISION_ITEMS,
            more: (n) => t('alerts.more', { count: n }),
            inline: { join: ', ', line: (items) => t(key, { items }) },
            keep: true,
          },
        ];
  const changed = o.revisions.filter((r) => r.kind !== 'withdrawn');
  const withdrawn = o.revisions.filter((r) => r.kind === 'withdrawn');
  return sendAdminAlert(db, {
    ...o,
    subject: `revisions:${o.runId}`,
    type: 'revisions',
    lines: (t) => [
      { keep: t('alerts.revisions.title', { count }) },
      ...listed(t, changed, 'alerts.revisions.body'),
      ...listed(t, withdrawn, 'alerts.revisions.withdrawn'),
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
      { keep: t('alerts.integrity.title', { check: o.check }) },
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
      { keep: t('alerts.parity.title', { name: o.caseName }) },
      t('alerts.parity.body', { detail: o.detail.slice(0, 500) }),
    ],
  });
}

/**
 * Recompute differences not yet told, one message per admin channel. Driven by the annotations
 * (one alert key each), so an undelivered alert is tried again at the next run. The first in
 * full, the others one per line while the channel has room (the rest counted); only the keys of
 * what arrives whole are recorded, the others are told at the next run.
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
    const body = (signals: string) =>
      t('alerts.recompute.body', {
        version: first.version,
        date: first.date,
        recorded: first.detail.recordedAllocation,
        now: first.detail.recomputedAllocation,
        signals: signals || '-',
      });
    const others = pending.slice(1);
    const parts: Part[] = [
      { keep: t('alerts.recompute.title', { count: pending.length }) },
      {
        items: first.detail.signalsDiffer,
        more: (count) => t('alerts.more', { count }),
        inline: { join: ', ', line: body },
        keep: true,
      },
      ...(others.length > 0 ? [t('alerts.recompute.others')] : []),
    ];
    const list = parts.length;
    parts.push(
      {
        items: others.map((n) =>
          t('alerts.recompute.otherDay', {
            version: n.version,
            date: n.date,
            recorded: n.detail.recordedAllocation,
            now: n.detail.recomputedAllocation,
          }),
        ),
        more: (count) => t('alerts.more', { count }),
      },
      { keep: healthLine },
    );
    const fit = fitMessage(parts, roomOn(o, channel, t));
    const keys = [first.key, ...others.slice(0, fit.shown[list]).map((n) => n.key)];
    await deliver(db, o, channel, { key: first.key, keys, ...fitted(fit) }, summary, t);
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
 * a signal or an instruction, and the record is said to be annotated, not changed. `others`: the
 * version's other corrections in the same message (see there). Fitted to `max` (`fitMessage`):
 * the other days that change the signal are listed while there is room, the rest counted ("and
 * N more"); the correction in full, the past-day line and the health line (the version's latest
 * recorded day) are never cut: a channel too small for them gets nothing (`needed`).
 * `told`: what arrives whole besides the correction in full (the number of changing days listed,
 * and whether the unchanged ones' count line arrives), so only those keys are recorded and the
 * others are told at the next run.
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
    /**
     * The version's other corrections told in the same message: each one that changes the
     * signal on its own line (date, ticker, recorded and corrected allocation), in the given
     * order; the unchanged ones counted.
     */
    others?: { date: TradingDate; detail: StandInCorrectedDetail }[];
  },
  /** The channel's longest message (less a drill's mark and line). */
  max: number,
): Pick<Alert, 'text' | 'needed'> & { told: { changed: number; unchanged: boolean } } {
  const d = o.detail;
  const name = (allocation: string) =>
    allocation === SAFE_STATE ? t('alerts.safeStateName') : allocation;
  // Two decimals, rounded half-expand by Intl (e.g. 0.010101 as "1.01%").
  const deviation = new Intl.NumberFormat(language, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(d.deviation);
  const changed = (o.others ?? []).filter((x) => x.detail.differs);
  const unchanged = (o.others ?? []).length - changed.length;
  const values = {
    strategy: o.name,
    date: o.date,
    ticker: d.ticker,
    standInDate: d.standInDate,
    deviation,
  };
  // The correction in full is never cut: it is told whole or not at all.
  const parts: Part[] = [
    { keep: t('alerts.standInCorrected.title', values) },
    {
      keep: t(
        d.standInDate === o.date
          ? 'alerts.standInCorrected.body'
          : 'alerts.standInCorrected.earlier',
        values,
      ),
    },
    {
      keep: d.differs
        ? t('alerts.standInCorrected.differs', {
            recorded: name(d.recordedAllocation),
            corrected: name(d.correctedAllocation),
          })
        : t('alerts.standInCorrected.same', { recorded: name(d.recordedAllocation) }),
    },
    ...(changed.length > 0 ? [t('alerts.standInCorrected.otherChanged')] : []),
  ];
  const list = parts.length;
  parts.push({
    items: changed.map((x) =>
      t('alerts.standInCorrected.otherDay', {
        date: x.date,
        ticker: x.detail.ticker,
        recorded: name(x.detail.recordedAllocation),
        corrected: name(x.detail.correctedAllocation),
      }),
    ),
    more: (count) => t('alerts.more', { count }),
  });
  if (unchanged > 0) parts.push({ count: t('alerts.standInCorrected.more', { count: unchanged }) });
  // Never cut either: without it the correction could read as a new signal.
  parts.push({ keep: t('alerts.standInCorrected.pastDay') });
  // Unknown stays unknown: without a recorded day the status is `unknown`, never green.
  const healthLine = o.health
    ? `${t(`alerts.health.${o.health.status}`)} ${t('alerts.standInCorrected.healthDate', { date: o.health.date })}`
    : t('alerts.health.unknown');
  const fit = fitMessage([...parts, { keep: healthLine }], max);
  return {
    ...fitted(fit),
    told: {
      changed: fit.shown[list]!,
      unchanged: unchanged > 0 && fit.shown[list + 1] === 1,
    },
  };
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
 * version one message: the newest correction that changes the signal (else the newest; latest
 * entry date first) in full, each other one that changes it on a line of its own, the unchanged
 * ones counted, every key recorded once it is delivered. An annotation that does not read back is told to the
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
      // In full: the newest correction that changes the signal, else the newest one.
      const lead = pending.find((n) => n.detail.differs) ?? pending[0];
      if (!lead) return;
      const others = pending.filter((n) => n !== lead);
      const { told, ...message } = standInCorrectedText(
        t,
        language,
        {
          name: version.name,
          date: lead.date,
          detail: lead.detail,
          others,
          ...(health && { health }),
        },
        roomOn(o, channel, t),
      );
      // Only what the message tells is recorded: the lead (the alert's own key), the changing
      // days listed whole (in order, newest first) and the unchanged ones when their count line
      // arrives whole. The others stay pending and are told at the next run.
      const keys = [
        lead.key,
        ...others
          .filter((n) => n.detail.differs)
          .slice(0, told.changed)
          .map((n) => n.key),
        ...(told.unchanged ? others.filter((n) => !n.detail.differs).map((n) => n.key) : []),
      ];
      await deliver(db, o, channel, { key: lead.key, keys, ...message }, summary, t);
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
      { keep: t('alerts.standInUnreadable.title') },
      {
        keep: t('alerts.standInUnreadable.body', {
          version: `${a.version.name} (${a.version.id})`,
          date: a.date,
          id: String(a.id),
        }),
      },
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
  if (alert.needed !== undefined) {
    // Its parts never cut do not fit (with a drill's mark and line): nothing is sent or
    // recorded, and the run is incomplete, so the admins hear of it.
    const needed = alert.needed + (o.drill ? drillOverhead(t) : 0);
    o.log.warn(`Alert not delivered (${label}): channel too small`, { key: alert.key, needed });
    summary.failed.push(`${label}: channel too small for the alert (${needed} characters needed)`);
    return;
  }
  // The alert was fitted to the room a drill's mark and line leave (`roomOn`); the cut is only a
  // guard against a channel's limit being passed.
  const text = cut(o.drill ? drillText(t, alert.text) : alert.text, notifier.info.maxLength);
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
  return text.length <= max ? text : cutAlways(text, max);
}

/** `max` characters of `text` at most, always ending in "…" (the line is not whole). */
function cutAlways(text: string, max: number): string {
  return `${text.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * A list in a message, shortened item by item to fit the channel. The items not listed are
 * counted exactly by `more` (never dropped silently). `inline`: the listed items and the count
 * joined by `join` into one line by `line`; otherwise each item is a line, the count a line after
 * them. `keep`: its lines are never cut or dropped (it is only shortened item by item).
 */
export interface ListPart {
  items: string[];
  /** At most this many listed whatever the room (default: all). */
  limit?: number;
  more: (count: number) => string;
  inline?: { join: string; line: (items: string) => string };
  keep?: boolean;
}

/**
 * A part of a message: a line (cut or dropped when nothing else fits), a line never cut
 * (`keep`), a count line (`count`: dropped whole, never cut in its text), or a list.
 */
export type Part = string | { keep: string } | { count: string } | ListPart;

export interface Fitted {
  /** The message; not to be sent when it does not fit (`fits` false). */
  text: string;
  /**
   * Per part, what arrives whole: a line 1 or 0; a list the number of its items listed (an inline
   * list's only when its whole line arrives).
   */
  shown: number[];
  /** Every part never cut arrives whole within `max`. When false nothing may be sent. */
  fits: boolean;
  /**
   * The characters the message needs at least: the parts never cut whole, the lists at their
   * count, one "…" for each run of other lines.
   */
  needed: number;
}

const isList = (p: Part): p is ListPart => typeof p === 'object' && 'items' in p;
// A list may carry `keep` too: a kept line is the part whose `keep` is its text.
const isKept = (p: Part): p is { keep: string } =>
  typeof p === 'object' && 'keep' in p && typeof p.keep === 'string';
const isCount = (p: Part): p is { count: string } => typeof p === 'object' && 'count' in p;

/**
 * The one way an alert fits its channel (requirements 11: every alert states the data health).
 * `max`: the channel's longest message, less a drill's mark and line (`roomOn`).
 * 1. The lists are shortened one item at a time, the list with the most items listed first (on a
 *    tie the later one), each counted exactly ("and N more"), until the message fits or no list
 *    lists anything. Lengths come from the items' lengths, not from a render per item.
 * 2. Still too long: the lines that may be cut go, run by run from the end (a run: the lines
 *    between those never cut). A run loses whole lines from its end, one "…" line in their
 *    place; only when its first line alone (with that "…") does not fit is that line cut in its
 *    text, and a count line never is (the run is then "…" alone). A run down to "…" gives its
 *    room to the run before it.
 * 3. A channel too small for the parts never cut whole and one "…" per run: `fits` is false and
 *    the caller sends nothing (`deliver` reports the channel as too small).
 */
export function fitMessage(parts: Part[], max: number): Fitted {
  const shown = parts.map((p) => (isList(p) ? Math.min(p.items.length, p.limit ?? Infinity) : 1));
  const render = (i: number): string[] => {
    const p = parts[i]!;
    if (typeof p === 'string') return [p];
    if (isKept(p)) return [p.keep];
    if (isCount(p)) return [p.count];
    const n = shown[i]!;
    const hidden = p.items.length - n;
    const listed = [...p.items.slice(0, n), ...(hidden > 0 ? [p.more(hidden)] : [])];
    return p.inline ? [p.inline.line(listed.join(p.inline.join))] : listed;
  };
  // Step 1 by arithmetic: each part's characters and lines for `shown` items, from prefix sums of
  // the item lengths. An inline line is its template's length plus `k` times the listed text's
  // (the translator puts the text in `k` times); the render after the loop checks it.
  const size = parts.map((p, i) => {
    if (!isList(p)) return () => ({ chars: render(i)[0]!.length, lines: 1 });
    const prefix = [0];
    for (const item of p.items) prefix.push(prefix.at(-1)! + item.length);
    // Measured on one and two characters, so a line that stands in for empty text still counts.
    const k = p.inline ? p.inline.line('xx').length - p.inline.line('x').length : 0;
    const base = p.inline ? p.inline.line('x').length - k : 0;
    return () => {
      const n = shown[i]!;
      const hidden = p.items.length - n;
      const more = hidden > 0 ? p.more(hidden).length : 0;
      const count = n + (hidden > 0 ? 1 : 0);
      if (!p.inline) return { chars: prefix[n]! + more, lines: count };
      const listed = prefix[n]! + more + p.inline.join.length * Math.max(0, count - 1);
      return { chars: base + k * listed, lines: 1 };
    };
  });
  const sizes = size.map((s) => s());
  const total = () => {
    const lines = sizes.reduce((n, s) => n + s.lines, 0);
    return sizes.reduce((n, s) => n + s.chars, 0) + Math.max(0, lines - 1);
  };
  const pickList = () => {
    let pick = -1;
    parts.forEach((p, i) => {
      if (isList(p) && shown[i]! > 0 && (pick < 0 || shown[i]! >= shown[pick]!)) pick = i;
    });
    return pick;
  };
  for (let pick = pickList(); total() > max && pick >= 0; pick = pickList()) {
    shown[pick]!--;
    sizes[pick] = size[pick]!();
  }
  let rendered = parts.map((_, i) => render(i));
  const textOf = () => rendered.flat().join('\n');
  // The arithmetic is exact for the alerts' templates; a line that is not is shortened by render.
  for (let pick = pickList(); textOf().length > max && pick >= 0; pick = pickList()) {
    shown[pick]!--;
    rendered = parts.map((_, i) => render(i));
  }

  // Each line with its part; runs of lines that may be cut, between those never cut.
  const lines = rendered.flatMap((ls, part) => {
    const p = parts[part]!;
    const keep = isKept(p) || (isList(p) && p.keep === true);
    return ls.map((text, j) => {
      const hidden = isList(p) && p.items.length > shown[part]!;
      // A line with a count: a count line, an inline list's line, a list's last line ("and N more").
      const count = isCount(p) || (hidden && (p.inline !== undefined || j === ls.length - 1));
      return { text, part, keep, count };
    });
  });
  type Line = (typeof lines)[number];
  const runs: { keep: boolean; lines: Line[] }[] = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && !last.keep && !line.keep) last.lines.push(line);
    else runs.push({ keep: line.keep, lines: [line] });
  }
  const length = (ls: Line[]) => ls.reduce((n, l) => n + l.text.length, 0) + ls.length - 1;
  const needed =
    runs.reduce((n, r) => n + (r.keep ? length(r.lines) : 1), 0) + Math.max(0, runs.length - 1);
  const whole = new Set<Line>(lines);
  let text = textOf();
  if (text.length > max) {
    if (needed > max) return { text, shown: parts.map(() => 0), fits: false, needed };
    let excess = text.length - max;
    const out = runs.map((r) => r.lines.map((l) => l.text));
    for (let i = runs.length - 1; i >= 0 && excess > 0; i--) {
      const r = runs[i]!;
      if (r.keep) continue;
      const all = length(r.lines);
      // The most whole lines that fit with one "…" line after them.
      let j = r.lines.length - 1;
      while (j >= 1 && all - (length(r.lines.slice(0, j)) + 2) < excess) j--;
      const dropped = j >= 1 ? r.lines.slice(j) : r.lines;
      for (const l of dropped) whole.delete(l);
      if (j >= 1) {
        out[i] = [...r.lines.slice(0, j).map((l) => l.text), '…'];
      } else {
        const first = r.lines[0]!;
        const room = Math.min(all - excess, first.text.length);
        out[i] = [!first.count && room >= 2 ? cutAlways(first.text, room) : '…'];
      }
      excess -= all - out[i]!.join('\n').length;
    }
    text = out.flat().join('\n');
  }
  const shownWhole = parts.map((p, i) => {
    const own = lines.filter((l) => l.part === i);
    if (!isList(p) || p.inline) {
      return own.length > 0 && own.every((l) => whole.has(l)) ? shown[i]! : 0;
    }
    // One line per item, the count after them: the items before the first line not whole.
    const first = own.findIndex((l) => !whole.has(l));
    return Math.min(shown[i]!, first < 0 ? own.length : first);
  });
  return { text, shown: shownWhole, fits: true, needed };
}

/**
 * The characters a message may take on a channel: its notifier's longest message, less a drill's
 * mark and line. Without a notifier `deliver` reports the channel; the room is then irrelevant.
 */
function roomOn(o: AlertOptions, channel: Channel, t: Translate): number {
  const max = o.notifiers.find((n) => n.info.key === channel.type)?.info.maxLength ?? Infinity;
  return max - (o.drill ? drillOverhead(t) : 0);
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

/** Between reasons in words (`describeReasons` and the alerts' reason lists). */
const REASONS_JOIN = '; ';

/**
 * Reason codes in words, e.g. `AAA2:B.close_match@alpaca` as "AAA2: closes differ between sources
 * (alpaca)". A code without a text stays as it is (it is still exact, only less readable).
 */
export function describeReasons(t: Translate, codes: string[]): string {
  return codes.map((code) => describeReason(t, code)).join(REASONS_JOIN);
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
