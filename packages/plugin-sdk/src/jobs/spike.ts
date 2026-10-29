// The A1 gate (stage-a, pre-registered), over every NYSE session in the range (from the
// calendar), not only the sessions that had a run:
//   - the primary succeeds on every trading day (after retries);
//   - at least one secondary is available on >= 95% of days;
//   - layer B passes on >= 99% of days where a secondary was available;
//   - layer C passes on >= 99% of days;
//   - every failure explained (the non-green results are listed for that).
// How each session is measured (docs/data-pipeline.md "Gate counting"):
//   - Only daily runs that finished (success or failed) and stored check results for the date
//     count. A failed run (incomplete, e.g. a secondary down) counts by what it stored, so a
//     secondary's outage is measured as secondary availability, not as a primary failure.
//   - The primary and layer B: from the latest such run targeting the date. A secondary is
//     available when any such run targeting the date got its bars.
//   - Layer C: the day's own run's layer C results (what was decided on) all green, and the
//     index results for the date from the latest such run whose window (DAILY_OVERLAP sessions
//     before its target through the target) covers it all green, so the next run's index check
//     for the date counts and a failure at decision time is never dropped by a later correction.
//     A fund with an index and no index result for the date is not passed; it is pending while
//     no later finished run covering the date has stored results for it.
//   - A session without a run is failed everywhere (`no_run`), except the `open` session (the
//     daily target whose run window has not closed): pending while no run for it has finished.
//   - The verdict covers the sessions before the first pending one ("passed through <date>");
//     the later ones are listed, never counted as passed. Unknown never reads as passing.
import type { TradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import { type Db, activeSymbols, schema } from '@saku/db';
import { and, asc, eq } from 'drizzle-orm';
import { DAILY_OVERLAP } from './ingest';

export const GATE = { secondaryAvailability: 0.95, layerB: 0.99, layerC: 0.99 } as const;

export interface SpikeDay {
  date: string;
  /** The run the primary and layer B are measured from; null: none finished with results. */
  runId: string | null;
  /** The run layer C is measured from (the latest one covering the date). */
  layerCRunId: string | null;
  /** `no_run`: failed without a run; `pending`: the open session, no run finished yet. */
  reason?: 'no_run' | 'pending';
  primaryOk: boolean;
  /** Secondary source -> some run for the day had its bar for every symbol it covers. */
  available: Record<string, boolean>;
  layerBPass: boolean;
  layerCPass: boolean;
  /** Layer C waits for an index result a later run can still bring (not judged yet). */
  layerCPending?: boolean;
  nonGreen: {
    layer: string;
    check: string;
    source: string | null;
    status: string;
    message: string | null;
    /** The run that stored it (the day's own run, or the later one that checked the index). */
    runId: string;
  }[];
}

export interface SpikeReport {
  days: SpikeDay[];
  primaryOkDays: number;
  availability: Record<string, number>;
  layerB: { days: number; passed: number };
  layerC: { days: number; passed: number };
  /** The last session the verdict covers (the day before the first pending one). */
  through?: TradingDate;
  /** Sessions after `through`, listed but not judged yet (from the first pending one on). */
  pending: number;
  /** The numeric gate over the sessions through `through`. */
  passed: boolean;
}

type Result = typeof schema.checkResults.$inferSelect;
const isIndexResult = (r: Result) => r.layer === 'C' && r.checkName.startsWith('index_');

export async function spikeReport(
  db: Db,
  o: {
    sessions: Sessions;
    from?: TradingDate;
    to?: TradingDate;
    /** The session whose daily run window is still open (the current daily target). */
    open?: TradingDate;
  },
): Promise<SpikeReport> {
  const roles = await db
    .select()
    .from(schema.sourceRoles)
    .where(eq(schema.sourceRoles.dataKind, 'bars'));
  const primary = roles.find((r) => r.role === 'primary')?.pluginKey;
  const secondaries = roles.filter((r) => r.role === 'secondary').map((r) => r.pluginKey);
  const symbols = await activeSymbols(db);

  // Every daily run, oldest first; those that finished and stored results for their target.
  const all = await db
    .select()
    .from(schema.jobRuns)
    .where(eq(schema.jobRuns.jobType, 'daily'))
    .orderBy(asc(schema.jobRuns.startedAt));
  const resultsOf = async (runId: string, date: TradingDate): Promise<Result[]> =>
    db
      .select()
      .from(schema.checkResults)
      .where(and(eq(schema.checkResults.runId, runId), eq(schema.checkResults.date, date)));
  const finished: { id: string; target: TradingDate; from: TradingDate | undefined }[] = [];
  for (const r of all) {
    const target = r.datesProcessed?.[0];
    if (!target || r.finishedAt === null) continue;
    let from: TradingDate | undefined;
    try {
      from = o.sessions.before(target, DAILY_OVERLAP);
    } catch {
      from = undefined; // Outside the calendar: covers its target only.
    }
    finished.push({ id: r.id, target, from });
  }

  // The range: given, else from the earliest daily run's target (any status: a run that crashed
  // still marks the start) to the latest target of a finished run.
  const targets = all.flatMap((r) => (r.datesProcessed?.[0] ? [r.datesProcessed[0]] : []));
  const from = o.from ?? targets.sort()[0];
  const to =
    o.to ??
    finished
      .map((r) => r.target)
      .sort()
      .at(-1);
  const dates = from && to && from <= to ? o.sessions.between(from, to) : [];

  const days: SpikeDay[] = [];
  for (const date of dates) {
    // Runs targeting the date that stored results for it, latest last.
    const own: { id: string; rs: Result[] }[] = [];
    for (const r of finished.filter((x) => x.target === date)) {
      const rs = await resultsOf(r.id, date);
      if (rs.length > 0) own.push({ id: r.id, rs });
    }
    const empty = Object.fromEntries(secondaries.map((s) => [s, false]));
    if (own.length === 0) {
      const pending = date === o.open;
      days.push({
        date,
        runId: null,
        layerCRunId: null,
        reason: pending ? 'pending' : 'no_run',
        primaryOk: false,
        available: empty,
        layerBPass: false,
        layerCPass: false,
        nonGreen: [],
      });
      continue;
    }
    const { id: runId, rs } = own.at(-1)!;
    const live = symbols.filter((s) => !s.inceptionDate || s.inceptionDate <= date);
    const primaryBars = rs.filter(
      (r) => r.checkName === 'bar_valid' && r.source === primary && r.status !== 'red',
    );
    const available: Record<string, boolean> = {};
    for (const s of secondaries) {
      available[s] = own.some(({ rs: x }) => {
        const closes = x.filter((r) => r.checkName === 'close_match' && r.source === s);
        return closes.length > 0 && closes.every((r) => r.message !== 'no secondary bar');
      });
    }

    // The index check for the date from the latest finished run covering it that stored results
    // for it (the next run checks the date once the index is published).
    let cRun: { id: string; rs: Result[] } = { id: runId, rs };
    let laterCovering = false;
    for (const r of finished) {
      const covers =
        r.target === date || (r.target > date && r.from !== undefined && r.from <= date);
      if (!covers) continue;
      const x =
        r.target === date ? own.find((y) => y.id === r.id)?.rs : await resultsOf(r.id, date);
      if (!x || x.length === 0) continue;
      cRun = { id: r.id, rs: x };
      if (r.target > date) laterCovering = true;
    }
    const ownC = rs.filter((r) => r.layer === 'C');
    const index = cRun.id === runId ? [] : cRun.rs.filter(isIndexResult);
    const indexNow = cRun.rs.filter(isIndexResult);
    // A fund with an index needs an index result for the date (index_match, or index_unavailable).
    const missingIndex = live
      .filter((s) => s.indexSeries)
      .some((s) => !indexNow.some((r) => r.symbolId === s.id));
    days.push({
      date,
      runId,
      layerCRunId: cRun.id,
      primaryOk: primaryBars.length >= live.length,
      available,
      layerBPass: rs.filter((r) => r.layer === 'B').every((r) => r.status === 'green'),
      // The day's own run (what was decided on) and the later index check must both be green: a
      // failure at decision time is never dropped by a later correction.
      layerCPass:
        !missingIndex &&
        ownC.every((r) => r.status === 'green') &&
        indexNow.every((r) => r.status === 'green'),
      ...(missingIndex && !laterCovering && { layerCPending: true }),
      nonGreen: [...rs, ...index]
        .filter((r) => r.status !== 'green')
        .map((r) => ({
          layer: r.layer,
          check: r.checkName,
          source: r.source,
          status: r.status,
          message: r.message,
          runId: r.runId,
        })),
    });
  }

  // The verdict covers the sessions before the first pending one (judged through the day before);
  // later sessions are listed, never counted as passed.
  const firstPending = days.findIndex((d) => d.reason === 'pending' || d.layerCPending);
  const counted = firstPending < 0 ? days : days.slice(0, firstPending);
  const through = counted.at(-1)?.date;
  const n = counted.length;
  const availability: Record<string, number> = {};
  for (const s of secondaries)
    availability[s] = n ? counted.filter((d) => d.available[s]).length / n : 0;
  // Layer B counts the days a secondary was available (a day without a run had none).
  const withSecondary = counted.filter((d) => Object.values(d.available).some(Boolean));
  const layerB = {
    days: withSecondary.length,
    passed: withSecondary.filter((d) => d.layerBPass).length,
  };
  const layerC = { days: n, passed: counted.filter((d) => d.layerCPass).length };
  const primaryOkDays = counted.filter((d) => d.primaryOk).length;
  const pending = days.length - n;
  const passed =
    n > 0 &&
    primaryOkDays === n &&
    Object.values(availability).some((a) => a >= GATE.secondaryAvailability) &&
    layerB.days > 0 &&
    layerB.passed / layerB.days >= GATE.layerB &&
    layerC.passed / layerC.days >= GATE.layerC;
  return {
    days,
    ...(through !== undefined && { through }),
    primaryOkDays,
    availability,
    layerB,
    layerC,
    pending,
    passed,
  };
}
