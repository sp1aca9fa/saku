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
// - `guard` (the forward record): an FX value is refused (unknown, with the reason in
//   `fxProblem`) when, at the read time, it is more than MAX_STALE_DAYS sessions behind (or the
//   lag cannot be counted on the calendar), or when the latest cross-check of its observation
//   (`fx_match`, any secondary) is red. A step holding CASH_BASE then has no equity (null, with
//   the reason); the USD-only versions never read FX.
import type { TradingDate } from '@saku/core';
import { type Sessions, seriesHealthAtOpen } from '@saku/data';
import { type Db, depositRateReader, fxPointInTime, getSetting, schema } from '@saku/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { cashReadAt } from './cash';
import { roles } from './verify';

export interface BaseCurrencyInputs {
  baseCurrency?: string;
  fxRate?: (date: TradingDate) => number | undefined;
  depositRate?: (date: TradingDate) => number | undefined;
  /** With `guard`: why the FX of a session was refused (undefined: not refused). */
  fxProblem?: (date: TradingDate) => string | undefined;
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

/** Observation dates whose latest FX cross-check (`fx_match`) from some secondary is red. */
async function redFxObservations(db: Db): Promise<Map<TradingDate, string>> {
  const c = schema.checkResults;
  const rows = await db
    .select({ date: c.date, source: c.source, status: c.status })
    .from(c)
    .where(and(eq(c.checkName, 'fx_match'), isNull(c.symbolId)))
    .orderBy(asc(c.id));
  const latest = new Map<string, { date: TradingDate; source: string | null; status: string }>();
  for (const r of rows) latest.set(`${r.date}\u0000${r.source ?? ''}`, r);
  const red = new Map<TradingDate, string>();
  for (const r of latest.values()) {
    if (r.status === 'red' && !red.has(r.date)) red.set(r.date, r.source ?? 'unknown');
  }
  return red;
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
  const primary = (await roles(db, 'fx')).primary;
  const fx = primary ? await fxPointInTime(db, pair, primary) : undefined;
  const read = (date: TradingDate) => fx?.asOf(date, cashReadAt(date));
  if (!o.guard) return { baseCurrency, fxRate: (date) => read(date)?.value, depositRate };

  const { sessions } = o.guard;
  const red = await redFxObservations(db);
  const problem = (date: TradingDate): string | undefined => {
    const v = read(date);
    if (v === undefined) return undefined;
    const h = seriesHealthAtOpen(sessions, date, v.date);
    if (h.status === 'unknown') {
      return `${pair} of ${v.date} read for ${date}: its lag cannot be counted on the calendar (${h.outside} outside it)`;
    }
    if (h.status === 'red') {
      return `${pair} is stale: its last value (${v.date}) is ${h.behind} sessions behind ${date}`;
    }
    const by = red.get(v.date);
    if (by !== undefined) return `${pair} of ${v.date} disagrees with ${by} (fx_match red)`;
    return undefined;
  };
  return {
    baseCurrency,
    fxRate: (date) => (problem(date) === undefined ? read(date)?.value : undefined),
    depositRate,
    fxProblem: problem,
  };
}
