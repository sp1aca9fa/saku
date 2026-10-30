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
// - The run's non-green health rows are grouped too, by (status, stored reason code, symbol or the
//   day), since a day can be red or yellow without a check result (parity refuses those days as
//   well). Only the reasons stored on this run's rows are used. A row stores its worst status, not
//   each reason's, so each reason's own status is derived (`reasonStatus`); one that cannot be
//   known is shown as "in a red/yellow row", never under a status it may not have.
// - Complete: a run is judged only when it succeeded and stored the overall row of its target
//   (verify stores the overall rows last, so that row means every row was stored). Otherwise its
//   green count is unknown and it is never "all green".
// - Results are shown as stored: nothing missing is turned into green. A full-history run stores
//   only its non-green results and the per-check counts (`check_summaries`), so its green count
//   comes from those counts and is unknown without them. Health rows (`data_health`) can be
//   non-green for reasons no check result carries (one source, a stand-in, series freshness), so
//   they are counted too and a run is "all green" only when neither has a non-green row.
import type { CheckLayer, HealthStatus, JobStatus, JobType, TradingDate } from '@saku/core';
import { worst } from '@saku/data';
import { type Db, schema } from '@saku/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  min,
  ne,
  sql,
} from 'drizzle-orm';
import { storedAny } from './health';
import { carriedReasonStatus } from './verify';

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
  /**
   * The reason's own status when `known`; otherwise the status of the rows it is on (the worst of
   * their reasons), shown as "in a red/yellow row".
   */
  status: HealthStatus;
  known: boolean;
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
  /** False when the per-check counts and the stored non-green results disagree. */
  countsAgree: boolean;
  /**
   * The run succeeded and stored the overall row of its target (so every row was stored); what
   * makes an incomplete run is in `incomplete`.
   */
  complete: boolean;
  incomplete?: 'not_success' | 'no_target' | 'no_target_row';
  /** Non-green health rows: overall (the day) and per symbol, by status. */
  health: {
    day: { red: number; yellow: number };
    symbol: { red: number; yellow: number };
  };
  groups: SummaryGroup[];
  /**
   * The non-green health rows grouped by (status, stored reason code, symbol or the day): a row
   * with several reasons counts once under each, with that reason's own status when it is known.
   */
  healthGroups: HealthGroup[];
  /**
   * True only when the run is complete, its counts agree, and it has no non-green check result
   * and no non-green health row (the exit code 0 of `pnpm health --summary`).
   */
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

/**
 * Health groups: red, then unknown in a red row, then yellow, then unknown in a yellow row; then
 * the larger count, then by reason and symbol.
 */
