// Point-in-time reads (requirements 04): the value of a series or FX rate for trading date D is
// the last value published as of a moment. One function serves the live pipeline and the
// backtester, so a backtest never uses a value the live run could not have had.
import type { TradingDate } from './domain';

/** One version of an observation: a value, or the source's withdrawal of it. */
export type Vintage =
  | {
      /** Observation date. */
      date: TradingDate;
      value: number;
      /** When the value became known (ISO 8601). */
      knownAt: string;
      withdrawn?: false;
    }
  | {
      date: TradingDate;
      /**
       * The source withdrew the date's value at `knownAt` (SeriesWithdrawal in domain.ts): from
       * then on, until a later value, the date has no value.
       */
      withdrawn: true;
      knownAt: string;
      value?: undefined;
    };

type Withdrawal = Extract<Vintage, { withdrawn: true }>;
type Value = Exclude<Vintage, Withdrawal>;
const isValue = (v: Vintage): v is Value => v.withdrawn !== true;

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

  /**
   * Vintages of one date are ordered by `knownAt`; equal `knownAt` keep the order of `rows`
   * (callers pass rows in fetch order, so a later fetch's restatement of the same publication
   * wins).
   */
  constructor(rows: Vintage[]) {
    const byDate = new Map<TradingDate, Vintage[]>();
    for (const r of rows) {
      const list = byDate.get(r.date) ?? [];
      list.push(r);
      byDate.set(r.date, list);
    }
    for (const date of [...byDate.keys()].sort()) {
      this.dates.push(date);
      this.vintages.push(
        byDate
          .get(date)!
          .sort((a, b) => (a.knownAt < b.knownAt ? -1 : a.knownAt > b.knownAt ? 1 : 0)),
      );
    }
  }

  /**
   * The latest observation dated on or before `date` that was known at `at`, in its latest
   * version known then. `firstKnown`: when nothing was known yet (before a source's vintage
   * history starts), use the observation's first known version instead, flagged as such; only
   * for backtests that accept it, never for the live pipeline.
   *
   * Withdrawals (spec 2026-10-30 withdrawn-values; requirements 04, point-in-time series): an
   * observation whose latest version known at `at` is a withdrawal has no value at `at`, so the
   * read looks further back (within LOOK_BACK) as for an observation not yet published. When a
   * withdrawal was known at `at`, the vintage history had started, so `firstKnown` is not used
   * (it would bring back a value the source no longer had). The `firstKnown` fallback itself
   * skips an observation whose first version is a withdrawal (it has no value to give).
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
    let withdrawalKnown = false;
    for (let j = i; j >= 0 && j > i - LOOK_BACK; j--) {
      const v = latestKnown(this.vintages[j]!, at);
      if (!v) continue;
      if (!isValue(v)) {
        withdrawalKnown = true;
        continue;
      }
      return { date: v.date, value: v.value, knownAt: v.knownAt, firstKnown: false };
    }
    if (!o.firstKnown || withdrawalKnown) return undefined;
    for (let j = i; j >= 0 && j > i - LOOK_BACK; j--) {
      const first = this.vintages[j]![0]!;
      if (isValue(first)) {
        return { date: first.date, value: first.value, knownAt: first.knownAt, firstKnown: true };
      }
    }
    return undefined;
  }

  /**
   * Every observation known at `at`, each in its latest version known then, oldest first: the
   * series as a run at `at` could have seen it (checks compare values on exact dates). An
   * observation not yet published at `at` is absent, never filled in; so is one whose latest
   * version known at `at` is a withdrawal.
   */
  knownAt(at: string): { date: TradingDate; value: number }[] {
    const out: { date: TradingDate; value: number }[] = [];
    this.vintages.forEach((list, i) => {
      const v = latestKnown(list, at);
      if (v && isValue(v)) out.push({ date: this.dates[i]!, value: v.value });
    });
    return out;
  }
}

/** The latest version of one observation known at `at` (a value or a withdrawal). */
function latestKnown(list: Vintage[], at: string): Vintage | undefined {
  return list.filter((x) => x.knownAt <= at).at(-1);
}
