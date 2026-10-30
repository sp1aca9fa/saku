// The data-health summary of one run (requirements 04, layer H "data-health report"; stage A3,
// and A1 "every failure explained"): the run's stored non-green check results grouped by
// (status, layer, check, symbol or the day, source) with counts and date ranges, and the dates of
// one group. Read-only.
//
// - The unit is one run's stored check results (not the per-date deciding run of `pnpm health`):
//   the question is "what did this check find", and a run is what the parity refusal
//   (docs/parity.md) and the Tier 0 data review read.
// - Default run: the latest (by start) finished bootstrap, weekly or checks run that names its
//   target and stored something, the same runs `pnpm health` counts (jobs/health.ts). A run still
//   going has not stored all its rows; a run that stored nothing graded nothing.
// - The run's non-green health rows are grouped too, by (row status, stored reason code, symbol or
//   the day), since a day can be red or yellow without a check result (parity refuses those days
//   as well). Only the reasons stored on this run's rows are used.
// - Results are shown as stored: nothing missing is turned into green. A full-history run stores
//   only its non-green results and the per-check counts (`check_summaries`), so its green count
//   comes from those counts and is unknown without them. Health rows (`data_health`) can be
//   non-green for reasons no check result carries (one source, a stand-in, series freshness), so
//   they are counted too and a run is "all green" only when neither has a non-green row.
import type { CheckLayer, HealthStatus, JobStatus, JobType, TradingDate } from '@saku/core';
import { type Db, schema } from '@saku/db';
import { and, asc, count, desc, eq, inArray, isNotNull, max, min, ne, sql } from 'drizzle-orm';
import { storedAny } from './health';

const FULL: JobType[] = ['bootstrap', 'weekly', 'checks'];
const NON_GREEN: HealthStatus[] = ['red', 'yellow'];
/** The label of a result or health row that is about the day, not a symbol (FX, series). */
export const DAY = 'day';
/** At most this many dates are listed for one group. */
export const DATE_CAP = 200;

export interface SummaryRun {
  id: string;
  jobType: JobType;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  target?: TradingDate;
  error: string | null;
}

export interface SummaryGroup {
  status: HealthStatus;
  layer: CheckLayer;
  check: string;
  /** The symbol's ticker, or `DAY` for results about the day (FX checks). */
  symbol: string;
  source: string | null;
  count: number;
  first: TradingDate;
  last: TradingDate;
}

export interface HealthGroup {
  /** The status of the rows (the worst of their reasons). */
  status: HealthStatus;
  /** A reason code as stored on the rows (`NO_REASON` for a non-green row without one). */
  reason: string;
  /** The symbol's ticker, or `DAY` for the overall rows. */
  symbol: string;
  count: number;
  first: TradingDate;
  last: TradingDate;
}

/** The reason of a non-green health row that stored none (shown, never dropped). */
export const NO_REASON = '';

export interface RunSummary {
  /** Stored non-green check results by status. */
  nonGreen: { red: number; yellow: number };
  /**
   * Green check results: stored ones for a daily run (it stores every result), else the run's
   * per-check counts; undefined when neither tells (never taken as 0).
   */
  green?: number;
  /** Non-green results by the per-check counts, when the run stored them (a cross-check). */
  summaryNonGreen?: number;
  /** Non-green health rows: overall (the day) and per symbol, by status. */
  health: {
    day: { red: number; yellow: number };
    symbol: { red: number; yellow: number };
  };
  groups: SummaryGroup[];
  /**
   * The non-green health rows grouped by (row status, stored reason code, symbol or the day): a
   * row with several reasons counts once under each, under the row's status (the status of the
   * row, not of that reason alone, which is not stored).
   */
  healthGroups: HealthGroup[];
  /** True only when the run has no non-green check result and no non-green health row. */
  allGreen: boolean;
}

function toRun(r: typeof schema.jobRuns.$inferSelect): SummaryRun {
  const target = r.datesProcessed?.[0];
  return {
    id: r.id,
    jobType: r.jobType,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    ...(target && { target }),
    error: r.error,
  };
}

/** The latest finished full-history run that names its target and stored something, or none. */
export async function defaultSummaryRun(db: Db): Promise<SummaryRun | undefined> {
  const rows = await db
    .select()
    .from(schema.jobRuns)
    .where(and(isNotNull(schema.jobRuns.finishedAt), inArray(schema.jobRuns.jobType, FULL)))
    .orderBy(desc(schema.jobRuns.startedAt));
  for (const r of rows) {
    if (!r.datesProcessed?.[0]) continue;
    if (await storedAny(db, r.id)) return toRun(r);
  }
  return undefined;
}