export function compareHealthGroups(a: HealthGroup, b: HealthGroup): number {
  const rank = (g: HealthGroup) =>
    (g.status === 'red' ? 0 : g.status === 'yellow' ? 2 : 4) + +!g.known;
  return (
    rank(a) - rank(b) || b.count - a.count || cmp(a.reason, b.reason) || cmp(a.symbol, b.symbol)
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

  // Complete: succeeded and stored the overall row of its target (stored last by verify).
  let incomplete: RunSummary['incomplete'];
  if (run.status !== 'success' || run.finishedAt === null) incomplete = 'not_success';
  else if (!run.target) incomplete = 'no_target';
  else {
    const [targetRow] = await db
      .select({ id: schema.dataHealth.id })
      .from(schema.dataHealth)
      .where(
        and(
          eq(schema.dataHealth.runId, run.id),
          eq(schema.dataHealth.date, run.target),
          isNull(schema.dataHealth.symbolId),
        ),
      )
      .limit(1);
    if (!targetRow) incomplete = 'no_target_row';
  }
  const complete = incomplete === undefined;

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
  // An incomplete run's green count is unknown (what it stored may be partial).
  let green: number | undefined;
  if (!complete) green = undefined;
  else if (run.jobType === 'daily') green = storedGreen?.n ?? 0;
  else if (hasSummaries) green = Number(s.passed);
  const summaryNonGreen = hasSummaries ? Number(s.checked) - Number(s.passed) : undefined;
  const countsAgree =
    summaryNonGreen === undefined || summaryNonGreen === nonGreen.red + nonGreen.yellow;

  // The run's own non-green health rows, with the reasons stored on them (nothing from other
  // runs: freshness merged from the run that targeted a date is `pnpm health`'s view, not this).
  const h = schema.dataHealth;
  const healthRows = await db
    .select({ date: h.date, symbolId: h.symbolId, status: h.status, reasons: h.reasons })
    .from(h)
    .where(and(eq(h.runId, run.id), ne(h.status, 'green')));
  const statusOf = await reasonStatuses(db, run.id, names, healthRows);
  const health = { day: { red: 0, yellow: 0 }, symbol: { red: 0, yellow: 0 } };
  const byReason = new Map<string, HealthGroup>();
  for (const row of healthRows) {
    health[row.symbolId === null ? 'day' : 'symbol'][row.status as 'red' | 'yellow']++;
    const symbol = row.symbolId === null ? DAY : (names.get(row.symbolId) ?? `#${row.symbolId}`);
    // A non-green row without a reason is shown as such, never dropped.
    const reasons = row.reasons.length > 0 ? new Set(row.reasons) : new Set([NO_REASON]);
    for (const reason of reasons) {
      const own = reason === NO_REASON ? undefined : statusOf(row, reason);
      const status = own ?? row.status;
      const known = own !== undefined;
      const key = JSON.stringify([status, known, reason, symbol]);
      const g = byReason.get(key);
      if (!g) {
        byReason.set(key, {
          status,
          known,
          reason,
          symbol,
          count: 1,
          first: row.date,
          last: row.date,
        });
        continue;
      }
      g.count++;
      if (row.date < g.first) g.first = row.date;
      if (row.date > g.last) g.last = row.date;
    }
  }
  const healthGroups = [...byReason.values()].sort(compareHealthGroups);

  return {
    nonGreen,
    ...(green !== undefined && { green }),
    ...(summaryNonGreen !== undefined && { summaryNonGreen }),
    countsAgree,
    complete,
    ...(incomplete && { incomplete }),
    health,
    groups,
    healthGroups,
    allGreen:
      complete && countsAgree && nonGreen.red + nonGreen.yellow === 0 && healthRows.length === 0,
  };
}

/** Reasons verify always grades with the same status (verify.ts, packages/data symbolHealth). */
function fixedStatus(code: string): HealthStatus | undefined {
  if (code === 'single_source' || code.startsWith('stand_in@')) return 'yellow';
  if (code === 'primary_missing' || code.startsWith('stand_in_refused:')) return 'red';
  if (code.startsWith('issuer_unavailable@') || code === 'issuer_nav_tolerance_invalid') {
    return 'yellow';
  }
  return undefined;
}

/**
 * Each stored reason's own status, from what the same run stored (a health row keeps only the
 * worst status of its reasons):
 * - fixed codes (single source and stand-ins yellow, a missing primary and a refused stand-in red,
 *   issuer data unavailable yellow) as verify grades them;
 * - series freshness and an FX cross-check that could not run: `carriedReasonStatus`;
 * - a check's code (`B.close_match@s`, on an overall row `USDJPY:B.fx_match@s`): the worst of the
 *   run's non-green results of that check, source, symbol (none on an overall row) and date;
 * - a symbol named on an overall row: that symbol's row of the run on that date.
 * Anything else, or no matching row: undefined (unknown, never guessed).
 */
async function reasonStatuses(
  db: Db,
  runId: string,
  names: Map<number, string>,
  rows: { date: TradingDate; symbolId: number | null; status: HealthStatus }[],
) {
  const r = schema.checkResults;
  const results = new Map<string, HealthStatus>();
  for (const x of await db
    .select({
      date: r.date,
      symbolId: r.symbolId,
      layer: r.layer,
      check: r.checkName,
      source: r.source,
      status: r.status,
    })
    .from(r)
    .where(and(eq(r.runId, runId), inArray(r.status, NON_GREEN)))) {
    const key = JSON.stringify([x.date, x.symbolId, reasonCode(x)]);
    const prev = results.get(key);
    results.set(key, prev ? worst(prev, x.status) : x.status);
  }
  const symbolRows = new Map<string, HealthStatus>();
  for (const x of rows) {
    if (x.symbolId !== null) symbolRows.set(JSON.stringify([x.date, x.symbolId]), x.status);
  }
  const ids = new Map([...names].map(([id, ticker]) => [ticker, id]));
  return (row: { date: TradingDate; symbolId: number | null }, code: string) => {
    const fixed = fixedStatus(code);
    if (fixed) return fixed;
    if (row.symbolId === null) {
      const carried = carriedReasonStatus(code);
      if (carried) return carried;
      const m = /^[^:@\s]+:([A-E]\.\w+(?:@.+)?)$/.exec(code);
      if (m) return results.get(JSON.stringify([row.date, null, m[1]]));
      const id = ids.get(code);
      return id === undefined ? undefined : symbolRows.get(JSON.stringify([row.date, id]));
    }
    if (/^[A-E]\.\w+(?:@.+)?$/.test(code)) {
      return results.get(JSON.stringify([row.date, row.symbolId, code]));
    }
    return undefined;
  };
}

/**
 * Whether the run graded a symbol (or the day, `null`), and the dates it graded: a full-history
 * run's `health_coverage` for a symbol; otherwise (a daily run, or the day) its stored health
 * rows. Undefined: not graded by this run.
 */
export async function gradedRange(
  db: Db,
  run: SummaryRun,
  symbolId: number | null,
): Promise<{ from: TradingDate; to: TradingDate } | undefined> {
  if (symbolId !== null && FULL.includes(run.jobType)) {
    const [c] = await db
      .select()
      .from(schema.healthCoverage)
      .where(
        and(eq(schema.healthCoverage.runId, run.id), eq(schema.healthCoverage.symbolId, symbolId)),
      );
    return c && { from: c.fromDate, to: c.toDate };
  }
  const h = schema.dataHealth;
  const [range] = await db
    .select({ from: min(h.date), to: max(h.date) })
    .from(h)
    .where(
      and(eq(h.runId, run.id), symbolId === null ? isNull(h.symbolId) : eq(h.symbolId, symbolId)),
    );
  return range?.from && range.to ? { from: range.from, to: range.to } : undefined;
}

/** The sources of a check's stored results in the run (any status), sorted; none as `null`. */
export async function checkSources(
  db: Db,
  runId: string,
  check: string,
): Promise<(string | null)[]> {
  const r = schema.checkResults;
  const rows = await db
    .selectDistinct({ source: r.source })
    .from(r)
    .where(and(eq(r.runId, runId), eq(r.checkName, check)));
  return rows.map((x) => x.source).sort((a, b) => cmp(a ?? '', b ?? ''));
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
