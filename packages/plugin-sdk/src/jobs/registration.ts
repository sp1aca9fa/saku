// Whether a strategy may be registered: a registered version starts a forward record, which must
// be honest from its first day (requirements 05 "Execution model", 03 intro, 04 severity rules).
// Every reason to refuse is returned, so the owner sees them all at once; none means it may be
// registered.
//
// The rules:
// - `forward_records_from` must be set (the record opens after the A1 gate, stage-a A2).
// - `same_close` execution is refused: it trades at a close not yet known when the signal is
//   computed; it exists only for testfol parity tests (05 "Execution model").
// - Every ticker the strategy depends on (its signals and holdings, as core `dependencies`, and the
//   holdings of its declared safe state, which it holds on red days) must be an active symbol.
// - Each such symbol must have passed the data checks over its full history (03 intro: "usable
//   only after passing the data quality checks (04) over its full history"). Read as: the latest
//   finished full-history pass (bootstrap, weekly or checks run) that graded the symbol
//   (`health_coverage`)
//   - succeeded (a pass that failed may have stopped on a calculation or data fault; an older
//     pass is never used instead of it),
//   - stored its grades completely (an overall `data_health` row: verify stores the coverage,
//     then the symbol rows, then the overall rows, so one overall row means every symbol row is
//     stored),
//   - graded from the symbol's first stored canonical bar or earlier,
//   - graded through `through` (the latest session whose data is final at registration, the
//     daily target: the conservative bound) and through the symbol's last stored canonical bar,
//   - and graded no day of the symbol red. Yellow days are allowed (computed with a warning, 04).
// Unknown stays unknown: no pass, a stale pass or a pass that cannot be read refuses.
//
// Not checked here: the cash rate. Series (the cash rate, index series, FX) are graded for
// freshness only on each run's own target date, not per date over the full history, so there is
// no full-history grade to read; the daily run grades the series on each recorded day.
import {
  CASH_USD,
  type Strategy,
  type TradingDate,
  dependencies,
  isTradingDate,
  parseTicker,
} from '@saku/core';
import { type Db, activeSymbols, getSetting, schema } from '@saku/db';
import { and, desc, eq, inArray, isNotNull, isNull, max, min } from 'drizzle-orm';

/** Full-history passes (they store `health_coverage`). */
const FULL = ['bootstrap', 'weekly', 'checks'] as const;
/** Red days listed by name; the rest are counted. */
const LISTED = 10;

export const SAME_CLOSE_REFUSAL =
  'same_close trades at a close that is not yet known; it is for testfol parity only. Use next_open.';

/** The tickers registration checks: what the strategy reads or holds, its safe state included. */
export function registrationTickers(strategy: Strategy): string[] {
  const safe = strategy.safeState.holdings
    .map((h) => h.ticker)
    .filter((t) => t !== CASH_USD)
    .map((t) => parseTicker(t).base);
  return [...new Set([...dependencies(strategy), ...safe])].sort();
}

export async function registrationProblems(
  db: Db,
  strategy: Strategy,
  o: {
    /** The latest session whose data is final now (`dailyTarget`). */
    through: TradingDate;
  },
): Promise<string[]> {
  const problems: string[] = [];
  if (!(await getSetting(db, 'forward_records_from'))) {
    problems.push(
      'Registration starts a forward record, which opens after the A1 gate: ' +
        'pnpm settings set forward_records_from <date> first.',
    );
  }
  if (strategy.execution === 'same_close') problems.push(SAME_CLOSE_REFUSAL);

  const known = new Map((await activeSymbols(db)).map((s) => [s.ticker, s.id]));
  const tickers = registrationTickers(strategy);
  const missing = tickers.filter((t) => !known.has(t));
  if (missing.length) {
    problems.push(`Not in the universe: ${missing.join(', ')} (pnpm symbols import).`);
  }
  for (const ticker of tickers) {
    const id = known.get(ticker);
    if (id !== undefined) problems.push(...(await symbolProblems(db, ticker, id, o.through)));
  }
  return problems;
}

async function symbolProblems(
  db: Db,
  ticker: string,
  symbolId: number,
  through: TradingDate,
): Promise<string[]> {
  const [bars] = await db
    .select({ first: min(schema.bars.date), last: max(schema.bars.date) })
    .from(schema.bars)
    .where(eq(schema.bars.symbolId, symbolId));
  if (!bars?.first || !bars.last) {
    return [`${ticker}: no stored bars; run pnpm bootstrap, then pnpm verify.`];
  }

  const c = schema.healthCoverage;
  const r = schema.jobRuns;
  const [pass] = await db
    .select({
      runId: r.id,
      jobType: r.jobType,
      status: r.status,
      dates: r.datesProcessed,
      from: c.fromDate,
      to: c.toDate,
    })
    .from(c)
    .innerJoin(r, eq(r.id, c.runId))
    .where(and(eq(c.symbolId, symbolId), isNotNull(r.finishedAt), inArray(r.jobType, [...FULL])))
    .orderBy(desc(r.startedAt))
    .limit(1);
  if (!pass) {
    return [`${ticker}: its full history has not been checked; run pnpm verify (full) first.`];
  }
  const which = `the latest full check (run ${pass.runId}, ${pass.jobType}${pass.dates?.[0] ? ` for ${pass.dates[0]}` : ''})`;
  if (pass.status !== 'success') {
    return [
      `${ticker}: ${which} did not succeed; fix what it reported, then run pnpm verify (full) again.`,
    ];
  }
  const [overall] = await db
    .select({ id: schema.dataHealth.id })
    .from(schema.dataHealth)
    .where(and(eq(schema.dataHealth.runId, pass.runId), isNull(schema.dataHealth.symbolId)))
    .limit(1);
  if (!isTradingDate(pass.from) || !isTradingDate(pass.to) || pass.from > pass.to || !overall) {
    return [
      `${ticker}: ${which} cannot be read (its grades are incomplete); run pnpm verify (full) again.`,
    ];
  }

  const problems: string[] = [];
  if (pass.from > bars.first) {
    problems.push(
      `${ticker}: ${which} graded from ${pass.from}, but its stored history starts ${bars.first}; ` +
        'run pnpm verify (full) again.',
    );
  }
  const end = bars.last > through ? bars.last : through;
  if (pass.to < end) {
    problems.push(
      `${ticker}: ${which} graded through ${pass.to}; registration needs it through ${end} ` +
        (bars.last < through
          ? '(the latest final session, not stored yet). After its daily run (pnpm daily), '
          : '(its latest stored bar). ') +
        'run pnpm verify (full) again.',
    );
  }
  const red = await db
    .select({ date: schema.dataHealth.date, reasons: schema.dataHealth.reasons })
    .from(schema.dataHealth)
    .where(
      and(
        eq(schema.dataHealth.runId, pass.runId),
        eq(schema.dataHealth.symbolId, symbolId),
        eq(schema.dataHealth.status, 'red'),
      ),
    )
    .orderBy(schema.dataHealth.date);
  if (red.length > 0) {
    const shown = red
      .slice(0, LISTED)
      .map((d) => `${d.date}${d.reasons.length ? ` (${d.reasons.join(', ')})` : ''}`);
    const more = red.length > LISTED ? `, and ${red.length - LISTED} more` : '';
    problems.push(
      `${ticker}: ${red.length} red ${red.length === 1 ? 'day' : 'days'} in its history ` +
        `(${which}): ${shown.join(', ')}${more}. Its data has not passed the checks ` +
        '(pnpm health --date <date> explains a day).',
    );
  }
  return problems;
}
