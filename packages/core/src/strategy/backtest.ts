// Equity curves (requirements 05, execution model): the strategy's daily decisions traded at the
// next open (default), the next close, or the same close (testfol parity only, not achievable).
// float64 analytics; the whole-share option (docs/indicators.md "Whole shares") gives USD amounts
// as float64 estimates. Base currency (docs/indicators.md "Base currency", "Base-currency cash",
// "FX spread"): an optional base-currency series, CASH_BASE and the FX spread on conversions.
import { totalReturn } from '../adjusted';
import type { RawBar, TradingDate } from '../domain';
import type { StrategyDay } from './engine';
import type { Holding, Strategy } from './schema';
import { CASH_BASE, CASH_USD, isCash, parseTicker } from './ticker';

export { CASH_BASE, CASH_USD, isCash, parseTicker };

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
  /**
   * Reads an omitted slippage or fee as 0 (docs/indicators.md "Equity curves", "Costs"). Only for
   * versions registered before C2 froze the effective costs into them (run as recorded) and
   * testfol parity cases; without it an omitted cost fails ("costs not resolved"). Never for
   * drafts or analytics: resolve with the install's `broker_costs` first.
   */
  omittedCostsAsZero?: boolean;
  /**
   * The install's base currency, an ISO 4217 code (docs/indicators.md "Base currency"). With it the
   * result has the base-currency series (`base`); without it nothing changes, and a strategy that
   * may hold CASH_BASE is refused.
   */
  baseCurrency?: string;
  /**
   * The valuation rate USD to base (base-currency units per USD) for a session, as known before
   * the session opens (read through asOf). Undefined when unknown. Never read with base USD (1).
   */
  fxRate?: (date: TradingDate) => number | undefined;
  /**
   * The base currency's deposit rate in percent a year in force on the date (`depositRateAsOf`).
   * Undefined when unknown: a covered day CASH_BASE is held on then fails, never 0.
   */
  depositRate?: (date: TradingDate) => number | undefined;
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
  /** With whole shares only: the value at the date's close (the initial amount until the first trade). */
  value?: UsdAmount;
  traded: boolean;
}

/** A base-currency point (docs/indicators.md "Base currency"): the USD point x the session's FX. */
export interface BasePoint {
  date: TradingDate;
  /** `equity` x FX; null when the session's FX is unknown or invalid. */
  equity: number | null;
  /** With whole shares only: `value` x FX in the base currency; null as `equity`. */
  value?: { amount: number; currency: string } | null;
}

export interface BaseCurrencyResult {
  currency: string;
  /** One per USD point, same dates. */
  points: BasePoint[];
  /** Sessions without an FX rate known before their open: no base value there. */
  unknownFx: TradingDate[];
  /** Sessions whose FX is not finite or not above 0: no base value there. */
  invalidFx: TradingDate[];
}

/** Trades that converted between USD and CASH_BASE (docs/indicators.md "FX spread"). */
export interface Conversions {
  count: number;
  /** FX spread paid, cost / value per trade, summed (also in `costs`). */
  fxSpreadCosts: number;
  /** Tax on currency conversion is not modeled (the tax engine is blocked, C34); displays say so. */
  tax: 'not_applied';
}

