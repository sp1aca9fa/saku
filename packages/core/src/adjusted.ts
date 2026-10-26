// Our adjusted series (requirements 04): a forward-accumulated total-return index from raw
// close, dividends and splits, 1.0 on the first date. A new dividend never changes past values,
// so incremental and full recomputation agree exactly.
import type { RawBar } from './domain';

/**
 * The day's total return of holding the fund from the previous close: shares multiply by the
 * split factor, and each share pays the dividend going ex that day.
 * Prices on a split-adjusted basis (`closeIsSplitAdjusted`) already reflect splits.
 */
export function totalReturn(prev: RawBar, bar: RawBar): number {
  const split = bar.closeIsSplitAdjusted ? 1 : bar.splitFactor;
  return ((bar.close + bar.divCash) * split) / prev.close - 1;
}

/** The day's price return without dividends (what an index level or a fund's target tracks). */
export function priceReturn(prev: RawBar, bar: RawBar): number {
  const split = bar.closeIsSplitAdjusted ? 1 : bar.splitFactor;
  return (bar.close * split) / prev.close - 1;
}

/** Total-return index over consecutive bars (sorted by date), starting at `start`. */
export function totalReturnIndex(bars: RawBar[], start = 1): number[] {
  const out: number[] = [];
  let level = start;
  bars.forEach((bar, i) => {
    if (i > 0) level *= 1 + totalReturn(bars[i - 1]!, bar);
    out.push(level);
  });
  return out;
}
