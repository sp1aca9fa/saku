// The monthly audit report (stage-a A3; requirements 04 layer H "monthly audit report" and
// "Fail-closed": the data-health status appears in the audit report; system design `saku-monthly`,
// the 1st at 11:47). What the data and the forward records went through in one month, read-only:
//
// 1. Days by grade: each trading day (New York sessions dated in the month) as `pnpm health`
//    grades it (`healthReport`: the latest finished run covering the date), counted green, yellow,
//    red or not graded (a date counts red when its overall grade or a symbol's is red, else yellow
//    when one is yellow, else not graded when it is not green: `daysVerdict`'s rule), then each
//    day not green with its reasons in words. A day nobody graded is "not graded", never green.
// 2. Revisions: `bar_revisions` rows detected in the month, by symbol and source, and the largest
//    relative changes |new / old - 1| (at most REVISIONS_LISTED; a value added, removed or changed
//    from 0 has no relative change and is listed first); `readjustments` detected in the month.
// 3. Quota use per provider, from the provider ledger (`provider_usage` day rows; UTC days, as the
//    ledger stores them): requests, the peak day and the distinct symbols against the declared
//    per-day and symbols-per-month limits, flagged above the quota guard's 80% (requirements 04
//    "Quota guard": never above 80% of a declared limit; a UTC day is one of the guard's 24-hour
//    windows and a calendar month lies within its 31-day symbol window). The ledger keeps day
//    rows for USAGE_SYMBOL_WINDOW_MS only (pruned by each run): days before that boundary may be
//    gone, so their counts are a lower bound and said to be ("at least"), never complete. Minute
//    rows are kept for a day only, so per-minute and per-hour use is not audited (said so).
// 4. Forward records: every chain and anchor verified now (`verifyChains`, as `pnpm strategy
//    verify`); per version the entries dated in the month (trading dates), their data status and
//    safe-state days, and the sessions of the month the forward step records for it (`recordsDay`,
//    jobs/forward.ts: on or after `forward_records_from`, a close after registration) without an
//    entry, so a version with no entry at all counts every such day (before the gate: the
//    sessions from its first entry on); annotations added in the month by kind.
// 5. Runs: job runs started in the month by type and status; each failed or unfinished one with
//    the first line of its error.
// 6. Stand-ins dated in the month: resolved (the primary arrived), closed (an admin's latest close
//    still matches the canonical bar, requirements 04 stand-in rule 5), reopened (closed before,
//    the canonical bar changed since: open again) and open.
//
// "The month" is a calendar month in the install's time zone (the `time_zone` setting, else the
// system's): instants (detected, created, started) from its first midnight to the next month's;
// trading days and forward entries by their New York trading date in the month; quota by UTC day.
// The report ends with a verdict in words: "Verdict: all clear." only when every trading day is
// green, every chain and anchor verifies, no forward record day is missing, no run failed or is
// unfinished, the quota use is fully known (the UTC month over and every day of it still in the
// ledger), every provider that sent requests has known limits, no provider is above 80% of a
// declared limit, and
// no stand-in of the month is open or reopened; otherwise "Verdict: needs attention (...)" with
// each item. Revisions and re-adjustments are listed, not judged (a provider correcting its data
// is expected; the checks grade what it changed).
import { type HealthStatus, type TradingDate, zonedInstant } from '@saku/core';
import type { Translate } from '@saku/content';
import type { Sessions } from '@saku/data';
import {
  type Db,
  USAGE_SYMBOL_WINDOW_MS,
  getSetting,
  schema,
  standInList,
  standInMatchesBar,
} from '@saku/db';
import { and, eq, gte, lt, lte } from 'drizzle-orm';
import type { Part } from './alerts';
import { type ChainCheck, chainProblems, verifyChains } from './chain-verify';
import { type DayReport, healthReport } from './health';
import { describeDay } from './health-lines';
import { fmt } from './health-values';
import type { verifyToken } from './anchor';
import { recordsDay } from './forward';
import { latestDailyTarget } from './stand-ins';
import { dailyTarget } from './target';
import type { ProviderLimits } from '../types';

/** The largest revisions listed; the rest are counted. */
export const REVISIONS_LISTED = 20;
/** Failed or unfinished runs, re-adjustments and unsettled stand-ins listed; the rest counted. */
export const LISTED = 50;
/** The quota guard's share of a limit (requirements 04 "Quota guard"). */
export const QUOTA_SHARE = 0.8;

