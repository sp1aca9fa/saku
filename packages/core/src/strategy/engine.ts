// The strategy engine (requirements 05, 06): from each ticker's canonical bars to the signals,
// the active allocation and the target holdings per date. Signals use the close of the date;
// trading on them is the execution model's job (next_open by default).
import { totalReturnIndex } from '../adjusted';
import type { RawBar, TradingDate } from '../domain';
import {
  type SeriesBar,
  drawdown,
  ema,
  garmanKlass,
  parkinson,
  periodReturn,
  positive,
  rangeProblem,
  rollingHigh,
  rollingLow,
  sma,
  volatility,
  yangZhang,
} from './indicators';
import {
  type Allocation,
  type Comparison,
  type Condition,
  type Holding,
  type IndicatorOperand,
  type Operand,
  type Strategy,
  comparisonsOf,
  derivedOrder,
  isDerived,
} from './schema';

/** Values within this relative distance of a bound are a tie: the previous state is kept (06). */
export const NEAR_TIE = 1e-9;

export interface StrategyDay {
  date: TradingDate;
  /** Compare and derived (not, and, or) signals: true/false; ensembles: the share of members true. */
  signals: Record<string, boolean | number>;
  allocation: string;
  holdings: Holding[];
  /** Comparisons that were within NEAR_TIE of a bound that day (logged, kept the state). */
  ties: string[];
}

/** Split-adjusted closes on the latest share basis (a later split rescales all of them). */
export function splitAdjusted(bars: RawBar[]): number[] {
  const out = new Array<number>(bars.length);
  let after = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    out[i] = b.closeIsSplitAdjusted ? b.close : b.close / after;
    if (!b.closeIsSplitAdjusted) after *= b.splitFactor;
  }
  return out;
}

/**
 * Each day's open, high and low on the series' basis (docs/indicators.md, B1): scaled by the
 * same factor as the day's series value against its raw close (price: the split adjustment;
 * total return: the index value / the raw close), so ratios within the day (H/L, C/O) are the
 * raw ones and the overnight ratio O_t / C_t-1 includes the day's dividend and split. A field the
 * source did not give stays missing (never estimated from the close).
 *
 * The close is scaled the same way (raw close x factor, the series value up to rounding) rather
 * than taken from the series: multiplying all four by one positive number keeps their equalities
 * and order exact in floating point, so a consistent day (low <= open, close <= high) stays
 * consistent and a flat one (high = low) gives exactly 0, never a rounding-made negative variance
 * that would read as inconsistent data on one history and not on another (incremental = full).
 */
export function onSeriesBasis(bars: RawBar[], series: number[]): SeriesBar[] {
  return bars.map((b, i) => {
    const factor = series[i]! / b.close;
    const scaled = (v: number | undefined) => (v === undefined ? undefined : v * factor);
    return {
      open: scaled(b.open),
      high: scaled(b.high),
      low: scaled(b.low),
      close: b.close * factor,
    };
  });
}

const tickersOf = (o: Operand): string[] => ('ticker' in o ? [o.ticker] : []);

/** Every ticker the signals read (holdings are not needed to evaluate). */
export function signalTickers(s: Strategy): string[] {
  return [
    ...new Set(
      s.signals
        .flatMap(comparisonsOf)
        .flatMap((c) => [...tickersOf(c.left), ...tickersOf(c.right)]),
    ),
  ];
}

/**
 * How many of a ticker's own latest bars, up to and including a date, an indicator operand's
 * value on that date reads (the formulas in docs/indicators.md, requirements 06; 0 for a
 * threshold): a price 1 bar; an SMA, N-day high or low, N-day drawdown, Parkinson or Garman-Klass
 * volatility of n n bars; a close-to-close volatility or a return over n days n + 1 bars (n
 * returns); a Yang-Zhang volatility of n n + 1 bars (the close before its window). An EMA and the
 * all-time drawdown read every bar since the series' first one: Infinity (any bar of the ticker
 * is inside their lookback; a stand-in at any age counts, erring toward counting).
 */
export function operandBars(o: Operand): number {
  if (!('ticker' in o)) return 0;
  switch (o.indicator) {
    case 'price':
      return 1;
    case 'sma':
    case 'high':
    case 'low':
      return o.length;
    case 'return':
      return o.length + 1;
    case 'ema':
      return Infinity;
    case 'drawdown':
      return o.length ?? Infinity;
    case 'volatility':
      return o.method === 'parkinson' || o.method === 'garman_klass' ? o.length : o.length + 1;
  }
}