export interface BacktestResult {
  points: EquityPoint[];
  /** Trades after the first entry. */
  switches: number;
  /** Total costs paid, as a share of equity at each trade, summed. */
  costs: number;
  /** With whole shares only: the initial amount and each trade's shares, residual cash and costs. */
  wholeShares?: WholeShareResult;
  /** With `baseCurrency` only: the base-currency series. */
  base?: BaseCurrencyResult;
  /** Only when a trade converted between USD holdings and CASH_BASE. */
  conversions?: Conversions;
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

/**
 * A ticker's bars from the previous session to this one (docs/indicators.md "Equity curves",
 * "Returns"): `base` is its bar on the previous session (required: a move before it is unknown),
 * `gap` its bars dated between the two sessions (each on a covered day), `bar` its bar on this
 * session.
 */
interface Span {
  base: RawBar;
  gap: RawBar[];
  bar: RawBar;
}

/**
 * One day's growth of a holding (1 + its return that day), refused when not finite or not above
 * 0: an equity at or below 0 cannot be compounded (docs/indicators.md "Returns").
 */
function growthOf(ticker: string, date: TradingDate, r: number): number {
  const g = 1 + r;
  if (!Number.isFinite(g) || g <= 0) {
    throw new Error(
      `${ticker} on ${date}: growth ${g} (a return of ${r}) leaves nothing to compound; the backtest stops rather than carry a value at or below 0.`,
    );
  }
  return g;
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
 * state's): cash (CASH_USD, CASH_BASE) has no bars (it reads a rate), a synthetic ticker reads its
 * base's bars.
 */
export function heldTickers(holdings: readonly Holding[]): string[] {
  return [
    ...new Set(
      holdings
        .map((h) => h.ticker)
        .filter((t) => !isCash(t))
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
  /** Compounds one part of the session `date` (`Segment`), `prev` the session before, over what is held. */
  grow(prev: TradingDate, date: TradingDate, segment: Segment): void;
  /** Trades to `to` at the session's open or close. */
  trade(to: Holding[], date: TradingDate, at: ExecutionPoint): void;
  /** The point's values at the date's close. */
  close(date: TradingDate): { equity: number; weights: Record<string, number>; value?: number };
  costs(): number;
  switches(): number;
  /** Trades that converted between USD and CASH_BASE (fractional book only). */
  conversions?(): Conversions | undefined;
}

/**
 * The fractional book (docs/indicators.md "Equity curves": weights, costs on turnover; "FX
 * spread": `spreadRate`, fxSpreadPct / 100, on |change in CASH_BASE weight|; undefined when
 * nothing converts: base currency USD, or no CASH_BASE).
 */
function fractionalBook(
  costRate: number,
  holdingReturn: (ticker: string, prev: TradingDate, date: TradingDate, segment: Segment) => number,
  spreadRate?: number,
): Book {
  let equity = 1;
  let weights: Record<string, number> = {};
  let costs = 0;
  let switches = 0;
  let converted = 0;
  let spreadCosts = 0;
  return {
    grow(prev, date, segment) {
      const entries = Object.entries(weights);
      if (entries.length === 0) return;
      let total = 0;
      const next: Record<string, number> = {};
      for (const [ticker, w] of entries) {
        next[ticker] = w * growthOf(ticker, date, holdingReturn(ticker, prev, date, segment));
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
      let cost = turnover * costRate;
      // The converted part pays the FX spread on top (|change in CASH_BASE weight| x value).
      // Without CASH_BASE before or after, nothing converts: the cost is exactly as before.
      if (spreadRate !== undefined && (CASH_BASE in target || CASH_BASE in weights)) {
        const change = Math.abs((target[CASH_BASE] ?? 0) - (weights[CASH_BASE] ?? 0));
        if (change > 0) {
          const spread = change * spreadRate;
          cost += spread;
          spreadCosts += spread;
          converted++;
        }
      }
      equity *= 1 - cost;
      costs += cost;
      if (Object.keys(weights).length > 0) switches++;
      weights = target;
    },
    close: () => ({ equity, weights: { ...weights } }),
    costs: () => costs,
    switches: () => switches,
    conversions: () =>
      converted > 0
        ? { count: converted, fxSpreadCosts: spreadCosts, tax: 'not_applied' as const }
        : undefined,
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

/**
 * Relative distance within which a split's share product counts as the whole number (float noise
 * and split ratios given to a few decimals); also the residual cash's allowance below 0.
 */
const NEAR_WHOLE = 1e-9;
/**
 * Relative distance within which a sizing quotient counts as the whole number: float noise only
 * (a few ulps, about 1e-16), 1000 times below the residual's allowance (`NEAR_WHOLE`), so a snap
 * never spends more than float noise and never trips the residual check.
 */
const SIZING_NOISE = 1e-12;

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
  cashDay: (date: TradingDate) => number;
  barOn: (ticker: string, date: TradingDate) => RawBar;
  span: (ticker: string, prev: TradingDate, date: TradingDate) => Span;
  covered: (prev: TradingDate, date: TradingDate) => TradingDate[];
}): Book & { trades: WholeShareTrade[] } {
  const { initial, costRate: c } = deps;
  let shares = new Map<string, number>();
  let cash = initial;
  let entered = false;
  let costs = 0;
  let switches = 0;
  const trades: WholeShareTrade[] = [];
  const price = (ticker: string, date: TradingDate, at: ExecutionPoint): number => {
    const bar = deps.barOn(ticker, date);
    const p = at === 'open' ? bar.open : bar.close;
    if (p === undefined) throw new Error(`${ticker} has no open on ${date}.`);
    return p;
  };

  return {
    trades,
    grow(prev, date, segment) {
      if (!entered || segment === 'intraday') return;
      // Each held ticker's bars over the step, by date: its gap bars at their close, the
      // session's bar at the part's end price (the open for the night, the close for the day).
      const byDay = new Map<TradingDate, [string, RawBar, number][]>();
      for (const ticker of shares.keys()) {
        const { gap, bar } = deps.span(ticker, prev, date);
        const end = segment === 'overnight' ? bar.open : bar.close;
        if (end === undefined) throw new Error(`${ticker} has no open on ${date}.`);
        for (const [b, p] of [...gap.map((m) => [m, m.close] as const), [bar, end] as const]) {
          byDay.set(b.date, [...(byDay.get(b.date) ?? []), [ticker, b, p]]);
        }
      }
      for (const day of deps.covered(prev, date)) {
        // The residual earns the day's cash rate, like CASH_USD; read only while the cash at the
        // start of the day is above 0 (before that day's dividend or fraction arrives).
        if (cash > 0) cash *= 1 + deps.cashDay(day);
        // Ex-date: split first (a fraction paid as cash), then the dividend on the shares kept.
        for (const [ticker, b, p] of byDay.get(day) ?? []) {
          const n = shares.get(ticker)!;
          const split = n * b.splitFactor;
          const whole = Math.round(split);
          const snapped = Math.abs(split - whole) <= NEAR_WHOLE * Math.abs(split);
          const kept = snapped ? whole : Math.floor(split);
          if (!snapped) cash += (split - kept) * p;
          cash += kept * b.divCash;
          shares.set(ticker, kept);
        }
        byDay.delete(day);
      }
      if (byDay.size > 0) {
        throw new Error(`Bars on ${[...byDay.keys()].join(', ')} fall on no covered day.`);
      }
      shares = new Map([...shares].filter(([, n]) => n > 0));
    },
    trade(to, date, at) {
      const target = new Map<string, number>();
      for (const h of to) {
        // An assertion: a ticker listed twice is refused up front (backtest); a Map would
        // otherwise keep one of its weights silently.
        if (target.has(h.ticker)) {
          throw new Error(`${h.ticker} is listed twice in the holdings traded on ${date}.`);
        }
        target.set(h.ticker, h.weight);
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
        // x = (weight x B) / (100 x p x (1 + c)); within 1e-12 (relative, float noise only) of a
        // whole number it is that number (58 x 100 / 200 must give 29, not 28.999...), then floor.
        const x = (w * budget) / (100 * prices.get(t)! * (1 + c));
        const near = Math.round(x);
        const n = Math.max(
          0,
          Math.floor(Math.abs(x - near) <= SIZING_NOISE * Math.abs(x) ? near : x),
        );
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
        // Exact arithmetic keeps it at 0 or above (docs/indicators.md "Whole shares"), up to the
        // sizing's snap (at most 1e-12 x B) and float noise; below 0 by more than 1e-9 x V is a
        // fault, never a silent clamp.
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
        const v = n * deps.barOn(t, date).close;
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

/**
 * What a backtest may hold, as base tickers: every allocation and the safe state (the strategy's
 * own lists), and what the days hold (for a caller passing days only).
 */
function holdableOf(input: Pick<BacktestInput, 'strategy' | 'days'>): string[] {
  return heldTickers([
    ...(input.strategy.allocations ?? []).flatMap((a) => a.holdings),
    ...(input.strategy.safeState?.holdings ?? []),
    ...input.days.flatMap((d) => d.holdings),
  ]);
}

/**
 * Covered days (docs/indicators.md "Equity curves", "Returns"): for a step from session `prev`
 * to session `date`, the dates strictly between them on which any ticker the strategy may hold
 * (`holdable`, base tickers) has a bar, then `date` itself.
 */
function coveredDays(
  holdable: readonly string[],
  bars: Record<string, RawBar[]>,
): (prev: TradingDate, date: TradingDate) => TradingDate[] {
  const dates = [...new Set(holdable.flatMap((t) => (bars[t] ?? []).map((b) => b.date)))].sort();
  return (prev, date) => {
    let lo = 0;
    let hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid]! <= prev) lo = mid + 1;
      else hi = mid;
    }
    const out: TradingDate[] = [];
    for (let j = lo; j < dates.length && dates[j]! < date; j++) out.push(dates[j]!);
    out.push(date);
    return out;
  };
}

/**
 * Every date a backtest of these inputs may read the cash rate on (for grading it; requirements
 * 04, data health wherever a number is computed): each session after the first and each covered
 * day between two sessions, in date order. Cash, financing and the whole-share residual read the
 * rate on these days only.
 */
export function rateReadDates(
  input: Pick<BacktestInput, 'strategy' | 'days' | 'bars'>,
): TradingDate[] {
  const holdable = holdableOf(input);
  const all = sessions(input.days, input.bars, holdable);
  const covered = coveredDays(holdable, input.bars);
  const out: TradingDate[] = [];
  for (let i = 1; i < all.length; i++) out.push(...covered(all[i - 1]!, all[i]!));
  return out;
}

/**
 * Whether the strategy may hold CASH_BASE (any allocation's or the safe state's holdings): its
 * backtest then needs the base currency, the deposit rate and, unless the base currency is USD,
 * the FX rate (docs/indicators.md "Base-currency cash").
 */
export function mayHoldCashBase(
  strategy: Partial<Pick<Strategy, 'safeState' | 'allocations'>>,
): boolean {
  return allHoldings({ strategy, days: [] }).some((h) => h.ticker === CASH_BASE);
}

/**
 * The run failed because CASH_BASE is held over a session without a known FX rate (the caller
 * can add why it is unknown, e.g. the forward record's refusal of a stale or disputed rate).
 */
export class FxUnknownError extends Error {
  constructor(
    readonly pair: string,
    readonly date: TradingDate,
  ) {
    super(`No FX rate (${pair}) known for ${date}: ${CASH_BASE} is held.`);
    this.name = 'FxUnknownError';
  }
}

/** An ISO 4217 code as the base currency is given: three capital letters. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Every holding a backtest of these inputs may take: allocations, the safe state and the days. */
function allHoldings(input: {
  strategy: Partial<Pick<Strategy, 'safeState' | 'allocations'>>;
  days: readonly StrategyDay[];
}): Holding[] {
  return [
    ...(input.strategy.allocations ?? []).flatMap((a) => a.holdings),
    ...(input.strategy.safeState?.holdings ?? []),
    ...input.days.flatMap((d) => d.holdings),
  ];
}

export function backtest(input: BacktestInput): BacktestResult {
  const { strategy } = input;
  const baseCurrency = input.baseCurrency;
  if (baseCurrency !== undefined && !CURRENCY_CODE.test(baseCurrency)) {
    throw new Error(
      `The base currency ${JSON.stringify(baseCurrency)} is not an ISO 4217 code (three capital letters).`,
    );
  }
  // CASH_BASE (docs/indicators.md "Base-currency cash") needs the base currency, and converts
  // (FX and the FX spread) unless the base currency is USD.
  const holdsBase = allHoldings(input).some((h) => h.ticker === CASH_BASE);
  if (holdsBase && baseCurrency === undefined) {
    throw new Error(
      `${CASH_BASE} needs the base currency: the strategy may hold it and no base currency is given.`,
    );
  }
  const converts = holdsBase && baseCurrency !== 'USD';
  // An omitted cost is unknown, not 0, unless the caller says so (stored pre-C2 versions, parity).
  // The FX spread is read only where a trade can convert.
  if (input.omittedCostsAsZero !== true) {
    for (const field of [
      'slippageBps',
      'feePct',
      ...(converts ? (['fxSpreadPct'] as const) : []),
    ] as const) {
      if (strategy.costs[field] === undefined) {
        throw new Error(
          `costs not resolved: ${field}; resolve with the install's broker_costs first`,
        );
      }
    }
  }
  const decided = new Map(input.days.map((d) => [d.date, d]));
  const holdable = holdableOf(input);
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
  const span = (ticker: string, prev: TradingDate, date: TradingDate): Span => {
    const [list, i] = positionOf(ticker, date);
    if (i === undefined) throw new Error(`${ticker} has no bar on ${date}.`);
    const [, k] = positionOf(ticker, prev);
    if (k === undefined || k >= i) {
      throw new Error(
        `${ticker} has no bar on ${prev}, the session before ${date}: its move from there is unknown.`,
      );
    }
    return { base: list[k]!, gap: list.slice(k + 1, i), bar: list[i]! };
  };
  const covered = coveredDays(holdable, input.bars);
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
  // CASH_BASE's day: the deposit rate in force on the date / 100 / 252, as CASH_USD's.
  const depositDay = (date: TradingDate) => {
    const rate = input.depositRate?.(date);
    if (rate === undefined) {
      throw new Error(`No deposit rate known for ${date}: ${CASH_BASE} is held (never 0).`);
    }
    if (!Number.isFinite(rate)) {
      throw new Error(`The deposit rate for ${date} is ${rate}, not a finite number.`);
    }
    return rate / 100 / 252;
  };
  /** The session's FX as CASH_BASE's valuation needs it: known, finite and above 0, or a failure. */
  const fxHeld = (date: TradingDate): number => {
    const fx = input.fxRate?.(date);
    if (fx === undefined) throw new FxUnknownError(`USD${baseCurrency}`, date);
    if (!Number.isFinite(fx) || fx <= 0) {
      throw new Error(`The FX rate (USD${baseCurrency}) for ${date} is ${fx}: not above 0.`);
    }
    return fx;
  };
  // One covered day of a holding (requirements 05: synthetic leverage is daily): L x the base's
  // return that day, minus (L - 1) x that day's cash rate / 252 and E / 100 / 252.
  const dayReturn = (
    ticker: string,
    t: ReturnType<typeof parseTicker>,
    r: number,
    date: TradingDate,
  ): number => {
    const lr = t.leverage * r;
    const financing = readsCashRate(ticker) ? (t.leverage - 1) * cashDay(date) : 0;
    return lr - financing - t.expensePct / 100 / 252;
  };
  /**
   * A holding's return over part of the session `date`, `prev` the session before. Without a
   * gap, one day as before (to the bit); over a gap, the covered days compound in date order,
   * each with its own rate; a ticker without a bar on a covered day has a 0 return there.
   */
  const holdingReturn = (
    ticker: string,
    prev: TradingDate,
    date: TradingDate,
    segment: Segment,
  ): number => {
    if (segment === 'intraday') {
      if (isCash(ticker)) return 0;
      const t = parseTicker(ticker);
      const bar = barOn(t.base, date);
      return t.leverage * assetReturn(bar, bar, 'intraday', t.base);
    }
    const days = covered(prev, date);
    if (ticker === CASH_USD) {
      if (days.length === 1) return cashDay(date);
      let growth = 1;
      for (const d of days) growth *= growthOf(ticker, d, cashDay(d));
      return growth - 1;
    }
    if (ticker === CASH_BASE) {
      // The deposit rate per covered day, then the step's FX move: (product of 1 + rate / 100 /
      // 252) x (fx(prev) / fx(date)). With base USD the FX factor is 1 and nothing is read.
      let growth = 1;
      for (const d of days) growth *= growthOf(ticker, d, depositDay(d));
      if (converts) growth *= fxHeld(prev) / fxHeld(date);
      return growth - 1;
    }
    const t = parseTicker(ticker);
    const s = span(t.base, prev, date);
    if (days.length === 1) {
      if (s.gap.length > 0)
        throw new Error(`${t.base} has a bar on no covered day before ${date}.`);
      return dayReturn(ticker, t, assetReturn(s.base, s.bar, segment, t.base), date);
    }
    let growth = 1;
    let last = s.base;
    let g = 0;
    for (const d of days) {
      let r = 0;
      if (d === date) r = assetReturn(last, s.bar, segment, t.base);
      else if (s.gap[g]?.date === d) {
        r = totalReturn(last, s.gap[g]!);
        last = s.gap[g++]!;
      }
      growth *= growthOf(ticker, d, dayReturn(ticker, t, r, d));
    }
    if (g !== s.gap.length)
      throw new Error(`${t.base} has a bar on no covered day before ${date}.`);
    return growth - 1;
  };

  let whole: ReturnType<typeof wholeBook> | undefined;
  if (initial !== undefined) {
    // Assumed (spec 2026-11-02 base-currency): a base-currency residual next to the USD one would
    // need its own sizing, conversion and FX rules; refused rather than modeled.
    if (holdsBase) {
      throw new Error(
        `Whole shares are refused with ${CASH_BASE}: a base-currency cash balance is not modeled with whole shares yet.`,
      );
    }
    // A synthetic ticker has no traded price: one built from its returns would depend on the
    // backtest's start date, so its share counts would mean nothing.
    const synthetic = allHoldings(input).find(
      (h) => h.ticker !== CASH_USD && h.ticker !== parseTicker(h.ticker).base,
    );
    if (synthetic) {
      throw new Error(
        `Whole shares are refused with a synthetic ticker (${synthetic.ticker}): it has no traded price, so its share count would depend on the backtest's start date.`,
      );
    }
    // One share count per ticker: a target listing one twice is refused before anything runs.
    for (const target of [
      ...(strategy.allocations ?? []).map((a) => a.holdings),
      ...(strategy.safeState ? [strategy.safeState.holdings] : []),
      ...input.days.map((d) => d.holdings),
    ]) {
      const twice = target.find((h, i) => target.findIndex((x) => x.ticker === h.ticker) !== i);
      if (twice) throw new Error(`Whole shares: ${twice.ticker} is listed twice in one target.`);
    }
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
      whole = wholeBook({ initial, costRate, cashDay, barOn, span, covered });
    }
  }
  // Only a strategy that may convert reads the FX spread (an omitted one is 0 only for callers
  // that read omitted costs as 0).
  const spreadRate = converts ? (strategy.costs.fxSpreadPct ?? 0) / 100 : undefined;
  const book: Book = whole ?? fractionalBook(costRate, holdingReturn, spreadRate);

  const points: EquityPoint[] = [];
  const pushPoint = (date: TradingDate, isDecided: boolean, traded: boolean) => {
    const c = book.close(date);
    points.push({
      date,
      decided: isDecided,
      equity: c.equity,
      weights: c.weights,
      ...(c.value !== undefined && { value: usd(c.value) }),
      traded,
    });
  };

  // `pending`: holdings decided at a close, waiting for their execution time.
  let pending: Holding[] | undefined;
  let held: Holding[] | undefined;
  days.forEach((day, i) => {
    let traded = false;
    if (i > 0) {
      const prev = days[i - 1]!.date;
      if (strategy.execution === 'next_open' && pending) {
        book.grow(prev, day.date, 'overnight');
        book.trade(pending, day.date, 'open');
        held = pending;
        pending = undefined;
        traded = true;
        book.grow(prev, day.date, 'intraday');
      } else {
        book.grow(prev, day.date, 'day');
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
  const conversions = book.conversions?.();
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
    ...(baseCurrency !== undefined && { base: baseSeries(points, baseCurrency, input.fxRate) }),
    ...(conversions && { conversions }),
  };
}

/**
 * The base-currency series (docs/indicators.md "Base currency"): each point's equity (and whole-
 * share value) x the session's FX, known before its open. Unknown or invalid FX gives that point
 * no base value (null), listed; it never fails the run (FX health affects only base-currency
 * valuation). With base USD the FX is 1 and the series equals the USD one.
 */
function baseSeries(
  points: readonly EquityPoint[],
  currency: string,
  fxRate: BacktestInput['fxRate'],
): BaseCurrencyResult {
  const unknownFx: TradingDate[] = [];
  const invalidFx: TradingDate[] = [];
  const out: BasePoint[] = points.map((p) => {
    let fx: number | undefined = 1;
    if (currency !== 'USD') {
      fx = fxRate?.(p.date);
      if (fx === undefined) unknownFx.push(p.date);
      else if (!Number.isFinite(fx) || fx <= 0) {
        invalidFx.push(p.date);
        fx = undefined;
      }
    }
    if (fx === undefined) {
      return { date: p.date, equity: null, ...(p.value && { value: null }) };
    }
    return {
      date: p.date,
      equity: p.equity * fx,
      ...(p.value && { value: { amount: p.value.amount * fx, currency } }),
    };
  });
  return { currency, points: out, unknownFx, invalidFx };
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
