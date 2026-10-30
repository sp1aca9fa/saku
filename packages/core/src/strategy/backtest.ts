// Equity curves (requirements 05, execution model): the strategy's daily decisions traded at the
// next open (default), the next close, or the same close (testfol parity only, not achievable).
// float64 analytics; money amounts come later through decimal.js.
import type { RawBar, TradingDate } from '../domain';
import type { StrategyDay } from './engine';
import type { Holding, Strategy } from './schema';

export const CASH_USD = 'CASH_USD';

/** A synthetic leveraged holding, e.g. `SPY?L=3&E=0.9` (leverage 3, expense 0.9% a year). */
export function parseTicker(ticker: string): {
  base: string;
  leverage: number;
  expensePct: number;
} {
  const [base, query] = ticker.split('?');
  const params = new URLSearchParams(query ?? '');
  return {
    base: base!,
    leverage: Number(params.get('L') ?? 1),
    expensePct: Number(params.get('E') ?? 0),
  };
}

/**
 * Whether the backtest reads the cash rate for a holding (requirements 05, execution model):
 * CASH_USD accrues it, and any leverage other than 1 (an unparsable one included) pays
 * `(leverage - 1)` times it as financing. The one rule; parity's cash health check uses it too.
 */
export function readsCashRate(ticker: string): boolean {
  return ticker === CASH_USD || parseTicker(ticker).leverage !== 1;
}

export interface BacktestInput {
  strategy: Pick<Strategy, 'execution' | 'costs'>;
  days: StrategyDay[];
  /** Bars of every holding's base ticker, sorted by date. */
  bars: Record<string, RawBar[]>;
  /**
   * USD cash rate in percent a year, as known before the date's session (point in time).
   * Undefined when unknown: the backtest then fails only where cash or financing is needed.
   */
  cashRate: (date: TradingDate) => number | undefined;
}

export interface EquityPoint {
  date: TradingDate;
  /** Value at the date's close, 1 at the first decision. */
  equity: number;
  /** Weights held at the close, after any trade that day. */
  weights: Record<string, number>;
  traded: boolean;
}

export interface BacktestResult {
  points: EquityPoint[];
  /** Trades after the first entry. */
  switches: number;
  /** Total costs paid, as a share of equity at each trade, summed. */
  costs: number;
}

type Segment = 'overnight' | 'intraday' | 'day';

/** One ticker's return over part of a session; dividends and splits go to the overnight holder. */
function assetReturn(prev: RawBar, bar: RawBar, segment: Segment, ticker: string): number {
  const split = bar.closeIsSplitAdjusted ? 1 : bar.splitFactor;
  if (segment === 'day') return ((bar.close + bar.divCash) * split) / prev.close - 1;
  if (bar.open === undefined) throw new Error(`${ticker} has no open on ${bar.date}.`);
  if (segment === 'overnight') return ((bar.open + bar.divCash) * split) / prev.close - 1;
  return bar.close / bar.open - 1;
}

const targetWeights = (holdings: Holding[]) =>
  Object.fromEntries(holdings.map((h) => [h.ticker, h.weight / 100]));

/**
 * Two holdings lists are the same position when they list the same tickers at the same weights,
 * in any order (requirements 05 positions; 13 testfol parity: a reorder is no trade, so no
 * switch and no cost). Weights compare exactly. Compared as sorted (ticker, weight) pairs, so a
 * repeated ticker matches only the same repeats: duplicates are never merged into one weight.
 */
export function sameHoldings(a: readonly Holding[], b: readonly Holding[]): boolean {
  if (a.length !== b.length) return false;
  const order = (x: Holding, y: Holding) =>
    x.ticker < y.ticker ? -1 : x.ticker > y.ticker ? 1 : x.weight - y.weight;
  const sa = [...a].sort(order);
  const sb = [...b].sort(order);
  return sa.every((h, i) => h.ticker === sb[i]!.ticker && h.weight === sb[i]!.weight);
}

