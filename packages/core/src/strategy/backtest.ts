// Equity curves (requirements 05, execution model): the strategy's daily decisions traded at the
// next open (default), the next close, or the same close (testfol parity only, not achievable).
// float64 analytics; the whole-share option (docs/indicators.md "Whole shares") gives USD amounts
// as float64 estimates.
import type { RawBar, TradingDate } from '../domain';
import type { StrategyDay } from './engine';
import type { Holding, Strategy } from './schema';
import { CASH_USD, parseTicker } from './ticker';

export { CASH_USD, parseTicker };

/**
 * Whether the backtest reads the cash rate for a holding (requirements 05, execution model):
 * CASH_USD accrues it, and any leverage other than 1 pays `(leverage - 1)` times it as financing.
 * The one rule; parity's cash health check uses it too. Throws on a malformed ticker
 * (`parseTicker`), which a parsed strategy does not have.
 */
export function readsCashRate(ticker: string): boolean {
  return ticker === CASH_USD || parseTicker(ticker).leverage !== 1;
}

export interface BacktestInput {
  /**
   * The safe state is the decision of a session without an evaluated day (`sessions`); a
   * backtest that meets one without it fails rather than guess.
   */
  strategy: Pick<Strategy, 'execution' | 'costs'> &
    Partial<Pick<Strategy, 'safeState' | 'allocations'>>;
  days: StrategyDay[];
  /**
   * Bars sorted by date of every ticker the strategy reads or may hold, its safe state's included
   * (`strategyTickers`). The dates every ticker it may hold has are the sessions (`sessions`).
   */
  bars: Record<string, RawBar[]>;
  /**
   * USD cash rate in percent a year, as known before the date's session (point in time).
   * Undefined when unknown: the backtest then fails only where cash or financing is needed.
   */
  cashRate: (date: TradingDate) => number | undefined;
  /**
   * Whole shares of a starting amount instead of fractional weights (docs/indicators.md "Equity
   * curves", "Whole shares"): a run setting, not part of the strategy. Without it, the fractional
   * results are unchanged.
   */
  wholeShares?: WholeShares;
}

/** Where a trade executes: the session's open (`next_open`) or its close. */
export type ExecutionPoint = 'open' | 'close';

/** A USD amount, a float64 estimate (docs/indicators.md "Whole shares"). */
export interface UsdAmount {
  amount: number;
  currency: 'USD';
}

export interface WholeShares {
  /** Plain decimal text above 0 (`"1000"`, `"2500.50"`). */
  initialAmount: string;
  /** Only `USD` for now; another currency is refused (base-currency cash and FX come later). */
  currency: string;
}

export interface WholeShareTrade {
  date: TradingDate;
  at: ExecutionPoint;
  /** The value at the execution prices before the trade (V). */
  value: UsdAmount;
  /** Shares of each non-cash ticker of the target after the trade, 0 included. */
  shares: Record<string, number>;
  /** The target's non-cash tickers that got 0 shares (reported, not an error). */
  zeroShares: string[];
  /** Held as CASH_USD until the next trade. */
  residualCash: UsdAmount;
  costs: UsdAmount;
}

export interface WholeShareResult {
  initialAmount: { amount: string; currency: 'USD' };
  trades: WholeShareTrade[];
}

export interface EquityPoint {
  date: TradingDate;
  /** False on a session without an evaluated day: its decision was the safe state. */
  decided: boolean;
  /** Value at the date's close, 1 at the first decision. */
  equity: number;
  /** Weights held at the close, after any trade that day. */
  weights: Record<string, number>;
  /** With whole shares only: the USD value at the date's close (initial amount until the first trade). */
  value?: number;
  traded: boolean;
}

