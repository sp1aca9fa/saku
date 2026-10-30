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
//   only after passing the data quality checks (04) over its full history"). Read as:
//   - no stored canonical bar of the symbol on a day the market was closed (or the calendar does
//     not cover), graded red, or not graded at all (`bars.status`, the per-date grade the forward
//     record reads, rewritten by every run that grades the date, daily runs included; NULL is
//     unknown, never green);
//   - the latest full-history run (bootstrap, weekly or checks, by start, whatever its status)
//     succeeded (one that failed may have stopped on a calculation or data fault; one still
//     marked running was interrupted, since registration holds the jobs lock; an older pass is
//     never used instead of it) and graded the symbol (`health_coverage`), and it
//     - stored its grades completely (an overall `data_health` row: verify stores the coverage,
//       then the symbol rows, then the overall rows, so one overall row means every symbol row
//       is stored),
//     - graded from the symbol's first stored canonical bar or earlier (bars before it, kept
//       from an earlier primary, are graded by no check),
//     - graded through `through` (the latest session whose data is final at registration, the
//       daily target: the conservative bound) and through the symbol's last stored canonical bar,
//     - and graded no day of the symbol red. Yellow is allowed (computed with a warning, 04).
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
import type { Sessions } from '@saku/data';
import { type Db, activeSymbols, getSetting, schema } from '@saku/db';
import { and, desc, eq, inArray, isNull, max, min } from 'drizzle-orm';

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
    /** The market calendar (bars on days that are not sessions are named apart). */
    sessions: Sessions;
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

  // The latest full-history run, whatever its status: one that failed, or is still marked
  // running (interrupted: registration holds the jobs lock), decides; never an older one.
  const r = schema.jobRuns;
  const [run] = await db
    .select({ id: r.id, jobType: r.jobType, status: r.status, dates: r.datesProcessed })
    .from(r)
    .where(inArray(r.jobType, [...FULL]))
    .orderBy(desc(r.startedAt))
    .limit(1);
  const pass: Pass | undefined = run && {
    ...run,
    which: `the latest full check (run ${run.id}, ${run.jobType}${run.dates?.[0] ? ` for ${run.dates[0]}` : ''})`,
  };
  const used = tickers.filter((t) => known.has(t));
  if (pass && used.length > 0 && pass.status !== 'success') {
    problems.push(
      `${capitalized(pass.which)} ${pass.status === 'running' ? 'was interrupted (it never finished)' : 'did not succeed'}; ` +
        'fix what it reported, then run pnpm verify (full) again.',
    );
  }
  for (const ticker of used) {
    problems.push(
      ...(await symbolProblems(db, ticker, known.get(ticker)!, o.through, o.sessions, pass)),
    );
  }
  return problems;
}

