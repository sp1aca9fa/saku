// A backtest's base-currency inputs (docs/indicators.md "Base currency", "Base-currency cash";
// requirements 04 point-in-time series, "FX health affects only base-currency valuation"; 05
// "Cash"; spec 2026-11-02 base-currency), loaded once per run and read in memory:
// - `baseCurrency`: the install's `base_currency` setting; none when it is not set (a strategy
//   that may hold CASH_BASE then fails in the backtest, and registration refuses it first).
// - `fxRate`: the valuation rate of the pair `USD<base>` from the primary FX source (source
//   roles), through asOf at the cash rate's read time (before the session opens: known at the
//   decision time and at every execution point). No primary source: unknown on every date, never
//   a guess. Not loaded when the base currency is USD (the backtest uses 1).
// - `depositRate`: `deposit_rates` in force on the date (`depositRateReader`, the same answer as
//   `depositRateAsOf`). Unknown stays undefined; a stored value that does not pass the rules
//   throws, so the run fails with the reason rather than read it.
//
// Two readings (CLAUDE.md: rates are read only through asOf, no look-ahead):
// - `pointInTime` (the forward record and its integrity checks): each date's deposit rate as known
//   at that date's read time (`knownBy` = `cashReadAt(date)`), so a later correction or backfill
//   never changes what an earlier day computed. Drafts may read the latest corrected value.
// - `guard` (the forward record and registration): each session's FX is graded at its read
//   time (`fxProblem`):
//   - refused (red; the value is not used, so a point that needs it has no equity, with the
//     reason): more than MAX_STALE_DAYS sessions behind, a lag the calendar cannot count, or the
//     latest cross-check of that value by a current secondary (`fx_match`) is red;
//   - warning (yellow; used, and the run reports it): 2 to MAX_STALE_DAYS sessions behind, or no
//     current secondary checked that value (single source: never green, requirements 04).
//   A cross-check counts only from a secondary in today's FX roles that compared the value read
//   (its `expected` is the current primary's value): a check against a former primary, or an
//   earlier vintage, says nothing about this value. The USD-only versions never read FX.
import type { TradingDate } from '@saku/core';
import { type Sessions, seriesHealthAtOpen } from '@saku/data';
import { type Db, depositRateReader, fxPointInTime, getSetting, schema } from '@saku/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { cashReadAt } from './cash';
import { roles } from './verify';

/** A session's FX grade at its read time (`guard`): refused, or used with a warning. */
export interface FxProblem {
  level: 'red' | 'yellow';
  reason: string;
}

export interface BaseCurrencyInputs {
  baseCurrency?: string;
  fxRate?: (date: TradingDate) => number | undefined;
  depositRate?: (date: TradingDate) => number | undefined;
  /** With `guard`: the session's FX grade (undefined: green, or no value at all). */
  fxProblem?: (date: TradingDate) => FxProblem | undefined;
}

/** The deposit rate in percent a year read as a number, or undefined; invalid values throw. */
export function depositRateOf(
  read: Awaited<ReturnType<typeof depositRateReader>>,
  o: { pointInTime?: boolean } = {},
): (date: TradingDate) => number | undefined {
  return (date) => {
    const r = read(date, o.pointInTime ? { knownBy: cashReadAt(date) } : {});
    if ('unknown' in r) return undefined;
    if ('invalid' in r) {
      throw new Error(`The deposit rate in force on ${date} is invalid: ${r.invalid.join('; ')}.`);
    }
    // Decimal text with at most 15 significant digits reads into float64 exactly.
    return Number(r.entry.ratePct);
  };
}

/** The FX cross-checks (`fx_match`) by observation date, in the order they were stored. */
async function fxMatches(
  db: Db,
): Promise<Map<TradingDate, { source: string | null; status: string; expected: number | null }[]>> {
  const c = schema.checkResults;
  const rows = await db
    .select({ date: c.date, source: c.source, status: c.status, expected: c.expected })
    .from(c)
    .where(and(eq(c.checkName, 'fx_match'), isNull(c.symbolId)))
    .orderBy(asc(c.id));
  const out = new Map<
    TradingDate,
    { source: string | null; status: string; expected: number | null }[]
  >();
  for (const r of rows) out.set(r.date, [...(out.get(r.date) ?? []), r]);
  return out;
}

export async function baseCurrencyInputs(
  db: Db,
  o: { pointInTime?: boolean; guard?: { sessions: Sessions } } = {},
): Promise<BaseCurrencyInputs> {
  const baseCurrency = await getSetting(db, 'base_currency');
  if (!baseCurrency) return {};
  const depositRate = depositRateOf(await depositRateReader(db), o);
  if (baseCurrency === 'USD') return { baseCurrency, depositRate };
  const pair = `USD${baseCurrency}`;
  const fxRoles = await roles(db, 'fx');
  const primary = fxRoles.primary;
  const fx = primary ? await fxPointInTime(db, pair, primary) : undefined;
  const read = (date: TradingDate) => fx?.asOf(date, cashReadAt(date));
  if (!o.guard) return { baseCurrency, fxRate: (date) => read(date)?.value, depositRate };

  const { sessions } = o.guard;
  const secondaries = new Set(fxRoles.secondaries);
  const matches = await fxMatches(db);
  const problem = (date: TradingDate): FxProblem | undefined => {
    const v = read(date);
    if (v === undefined) return undefined;
    const red = (reason: string): FxProblem => ({ level: 'red', reason });
    const h = seriesHealthAtOpen(sessions, date, v.date);
    if (h.status === 'unknown') {
      return red(
        `${pair} of ${v.date} read for ${date}: its lag cannot be counted on the calendar (${h.outside} outside it)`,
      );
    }
    if (h.status === 'red') {
      return red(
        `${pair} is stale: its last value (${v.date}) is ${h.behind} sessions behind ${date}`,
      );
    }
    // The latest check of this value by each current secondary.
    const latest = new Map<string, string>();
    for (const m of matches.get(v.date) ?? []) {
      if (m.source !== null && secondaries.has(m.source) && m.expected === v.value) {
        latest.set(m.source, m.status);
      }
    }
    const disputed = [...latest].find(([, status]) => status === 'red');
    if (disputed) return red(`${pair} of ${v.date} disagrees with ${disputed[0]} (fx_match red)`);
    if (h.status === 'yellow') {
      return {
        level: 'yellow',
        reason: `${pair} is ${h.behind} sessions behind ${date} (last value ${v.date})`,
      };
    }
    if (latest.size === 0) {
      return {
        level: 'yellow',
        reason: `${pair} of ${v.date} is from ${primary} alone: no current secondary checked it`,
      };
    }
    return undefined;
  };
  return {
    baseCurrency,
    fxRate: (date) => (problem(date)?.level === 'red' ? undefined : read(date)?.value),
    depositRate,
    fxProblem: problem,
  };
}