/**
 * Per signal ticker: the longest lookback of its operands (`operandBars`), and whether any
 * operand reads its total-return series. A signal's state can still carry an older value through
 * its tolerance band (the previous state is kept inside it); that is the state on the day before,
 * decided then.
 */
export function signalLookbacks(s: Strategy): Map<string, { bars: number; totalReturn: boolean }> {
  const out = new Map<string, { bars: number; totalReturn: boolean }>();
  for (const c of s.signals.flatMap(comparisonsOf)) {
    for (const o of [c.left, c.right]) {
      if (!('ticker' in o)) continue;
      const bars = operandBars(o);
      const prev = out.get(o.ticker);
      out.set(o.ticker, {
        bars: Math.max(prev?.bars ?? 0, bars),
        totalReturn: (prev?.totalReturn ?? false) || o.totalReturn,
      });
    }
  }
  return out;
}

const operandKey = (o: IndicatorOperand) =>
  [
    o.indicator,
    o.ticker,
    'length' in o ? (o.length ?? 'all') : '',
    o.indicator === 'volatility' ? (o.method ?? 'close') : '',
    o.totalReturn ? 'tr' : 'p',
  ].join(':');

/** An indicator operand's values over its ticker's bars (`series`: price or total return). */
function indicatorValues(o: IndicatorOperand, bars: RawBar[], s: number[]): (number | undefined)[] {
  switch (o.indicator) {
    case 'price':
      return s;
    case 'sma':
      return sma(s, o.length);
    case 'ema':
      return ema(s, o.length);
    case 'return':
      return periodReturn(s, o.length);
    case 'drawdown':
      return drawdown(s, o.length);
    case 'high':
      return rollingHigh(s, o.length);
    case 'low':
      return rollingLow(s, o.length);
    case 'volatility':
      switch (o.method ?? 'close') {
        case 'close':
          return volatility(s, o.length);
        case 'parkinson':
          return parkinson(onSeriesBasis(bars, s), o.length);
        case 'garman_klass':
          return garmanKlass(onSeriesBasis(bars, s), o.length);
        case 'yang_zhang':
          return yangZhang(onSeriesBasis(bars, s), o.length);
      }
  }
}

/**
 * One comparison's state through time: tolerance band, near-ties, plain first comparison.
 *
 * The band is the reference +- |reference| x t/100 (docs/indicators.md "Signals", compare;
 * decisions log 2026-11-01; requirements 05 "symmetric hysteresis"): for a positive reference
 * that is 05's reference x (1 +- t/100); the absolute value keeps the upper bound above the lower
 * one when the reference is negative (a drawdown, a negative return), where reference x (1 + t/100)
 * would be the lower bound and the band would be inverted. Computed as the two products
 * reference x (1 +- t/100), the larger the upper bound: equal to reference +- |reference| x t/100
 * (up to rounding, well inside the near-tie rule), and bit for bit what it was for a positive
 * reference. A reference of exactly 0 gives a band of no width (owner question C27).
 */
export function compareStep(
  value: number,
  ref: number,
  c: Pick<Comparison, 'op' | 'tolerancePct'>,
  prev: boolean | undefined,
): { state: boolean; tie: boolean } {
  const t = c.tolerancePct / 100;
  const a = ref * (1 + t);
  const b = ref * (1 - t);
  const upper = ref < 0 ? b : a;
  const lower = ref < 0 ? a : b;
  const near = (a: number, b: number) => Math.abs(a - b) <= NEAR_TIE * Math.abs(b);
  const tie = near(value, upper) || near(value, lower);
  const above = value > upper && !near(value, upper);
  const below = value < lower && !near(value, lower);
  if (prev === undefined) {
    // The first valid day: a plain comparison (a tie counts as not true).
    const plain = c.op === '>' ? value > ref : value < ref;
    return { state: plain && !near(value, ref), tie };
  }
  if (c.op === '>') return { state: above ? true : below ? false : prev, tie };
  return { state: below ? true : above ? false : prev, tie };
}