/** A run by id (any type or state), or none. */
export async function findRun(db: Db, id: string): Promise<SummaryRun | undefined> {
  const [row] = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, id));
  return row && toRun(row);
}

/** Group order: red first, then the larger count, then by layer, check, symbol and source. */
export function compareGroups(a: SummaryGroup, b: SummaryGroup): number {
  const rank = (s: HealthStatus) => (s === 'red' ? 0 : s === 'yellow' ? 1 : 2);
  return (
    rank(a.status) - rank(b.status) ||
    b.count - a.count ||
    cmp(a.layer, b.layer) ||
    cmp(a.check, b.check) ||
    cmp(a.symbol, b.symbol) ||
    cmp(a.source ?? '', b.source ?? '')
  );
}

/** Health groups: red first, then the larger count, then by reason and symbol. */
export function compareHealthGroups(a: HealthGroup, b: HealthGroup): number {
  const rank = (s: HealthStatus) => (s === 'red' ? 0 : s === 'yellow' ? 1 : 2);
  return (
    rank(a.status) - rank(b.status) ||
    b.count - a.count ||
    cmp(a.reason, b.reason) ||
    cmp(a.symbol, b.symbol)
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function tickers(db: Db): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: schema.symbols.id, ticker: schema.symbols.ticker })
    .from(schema.symbols);
  return new Map(rows.map((r) => [r.id, r.ticker]));
}

export async function runSummary(db: Db, run: SummaryRun): Promise<RunSummary> {
  const r = schema.checkResults;
  const names = await tickers(db);
  const grouped = await db
    .select({
      status: r.status,
      layer: r.layer,
      check: r.checkName,
      symbolId: r.symbolId,
      source: r.source,
      count: count(),
      first: min(r.date),
      last: max(r.date),
    })
    .from(r)
    .where(and(eq(r.runId, run.id), inArray(r.status, NON_GREEN)))
    .groupBy(r.status, r.layer, r.checkName, r.symbolId, r.source);
  const groups: SummaryGroup[] = grouped.map((g) => ({
    status: g.status,
    layer: g.layer,
    check: g.check,
    symbol: g.symbolId === null ? DAY : (names.get(g.symbolId) ?? `#${g.symbolId}`),
    source: g.source,
    count: g.count,
    first: g.first!,
    last: g.last!,
  }));
  groups.sort(compareGroups);

  const nonGreen = { red: 0, yellow: 0 };
  for (const g of groups) nonGreen[g.status as 'red' | 'yellow'] += g.count;

  const [storedGreen] = await db
    .select({ n: count() })
    .from(r)
    .where(and(eq(r.runId, run.id), eq(r.status, 'green')));
  const summaries = await db
    .select({
      checked: sql<number>`sum(${schema.checkSummaries.checked})`,
      passed: sql<number>`sum(${schema.checkSummaries.passed})`,
      n: count(),
    })
    .from(schema.checkSummaries)
    .where(eq(schema.checkSummaries.runId, run.id));
  const s = summaries[0];
  const hasSummaries = !!s && s.n > 0;
  // Daily runs store every result of their window; full-history runs only the non-green ones.
  let green: number | undefined;
  if (run.jobType === 'daily') green = storedGreen?.n ?? 0;
  else if (hasSummaries) green = Number(s.passed);

  // The run's own non-green health rows, with the reasons stored on them (nothing from other
  // runs: freshness merged from the run that targeted a date is `pnpm health`'s view, not this).
  const h = schema.dataHealth;
  const healthRows = await db
    .select({ date: h.date, symbolId: h.symbolId, status: h.status, reasons: h.reasons })
    .from(h)
    .where(and(eq(h.runId, run.id), ne(h.status, 'green')));
  const health = { day: { red: 0, yellow: 0 }, symbol: { red: 0, yellow: 0 } };
  const byReason = new Map<string, HealthGroup>();
  for (const row of healthRows) {
    const status = row.status as 'red' | 'yellow';
    health[row.symbolId === null ? 'day' : 'symbol'][status]++;
    const symbol = row.symbolId === null ? DAY : (names.get(row.symbolId) ?? `#${row.symbolId}`);
    // A non-green row without a reason is shown as such, never dropped.
    const reasons = row.reasons.length > 0 ? new Set(row.reasons) : new Set([NO_REASON]);
    for (const reason of reasons) {
      const key = JSON.stringify([status, reason, symbol]);
      const g = byReason.get(key);
      if (!g) {
        byReason.set(key, { status, reason, symbol, count: 1, first: row.date, last: row.date });
        continue;
      }
      g.count++;
      if (row.date < g.first) g.first = row.date;
      if (row.date > g.last) g.last = row.date;
    }
  }
  const healthGroups = [...byReason.values()].sort(compareHealthGroups);

  const anyHealth = healthRows.length;
  return {
    nonGreen,
    ...(green !== undefined && { green }),
    ...(hasSummaries && { summaryNonGreen: Number(s.checked) - Number(s.passed) }),
    health,
    groups,
    healthGroups,
    allGreen: nonGreen.red + nonGreen.yellow === 0 && anyHealth === 0,
  };
}