export interface BacktestResult {
  points: EquityPoint[];
  /** Trades after the first entry. */
  switches: number;
  /** Total costs paid, as a share of equity at each trade, summed. */
  costs: number;
  /** With whole shares only: the initial amount and each trade's shares, residual cash and costs. */
  wholeShares?: WholeShareResult;
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

/**
 * The base tickers of every holding the strategy may take (any allocation's and the safe
 * state's): cash has no bars (it reads the rate), a synthetic ticker reads its base's bars.
 */
export function heldTickers(holdings: readonly Holding[]): string[] {
  return [
    ...new Set(
      holdings
        .map((h) => h.ticker)
        .filter((t) => t !== CASH_USD)
        .map((t) => parseTicker(t).base),
    ),
  ].sort();
}

/**
 * The sessions an equity curve runs over (docs/indicators.md "Equity curves", "Days without a
 * decision"): every date on which every ticker the strategy may hold (`held`: any allocation's
 * holdings and the safe state's, through their base ticker) has a bar, from the first evaluated
 * date on, and every evaluated day. A session that is not an evaluated day (an operand had no
 * value, or a ticker the signals read had no bar) still counts: the holdings' returns of every
 * session are compounded, never skipped, and its decision is the strategy's safe state, traded
 * like any decision (as the forward record does on a day without a decision). A ticker it may
 * hold without bars fails: callers load every one, the safe state's included.
 */
export function sessions(
  days: StrategyDay[],
  bars: Record<string, RawBar[]>,
  held: readonly string[],
): TradingDate[] {
  if (days.length === 0) return [];
  const first = days.reduce((a, d) => (d.date < a ? d.date : a), days[0]!.date);
  const count = new Map<TradingDate, number>();
  for (const t of held) {
    const list = bars[t];
    if (!list) throw new Error(`No bars for ${t}.`);
    for (const b of list) count.set(b.date, (count.get(b.date) ?? 0) + 1);
  }
  const out = new Set<TradingDate>(days.map((d) => d.date));
  for (const [date, n] of count) if (n === held.length && date >= first) out.add(date);
  return [...out].sort();
}

/** The bookkeeping of an equity curve: fractional weights (default) or whole shares. */
interface Book {
  /** Compounds one part of a session (`Segment`) over what is held. */
  grow(date: TradingDate, segment: Segment): void;
  /** Trades to `to` at the session's open or close. */
  trade(to: Holding[], date: TradingDate, at: ExecutionPoint): void;
  /** The point's values at the date's close. */
  close(date: TradingDate): { equity: number; weights: Record<string, number>; value?: number };
  costs(): number;
  switches(): number;
}

/** The fractional book (docs/indicators.md "Equity curves": weights, costs on turnover). */
function fractionalBook(
  costRate: number,
  holdingReturn: (ticker: string, date: TradingDate, segment: Segment) => number,
): Book {
  let equity = 1;
  let weights: Record<string, number> = {};
  let costs = 0;
  let switches = 0;
  return {
    grow(date, segment) {
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
    },
    trade(to) {
      const target = targetWeights(to);
      const tickers = new Set([...Object.keys(weights), ...Object.keys(target)]);
      let turnover = 0;
      for (const t of tickers) turnover += Math.abs((target[t] ?? 0) - (weights[t] ?? 0));
      const cost = turnover * costRate;
      equity *= 1 - cost;
      costs += cost;
      if (Object.keys(weights).length > 0) switches++;
      weights = target;
    },
    close: () => ({ equity, weights: { ...weights } }),
    costs: () => costs,
    switches: () => switches,
  };
}

/** Plain decimal text: digits, optionally a point and digits (no sign, exponent or spaces). */
const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

/** The initial amount of a whole-share run, or a refusal with the reason. */
function wholeSharesAmount(ws: WholeShares): number {
  if (ws.currency !== 'USD') {
    throw new Error(
      `Whole shares in ${JSON.stringify(ws.currency)} are refused: only USD for now (base-currency cash and FX come later).`,
    );
  }
  if (typeof ws.initialAmount !== 'string' || !DECIMAL_TEXT.test(ws.initialAmount)) {
    throw new Error(
      `Whole shares: the initial amount ${JSON.stringify(ws.initialAmount)} is not plain decimal text.`,
    );
  }
  const amount = Number(ws.initialAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Whole shares: the initial amount must be above 0 (${ws.initialAmount}).`);
  }
  return amount;
}

/** Relative distance within which a float product counts as the whole number (float noise). */
const NEAR_WHOLE = 1e-9;

const usd = (amount: number): UsdAmount => ({ amount, currency: 'USD' });

/**
 * The whole-share book (docs/indicators.md "Equity curves", "Whole shares"; requirements 05
 * "Execution model", small amounts): whole share counts and a USD residual cash, sized at each
 * trade on a budget that sets the sale cost of everything held aside first, so the residual
 * never goes below 0. Float64 amounts (estimates).
 */
function wholeBook(deps: {
  initial: number;
  costRate: number;
  /** The first session: a synthetic ticker's price starts at its base's close there. */
  first: TradingDate;
  cashDay: (date: TradingDate) => number;
  holdingReturn: (ticker: string, date: TradingDate, segment: Segment) => number;
  barOn: (ticker: string, date: TradingDate) => RawBar;
}): Book & { trades: WholeShareTrade[] } {
  const { initial, costRate: c } = deps;
  let shares = new Map<string, number>();
  let cash = initial;
  let entered = false;
  let costs = 0;
  let switches = 0;
  const trades: WholeShareTrade[] = [];
  // Every part of a session the backtest compounded, in order: a synthetic ticker's price
  // follows them whether held or not, applied when its price is needed (so the cash rate for
  // its financing is read only then).
  const steps: { date: TradingDate; segment: Segment }[] = [];
  const synthetic = new Map<string, { level: number; next: number }>();
  const isSynthetic = (ticker: string) => ticker !== parseTicker(ticker).base;
  const level = (ticker: string): number => {
    let s = synthetic.get(ticker);
    if (!s) {
      s = { level: deps.barOn(parseTicker(ticker).base, deps.first).close, next: 0 };
      synthetic.set(ticker, s);
    }
    while (s.next < steps.length) {
      const step = steps[s.next]!;
      s.level *= 1 + deps.holdingReturn(ticker, step.date, step.segment);
      s.next++;
    }
    return s.level;
  };
  const price = (ticker: string, date: TradingDate, at: ExecutionPoint): number => {
    if (isSynthetic(ticker)) return level(ticker);
    const bar = deps.barOn(ticker, date);
    const p = at === 'open' ? bar.open : bar.close;
    if (p === undefined) throw new Error(`${ticker} has no open on ${date}.`);
    return p;
  };

  return {
    trades,
    grow(date, segment) {
      steps.push({ date, segment });
      if (!entered) return;
      // The residual earns the cash rate per night, like CASH_USD; read only while above 0.
      if (segment !== 'intraday' && cash > 0) cash *= 1 + deps.cashDay(date);
      const next = new Map<string, number>();
      for (const [ticker, n] of shares) {
        if (isSynthetic(ticker) || segment === 'intraday') {
          if (isSynthetic(ticker)) level(ticker);
          next.set(ticker, n);
          continue;
        }
        // Ex-date (night part or whole day): split first, then the dividend per share after
        // the split goes to cash; a split's fraction is paid as cash at the part's end price.
        const bar = deps.barOn(ticker, date);
        const end = segment === 'overnight' ? bar.open : bar.close;
        if (end === undefined) throw new Error(`${ticker} has no open on ${date}.`);
        const split = n * bar.splitFactor;
        const whole = Math.round(split);
        const snapped = Math.abs(split - whole) <= NEAR_WHOLE * Math.abs(split);
        const kept = snapped ? whole : Math.floor(split);
        if (!snapped) cash += (split - kept) * end;
        cash += kept * bar.divCash;
        if (kept > 0) next.set(ticker, kept);
      }
      shares = next;
    },
    trade(to, date, at) {
      const target = new Map<string, number>();
      for (const h of to) {
        if (target.has(h.ticker)) {
          throw new Error(`${h.ticker} is listed twice in the holdings traded on ${date}.`);
        }
        target.set(h.ticker, h.weight / 100);
      }
      const tickers = [...new Set([...shares.keys(), ...target.keys()])]
        .filter((t) => t !== CASH_USD)
        .sort();
      const prices = new Map(tickers.map((t) => [t, price(t, date, at)]));
      for (const [t, p] of prices) {
        if (!(p > 0) || !Number.isFinite(p)) {
          throw new Error(
            `${t} is priced ${p} at the ${at} of ${date}: whole shares cannot be bought or sold.`,
          );
        }
      }
      let held = 0;
      for (const [t, n] of shares) held += n * prices.get(t)!;
      const value = cash + held;
      const budget = value - c * held;
      const next = new Map<string, number>();
      const zeroShares: string[] = [];
      for (const [t, w] of target) {
        if (t === CASH_USD) continue;
        const n = Math.max(0, Math.floor((w * budget) / (prices.get(t)! * (1 + c))));
        next.set(t, n);
        if (n === 0) zeroShares.push(t);
      }
      let traded = 0;
      for (const t of tickers) {
        traded += Math.abs((next.get(t) ?? 0) - (shares.get(t) ?? 0)) * prices.get(t)!;
      }
      let bought = 0;
      for (const [t, n] of next) bought += n * prices.get(t)!;
      const cost = c * traded;
      let residual = value - bought - cost;
      if (residual < 0) {
        // Exact arithmetic keeps it at 0 or above (docs/indicators.md "Whole shares"); below 0
        // by more than float noise is a fault, never a silent clamp.
        if (residual < -NEAR_WHOLE * value) {
          throw new Error(`Whole shares on ${date}: the residual cash ${residual} is below 0.`);
        }
        residual = 0;
      }
      shares = new Map([...next].filter(([, n]) => n > 0));
      cash = residual;
      costs += cost / value;
      if (entered) switches++;
      entered = true;
      trades.push({
        date,
        at,
        value: usd(value),
        shares: Object.fromEntries(next),
        zeroShares,
        residualCash: usd(residual),
        costs: usd(cost),
      });
    },
    close(date) {
      if (!entered) return { equity: 1, weights: {}, value: initial };
      let value = cash;
      const parts: [string, number][] = [];
      for (const [t, n] of shares) {
        const v = n * (isSynthetic(t) ? level(t) : deps.barOn(t, date).close);
        parts.push([t, v]);
        value += v;
      }
      if (cash > 0) parts.push([CASH_USD, cash]);
      return {
        equity: value / initial,
        weights: Object.fromEntries(parts.map(([t, v]) => [t, v / value])),
        value,
      };
    },
    costs: () => costs,
    switches: () => switches,
  };
}

export function backtest(input: BacktestInput): BacktestResult {
  const { strategy } = input;
  const decided = new Map(input.days.map((d) => [d.date, d]));
  // What it may hold: every allocation and the safe state (the strategy's own lists), and what
  // the days hold (for a caller passing days only).
  const holdable = heldTickers([
    ...(strategy.allocations ?? []).flatMap((a) => a.holdings),
    ...(strategy.safeState?.holdings ?? []),
    ...input.days.flatMap((d) => d.holdings),
  ]);
  const initial = input.wholeShares && wholeSharesAmount(input.wholeShares);
  const days = sessions(input.days, input.bars, holdable).map((date) => {
    const day = decided.get(date);
    if (day) return { date, holdings: day.holdings, decided: true };
    if (!strategy.safeState) {
      throw new Error(`${date} has no decision and the strategy no safe state to take.`);
    }
    return { date, holdings: strategy.safeState.holdings, decided: false };
  });
  const costRate = (strategy.costs.slippageBps ?? 0) / 10_000 + (strategy.costs.feePct ?? 0) / 100;
  const index = new Map<string, Map<TradingDate, number>>();
  const positionOf = (ticker: string, date: TradingDate): [RawBar[], number | undefined] => {
    const list = input.bars[ticker];
    if (!list) throw new Error(`No bars for ${ticker}.`);
    let byDate = index.get(ticker);
    if (!byDate) {
      byDate = new Map(list.map((b, i) => [b.date, i]));
      index.set(ticker, byDate);
    }
    return [list, byDate.get(date)];
  };
  const barAt = (ticker: string, date: TradingDate): [RawBar, RawBar] => {
    const [list, i] = positionOf(ticker, date);
    if (i === undefined || i === 0) throw new Error(`${ticker} has no bar on ${date} or before.`);
    return [list[i - 1]!, list[i]!];
  };
  const barOn = (ticker: string, date: TradingDate): RawBar => {
    const [list, i] = positionOf(ticker, date);
    if (i === undefined) throw new Error(`${ticker} has no bar on ${date}.`);
    return list[i]!;
  };
  const cashDay = (date: TradingDate) => {
    const rate = input.cashRate(date);
    if (rate === undefined) throw new Error(`No cash rate known for ${date}.`);
    return rate / 100 / 252;
  };
  const holdingReturn = (ticker: string, date: TradingDate, segment: Segment): number => {
    const financed = segment !== 'intraday';
    if (ticker === CASH_USD) return financed ? cashDay(date) : 0;
    const t = parseTicker(ticker);
    const [prev, bar] = barAt(t.base, date);
    const r = t.leverage * assetReturn(prev, bar, segment, t.base);
    if (!financed) return r;
    const financing = readsCashRate(ticker) ? (t.leverage - 1) * cashDay(date) : 0;
    return r - financing - t.expensePct / 100 / 252;
  };

  let whole: ReturnType<typeof wholeBook> | undefined;
  if (initial !== undefined) {
    // Prices as traded: a share count on today's split basis is not one anyone held.
    for (const base of holdable) {
      if (input.bars[base]!.some((b) => b.closeIsSplitAdjusted)) {
        throw new Error(`Whole shares need prices as traded: ${base}'s bars are split-adjusted.`);
      }
    }
    // Below 1 the budget (value - c x held) stays above 0, so the residual cannot go below 0.
    if (!(costRate >= 0 && costRate < 1)) {
      throw new Error(`Whole shares need a cost rate from 0 to below 100% (${costRate}).`);
    }
    if (days.length > 0) {
      whole = wholeBook({ initial, costRate, first: days[0]!.date, cashDay, holdingReturn, barOn });
    }
  }
  const book: Book = whole ?? fractionalBook(costRate, holdingReturn);

  const points: EquityPoint[] = [];
  const pushPoint = (date: TradingDate, isDecided: boolean, traded: boolean) => {
    const c = book.close(date);
    points.push({
      date,
      decided: isDecided,
      equity: c.equity,
      weights: c.weights,
      ...(c.value !== undefined && { value: c.value }),
      traded,
    });
  };

  // `pending`: holdings decided at a close, waiting for their execution time.
  let pending: Holding[] | undefined;
  let held: Holding[] | undefined;
  days.forEach((day, i) => {
    let traded = false;
    if (i > 0) {
      if (strategy.execution === 'next_open' && pending) {
        book.grow(day.date, 'overnight');
        book.trade(pending, day.date, 'open');
        held = pending;
        pending = undefined;
        traded = true;
        book.grow(day.date, 'intraday');
      } else {
        book.grow(day.date, 'day');
        if (strategy.execution === 'next_close' && pending) {
          book.trade(pending, day.date, 'close');
          held = pending;
          pending = undefined;
          traded = true;
        }
      }
    }
    const wanted = pending ?? held;
    if (!wanted || !sameHoldings(wanted, day.holdings)) {
      if (strategy.execution === 'same_close') {
        book.trade(day.holdings, day.date, 'close');
        held = day.holdings;
        traded = true;
      } else {
        pending = held && sameHoldings(held, day.holdings) ? undefined : day.holdings;
      }
    }
    pushPoint(day.date, day.decided, traded);
  });
  return {
    points,
    switches: book.switches(),
    costs: book.costs(),
    ...(input.wholeShares && {
      wholeShares: {
        initialAmount: { amount: input.wholeShares.initialAmount, currency: 'USD' as const },
        trades: whole?.trades ?? [],
      },
    }),
  };
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
