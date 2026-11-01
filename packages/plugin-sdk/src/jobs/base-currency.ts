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
import type { TradingDate } from '@saku/core';
import { type Db, depositRateReader, fxPointInTime, getSetting } from '@saku/db';
import { cashReadAt } from './cash';
import { roles } from './verify';

export interface BaseCurrencyInputs {
  baseCurrency?: string;
  fxRate?: (date: TradingDate) => number | undefined;
  depositRate?: (date: TradingDate) => number | undefined;
}

/** The deposit rate in percent a year read as a number, or undefined; invalid values throw. */
export function depositRateOf(
  read: Awaited<ReturnType<typeof depositRateReader>>,
): (date: TradingDate) => number | undefined {
  return (date) => {
    const r = read(date);
    if ('unknown' in r) return undefined;
    if ('invalid' in r) {
      throw new Error(`The deposit rate in force on ${date} is invalid: ${r.invalid.join('; ')}.`);
    }
    // Decimal text with at most 15 significant digits reads into float64 exactly.
    return Number(r.entry.ratePct);
  };
}

export async function baseCurrencyInputs(db: Db): Promise<BaseCurrencyInputs> {
  const baseCurrency = await getSetting(db, 'base_currency');
  if (!baseCurrency) return {};
  const depositRate = depositRateOf(await depositRateReader(db));
  if (baseCurrency === 'USD') return { baseCurrency, depositRate };
  const primary = (await roles(db, 'fx')).primary;
  const fx = primary ? await fxPointInTime(db, `USD${baseCurrency}`, primary) : undefined;
  const fxRate = (date: TradingDate) => fx?.asOf(date, cashReadAt(date))?.value;
  return { baseCurrency, fxRate, depositRate };
}