function conditionHolds(when: Condition, on: (id: string) => boolean): boolean {
  return (
    (when.all ?? []).every(on) &&
    ((when.any ?? []).length === 0 || (when.any ?? []).some(on)) &&
    !(when.none ?? []).some(on)
  );
}

/** Each indicator over its ticker's own history, looked up by date (computed once per operand). */
function context(bars: Record<string, RawBar[]>) {
  const values = new Map<string, Map<TradingDate, number | undefined>>();
  const seriesCache = new Map<string, number[]>();
  const series = (ticker: string, totalReturn: boolean) => {
    const key = `${ticker}:${totalReturn}`;
    let s = seriesCache.get(key);
    if (!s) {
      s = totalReturn ? totalReturnIndex(bars[ticker]!) : splitAdjusted(bars[ticker]!);
      seriesCache.set(key, s);
    }
    return s;
  };
  const lookup = (o: Operand, date: TradingDate): number | undefined => {
    if ('threshold' in o) return o.threshold;
    const key = operandKey(o);
    let byDate = values.get(key);
    if (!byDate) {
      const v = indicatorValues(o, bars[o.ticker]!, series(o.ticker, o.totalReturn));
      byDate = new Map(bars[o.ticker]!.map((b, i) => [b.date, v[i]]));
      values.set(key, byDate);
    }
    return byDate.get(date);
  };
  return { series, lookup };
}

/** An operand's name in reason codes: the indicator, or a volatility's method other than close. */
const operandName = (o: IndicatorOperand) =>
  o.indicator === 'volatility' && o.method && o.method !== 'close' ? o.method : o.indicator;

/**
 * Why `date` has no decision (`evaluate` gave none), as reason codes naming the ticker, the
 * indicator and the day at fault (requirements 04: the instruction says what is wrong), for each
 * operand without a value that date:
 * - `T:range_missing(<method>)@<day>`: a range volatility's window holds a day without an open,
 *   high or low (never estimated);
 * - `T:range_invalid(<method>)@<day>`: ... a day whose open, high, low and close are inconsistent
 *   (an open or close outside [low, high], a high below the low) or not positive;
 * - `T:value_invalid(<indicator>)@<day>`: a value it reads is not positive or not finite;
 * - `T:warm_up(<indicator>)`: not enough history yet;
 * - `T:no_value(<indicator>)`: none of these found (a negative variance from rounding, say).
 * Empty when every operand has a value (a signal ticker without a bar that day: its data health
 * says so).
 */
export function whyUndecided(
  strategy: Strategy,
  bars: Record<string, RawBar[]>,
  date: TradingDate,
): string[] {
  const { series, lookup } = context(bars);
  const out: string[] = [];
  const add = (code: string) => {
    if (!out.includes(code)) out.push(code);
  };
  for (const c of strategy.signals.flatMap(comparisonsOf)) {
    for (const o of [c.left, c.right]) {
      if ('threshold' in o) continue;
      const list = bars[o.ticker];
      const i = list?.findIndex((b) => b.date === date) ?? -1;
      if (i < 0 || lookup(o, date) !== undefined) continue;
      const name = operandName(o);
      const t = `${o.ticker}:`;
      const from = firstRead(o, i);
      if (from < 0) {
        add(`${t}warm_up(${name})`);
        continue;
      }
      const s = series(o.ticker, o.totalReturn);
      let found = false;
      const fault = (code: string) => {
        found = true;
        add(code);
      };
      if (o.indicator === 'volatility' && name !== 'volatility') {
        const days = onSeriesBasis(list!, s);
        // Yang-Zhang reads only the close of the day before its window.
        const first = name === 'yang_zhang' ? from + 1 : from;
        if (name === 'yang_zhang' && !positive(days[from]!.close)) {
          fault(`${t}value_invalid(${name})@${list![from]!.date}`);
        }
        for (let j = first; j <= i; j++) {
          const p = rangeProblem(days[j]!);
          if (p) fault(`${t}range_${p}(${name})@${list![j]!.date}`);
        }
      } else {
        // `return` reads its two ends; the others every value of their window.
        const read =
          o.indicator === 'return'
            ? [from, i]
            : Array.from({ length: i - from + 1 }, (_, k) => from + k);
        const usable = o.indicator === 'return' || o.indicator === 'drawdown' ? positive : isFinite;
        for (const j of read) {
          if (!usable(s[j]!)) fault(`${t}value_invalid(${name})@${list![j]!.date}`);
        }
      }
      if (!found) add(`${t}no_value(${name})`);
    }
  }
  return out;
}