export interface GroupFilter {
  check: string;
  /** The symbol's id, or null for the results about the day; undefined: every symbol and the day. */
  symbolId?: number | null;
  source?: string;
}

export interface DateRow {
  date: TradingDate;
  status: HealthStatus;
  layer: CheckLayer;
  symbol: string;
  source: string | null;
  observed: number | null;
  expected: number | null;
  tolerance: number | null;
  message: string | null;
}

/** Whether the run has any result (or per-check count) of a check by this name. */
export async function runHasCheck(db: Db, runId: string, check: string): Promise<boolean> {
  const [result] = await db
    .select({ runId: schema.checkResults.runId })
    .from(schema.checkResults)
    .where(and(eq(schema.checkResults.runId, runId), eq(schema.checkResults.checkName, check)))
    .limit(1);
  if (result) return true;
  const [summary] = await db
    .select({ runId: schema.checkSummaries.runId })
    .from(schema.checkSummaries)
    .where(and(eq(schema.checkSummaries.runId, runId), eq(schema.checkSummaries.checkName, check)))
    .limit(1);
  return !!summary;
}

/** The names of the checks with a non-green result in the run, sorted. */
export async function nonGreenChecks(db: Db, runId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ check: schema.checkResults.checkName })
    .from(schema.checkResults)
    .where(
      and(eq(schema.checkResults.runId, runId), inArray(schema.checkResults.status, NON_GREEN)),
    );
  return rows.map((r) => r.check).sort(cmp);
}

/**
 * The non-green results of one group, by date (then symbol, source and layer), at most `cap`
 * rows; `total` counts them all.
 */
export async function groupDates(
  db: Db,
  runId: string,
  f: GroupFilter,
  cap = DATE_CAP,
): Promise<{ rows: DateRow[]; total: number }> {
  const r = schema.checkResults;
  const where = and(
    eq(r.runId, runId),
    eq(r.checkName, f.check),
    inArray(r.status, NON_GREEN),
    f.symbolId === undefined
      ? undefined
      : f.symbolId === null
        ? sql`${r.symbolId} is null`
        : eq(r.symbolId, f.symbolId),
    f.source === undefined ? undefined : eq(r.source, f.source),
  );
  const [total] = await db.select({ n: count() }).from(r).where(where);
  const names = await tickers(db);
  const rows = await db
    .select()
    .from(r)
    .where(where)
    .orderBy(asc(r.date), asc(r.symbolId), asc(r.source), asc(r.layer), asc(r.id))
    .limit(cap);
  return {
    total: total?.n ?? 0,
    rows: rows.map((x) => ({
      date: x.date,
      status: x.status,
      layer: x.layer,
      symbol: x.symbolId === null ? DAY : (names.get(x.symbolId) ?? `#${x.symbolId}`),
      source: x.source,
      observed: x.observed,
      expected: x.expected,
      tolerance: x.tolerance,
      message: x.message,
    })),
  };
}

/** The reason code of a check result, as the health rows name it (`B.close_match@source`). */
export function reasonCode(g: { layer: CheckLayer; check: string; source: string | null }) {
  return `${g.layer}.${g.check}${g.source ? `@${g.source}` : ''}`;
}

/** The latest runs of any kind (by start), for the message refusing an unknown run id. */
export async function recentRuns(db: Db, limit: number): Promise<SummaryRun[]> {
  const rows = await db
    .select()
    .from(schema.jobRuns)
    .orderBy(desc(schema.jobRuns.startedAt))
    .limit(limit);
  return rows.map(toRun);
}
