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
      /** The version's vintage time (see VintageTimes); defaults to `knownAt`. */
      vintageAt?: string;
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
      vintageAt?: string;
      value?: undefined;
    };

/*
 * Vintage time and known time (spec 2026-10-30 restated-vintage; requirements 04, point-in-time
 * series, no look-ahead). A version carries two times:
 * - `vintageAt`: when the source says the version was published (its vintage), or, when the
 *   source gives none, when we fetched it (then equal to `knownAt`, the default).
 * - `knownAt`: when a run could first have had it. A vintage first seen is known from its
 *   publication (the source's history); a later restatement of the same vintage (another value,
 *   or a withdrawal) only from its fetch, so `knownAt >= vintageAt` always (refused otherwise).
 * Among a date's versions known at a moment, the latest vintage counts; among versions of the
 * same vintage, the latest known, then the order given (fetch order). So a restatement never
 * counts before we fetched it, and a restated older vintage never outranks a newer one.
 */

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
  /** Versions per observation in rank order (see above): the last one known at a moment counts. */
  private readonly vintages: Vintage[][] = [];

  /**
   * Versions of one date are ranked by vintage time, then `knownAt`, then the order of `rows`
   * (callers pass rows in fetch order, so a later fetch's restatement of the same vintage known
   * at the same time wins). Refuses a version known before its own vintage time.
   */
  constructor(rows: Vintage[]) {
    const byDate = new Map<TradingDate, Vintage[]>();
    for (const r of rows) {
      if (vintageOf(r) > r.knownAt) {
        throw new Error(
          `${r.date}: a version known at ${r.knownAt}, before its vintage time ${vintageOf(r)}`,
        );
      }
      const list = byDate.get(r.date) ?? [];
      list.push(r);
      byDate.set(r.date, list);
    }
    for (const date of [...byDate.keys()].sort()) {
      this.dates.push(date);
      this.vintages.push(
        byDate
          .get(date)!
          .sort((a, b) => compare(vintageOf(a), vintageOf(b)) || compare(a.knownAt, b.knownAt)),
      );
    }
  }

  /**
   * The latest observation dated on or before `date` that was known at `at`, in its latest
   * version known then. `firstKnown`: when nothing was known yet (before a source's vintage
   * history starts), use the observation's first known version instead (what a read at the
   * earliest `knownAt` of its versions returns), flagged as such; only for backtests that accept
   * it, never for the live pipeline.
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
      const list = this.vintages[j]!;
      const earliest = list.reduce((m, x) => (x.knownAt < m ? x.knownAt : m), list[0]!.knownAt);
      const first = latestKnown(list, earliest);
      if (first && isValue(first)) {
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

const vintageOf = (v: Vintage): string => v.vintageAt ?? v.knownAt;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The version of one observation that counts at `at` (a value or a withdrawal): the last known
 * then in rank order (latest vintage, then latest known, then fetch order).
 */
function latestKnown(list: Vintage[], at: string): Vintage | undefined {
  return list.filter((x) => x.knownAt <= at).at(-1);
}
