// Whether a strategy may be registered: a registered version starts a forward record, which must
// be honest from its first day (requirements 05 "Execution model", 03 intro, 04 severity rules).
// Every reason to refuse is returned, so the owner sees them all at once; none means it may be
// registered.
//
// The rules:
// - `forward_records_from` must be set (the record opens after the A1 gate, stage-a A2).
// - Every cost is known: the strategy's own, or the install's `broker_costs` for one it omits
//   (`effectiveCosts`, requirements 05 "Costs"); omitted with no usable setting refuses, never 0.
//   The effective costs are what gets registered (`RegistrationReport.costs`).
// - A strategy that may hold CASH_BASE (base-currency cash; docs/indicators.md "Base-currency
//   cash") needs what its forward equity reads: `base_currency` set, a deposit rate in force on
//   `through` (`depositRateAsOf`; unknown or invalid refuses, never 0), and, unless the base
//   currency is USD, a primary FX source with a valuation rate USD<base> known before `through`'s
//   open (finite, above 0). Each missing one refuses. Such a strategy also gets a note (content
//   `registration.cashBaseNote`): tax on currency conversion is not applied yet, and the FX
//   spread applies to conversions only.
// - `same_close` execution is refused: it trades at a close not yet known when the signal is
//   computed; it exists only for testfol parity tests (05 "Execution model").
// - A range volatility (parkinson, garman_klass, yang_zhang) is refused: it reads opens, highs
//   and lows, which no check compares between sources yet (decision C32, docs/indicators.md B1).
// - Every ticker the strategy depends on (its signals and holdings, as core `dependencies`, and the
//   holdings of its declared safe state, which it holds on red days) must be an active symbol.
// - Each such symbol must have passed the data checks over its full history (03 intro: "usable
//   only after passing the data quality checks (04) over its full history"). Read as:
//   - no stored canonical bar of the symbol on a day the calendar does not cover, graded red, or
//     not graded at all (`bars.status`, the per-date grade the forward record reads, rewritten by
//     every run that grades the date, daily runs included; NULL is unknown, never green);
//   - bars on days the market was closed are not refused (requirements 04 "Closed-day bars":
//     verify builds no canonical bar for them and `canonicalBars` leaves any stored one out, so
//     no signal reads them): listed as information (`notes`), the primary's raw bars and any
//     stored canonical row on such days;
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
//       A red day the calendar says was closed does not refuse when every red finding on it is a
//       closed-day bar and nothing else (`closedDayOnly`): layer A `bar_valid` with the single
//       problem "not a trading day", and no other red reason. Anything else red on it refuses
//       (a closed-day bar with a dividend or split among them: its event is in no bar read),
//       unless an admin resolved that event of the primary as not real (C19; its sessions after
//       are then no longer red either).
// Unknown stays unknown: no pass, a stale pass or a pass that cannot be read refuses.
//
// Not checked here: the cash rate. Series (the cash rate, index series, FX) are graded for
// freshness only on each run's own target date, not per date over the full history, so there is
// no full-history grade to read; the daily run grades the series on each recorded day.
import {
  CASH_BASE,
  comparisonsOf,
  type Strategy,
  type TradingDate,
  dependencies,
  isCash,
  isTradingDate,
  mayHoldCashBase,
  parseTicker,
} from '@saku/core';
import { translator } from '@saku/content';
import { CLOSED_DAY_EVENT, NOT_A_SESSION, type Sessions } from '@saku/data';
import {
  type Db,
  activeSymbols,
  closedEventResolutionsOf,
  depositRateAsOf,
  fxPointInTime,
  getSetting,
  resolutionOf,
  schema,
} from '@saku/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { cashReadAt } from './cash';
import { type EffectiveCosts, effectiveCosts } from './costs';
import { roles } from './verify';

/** Full-history passes (they store `health_coverage`). */
const FULL = ['bootstrap', 'weekly', 'checks'] as const;
/** Red days listed by name; the rest are counted. */
const LISTED = 10;

export const SAME_CLOSE_REFUSAL =
  'same_close trades at a close that is not yet known; it is for testfol parity only. Use next_open.';