export function backtest(input: BacktestInput): BacktestResult {
  const { days, strategy } = input;
  const costRate = (strategy.costs.slippageBps ?? 0) / 10_000 + (strategy.costs.feePct ?? 0) / 100;
  const index = new Map<string, Map<TradingDate, number>>();
  const barAt = (ticker: string, date: TradingDate): [RawBar, RawBar] => {
    const list = input.bars[ticker];
    if (!list) throw new Error(`No bars for ${ticker}.`);
    let byDate = index.get(ticker);
    if (!byDate) {
      byDate = new Map(list.map((b, i) => [b.date, i]));
      index.set(ticker, byDate);
    }
    const i = byDate.get(date);
    if (i === undefined || i === 0) throw new Error(`${ticker} has no bar on ${date} or before.`);
    return [list[i - 1]!, list[i]!];
  };
  const holdingReturn = (ticker: string, date: TradingDate, segment: Segment): number => {
    const cashDay = () => {
      const rate = input.cashRate(date);
      if (rate === undefined) throw new Error(`No cash rate known for ${date}.`);
      return rate / 100 / 252;
    };
    const financed = segment !== 'intraday';
    if (ticker === CASH_USD) return financed ? cashDay() : 0;
    const t = parseTicker(ticker);
    const [prev, bar] = barAt(t.base, date);
    const r = t.leverage * assetReturn(prev, bar, segment, t.base);
    if (!financed) return r;
    const financing = readsCashRate(ticker) ? (t.leverage - 1) * cashDay() : 0;
    return r - financing - t.expensePct / 100 / 252;
  };

  let equity = 1;
  let weights: Record<string, number> = {};
  let costs = 0;
  let switches = 0;
  const points: EquityPoint[] = [];
  const grow = (date: TradingDate, segment: Segment) => {
    const entries = Object.entries(weights);
    if (entries.length === 0) return;
    let total = 0;
    const next: Record<string, number> = {};
    for (const [ticker, w] of entries) {
      next[ticker] = w * (1 + holdingReturn(ticker, date, segment));
      total += next[ticker];
    }
    equity *= total;
    weights = Object.fromEntries(Object.entries(next).map(([t, v]) => [t, v / total]));
  };
  const trade = (to: Holding[]) => {
    const target = targetWeights(to);
    const tickers = new Set([...Object.keys(weights), ...Object.keys(target)]);
    let turnover = 0;
    for (const t of tickers) turnover += Math.abs((target[t] ?? 0) - (weights[t] ?? 0));
    const cost = turnover * costRate;
    equity *= 1 - cost;
    costs += cost;
    if (Object.keys(weights).length > 0) switches++;
    weights = target;
  };

  // `pending`: holdings decided at a close, waiting for their execution time.
  let pending: Holding[] | undefined;
  let held: Holding[] | undefined;
  days.forEach((day, i) => {
    let traded = false;
    if (i > 0) {
      if (strategy.execution === 'next_open' && pending) {
        grow(day.date, 'overnight');
        trade(pending);
        held = pending;
        pending = undefined;
        traded = true;
        grow(day.date, 'intraday');
      } else {
        grow(day.date, 'day');
        if (strategy.execution === 'next_close' && pending) {
          trade(pending);
          held = pending;
          pending = undefined;
          traded = true;
        }
      }
    }
    const wanted = pending ?? held;
    if (!wanted || !sameHoldings(wanted, day.holdings)) {
      if (strategy.execution === 'same_close') {
        trade(day.holdings);
        held = day.holdings;
        traded = true;
      } else {
        pending = held && sameHoldings(held, day.holdings) ? undefined : day.holdings;
      }
    }
    points.push({ date: day.date, equity, weights: { ...weights }, traded });
  });
  return { points, switches, costs };
}

/** Compound annual growth over calendar time, and the deepest fall from a previous peak. */
export function summary(points: EquityPoint[]): { cagr: number; maxDrawdown: number } {
  if (points.length < 2) return { cagr: 0, maxDrawdown: 0 };
  const first = points[0]!;
  const last = points.at(-1)!;
  const years = (Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 86_400_000);
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    maxDrawdown = Math.min(maxDrawdown, p.equity / peak - 1);
  }
  return { cagr: (last.equity / first.equity) ** (1 / years) - 1, maxDrawdown };
}
