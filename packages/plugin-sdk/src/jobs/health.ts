// The data-health report (requirements 04, layer H "daily data-health report"; stage A3): what
// was not green on each trading date, overall and per symbol, as the latest run that covered the
// date graded it. Read-only.
//
// Which run decides a date (docs/data-pipeline.md "Data health"; what `verify` stores):
// - Only finished runs that name their target (`dates_processed[0]`) count; a run still going
//   (or interrupted) has not stored all its rows, and its window is not known.
// - A daily run covers `DAILY_OVERLAP` sessions before its target through the target, and stores
//   every row there: a stored row is the grade, no row is "not graded".
// - A bootstrap, weekly or checks run (full history) covers every date up to its target. It stores
//   the overall row of every date it graded (green included) and only the non-green symbol rows:
//   no overall row is "not graded"; with the overall row, a missing symbol row is green, unless a
//   non-green check result of that run for that symbol and day lacks its row (then verify did not
//   grade the symbol). Verify stores the overall rows after every symbol row, so an overall row
//   means the symbol rows were all stored. Full runs from before verify stored green overall rows
//   read as "not graded" until the next one.
// - The latest such run (by start) decides the date, so a later full-history run that found a
//   day green overrides an older daily yellow or red; an older grade is never shown over it.
// - A symbol before its first canonical bar is not part of the day (verify grades from there),
//   unless its inception date says it should have data: then it is "not graded". An active
//   symbol with no canonical bar at all is "not graded".
// Unknown stays unknown: nothing here turns a missing grade into green.
import type { HealthStatus, JobType, TradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import { type Db, schema } from '@saku/db';
import { and, desc, eq, inArray, isNotNull, min } from 'drizzle-orm';
import { DAILY_OVERLAP } from './ingest';

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

/** Finished runs that graded a window, latest first. */
async function coveringRuns(db: Db, sessions: Sessions): Promise<Covering[]> {
  const rows = await db
    .select()
    .from(schema.jobRuns)
    .where(isNotNull(schema.jobRuns.finishedAt))
    .orderBy(desc(schema.jobRuns.startedAt));
  const out: Covering[] = [];
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
      out.push({ id: r.id, jobType: r.jobType, target, from });
    } else if (FULL.includes(r.jobType)) {
      out.push({ id: r.id, jobType: r.jobType, target });
    }
  }
  return out;
}

/** The latest date a finished run graded (its target), or none. */
export async function latestGradedDate(
  db: Db,
  sessions: Sessions,
): Promise<TradingDate | undefined> {
  const runs = await coveringRuns(db, sessions);
  return runs.map((r) => r.target).sort((a, b) => (a < b ? 1 : -1))[0];
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
  const runs = await coveringRuns(db, o.sessions);
  const symbols = await db.select().from(schema.symbols);
  const ticker = new Map(symbols.map((s) => [s.id, s.ticker]));
  const firstBar = new Map(
    (
      await db
        .select({ symbolId: schema.bars.symbolId, first: min(schema.bars.date) })
        .from(schema.bars)
        .groupBy(schema.bars.symbolId)
    ).map((r) => [r.symbolId, r.first!]),
  );

  const out: DayReport[] = [];
  for (const date of o.dates) {
    const run = runs.find((r) => (r.from === undefined || r.from <= date) && date <= r.target);
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
    const grade = (row: (typeof rows)[number]): Grade => ({
      status: row.status,
      reasons: row.reasons,
    });

    const overallRow = rows.find((r) => r.symbolId === null);
    const overall = overallRow ? grade(overallRow) : NOT_GRADED;
    // A full-history run's missing symbol row is green only on a date it graded.
    const silentIsGreen = full && overallRow !== undefined;

    const listed: DayReport['symbols'] = [];
    const candidates = new Set([
      ...symbols.filter((s) => s.active).map((s) => s.id),
      ...rows.flatMap((r) => (r.symbolId === null ? [] : [r.symbolId])),
    ]);
    for (const id of candidates) {
      const s = symbols.find((x) => x.id === id)!;
      const row = rows.find((r) => r.symbolId === id);
      let g: Grade;
      if (row) g = grade(row);
      else {
        const first = firstBar.get(id);
        if (first !== undefined && date < first) {
          // Not yet in its history; "not graded" when its inception says data should exist.
          if (!s.inceptionDate || date < s.inceptionDate) continue;
          g = NOT_GRADED;
        } else if (first !== undefined && silentIsGreen && !flagged.has(id)) {
          g = { status: 'green', reasons: [] };
        } else g = NOT_GRADED;
      }
      if (g.status !== 'green') listed.push({ ticker: ticker.get(id)!, grade: g });
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