/** Volatility methods that read each day's open, high and low (docs/indicators.md, B1). */
const RANGE_METHODS: readonly string[] = ['parkinson', 'garman_klass', 'yang_zhang'];

export const RANGE_VOLATILITY_REFUSAL =
  "a range volatility (parkinson, garman_klass or yang_zhang) reads each day's open, high and " +
  'low, which are not cross-checked between sources yet (decision C32): a wrong high or low ' +
  'would pass as a green day and move the signal. Use method close until that check exists; ' +
  'backtests may use range methods.';

/** Whether a signal reads a range volatility (refused until open/high/low are checked, C32). */
export function readsRangeVolatility(strategy: Strategy): boolean {
  return strategy.signals
    .flatMap(comparisonsOf)
    .flatMap((c) => [c.left, c.right])
    .some(
      (o) =>
        'indicator' in o &&
        o.indicator === 'volatility' &&
        RANGE_METHODS.includes(o.method ?? 'close'),
    );
}

/** The tickers registration checks: what the strategy reads or holds, its safe state included. */
export function registrationTickers(strategy: Strategy): string[] {
  const safe = strategy.safeState.holdings
    .map((h) => h.ticker)
    .filter((t) => !isCash(t))
    .map((t) => parseTicker(t).base);
  return [...new Set([...dependencies(strategy), ...safe])].sort();
}

/** What registration says: every reason to refuse, and information that does not refuse. */
export interface RegistrationReport {
  problems: string[];
  notes: string[];
  /** The strategy as it would be registered, with its effective costs; undefined when unknown. */
  costs?: Exclude<EffectiveCosts, { problem: string }>;
}

/** The reasons to refuse only (`registrationReport`). */
export async function registrationProblems(
  db: Db,
  strategy: Strategy,
  o: { through: TradingDate; sessions: Sessions },
): Promise<string[]> {
  return (await registrationReport(db, strategy, o)).problems;
}

export async function registrationReport(
  db: Db,
  strategy: Strategy,
  o: {
    /** The latest session whose data is final now (`dailyTarget`). */
    through: TradingDate;
    /** The market calendar (bars on days that are not sessions are named apart). */
    sessions: Sessions;
  },
): Promise<RegistrationReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!(await getSetting(db, 'forward_records_from'))) {
    problems.push(
      'Registration starts a forward record, which opens after the A1 gate: ' +
        'pnpm settings set forward_records_from <date> first.',
    );
  }
  const costs = await effectiveCosts(db, strategy);
  if ('problem' in costs) problems.push(costs.problem);
  if (mayHoldCashBase(strategy)) {
    problems.push(...(await cashBaseProblems(db, o.through)));
    // Said in the install's primary language (content), refused or not.
    const t = translator((await getSetting(db, 'primary_language')) ?? 'en');
    notes.push(t('registration.cashBaseNote'));
  }
  if (strategy.execution === 'same_close') problems.push(SAME_CLOSE_REFUSAL);
  if (readsRangeVolatility(strategy)) problems.push(RANGE_VOLATILITY_REFUSAL);

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
  const primary = (await roles(db, 'bars')).primary;
  for (const ticker of used) {
    const r = await symbolProblems(db, ticker, known.get(ticker)!, o, primary, pass);
    problems.push(...r.problems);
    notes.push(...r.notes);
  }
  return { problems, notes, ...('problem' in costs ? {} : { costs }) };
}