const DAY_MS = 86_400_000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

// ---------------------------------------------------------------------------------------------
// Months

/** True for `YYYY-MM` with a month 01 to 12. */
export function isMonth(value: string): boolean {
  return MONTH.test(value);
}

/** The month `n` months after `month` (negative: before). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** The calendar month of an instant in a time zone. */
export function monthOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year').padStart(4, '0')}-${get('month')}`;
}

/** The calendar month before the one `now` is in, in the time zone (the report's default). */
export function previousMonth(now: Date, timeZone: string): string {
  return addMonths(monthOf(now, timeZone), -1);
}

export interface MonthWindow {
  month: string;
  /** The month's first midnight in the time zone (ISO instant, inclusive). */
  from: string;
  /** The next month's first midnight (ISO instant, exclusive). */
  to: string;
  firstDay: string;
  lastDay: string;
}

export function monthWindow(month: string, timeZone: string): MonthWindow {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    month,
    from: zonedInstant(`${month}-01`, '00:00', timeZone),
    to: zonedInstant(`${addMonths(month, 1)}-01`, '00:00', timeZone),
    firstDay: `${month}-01`,
    lastDay: `${month}-${String(last).padStart(2, '0')}`,
  };
}

/** The install's time zone: the `time_zone` setting, else the system's. */
export async function installTimeZone(db: Db): Promise<string> {
  return (await getSetting(db, 'time_zone')) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Whether a month can be audited at `now`: it is over in the install's time zone, the data of its
 * last trading day is final (the daily target, `finalAfter` New York, has reached it), and a
 * complete daily run has processed that day (`latestDailyTarget` on or after it), so no day of it
 * is "not graded" or a forward record day "missing" only for being early; the timer's retry days
 * then audit it. A month with trading days but no complete daily run ever is not ready either
 * (fails closed). A month without sessions needs no daily run; a month the calendar does not
 * cover can be audited once over (its days then read "not known").
 */
export async function monthReady(
  db: Db,
  month: string,
  o: { now: Date; timeZone: string; sessions: Sessions; finalAfter: string },
): Promise<{ ok: true } | { ok: false; why: string }> {
  const w = monthWindow(month, o.timeZone);
  if (o.now.getTime() < Date.parse(w.to)) {
    return { ok: false, why: `${month} is not over yet in ${o.timeZone}.` };
  }
  let last: TradingDate | undefined;
  let target: TradingDate;
  try {
    last = o.sessions.between(w.firstDay, w.lastDay).at(-1);
    target = dailyTarget(o.sessions, o.now, o.finalAfter);
  } catch {
    return { ok: true };
  }
  if (last === undefined) return { ok: true };
  if (target < last) {
    return {
      ok: false,
      why: `The data of ${last}, the last trading day of ${month}, is not final until ${o.finalAfter} New York.`,
    };
  }
  const daily = await latestDailyTarget(db);
  if (daily === undefined || daily < last) {
    return {
      ok: false,
      why:
        `No complete daily run has processed ${last}, the last trading day of ${month}, yet ` +
        `(latest: ${daily ?? 'none'}).`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The report

export interface RevisionLine {
  ticker: string;
  date: string;
  source: string;
  field: string;
  oldValue: number | null;
  newValue: number | null;
  /** new / old - 1; null when there is none (a value added, removed or from 0). */
  change: number | null;
}

export interface ProviderQuota {
  provider: string;
  requests: number;
  /** Days of the month with stored requests. */
  days: number;
  peak?: { day: string; requests: number };
  symbols: number;
  /** Whether a loaded plug-in or notifier uses this provider id (else its limits are not known). */
  known: boolean;
  /** The declared limits (none declared: undefined). */
  limits?: ProviderLimits;
  /** Limits the month went above QUOTA_SHARE of ('per day', 'symbols per month'). */
  over: string[];
}

export interface AuditReport {
  window: MonthWindow;
  timeZone: string;
  producedAt: string;
  days:
    | {
        known: true;
        report: DayReport[];
        counts: { green: number; yellow: number; red: number; notGraded: number };
      }
    | { known: false; why: string };
  revisions: {
    count: number;
    groups: { ticker: string; source: string; count: number }[];
    largest: RevisionLine[];
    readjustments: {
      ticker: string;
      source: string;
      fromDate: string;
      toDate: string;
      factor: number;
      detectedAt: string;
    }[];
  };
  quota: {
    /**
     * The counts are complete: the month's last UTC day is over (`utcOver`) and every day of the
     * month is still in the ledger (from `keptFrom`).
     */
    complete: boolean;
    /** The UTC month is over (now at or after the next month's first UTC midnight). */
    utcOver: boolean;
    /** The first UTC day surely still stored. */
    keptFrom: string;
    providers: ProviderQuota[];
  };
  forward: {
    chain: ChainCheck;
    versions: {
      id: string;
      name: string;
      entries: number;
      safe: number;
      statuses: Record<HealthStatus, number>;
      /**
       * Sessions of the month the forward step records (`recordsDay`) without an entry; before
       * the A1 gate (no `forward_records_from`) or without a known registration, the sessions
       * from its first entry on without one. Undefined: not known (no entry yet before the gate,
       * or the month's trading days not known).
       */
      missing?: TradingDate[];
    }[];
    annotations: { kind: string; count: number }[];
  };
  runs: {
    groups: { jobType: string; status: string; count: number }[];
    problems: {
      id: string;
      jobType: string;
      target?: string;
      startedAt: string;
      status: string;
      error?: string;
    }[];
  };
  standIns: {
    count: number;
    resolved: number;
    closed: number;
    open: number;
    reopened: number;
    unsettled: { ticker: string; date: string; reopened: boolean }[];
  };
}

export interface AuditOptions {
  month: string;
  timeZone: string;
  sessions: Sessions;
  now: Date;
  /** Declared limits per provider id (`declaredLimits`). */
  limits: Map<string, ProviderLimits | undefined>;
  /** The CA file timestamp tokens are verified against. */
  caFile: string;
  /** The token check (default openssl, `verifyToken`). */
  token?: typeof verifyToken;
}

/** Each provider id's declared limits, from the loaded plug-ins' and notifiers' descriptions. */
export function declaredLimits(
  infos: { key: string; kind: string; provider?: string; limits?: ProviderLimits }[],
): Map<string, ProviderLimits | undefined> {
  const out = new Map<string, ProviderLimits | undefined>();
  for (const info of infos) {
    if (info.kind === 'calendar') continue; // Calendars send no requests.
    // Plug-ins of one provider declare the same limits (`validateInfos`).
    const id = info.provider ?? info.key;
    if (!out.get(id)) out.set(id, info.limits);
  }
  return out;
}

/** An ISO instant inside [from, to); an unreadable one is in no month. */
function within(iso: string, w: MonthWindow): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= Date.parse(w.from) && t < Date.parse(w.to);
}

/** A day either side of the month's UTC dates: the SQL pre-filter, made exact by `within`. */
function coarse(w: MonthWindow): { from: string; to: string } {
  return {
    from: new Date(Date.parse(w.from) - DAY_MS).toISOString().slice(0, 10),
    to: new Date(Date.parse(w.to) + DAY_MS).toISOString().slice(0, 10),
  };
}

export async function auditReport(db: Db, o: AuditOptions): Promise<AuditReport> {
  if (!isMonth(o.month)) throw new Error(`${o.month} is not a month (YYYY-MM).`);
  const w = monthWindow(o.month, o.timeZone);
  const tickers = new Map(
    (
      await db.select({ id: schema.symbols.id, ticker: schema.symbols.ticker }).from(schema.symbols)
    ).map((s) => [s.id, s.ticker]),
  );
  const tickerOf = (id: number) => tickers.get(id) ?? `symbol ${id}`;

  // 1. Days by grade.
  let days: AuditReport['days'];
  let sessions: TradingDate[] | undefined;
  try {
    sessions = o.sessions.between(w.firstDay, w.lastDay);
  } catch (e) {
    days = { known: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (sessions) {
    const report = await healthReport(db, { dates: sessions, sessions: o.sessions });
    const counts = { green: 0, yellow: 0, red: 0, notGraded: 0 };
    for (const d of report) counts[dayClass(d)]++;
    days = { known: true, report, counts };
  }

  // 2. Revisions and re-adjustments detected in the month.
  const c = coarse(w);
  const revisionRows = (
    await db
      .select()
      .from(schema.barRevisions)
      .where(
        and(gte(schema.barRevisions.detectedAt, c.from), lt(schema.barRevisions.detectedAt, c.to)),
      )
  ).filter((r) => within(r.detectedAt, w));
  const groups = new Map<string, { ticker: string; source: string; count: number }>();
  for (const r of revisionRows) {
    const ticker = tickerOf(r.symbolId);
    const key = `${ticker}\u0000${r.source}`;
    const g = groups.get(key) ?? { ticker, source: r.source, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  const lines: RevisionLine[] = revisionRows.map((r) => ({
    ticker: tickerOf(r.symbolId),
    date: r.date,
    source: r.source,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    change: relativeChange(r.oldValue, r.newValue),
  }));
  // No relative change first (a value added, removed or from 0), then the largest.
  const size = (l: RevisionLine) => (l.change === null ? Infinity : Math.abs(l.change));
  lines.sort(
    (a, b) =>
      size(b) - size(a) ||
      compareText(`${a.date} ${a.ticker} ${a.field}`, `${b.date} ${b.ticker} ${b.field}`),
  );
  const readjustments = (await db.select().from(schema.readjustments))
    .filter((r) => within(r.detectedAt, w))
    .map((r) => ({
      ticker: tickerOf(r.symbolId),
      source: r.source,
      fromDate: r.fromDate,
      toDate: r.toDate,
      factor: r.factor,
      detectedAt: r.detectedAt,
    }))
    .sort((a, b) => compareText(a.detectedAt, b.detectedAt) || compareText(a.ticker, b.ticker));

  // 3. Quota use (UTC days of the same YYYY-MM, as the ledger stores them). Complete only once
  // the UTC month is over (an install zone ahead of UTC ends its month first: the last UTC day
  // may still be counting) and its first day is still kept.
  const [qy, qm] = o.month.split('-').map(Number) as [number, number];
  const utcOver = o.now.getTime() >= Date.UTC(qy, qm, 1);
  const keptFrom = new Date(o.now.getTime() - USAGE_SYMBOL_WINDOW_MS).toISOString().slice(0, 10);
  const usage = await db
    .select()
    .from(schema.providerUsage)
    .where(
      and(
        eq(schema.providerUsage.windowType, 'day'),
        gte(schema.providerUsage.windowStart, w.firstDay),
        lte(schema.providerUsage.windowStart, w.lastDay),
      ),
    );
  const providers = new Map<string, ProviderQuota & { symbolSet: Set<string> }>();
  const quotaOf = (provider: string) => {
    let q = providers.get(provider);
    if (!q) {
      const limits = o.limits.get(provider);
      q = {
        provider,
        requests: 0,
        days: 0,
        symbols: 0,
        symbolSet: new Set(),
        over: [],
        known: o.limits.has(provider),
        ...(limits && { limits }),
      };
      providers.set(provider, q);
    }
    return q;
  };
  for (const [provider, limits] of o.limits) if (limits) quotaOf(provider);
  for (const row of usage) {
    const q = quotaOf(row.provider);
    q.requests += row.requestCount;
    q.days++;
    if (!q.peak || row.requestCount > q.peak.requests) {
      q.peak = { day: row.windowStart, requests: row.requestCount };
    }
    for (const s of Array.isArray(row.symbols) ? row.symbols : []) q.symbolSet.add(String(s));
  }
  const quota: ProviderQuota[] = [...providers.values()]
    .map(({ symbolSet, ...q }) => {
      const over: string[] = [];
      const perDay = q.limits?.perDay;
      if (perDay !== undefined && q.peak && q.peak.requests > QUOTA_SHARE * perDay) {
        over.push('per day');
      }
      const perMonth = q.limits?.symbolsPerMonth;
      if (perMonth !== undefined && symbolSet.size > QUOTA_SHARE * perMonth) {
        over.push('symbols per month');
      }
      return { ...q, symbols: symbolSet.size, over };
    })
    .sort((a, b) => compareText(a.provider, b.provider));

  // 4. Forward records. Missing days: the days the forward step itself records for the version
  // (`recordsDay`: on or after `forward_records_from`, a close after registration; requirements
  // 05) that have no entry, so a version with no entry at all still has its days counted.
  const recordsFrom = await getSetting(db, 'forward_records_from');
  const chain = await verifyChains(db, { caFile: o.caFile, ...(o.token && { token: o.token }) });
  const versions: AuditReport['forward']['versions'] = [];
  const registered = new Map(
    (
      await db
        .select({ id: schema.strategyVersions.id, at: schema.strategyVersions.registeredAt })
        .from(schema.strategyVersions)
    ).map((v) => [v.id, v.at]),
  );
  for (const v of chain.versions) {
    const all = await db
      .select({
        date: schema.forwardEntries.date,
        safe: schema.forwardEntries.safeStateApplied,
        status: schema.forwardEntries.dataStatus,
      })
      .from(schema.forwardEntries)
      .where(eq(schema.forwardEntries.versionId, v.id));
    const first = all.map((e) => e.date).sort()[0];
    const registeredAt = registered.get(v.id);
    const at = Date.parse(registeredAt ?? '');
    // A version registered after the month has nothing to show for it.
    if (Number.isFinite(at) && at >= Date.parse(w.to)) continue;
    const inMonth = all.filter((e) => e.date >= w.firstDay && e.date <= w.lastDay);
    const dated = new Set(inMonth.map((e) => e.date));
    const statuses: Record<HealthStatus, number> = { green: 0, yellow: 0, red: 0 };
    for (const e of inMonth) statuses[e.status]++;
    let missing: TradingDate[] | undefined;
    if (recordsFrom !== undefined && registeredAt !== undefined && sessions) {
      const expected = sessions.filter((d) => recordsDay(d, recordsFrom, registeredAt, o.sessions));
      // Nothing due in the month and nothing recorded in it (e.g. the month before the gate).
      if (expected.length === 0 && inMonth.length === 0) continue;
      missing = expected.filter((d) => !dated.has(d));
    } else {
      // Before the gate: counted from the first entry; first recorded after the month: nothing.
      if (first !== undefined && first > w.lastDay) continue;
      if (first !== undefined && sessions)
        missing = sessions.filter((d) => d >= first && !dated.has(d));
    }
    versions.push({
      id: v.id,
      name: v.name,
      entries: inMonth.length,
      safe: inMonth.filter((e) => e.safe).length,
      statuses,
      ...(missing && { missing }),
    });
  }
  versions.sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  const kinds = new Map<string, number>();
  for (const a of await db
    .select({
      kind: schema.forwardAnnotations.kind,
      createdAt: schema.forwardAnnotations.createdAt,
    })
    .from(schema.forwardAnnotations)) {
    if (within(a.createdAt, w)) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  }
  const annotations = [...kinds]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => compareText(a.kind, b.kind));

  // 5. Runs started in the month.
  const runs = (await db.select().from(schema.jobRuns))
    .filter((r) => within(r.startedAt, w))
    .sort((a, b) => compareText(a.startedAt, b.startedAt));
  const runGroups = new Map<string, { jobType: string; status: string; count: number }>();
  for (const r of runs) {
    const key = `${r.jobType} ${r.status}`;
    const g = runGroups.get(key) ?? { jobType: r.jobType, status: r.status, count: 0 };
    g.count++;
    runGroups.set(key, g);
  }
  const problems = runs
    .filter((r) => r.status !== 'success')
    .map((r) => {
      const error = r.error?.split('\n')[0]?.trim();
      const target = r.datesProcessed?.[0];
      return {
        id: r.id,
        jobType: r.jobType,
        startedAt: r.startedAt,
        status: r.status,
        ...(target && { target }),
        ...(error && { error }),
      };
    });

  // 6. Stand-ins dated in the month.
  const standIns = { count: 0, resolved: 0, closed: 0, open: 0, reopened: 0 };
  const unsettled: AuditReport['standIns']['unsettled'] = [];
  for (const s of await standInList(db)) {
    if (s.date < w.firstDay || s.date > w.lastDay) continue;
    standIns.count++;
    if (s.resolvedAt !== null) standIns.resolved++;
    else if (s.latestClose && standInMatchesBar(s.latestClose, s.canonical)) standIns.closed++;
    else if (s.closes.length > 0) {
      standIns.reopened++;
      unsettled.push({ ticker: s.ticker, date: s.date, reopened: true });
    } else {
      standIns.open++;
      unsettled.push({ ticker: s.ticker, date: s.date, reopened: false });
    }
  }

  return {
    window: w,
    timeZone: o.timeZone,
    producedAt: o.now.toISOString(),
    days: days!,
    revisions: {
      count: revisionRows.length,
      groups: [...groups.values()].sort(
        (a, b) =>
          b.count - a.count || compareText(a.ticker, b.ticker) || compareText(a.source, b.source),
      ),
      largest: lines.slice(0, REVISIONS_LISTED),
      readjustments,
    },
    quota: { complete: utcOver && w.firstDay >= keptFrom, utcOver, keptFrom, providers: quota },
    forward: { chain, versions, annotations },
    runs: {
      groups: [...runGroups.values()].sort(
        (a, b) => compareText(a.jobType, b.jobType) || compareText(a.status, b.status),
      ),
      problems,
    },
    standIns: { ...standIns, unsettled },
  };
}

/** A day's class: green only when green overall and for every symbol; else its worst. */
function dayClass(d: DayReport): 'green' | 'yellow' | 'red' | 'notGraded' {
  if (d.green) return 'green';
  const statuses = [d.overall.status, ...d.symbols.map((s) => s.grade.status)];
  if (statuses.includes('red')) return 'red';
  if (statuses.includes('yellow')) return 'yellow';
  return 'notGraded';
}

/** new / old - 1, or null when it has no meaning (a missing value, or from 0). */
export function relativeChange(oldValue: number | null, newValue: number | null): number | null {
  if (oldValue === null || newValue === null) return null;
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue) || oldValue === 0) return null;
  return newValue / oldValue - 1;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// The verdict, the text and the alert

/** What needs attention, in words; empty when all is clear. */
export function auditIssues(r: AuditReport): string[] {
  const issues: string[] = [];
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (!r.days.known) issues.push('trading days not known');
  else {
    const { red, yellow, notGraded } = r.days.counts;
    if (red) issues.push(`${n(red, 'trading day', 'trading days')} red`);
    if (yellow) issues.push(`${n(yellow, 'trading day', 'trading days')} yellow`);
    if (notGraded) issues.push(`${n(notGraded, 'trading day', 'trading days')} not graded`);
  }
  const broken = chainProblems(r.forward.chain);
  if (broken) issues.push(`forward record chain problems in ${n(broken, 'item', 'items')}`);
  const missing = missingDays(r);
  if (missing) issues.push(`${n(missing, 'forward record day', 'forward record days')} missing`);
  if (r.runs.problems.length) {
    issues.push(`${n(r.runs.problems.length, 'run', 'runs')} failed or unfinished`);
  }
  if (!r.quota.complete) issues.push('quota use not fully known');
  const unknownLimits = r.quota.providers.filter((p) => !p.known && p.requests > 0).length;
  if (unknownLimits) {
    issues.push(`quota limits not known for ${n(unknownLimits, 'provider', 'providers')}`);
  }
  const over = r.quota.providers.filter((p) => p.over.length > 0).length;
  if (over) issues.push(`${n(over, 'provider', 'providers')} above 80% of a limit`);
  const unsettled = r.standIns.open + r.standIns.reopened;
  if (unsettled) issues.push(`${n(unsettled, 'stand-in', 'stand-ins')} open`);
  return issues;
}

const missingDays = (r: AuditReport) =>
  r.forward.versions.reduce((sum, v) => sum + (v.missing?.length ?? 0), 0);

export function auditVerdict(r: AuditReport): string {
  const issues = auditIssues(r);
  return issues.length === 0
    ? 'Verdict: all clear.'
    : `Verdict: needs attention (${issues.join(', ')}).`;
}

/** An ISO instant as `YYYY-MM-DD HH:MM` in the time zone. */
export function localTime(iso: string, timeZone: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** At most `max` lines of `items`, the rest counted exactly. */
function capped(items: string[], max: number, indent = '  '): string[] {
  return [
    ...items.slice(0, max).map((i) => `${indent}${i}`),
    ...(items.length > max ? [`${indent}... and ${items.length - max} more`] : []),
  ];
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** The report as text (the reasons in `t`'s language, the rest in English like `pnpm health`). */
export function auditText(t: Translate, r: AuditReport): string {
  const w = r.window;
  const tz = r.timeZone;
  const out: string[] = [
    `Audit report for ${w.month} (${tz}: ${localTime(w.from, tz)} to ${localTime(w.to, tz)}; ` +
      `trading days dated ${w.firstDay} to ${w.lastDay} in New York).`,
    '',
    '1. Days by grade',
  ];
  if (!r.days.known) out.push(`Not known: ${r.days.why}`);
  else {
    const c = r.days.counts;
    out.push(
      `Trading days: ${r.days.report.length}. Green ${c.green}, yellow ${c.yellow}, red ${c.red}, ` +
        `not graded ${c.notGraded}.`,
    );
    for (const d of r.days.report) if (!d.green) out.push(...describeDay(t, d));
  }

  out.push('', '2. Revisions');
  const rv = r.revisions;
  out.push(`Bar values revised (detected in the month): ${rv.count}.`);
  for (const g of rv.groups) out.push(`  ${g.ticker}  ${g.source}  ${g.count}`);
  if (rv.largest.length) {
    out.push(
      `Largest relative changes (at most ${REVISIONS_LISTED}; a value added, removed or from 0 first):`,
    );
    for (const l of rv.largest) {
      const change =
        l.change !== null
          ? `${l.change >= 0 ? '+' : ''}${(100 * l.change).toPrecision(3)}%`
          : l.oldValue === null
            ? 'value added'
            : l.newValue === null
              ? 'value removed'
              : 'from 0';
      out.push(
        `  ${l.ticker} ${l.date} ${l.field}@${l.source}: ${fmt(l.oldValue)} -> ${fmt(l.newValue)} (${change})`,
      );
    }
  }
  out.push(`Re-adjustments (detected in the month): ${rv.readjustments.length}.`);
  out.push(
    ...capped(
      rv.readjustments.map(
        (a) =>
          `${a.ticker} ${a.source} ${a.fromDate}..${a.toDate} factor ${fmt(a.factor)} ` +
          `(detected ${localTime(a.detectedAt, tz)})`,
      ),
      LISTED,
    ),
  );

  out.push('', '3. Quota use per provider (UTC days, from the provider ledger)');
  if (!r.quota.utcOver) {
    out.push(
      `The month's last UTC day is not over yet (until ${localTime(`${addMonths(w.month, 1)}-01T00:00:00.000Z`, tz)} ` +
        `${tz}), so the counts below are partial: at least these.`,
    );
  }
  if (w.firstDay < r.quota.keptFrom) {
    out.push(
      `The ledger keeps days from ${r.quota.keptFrom} for sure; earlier days of the month may be ` +
        'gone, so the counts below are at least these.',
    );
  }
  const atLeast = r.quota.complete ? '' : 'at least ';
  if (r.quota.providers.length === 0) out.push('No provider declares limits or sent requests.');
  for (const p of r.quota.providers) {
    const parts = [
      `${atLeast}${p.requests} ${p.requests === 1 ? 'request' : 'requests'} on ${p.days} ${p.days === 1 ? 'day' : 'days'}`,
    ];
    if (p.peak) {
      const perDay = p.limits?.perDay;
      parts.push(
        `peak ${p.peak.day} with ${p.peak.requests}` +
          (perDay !== undefined ? ` (${pct(p.peak.requests / perDay)} of ${perDay} a day)` : ''),
      );
    }
    const perMonth = p.limits?.symbolsPerMonth;
    parts.push(
      `${atLeast}${p.symbols} ${p.symbols === 1 ? 'symbol' : 'symbols'}` +
        (perMonth !== undefined ? ` (${pct(p.symbols / perMonth)} of ${perMonth} a month)` : ''),
    );
    if (!p.known) parts.push('limits not known (no loaded plug-in uses this provider id)');
    else if (p.limits?.perDay === undefined && p.limits?.symbolsPerMonth === undefined) {
      parts.push('no daily or monthly symbol limit declared');
    }
    if (p.over.length) parts.push(`ABOVE 80% of the ${p.over.join(' and ')} limit`);
    out.push(`  ${p.provider}: ${parts.join('; ')}.`);
  }
  out.push('Per-minute and per-hour use is kept for a day only and is not audited.');

  out.push('', '4. Forward records');
  const ch = r.forward.chain;
  const bad = chainProblems(ch);
  out.push(
    `Chain verification now: ${ch.versions.length} ${ch.versions.length === 1 ? 'version' : 'versions'}, ` +
      `${ch.anchors.length} ${ch.anchors.length === 1 ? 'anchor' : 'anchors'}; ` +
      (bad ? `${bad} with problems:` : 'all ok.'),
  );
  for (const v of ch.versions) {
    if (v.problems.length) out.push(`  ${v.name} (${v.id}): ${v.problems.join('; ')}`);
  }
  for (const a of ch.anchors) {
    if (a.problems.length)
      out.push(`  Anchor ${a.date} (${a.authority}): ${a.problems.join('; ')}`);
  }
  if (r.forward.versions.length === 0) out.push('No version recorded in the month.');
  else out.push('Entries dated in the month:');
  for (const v of r.forward.versions) {
    const s = v.statuses;
    const missing =
      v.missing === undefined
        ? r.days.known
          ? 'no entry yet'
          : 'missing days not known'
        : v.missing.length === 0
          ? 'no day missing'
          : `MISSING ${v.missing.length} (${v.missing.slice(0, 10).join(', ')}${v.missing.length > 10 ? ', ...' : ''})`;
    out.push(
      `  ${v.name} (${v.id}): ${v.entries} ${v.entries === 1 ? 'entry' : 'entries'} (green ${s.green}, ` +
        `yellow ${s.yellow}, red ${s.red}), ${v.safe} safe-state ${v.safe === 1 ? 'day' : 'days'}, ${missing}.`,
    );
  }
  out.push(
    `Annotations added in the month: ${
      r.forward.annotations.length
        ? r.forward.annotations.map((a) => `${a.kind} ${a.count}`).join(', ')
        : 'none'
    }.`,
  );

  out.push('', '5. Runs');
  if (r.runs.groups.length === 0) out.push('No run started in the month.');
  const byType = new Map<string, string[]>();
  for (const g of r.runs.groups) {
    byType.set(g.jobType, [...(byType.get(g.jobType) ?? []), `${g.status} ${g.count}`]);
  }
  for (const [type, list] of byType) out.push(`  ${type}: ${list.join(', ')}`);
  if (r.runs.problems.length) {
    out.push('Failed or unfinished:');
    out.push(
      ...capped(
        r.runs.problems.map(
          (p) =>
            `${localTime(p.startedAt, tz)} ${p.jobType}${p.target ? ` for ${p.target}` : ''}: ` +
            (p.status === 'running'
              ? 'never finished (interrupted, or still running)'
              : `${p.status}: ${p.error ?? 'no error stored'}`),
        ),
        LISTED,
      ),
    );
  }

  out.push('', '6. Stand-ins (dated in the month)');
  const si = r.standIns;
  out.push(
    `${si.count}: ${si.resolved} resolved, ${si.closed} closed, ${si.open} open, ${si.reopened} reopened.`,
  );
  if (si.unsettled.length) {
    out.push('Not settled:');
    out.push(
      ...capped(
        si.unsettled.map((s) => `${s.ticker} ${s.date}${s.reopened ? ' (reopened)' : ''}`),
        LISTED,
      ),
    );
  }

  out.push('', auditVerdict(r));
  return out.join('\n');
}

/** The command that prints a month's full report. */
export const auditCommand = (month: string) => `pnpm audit-report --month ${month}`;

/** The alert's short form: title, verdict, one count line per section, where the full report is. */
export function auditParts(t: Translate, r: AuditReport): Part[] {
  const month = r.window.month;
  const clear = auditIssues(r).length === 0;
  const over = r.quota.providers.filter((p) => p.over.length > 0).length;
  const broken = chainProblems(r.forward.chain);
  const v = r.forward.versions;
  const forward = {
    entries: v.reduce((n, x) => n + x.entries, 0),
    safe: v.reduce((n, x) => n + x.safe, 0),
    missing: missingDays(r),
    annotations: r.forward.annotations.reduce((n, a) => n + a.count, 0),
  };
  return [
    { keep: t('alerts.audit.title', { month }) },
    { keep: t(clear ? 'alerts.audit.clear' : 'alerts.audit.attention') },
    {
      keep: r.days.known
        ? t('alerts.audit.days', { ...r.days.counts })
        : t('alerts.audit.daysUnknown'),
    },
    {
      keep: t('alerts.audit.revisions', {
        revisions: r.revisions.count,
        readjustments: r.revisions.readjustments.length,
      }),
    },
    {
      keep: t(r.quota.complete ? 'alerts.audit.quota' : 'alerts.audit.quotaPartial', {
        over,
        providers: r.quota.providers.length,
      }),
    },
    {
      keep: t(broken ? 'alerts.audit.forwardBroken' : 'alerts.audit.forward', {
        ...forward,
        problems: broken,
      }),
    },
    {
      keep: t('alerts.audit.runs', {
        runs: r.runs.groups.reduce((n, g) => n + g.count, 0),
        failed: r.runs.problems.length,
      }),
    },
    {
      keep: t('alerts.audit.standIns', {
        count: r.standIns.count,
        resolved: r.standIns.resolved,
        closed: r.standIns.closed,
        open: r.standIns.open,
        reopened: r.standIns.reopened,
      }),
    },
    { keep: t('alerts.audit.full', { command: auditCommand(month) }) },
  ];
}
