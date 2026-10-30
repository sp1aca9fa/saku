// The data-health report (requirements 04, layer H "daily data-health report"; stage A3): what
// was not green on each trading date, overall and per symbol, as the latest run that covered the
// date graded it. Read-only.
//
// Which run decides a date (docs/data-pipeline.md "Data health"; what `verify` stores):
// - Only finished runs that name their target (`dates_processed[0]`) and stored something (a
//   health row, a check result or a summary) count: a run still going has not stored all its
//   rows and its window is not known; a run that failed before storing anything graded nothing
//   and does not blank older grades.
// - A daily run covers `DAILY_OVERLAP` sessions before its target through the target, and stores
//   every row there: a stored row is the grade, no row is "not graded".
// - A bootstrap, weekly or checks run (full history) covers every date up to its target. It stores
//   the overall row of every date it graded (green included), only the non-green symbol rows, and
//   each symbol's graded range (`health_coverage`): no overall row is "not graded"; a missing
//   symbol row is green only inside that symbol's range for that run, and not graded outside it
//   or when a non-green check result of that run for that symbol and day lacks its row. Verify
//   stores the coverage, then the symbol rows, then the overall rows, so an overall row means the
//   rest is stored. Full runs from before the coverage existed read "not graded" for every symbol
//   without a row until the next full run.
// - The latest such run (by start) decides the date, so a later full-history run that found a
//   day green overrides an older daily yellow or red; an older grade is never shown over it.
// - Series freshness (the cash rate, each fund's index, the base-currency FX pair) is graded only
//   on a run's own target. For a date the deciding run did not target, the freshness reasons and
//   the FX cross-checks that could not run (`fx_unavailable`) of the latest counted run that
//   targeted it are merged into the overall grade (status from the reason), so a day graded for
//   them (what the forward record acted on) never reads green later.
// - A symbol before its first canonical bar is not part of the day (verify grades from there),
//   unless its inception date says it should have data: then it is "not graded". An active
//   symbol with no canonical bar at all is "not graded" unless the run graded it.
// Unknown stays unknown: nothing here turns a missing grade into green.
import type { HealthStatus, JobType, TradingDate } from '@saku/core';
import { type Sessions, worst } from '@saku/data';
import { type Db, schema } from '@saku/db';
import { and, desc, eq, inArray, isNotNull, isNull, min } from 'drizzle-orm';
import { DAILY_OVERLAP } from './ingest';
import { carriedReasonStatus } from './verify';

export type Grade =
  { status: HealthStatus; reasons: string[] } | { status: 'not_graded'; reasons: [] };

export interface ReportRun {
  id: string;
  jobType: JobType;
  target: TradingDate;
}

export interface DayReport {
  date: TradingDate;
  overall: Grade;
  /** Symbols not green that day ("not graded" included), by ticker. */
  symbols: { ticker: string; grade: Grade }[];
  /** The run whose grades these are; none when no run covered the date. */
  run?: ReportRun;
  /** Green overall and every symbol graded green: the only state that counts as green. */
  green: boolean;
}

const NOT_GRADED: Grade = { status: 'not_graded', reasons: [] };
const FULL: JobType[] = ['bootstrap', 'weekly', 'checks'];

interface Covering extends ReportRun {
  /** Daily runs: the first date of their window; full-history runs: none (the whole history). */
  from?: TradingDate;
}

/** Whether a run stored anything (a run that failed before storing graded nothing). */
export async function storedAny(db: Db, runId: string): Promise<boolean> {
  for (const table of [schema.checkResults, schema.checkSummaries, schema.dataHealth]) {
    const [row] = await db
      .select({ runId: table.runId })
      .from(table)
      .where(eq(table.runId, runId))
      .limit(1);
    if (row) return true;
  }
  return false;
}

/**
 * Finished runs with a target, latest first; each is checked for stored rows only when asked
 * (`counts`), since only the latest few usually matter.
 */
async function finishedRuns(db: Db, sessions: Sessions) {
  const rows = await db
    .select()
    .from(schema.jobRuns)
    .where(isNotNull(schema.jobRuns.finishedAt))
    .orderBy(desc(schema.jobRuns.startedAt));
  const runs: Covering[] = [];
  for (const r of rows) {
    const target = r.datesProcessed?.[0];
    if (!target) continue;
    if (r.jobType === 'daily') {
      let from: TradingDate;
      try {
        from = sessions.before(target, DAILY_OVERLAP);
      } catch {
        continue; // Outside the calendar: the run could not have graded its window either.
      }
      runs.push({ id: r.id, jobType: r.jobType, target, from });
    } else if (FULL.includes(r.jobType)) {
      runs.push({ id: r.id, jobType: r.jobType, target });
    }
  }
  const known = new Map<string, boolean>();
  const counts = async (run: Covering) => {
    let stored = known.get(run.id);
    if (stored === undefined) {
      stored = await storedAny(db, run.id);
      known.set(run.id, stored);
    }
    return stored;
  };
  /** The latest counted run matching `test`. */
  const latest = async (test: (r: Covering) => boolean) => {
    for (const r of runs) if (test(r) && (await counts(r))) return r;
    return undefined;
  };
  return { latest };
}