/** What a strategy that may hold CASH_BASE needs before its forward record starts (see above). */
async function cashBaseProblems(db: Db, through: TradingDate): Promise<string[]> {
  const base = await getSetting(db, 'base_currency');
  if (!base) {
    return [
      `The strategy may hold ${CASH_BASE} (base-currency cash) and base_currency is not set: ` +
        'pnpm settings set base_currency <code> first.',
    ];
  }
  const problems: string[] = [];
  const rate = await depositRateAsOf(db, through);
  if ('unknown' in rate) {
    problems.push(
      `The strategy may hold ${CASH_BASE} and no ${base} deposit rate is in force on ${through} ` +
        '(never read as 0): pnpm settings deposit-rate add <ratePct> <from> ' +
        `${base} first.`,
    );
  } else if ('invalid' in rate) {
    problems.push(
      `The strategy may hold ${CASH_BASE} and the ${base} deposit rate in force on ${through} is ` +
        `invalid (${rate.invalid.join('; ')}): correct it with pnpm settings deposit-rate correct.`,
    );
  }
  if (base !== 'USD') {
    const primary = (await roles(db, 'fx')).primary;
    if (!primary) {
      problems.push(
        `The strategy may hold ${CASH_BASE} and no primary FX source is set: its value in USD ` +
          `needs the valuation rate USD${base}.`,
      );
    } else {
      // A rate known before through's open, as the backtest reads it (`cashReadAt`), finite and
      // above 0: the forward record's first steps need one.
      const pit = await fxPointInTime(db, `USD${base}`, primary);
      const fx = pit.asOf(through, cashReadAt(through))?.value;
      if (fx === undefined || !Number.isFinite(fx) || !(fx > 0)) {
        problems.push(
          `The strategy may hold ${CASH_BASE} and no valuation rate USD${base} from ${primary} ` +
            `is known before the open of ${through}` +
            `${fx === undefined ? '' : ` (read ${fx})`}: run pnpm jobs daily (or check the FX source) first.`,
        );
      }
    }
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
  o: { through: TradingDate; sessions: Sessions },
  primarySource: string | undefined,
  pass: Pass | undefined,
): Promise<RegistrationReport> {
  const { through, sessions } = o;
  const b = schema.bars;
  const problems: string[] = [];
  const notes: string[] = [];
  const done = () => ({ problems, notes });

  // Each stored bar's grade as the latest run that graded it set it (what the forward record
  // reads; a daily run after the pass rewrites it), whatever the pass found:
  // - a bar on a day the market was closed is not read (`canonicalBars` leaves it out): noted;
  // - a bar on a day the calendar does not cover cannot be judged: unknown;
  // - otherwise no red bar, and no bar no run has graded (NULL is unknown, never green).
  // The symbol's first and last stored bars are those the signals read (closed days left out).
  const closed = new Set<TradingDate>();
  const outside: string[] = [];
  const redBars: string[] = [];
  const ungraded: string[] = [];
  const read: TradingDate[] = [];
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
      read.push(x.date);
      continue;
    }
    if (!session) {
      closed.add(x.date);
      continue;
    }
    read.push(x.date);
    if (x.status === 'red') redBars.push(x.date);
    else if (x.status === null) ungraded.push(x.date);
  }
  // The primary's raw bars on closed days: verify builds no canonical bar for them.
  if (primarySource) {
    for (const x of await db
      .select({ date: schema.barsRaw.date })
      .from(schema.barsRaw)
      .where(
        and(eq(schema.barsRaw.symbolId, symbolId), eq(schema.barsRaw.source, primarySource)),
      )) {
      if (sessions.closedOn(x.date)) closed.add(x.date);
    }
  }
  if (closed.size > 0) {
    const days = [...closed].sort();
    notes.push(
      `${ticker}: ${days.length} ${days.length === 1 ? 'bar' : 'bars'} on days the market was ` +
        `closed, excluded (no signal reads them): ${listed(days)}.`,
    );
  }
  const first = read[0];
  const last = read.at(-1);
  if (!first || !last) {
    problems.push(`${ticker}: no stored bars; run pnpm bootstrap, then pnpm verify.`);
    return done();
  }
  const bars = { first, last };
  const barsAre = (n: number) => `${n} stored ${n === 1 ? 'bar is' : 'bars are'}`;
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
    return done();
  }
  if (pass.status !== 'success') return done(); // Said once for every ticker.

  const c = schema.healthCoverage;
  const [coverage] = await db
    .select({ from: c.fromDate, to: c.toDate })
    .from(c)
    .where(and(eq(c.runId, pass.id), eq(c.symbolId, symbolId)));
  if (!coverage) {
    problems.push(`${ticker}: ${pass.which} did not grade it; run pnpm verify (full) again.`);
    return done();
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
    return done();
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
  const redRows = await db
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
  const red: typeof redRows = [];
  const resolved = primarySource
    ? await resolvedClosedDays(db, symbolId, primarySource)
    : new Set<TradingDate>();
  for (const d of redRows) {
    if (
      sessions.closedOn(d.date) &&
      (await closedDayOnly(
        db,
        pass.id,
        symbolId,
        d,
        (source) => source === primarySource && resolved.has(d.date),
      ))
    ) {
      continue;
    }
    red.push(d);
  }
  if (red.length > 0) {
    problems.push(
      `${ticker}: ${red.length} red ${red.length === 1 ? 'day' : 'days'} in its history ` +
        `(${pass.which}): ${listed(red.map((d) => `${d.date}${d.reasons.length ? ` (${d.reasons.join(', ')})` : ''}`))}. ` +
        'Its data has not passed the checks (pnpm health --date <date> explains a day).',
    );
  }
  return done();
}

