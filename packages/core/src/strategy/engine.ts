// The strategy engine (requirements 05, 06): from each ticker's canonical bars to the signals,
// the active allocation and the target holdings per date. Signals use the close of the date;
// trading on them is the execution model's job (next_open by default).
import { totalReturnIndex } from '../adjusted';
import type { RawBar, TradingDate } from '../domain';
import { sma, volatility } from './indicators';
import type {
  Allocation,
  Comparison,
  Condition,
  Holding,
  IndicatorOperand,
  Operand,
  Strategy,
} from './schema';

/** Values within this relative distance of a bound are a tie: the previous state is kept (06). */
export const NEAR_TIE = 1e-9;

export interface StrategyDay {
  date: TradingDate;
  /** Compare signals: true/false; ensembles: the share of members true. */
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

const tickersOf = (o: Operand): string[] => ('ticker' in o ? [o.ticker] : []);
const comparisonsOf = (s: Strategy['signals'][number]): Comparison[] =>
  s.type === 'compare' ? [s] : s.members;

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

const operandKey = (o: IndicatorOperand) =>
  `${o.indicator}:${o.ticker}:${'length' in o ? o.length : ''}:${o.totalReturn ? 'tr' : 'p'}`;

/** One comparison's state through time: tolerance band, near-ties, plain first comparison. */
function compareStep(
  value: number,
  ref: number,
  c: Comparison,
  prev: boolean | undefined,
): { state: boolean; tie: boolean } {
  const t = c.tolerancePct / 100;
  const upper = ref * (1 + t);
  const lower = ref * (1 - t);
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

/**
 * Evaluates a strategy (frequency daily) on every date all its signal tickers have a bar, from
 * the first date every signal is defined (after the warm-up).
 */
export function evaluate(strategy: Strategy, bars: Record<string, RawBar[]>): StrategyDay[] {
  if (strategy.evaluation.frequency !== 'daily') {
    throw new Error('Only daily evaluation is supported so far.');
  }
  const tickers = signalTickers(strategy);
  for (const t of tickers) {
    if (!bars[t]?.length) throw new Error(`No bars for ${t}.`);
  }

  // Each indicator over its ticker's own history, looked up by date.
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
      const s = series(o.ticker, o.totalReturn);
      const v =
        o.indicator === 'price'
          ? s
          : o.indicator === 'sma'
            ? sma(s, o.length)
            : volatility(s, o.length);
      byDate = new Map(bars[o.ticker]!.map((b, i) => [b.date, v[i]]));
      values.set(key, byDate);
    }
    return byDate.get(date);
  };

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
    if (!defined) continue;
    const active: Allocation = strategy.allocations.find(
      (a) => !a.when || conditionHolds(a.when, (id) => truth[id]!),
    )!;
    out.push({ date, signals, allocation: active.name, holdings: active.holdings, ties });
  }
  return out;
}