/** The latest date a counted run graded (its target), or none. */
export async function latestGradedDate(
  db: Db,
  sessions: Sessions,
): Promise<TradingDate | undefined> {
  const { latest } = await finishedRuns(db, sessions);
  let best: TradingDate | undefined;
  // Runs are by start; the targets need not be in order (a checks run for an older date).
  while (true) {
    const r = await latest((x) => best === undefined || x.target > best);
    if (!r) return best;
    best = r.target;
  }
}

/** The latest run of any kind (also one still going), for the report's header. */
export async function latestRun(db: Db) {
  const [row] = await db
    .select()
    .from(schema.jobRuns)
    .orderBy(desc(schema.jobRuns.startedAt))
    .limit(1);
  return row;
}

export async function healthReport(
  db: Db,
  o: { dates: TradingDate[]; sessions: Sessions },
): Promise<DayReport[]> {
  const { latest } = await finishedRuns(db, o.sessions);
  const symbols = await db.select().from(schema.symbols);
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const firstBar = new Map(
    (
      await db
        .select({ symbolId: schema.bars.symbolId, first: min(schema.bars.date) })
        .from(schema.bars)
        .groupBy(schema.bars.symbolId)
    ).flatMap((r) => (r.first ? [[r.symbolId, r.first] as const] : [])),
  );
  const coverageOf = async (runId: string) =>
    new Map(
      (
        await db.select().from(schema.healthCoverage).where(eq(schema.healthCoverage.runId, runId))
      ).map((c) => [c.symbolId, c]),
    );
  const overallRowOf = async (runId: string, date: TradingDate) =>
    (
      await db
        .select()
        .from(schema.dataHealth)
        .where(
          and(
            eq(schema.dataHealth.runId, runId),
            eq(schema.dataHealth.date, date),
            isNull(schema.dataHealth.symbolId),
          ),
        )
    )[0];

  const out: DayReport[] = [];
  for (const date of o.dates) {
    const run = await latest((r) => (r.from === undefined || r.from <= date) && date <= r.target);
    if (!run) {
      out.push({ date, overall: NOT_GRADED, symbols: [], green: false });
      continue;
    }
    const full = run.from === undefined;
    const rows = await db
      .select()
      .from(schema.dataHealth)
      .where(and(eq(schema.dataHealth.runId, run.id), eq(schema.dataHealth.date, date)));
    // Symbols with a non-green check result that day.
    const flagged = new Set(
      (
        await db
          .select({ symbolId: schema.checkResults.symbolId })
          .from(schema.checkResults)
          .where(
            and(
              eq(schema.checkResults.runId, run.id),
              eq(schema.checkResults.date, date),
              inArray(schema.checkResults.status, ['yellow', 'red']),
            ),
          )
      ).map((r) => r.symbolId),
    );
    const coverage = full ? await coverageOf(run.id) : new Map<number, never>();
    const grade = (row: { status: HealthStatus; reasons: string[] }): Grade => ({
      status: row.status,
      reasons: [...row.reasons],
    });

    const overallRow = rows.find((r) => r.symbolId === null);
    let overall = overallRow ? grade(overallRow) : NOT_GRADED;
    if (overall.status !== 'not_graded' && run.target !== date) {
      // Series freshness as the run that targeted this date graded it (only that run did).
      const own = await latest((r) => r.target === date);
      const row = own && (await overallRowOf(own.id, date));
      for (const code of row?.reasons ?? []) {
        const status = carriedReasonStatus(code);
        if (!status || overall.reasons.includes(code)) continue;
        overall = { status: worst(overall.status, status), reasons: [...overall.reasons, code] };
      }
    }

    const listed: DayReport['symbols'] = [];
    const candidates = new Set([
      ...symbols.filter((s) => s.active).map((s) => s.id),
      ...rows.flatMap((r) => (r.symbolId === null ? [] : [r.symbolId])),
      ...coverage.keys(),
    ]);
    for (const id of candidates) {
      const s = byId.get(id)!;
      const row = rows.find((r) => r.symbolId === id);
      const range = coverage.get(id);
      let g: Grade;
      if (row) g = grade(row);
      else if (
        full &&
        overallRow &&
        range &&
        range.fromDate <= date &&
        date <= range.toDate &&
        !flagged.has(id)
      ) {
        g = { status: 'green', reasons: [] };
      } else {
        const first = firstBar.get(id);
        const beforeInception = !!s.inceptionDate && date < s.inceptionDate;
        // Not yet in its history: not part of the day, unless its inception says data should
        // exist (then not graded). With no bar at all, a date before its inception is skipped.
        const beforeHistory = first !== undefined && date < first;
        if (
          (beforeHistory && (!s.inceptionDate || beforeInception)) ||
          (first === undefined && beforeInception)
        ) {
          continue;
        }
        g = NOT_GRADED;
      }
      if (g.status !== 'green') listed.push({ ticker: s.ticker, grade: g });
    }
    listed.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
    out.push({
      date,
      overall,
      symbols: listed,
      run: { id: run.id, jobType: run.jobType, target: run.target },
      green: overall.status === 'green' && listed.length === 0,
    });
  }
  return out;
}