/** A health reason code of a check result: `<layer>.<check>` with `@<source>` when it has one. */
const CHECK_REASON = /^[A-F]\.[a-z_]+(@\S+)?$/;
/** The reasons a symbol's grade carries that are never red on their own (`symbolHealth`). */
const YELLOW_ONLY = /^(single_source|stand_in@\S+|stand_in_closed_changed@\S+)$/;

/**
 * The closed days whose dividend or split, in the primary's raw bar as stored now, an admin
 * resolution covers (decisions log 2026-11-01, C19: the event is not real; `resolutionOf`).
 */
async function resolvedClosedDays(
  db: Db,
  symbolId: number,
  primary: string,
): Promise<Set<TradingDate>> {
  const resolutions = await closedEventResolutionsOf(db, { symbolId });
  if (resolutions.length === 0) return new Set();
  const out = new Set<TradingDate>();
  for (const x of await db
    .select({
      date: schema.barsRaw.date,
      divCash: schema.barsRaw.divCash,
      splitFactor: schema.barsRaw.splitFactor,
    })
    .from(schema.barsRaw)
    .where(and(eq(schema.barsRaw.symbolId, symbolId), eq(schema.barsRaw.source, primary)))) {
    if (resolutionOf(resolutions, { symbolId, source: primary, ...x })) out.add(x.date);
  }
  return out;
}

/** A closed-day bar's `bar_valid` problems when it carries a dividend or split. */
const NOT_A_SESSION_WITH_EVENT = `${NOT_A_SESSION}; ${CLOSED_DAY_EVENT}`;

/**
 * Whether a red day of a symbol, on a day the market was closed, is red only because a source
 * dated a bar on it (requirements 04 "Closed-day bars": the bar is in no series the signals
 * read, so it does not refuse). True only when every red result the pass stored for the symbol
 * on that date is layer A `bar_valid` with the single problem `NOT_A_SESSION` (a closed-day bar
 * with a dividend or split, or any other problem with it, is not), and every reason of the day is
 * either a check result's or one that is never red on its own. One exception (decisions log
 * 2026-11-01, C19): the primary's closed-day bar whose dividend or split an admin resolved as
 * not real (`resolvedEvent(source)` true) counts as a closed-day bar only, its problems being
 * exactly `NOT_A_SESSION` and `CLOSED_DAY_EVENT`. Anything not known: false.
 */
async function closedDayOnly(
  db: Db,
  runId: string,
  symbolId: number,
  day: { date: TradingDate; reasons: string[] },
  resolvedEvent: (source: string | null) => boolean,
): Promise<boolean> {
  if (!day.reasons.every((r) => CHECK_REASON.test(r) || YELLOW_ONLY.test(r))) return false;
  const r = schema.checkResults;
  const results = await db
    .select({ layer: r.layer, check: r.checkName, source: r.source, message: r.message })
    .from(r)
    .where(
      and(eq(r.runId, runId), eq(r.symbolId, symbolId), eq(r.date, day.date), eq(r.status, 'red')),
    );
  return (
    results.length > 0 &&
    results.every(
      (x) =>
        x.layer === 'A' &&
        x.check === 'bar_valid' &&
        (x.message === NOT_A_SESSION ||
          (x.message === NOT_A_SESSION_WITH_EVENT && resolvedEvent(x.source))),
    )
  );
}