const isFinite = (v: number) => Number.isFinite(v);

/**
 * The first of its ticker's bars an operand's value at bar `i` reads (docs/indicators.md, the
 * warm-up column), or -1 when the history is too short: an EMA and the all-time drawdown read
 * from the first bar.
 */
function firstRead(o: IndicatorOperand, i: number): number {
  switch (o.indicator) {
    case 'price':
      return i;
    case 'sma':
    case 'high':
    case 'low':
      return i - o.length + 1;
    case 'ema':
      return i < o.length - 1 ? -1 : 0;
    case 'return':
      return i - o.length;
    case 'drawdown':
      return o.length === undefined ? 0 : i - o.length + 1;
    case 'volatility':
      return o.method === 'parkinson' || o.method === 'garman_klass'
        ? i - o.length + 1
        : i - o.length;
  }
}

/**
 * Evaluates a strategy (frequency daily) on every date all its signal tickers have a bar, from
 * the first date every signal is defined (after the warm-up). A later date where an operand has
 * no value (a range-based volatility whose window holds a day without an open, high or low, or
 * with a data error) is not evaluated either: no decision that day, never a guessed value.
 */
export function evaluate(strategy: Strategy, bars: Record<string, RawBar[]>): StrategyDay[] {
  if (strategy.evaluation.frequency !== 'daily') {
    throw new Error('Only daily evaluation is supported so far.');
  }
  const tickers = signalTickers(strategy);
  for (const t of tickers) {
    if (!bars[t]?.length) throw new Error(`No bars for ${t}.`);
  }

  const { lookup } = context(bars);
  const order = derivedOrder(strategy.signals);

  const dateSets = tickers.map((t) => new Set(bars[t]!.map((b) => b.date)));
  const dates =
    tickers.length === 0
      ? []
      : [...dateSets[0]!].filter((d) => dateSets.every((s) => s.has(d))).sort();

  const state = new Map<string, boolean>();
  const out: StrategyDay[] = [];
  for (const date of dates) {
    const ties: string[] = [];
    const signals: Record<string, boolean | number> = {};
    const truth: Record<string, boolean> = {};
    let defined = true;
    for (const s of strategy.signals) {
      if (isDerived(s)) continue;
      const results = comparisonsOf(s).map((c, i) => {
        const key = `${s.id}#${i}`;
        const value = lookup(c.left, date);
        const ref = lookup(c.right, date);
        if (value === undefined || ref === undefined) return undefined;
        const r = compareStep(value, ref, c, state.get(key));
        state.set(key, r.state);
        if (r.tie) ties.push(s.type === 'compare' ? s.id : key);
        return r.state;
      });
      if (results.some((r) => r === undefined)) {
        defined = false;
        continue;
      }
      if (s.type === 'compare') {
        signals[s.id] = truth[s.id] = results[0]!;
      } else {
        const share = results.filter(Boolean).length / results.length;
        signals[s.id] = share;
        truth[s.id] = share >= s.threshold;
      }
    }
    // Derived signals (docs/indicators.md "Signals"), after every signal they read: true/false
    // from the inputs' states that date (an ensemble's state: its share against its threshold),
    // no state or near-tie of their own. Defined when every input is.
    for (const s of order) {
      const inputs = (s.type === 'not' ? [s.of] : s.of).map((id) => truth[id]);
      if (inputs.some((v) => v === undefined)) {
        defined = false;
        continue;
      }
      truth[s.id] =
        s.type === 'not'
          ? !inputs[0]
          : s.type === 'and'
            ? inputs.every(Boolean)
            : inputs.some(Boolean);
    }
    if (!defined) continue;
    // After the compare and ensemble signals, each in file order (not the order of evaluation).
    for (const s of strategy.signals) if (isDerived(s)) signals[s.id] = truth[s.id]!;
    const active: Allocation = strategy.allocations.find(
      (a) => !a.when || conditionHolds(a.when, (id) => truth[id]!),
    )!;
    out.push({ date, signals, allocation: active.name, holdings: active.holdings, ties });
  }
  return out;
}
