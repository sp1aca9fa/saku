// Point-in-time reads (requirements 04): the value of a series or FX rate for trading date D is
// the last value published as of a moment. One function serves the live pipeline and the
// backtester, so a backtest never uses a value the live run could not have had.
import type { TradingDate } from './domain';

export interface Vintage {
  /** Observation date. */
  date: TradingDate;
  value: number;
  /** When the value became known (ISO 8601). */
  knownAt: string;
}

export interface AsOfValue {
  date: TradingDate;
  value: number;
  knownAt: string;
  /** True when no vintage was known yet and the first known one was used (labeled look-ahead). */
  firstKnown: boolean;
}

/** How many observations back a read looks for one already known (older is stale anyway). */
const LOOK_BACK = 10;

export class PointInTime {
  private readonly dates: TradingDate[] = [];
  /** Vintages per observation, oldest knowledge first. */
  private readonly vintages: Vintage[][] = [];

  constructor(rows: Vintage[]) {
    const byDate = new Map<TradingDate, Vintage[]>();
    for (const r of rows) {
      const list = byDate.get(r.date) ?? [];
      list.push(r);
      byDate.set(r.date, list);
    }
    for (const date of [...byDate.keys()].sort()) {
      this.dates.push(date);
      this.vintages.push(byDate.get(date)!.sort((a, b) => (a.knownAt < b.knownAt ? -1 : 1)));
    }
  }

  /**
   * The latest observation dated on or before `date` that was known at `at`, in its latest
   * version known then. `firstKnown`: when nothing was known yet (before a source's vintage
   * history starts), use the observation's first known version instead, flagged as such; only
   * for backtests that accept it, never for the live pipeline.
   */
  asOf(date: TradingDate, at: string, o: { firstKnown?: boolean } = {}): AsOfValue | undefined {
    let lo = 0;
    let hi = this.dates.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.dates[mid]! <= date) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (i < 0) return undefined;
    for (let j = i; j >= 0 && j > i - LOOK_BACK; j--) {
      const known = this.vintages[j]!.filter((v) => v.knownAt <= at);
      const v = known.at(-1);
      if (v) return { date: v.date, value: v.value, knownAt: v.knownAt, firstKnown: false };
    }
    if (!o.firstKnown) return undefined;
    const first = this.vintages[i]![0]!;
    return { date: first.date, value: first.value, knownAt: first.knownAt, firstKnown: true };
  }

  /**
   * Every observation known at `at`, each in its latest version known then, oldest first: the
   * series as a run at `at` could have seen it (checks compare values on exact dates). An
   * observation not yet published at `at` is absent, never filled in.
   */
  knownAt(at: string): { date: TradingDate; value: number }[] {
    const out: { date: TradingDate; value: number }[] = [];
    this.vintages.forEach((list, i) => {
      const v = list.filter((x) => x.knownAt <= at).at(-1);
      if (v) out.push({ date: this.dates[i]!, value: v.value });
    });
    return out;
  }
}