interface Pass {
  id: string;
  status: string;
  /** How the messages name it. */
  which: string;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** `n` dates as a list: the first `LISTED`, then how many more. */
function listed(dates: string[]): string {
  const more = dates.length > LISTED ? `, and ${dates.length - LISTED} more` : '';
  return `${dates.slice(0, LISTED).join(', ')}${more}`;
}

async function symbolProblems(
  db: Db,
  ticker: string,
  symbolId: number,
  through: TradingDate,
  sessions: Sessions,
  pass: Pass | undefined,
): Promise<string[]> {
  const b = schema.bars;
  const [bars] = await db
    .select({ first: min(b.date), last: max(b.date) })
    .from(b)
    .where(eq(b.symbolId, symbolId));
  if (!bars?.first || !bars.last) {
    return [`${ticker}: no stored bars; run pnpm bootstrap, then pnpm verify.`];
  }
  const problems: string[] = [];

  // Each stored bar's grade as the latest run that graded it set it (what the forward record
  // reads; a daily run after the pass rewrites it), whatever the pass found:
  // - a bar on a day the market was closed is wrong data no check run can fix (verify grades it
  //   red, layer A `bar_valid`): named apart, with what removes it;
  // - a bar on a day the calendar does not cover cannot be judged: unknown;
  // - otherwise no red bar, and no bar no run has graded (NULL is unknown, never green).
  const closed: string[] = [];
  const outside: string[] = [];
  const redBars: string[] = [];
  const ungraded: string[] = [];
  for (const x of await db
    .select({ date: b.date, status: b.status })
    .from(b)
    .where(eq(b.symbolId, symbolId))
    .orderBy(b.date)) {
    let session: boolean;
    try {
      session = sessions.isSession(x.date);
    } catch {
      outside.push(x.date);
      continue;
    }
    if (!session) closed.push(x.date);
    else if (x.status === 'red') redBars.push(x.date);
    else if (x.status === null) ungraded.push(x.date);
  }
  const barsAre = (n: number) => `${n} stored ${n === 1 ? 'bar is' : 'bars are'}`;
  if (closed.length > 0) {
    problems.push(
      `${ticker}: ${closed.length} stored ${closed.length === 1 ? 'bar' : 'bars'} on days the market was ` +
        `closed: ${listed(closed)}. No command removes such a bar yet; tell the admin (an open ` +
        'decision: keep closed-day bars out of the canonical series, or an admin withdrawal).',
    );
  }
  if (outside.length > 0) {
    problems.push(
      `${ticker}: ${barsAre(outside.length)} on days the market calendar does not cover: ` +
        `${listed(outside)}. Update the calendar plug-in.`,
    );
  }
  if (redBars.length > 0) {
    problems.push(
      `${ticker}: ${barsAre(redBars.length)} graded red: ${listed(redBars)}. Its data has not passed the ` +
        'checks (pnpm health --date <date> explains a day).',
    );
  }
  if (ungraded.length > 0) {
    problems.push(
      `${ticker}: ${barsAre(ungraded.length)} not graded: ${listed(ungraded)}. Run pnpm verify (full).`,
    );
  }

  if (!pass) {
    problems.push(
      `${ticker}: its full history has not been checked; run pnpm verify (full) first.`,
    );
    return problems;
  }
  if (pass.status !== 'success') return problems; // Said once for every ticker.

  const c = schema.healthCoverage;
  const [coverage] = await db
    .select({ from: c.fromDate, to: c.toDate })
    .from(c)
    .where(and(eq(c.runId, pass.id), eq(c.symbolId, symbolId)));
  if (!coverage) {
    problems.push(`${ticker}: ${pass.which} did not grade it; run pnpm verify (full) again.`);
    return problems;
  }
  const [overall] = await db
    .select({ id: schema.dataHealth.id })
    .from(schema.dataHealth)
    .where(and(eq(schema.dataHealth.runId, pass.id), isNull(schema.dataHealth.symbolId)))
    .limit(1);
  if (
    !isTradingDate(coverage.from) ||
    !isTradingDate(coverage.to) ||
    coverage.from > coverage.to ||
    !overall
  ) {
    problems.push(
      `${ticker}: ${pass.which} cannot be read (its grades are incomplete); run pnpm verify (full) again.`,
    );
    return problems;
  }

  if (coverage.from > bars.first) {
    // Verify grades a symbol from its primary source's history; canonical bars before it (kept
    // from an earlier primary, e.g. after a change of primary) are graded by no check.
    problems.push(
      `${ticker}: its stored bars from ${bars.first} to before ${coverage.from} are graded by no ` +
        "check: they are older than the primary source's history (kept from an earlier primary, " +
        'e.g. after a change of primary). An admin gives the checks that history: a primary ' +
        'source that has it (pnpm sources set bars <key> primary, then pnpm bootstrap), or the ' +
        'history imported as a source with a role (pnpm csv import), then pnpm verify (full).',
    );
  }
  const end = bars.last > through ? bars.last : through;
  if (coverage.to < end) {
    problems.push(
      `${ticker}: ${pass.which} graded through ${coverage.to}; registration needs it through ${end} ` +
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
        eq(schema.dataHealth.runId, pass.id),
        eq(schema.dataHealth.symbolId, symbolId),
        eq(schema.dataHealth.status, 'red'),
      ),
    )
    .orderBy(schema.dataHealth.date);
  if (red.length > 0) {
    problems.push(
      `${ticker}: ${red.length} red ${red.length === 1 ? 'day' : 'days'} in its history ` +
        `(${pass.which}): ${listed(red.map((d) => `${d.date}${d.reasons.length ? ` (${d.reasons.join(', ')})` : ''}`))}. ` +
        'Its data has not passed the checks (pnpm health --date <date> explains a day).',
    );
  }
  return problems;
}
