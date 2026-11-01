// Reference implementation of the core math (requirements 04, layer E; docs/indicators.md):
// adjusted series, indicators, signals, allocations and equity curves, written apart from
// packages/core and on purpose with other algorithms (prefix sums, Welford's variance, explicit
// state machines). It never imports @saku/core. When the two disagree, find the root cause;
// never copy one into the other.

import { refParseTicker } from './ticker';

export interface RefBar {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  divCash: number;
  splitFactor: number;
  closeIsSplitAdjusted: boolean;
}

export type RefIndicator =
  'price' | 'sma' | 'ema' | 'return' | 'volatility' | 'drawdown' | 'high' | 'low';

export type RefVolatilityMethod = 'close' | 'parkinson' | 'garman_klass' | 'yang_zhang';

export interface RefOperand {
  indicator?: RefIndicator;
  ticker?: string;
  /** Left out for `drawdown` means all-time. */
  length?: number;
  totalReturn?: boolean;
  /** Volatility only; `close` when left out. */
  method?: RefVolatilityMethod;
  threshold?: number;
}

export interface RefComparison {
  left: RefOperand;
  op: '>' | '<';
  right: RefOperand;
  tolerancePct?: number;
}

export interface RefSignal extends Partial<RefComparison> {
  id: string;
  type: 'compare' | 'ensemble' | 'not' | 'and' | 'or';
  members?: RefComparison[];
  threshold?: number;
  /** Derived signals: `not` names one signal id, `and` / `or` a list of ids. */
  of?: string | string[];
}

const isDerived = (sig: RefSignal) => sig.type === 'not' || sig.type === 'and' || sig.type === 'or';

export interface RefStrategy {
  execution?: 'next_open' | 'next_close' | 'same_close';
  costs?: { slippageBps?: number; feePct?: number; fxSpreadPct?: number };
  signals: RefSignal[];
  allocations: {
    name: string;
    when?: { all?: string[]; any?: string[]; none?: string[] };
    holdings: { ticker: string; weight: number }[];
  }[];
  /** Held on a date that is not evaluated (docs/indicators.md "Days without a decision"). */
  safeState?: { holdings: { ticker: string; weight: number }[] };
}

export interface RefDay {
  date: string;
  signals: Record<string, boolean | number>;
  allocation: string;
  holdings: { ticker: string; weight: number }[];
}

const TIE = 1e-9;

/** Total-return index: the product of daily total returns, 1 on the first date. */
export function refTotalReturn(bars: RefBar[]): number[] {
  const out = [1];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const shares = b.closeIsSplitAdjusted ? 1 : b.splitFactor;
    out.push(out[i - 1]! * (((b.close + b.divCash) * shares) / bars[i - 1]!.close));
  }
  return out;
}

/** Closes on the latest share basis: close x (splits up to the date) / (all splits). */
export function refPrice(bars: RefBar[]): number[] {
  const cumulative: number[] = [];
  let c = 1;
  for (const b of bars) {
    if (!b.closeIsSplitAdjusted) c *= b.splitFactor;
    cumulative.push(c);
  }
  return bars.map((b, i) => (b.closeIsSplitAdjusted ? b.close : (b.close * cumulative[i]!) / c));
}

/** SMA from prefix sums. */
export function refSma(values: number[], length: number): (number | undefined)[] {
  const prefix = [0];
  for (const v of values) prefix.push(prefix.at(-1)! + v);
  return values.map((_, i) =>
    i + 1 < length ? undefined : (prefix[i + 1]! - prefix[i + 1 - length]!) / length,
  );
}

/** Annualized close-to-close volatility in percent, Welford's sample variance per window. */
export function refVolatility(values: number[], length: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < length) {
      out.push(undefined);
      continue;
    }
    let n = 0;
    let mean = 0;
    let m2 = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const r = values[j]! / values[j - 1]! - 1;
      n++;
      const d = r - mean;
      mean += d / n;
      m2 += d * (r - mean);
    }
    out.push(Math.sqrt((m2 / (n - 1)) * 252) * 100);
  }
  return out;
}

// ---- B1 indicators (docs/indicators.md "Indicators (B1, v1)"; requirements 06 v1). ----
// Written as literally as the contract reads: every value is recomputed from its own loop.
// A doubtful value never yields a number: the contract's data-error rules give no value instead.

const positive = (x: number | undefined): x is number =>
  x !== undefined && Number.isFinite(x) && x > 0;

/**
 * EMA: alpha = 2 / (N + 1); seed at bar N - 1 = mean of the first N values; then recursive.
 * A non-finite EMA gives no value (and, being recursive, stays non-finite afterwards).
 */
export function refEma(values: number[], length: number): (number | undefined)[] {
  const alpha = 2 / (length + 1);
  const out: (number | undefined)[] = [];
  let ema: number | undefined;
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) {
      out.push(undefined);
      continue;
    }
    if (ema === undefined) {
      let sum = 0;
      for (let j = 0; j < length; j++) sum += values[j]!;
      ema = sum / length;
    } else {
      ema = alpha * values[i]! + (1 - alpha) * ema;
    }
    out.push(Number.isFinite(ema) ? ema : undefined);
  }
  return out;
}

/**
 * Simple return over N bars in percent: (v_t / v_t-N - 1) x 100; warm-up N bars. No value when
 * either value read is not positive or not finite.
 */
export function refReturn(values: number[], length: number): (number | undefined)[] {
  return values.map((v, i) => {
    if (i < length) return undefined;
    const before = values[i - length];
    if (!positive(v) || !positive(before)) return undefined;
    return (v / before - 1) * 100;
  });
}

/** Highest of the last N values (today included); warm-up N - 1 bars; no value if one is not finite. */
export function refHigh(values: number[], length: number): (number | undefined)[] {
  return values.map((_, i) => {
    if (i < length - 1) return undefined;
    let m = -Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) return undefined;
      if (values[j]! > m) m = values[j]!;
    }
    return m;
  });
}

/** Lowest of the last N values (today included); warm-up N - 1 bars; no value if one is not finite. */
export function refLow(values: number[], length: number): (number | undefined)[] {
  return values.map((_, i) => {
    if (i < length - 1) return undefined;
    let m = Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) return undefined;
      if (values[j]! < m) m = values[j]!;
    }
    return m;
  });
}

/**
 * Drawdown in percent: (v_t / peak - 1) x 100, the peak being the highest of the last N values
 * (today included), or of every value since the first one when `length` is left out. No value
 * when a value read is not positive or not finite; for the all-time drawdown every value since
 * the first is read, so one bad value gives no value from that day on.
 */
export function refDrawdown(values: number[], length?: number): (number | undefined)[] {
  return values.map((v, i) => {
    const from = length === undefined ? 0 : i - length + 1;
    if (from < 0) return undefined;
    let peak = -Infinity;
    for (let j = from; j <= i; j++) {
      if (!positive(values[j])) return undefined;
      if (values[j]! > peak) peak = values[j]!;
    }
    return (v / peak - 1) * 100;
  });
}

/** One day's open, high, low and close on the series' basis. */
export interface RefOhlc {
  open?: number;
  high?: number;
  low?: number;
  close: number;
}

/**
 * OHLC on the series' basis: each of the day's raw open, high, low and close times the same
 * factor (series value / raw close), so equal raw values stay exactly equal and a flat day gives
 * exactly 0. A missing open, high or low stays missing.
 */
export function refOhlc(bars: RefBar[], totalReturn: boolean): RefOhlc[] {
  const series = totalReturn ? refTotalReturn(bars) : refPrice(bars);
  return bars.map((b, i) => {
    const factor = series[i]! / b.close;
    return {
      open: b.open === undefined ? undefined : b.open * factor,
      high: b.high === undefined ? undefined : b.high * factor,
      low: b.low === undefined ? undefined : b.low * factor,
      close: b.close * factor,
    };
  });
}

/**
 * True when every day from `from` to `to` has an open, high and low, all four values positive
 * and finite, the high not below the low, and the open and close within [low, high]. Otherwise
 * the window gives no value (never estimated).
 */
function windowUsable(d: RefOhlc[], from: number, to: number): boolean {
  for (let j = from; j <= to; j++) {
    const x = d[j]!;
    if (!positive(x.open) || !positive(x.high) || !positive(x.low) || !positive(x.close)) {
      return false;
    }
    if (x.high < x.low) return false;
    if (x.open < x.low || x.open > x.high) return false;
    if (x.close < x.low || x.close > x.high) return false;
  }
  return true;
}

/** sqrt(252 x variance) x 100, or no value for a negative or non-finite variance. */
export const refAnnualize = (variance: number): number | undefined =>
  variance < 0 || !Number.isFinite(variance) ? undefined : Math.sqrt(252 * variance) * 100;

/** Parkinson: sqrt(252 x S / (4 ln 2 x N)) x 100, S = sum of (ln(H/L))^2 over the last N days. */
export function refParkinson(d: RefOhlc[], length: number): (number | undefined)[] {
  return d.map((_, i) => {
    const from = i - length + 1;
    if (from < 0 || !windowUsable(d, from, i)) return undefined;
    let S = 0;
    for (let j = from; j <= i; j++) S += Math.log(d[j]!.high! / d[j]!.low!) ** 2;
    return refAnnualize(S / (4 * Math.log(2) * length));
  });
}

/** Garman-Klass: sqrt(252 x mean of [0.5 (ln H/L)^2 - (2 ln 2 - 1)(ln C/O)^2]) x 100. */
export function refGarmanKlass(d: RefOhlc[], length: number): (number | undefined)[] {
  return d.map((_, i) => {
    const from = i - length + 1;
    if (from < 0 || !windowUsable(d, from, i)) return undefined;
    let sum = 0;
    for (let j = from; j <= i; j++) {
      const x = d[j]!;
      const hl = Math.log(x.high! / x.low!);
      const co = Math.log(x.close / x.open!);
      sum += 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
    }
    return refAnnualize(sum / length);
  });
}

/** Sample variance (n - 1), two-pass. */
function sampleVariance(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
}

/**
 * Yang-Zhang: sqrt(252 x (s_o + k s_c + (1 - k) s_rs)) x 100 over the last N days; s_o and s_c
 * sample variances of ln(O_t / C_t-1) and ln(C_t / O_t), s_rs the mean Rogers-Satchell term,
 * k = 0.34 / (1.34 + (N + 1) / (N - 1)). The window is the last N days; the close before it is
 * read only for the first overnight ratio.
 */
export function refYangZhang(d: RefOhlc[], length: number): (number | undefined)[] {
  const k = 0.34 / (1.34 + (length + 1) / (length - 1));
  return d.map((_, i) => {
    const from = i - length + 1;
    if (from < 1 || !windowUsable(d, from, i) || !positive(d[from - 1]!.close)) return undefined;
    const overnight: number[] = [];
    const openToClose: number[] = [];
    let rs = 0;
    for (let j = from; j <= i; j++) {
      const x = d[j]!;
      overnight.push(Math.log(x.open! / d[j - 1]!.close));
      openToClose.push(Math.log(x.close / x.open!));
      rs +=
        Math.log(x.high! / x.close) * Math.log(x.high! / x.open!) +
        Math.log(x.low! / x.close) * Math.log(x.low! / x.open!);
    }
    const so = sampleVariance(overnight);
    const sc = sampleVariance(openToClose);
    return refAnnualize(so + k * sc + (1 - k) * (rs / length));
  });
}

type State = 'unset' | 'true' | 'false';

/**
 * One comparison step as a state machine (tolerance band, near-ties, plain first day). The band
 * is right +- |right| x t/100 (docs/indicators.md "Signals", compare), so it stays symmetric and
 * ordered for a negative reference and has zero width at a reference of 0.
 */
function refStep(value: number, ref: number, c: RefComparison, state: State): State {
  const t = (c.tolerancePct ?? 0) / 100;
  const hi = ref + Math.abs(ref) * t;
  const lo = ref - Math.abs(ref) * t;
  const tieWith = (bound: number) => Math.abs(value - bound) <= TIE * Math.abs(bound);
  if (state === 'unset') {
    if (tieWith(ref)) return 'false';
    return (c.op === '>' ? value > ref : value < ref) ? 'true' : 'false';
  }
  const clearlyAbove = !tieWith(hi) && value > hi;
  const clearlyBelow = !tieWith(lo) && value < lo;
  switch (c.op) {
    case '>':
      if (clearlyAbove) return 'true';
      if (clearlyBelow) return 'false';
      return state;
    case '<':
      if (clearlyBelow) return 'true';
      if (clearlyAbove) return 'false';
      return state;
  }
}

/** Signals and allocations per date (daily evaluation). */
export function refEvaluate(s: RefStrategy, bars: Record<string, RefBar[]>): RefDay[] {
  const comparisons = (sig: RefSignal): RefComparison[] => {
    if (isDerived(sig)) return [];
    return sig.type === 'compare' ? [sig as RefComparison] : sig.members!;
  };
  const tickers = new Set<string>();
  for (const sig of s.signals) {
    for (const c of comparisons(sig)) {
      if (c.left.ticker) tickers.add(c.left.ticker);
      if (c.right.ticker) tickers.add(c.right.ticker);
    }
  }
  // An operand's whole array over its ticker's bars, computed once per evaluation.
  const operandValues = (o: RefOperand): (number | undefined)[] => {
    const list = bars[o.ticker!]!;
    const series = o.totalReturn ? refTotalReturn(list) : refPrice(list);
    switch (o.indicator) {
      case 'price':
        return series;
      case 'sma':
        return refSma(series, o.length!);
      case 'ema':
        return refEma(series, o.length!);
      case 'return':
        return refReturn(series, o.length!);
      case 'drawdown':
        return refDrawdown(series, o.length);
      case 'high':
        return refHigh(series, o.length!);
      case 'low':
        return refLow(series, o.length!);
      case 'volatility': {
        const method = o.method ?? 'close';
        if (method === 'close') return refVolatility(series, o.length!);
        const d = refOhlc(list, o.totalReturn ?? false);
        if (method === 'parkinson') return refParkinson(d, o.length!);
        if (method === 'garman_klass') return refGarmanKlass(d, o.length!);
        return refYangZhang(d, o.length!);
      }
      default:
        throw new Error(`reference: unknown indicator ${String(o.indicator)}`);
    }
  };
  // Cache keyed by the full operand (every field that changes the array).
  const cache = new Map<string, (number | undefined)[]>();
  const indexOf = new Map<string, Map<string, number>>();
  const valueOf = (o: RefOperand, date: string): number | undefined => {
    if (o.threshold !== undefined && o.indicator === undefined) return o.threshold;
    const key = JSON.stringify([
      o.indicator,
      o.ticker,
      o.length ?? null,
      o.totalReturn ?? false,
      o.method ?? 'close',
    ]);
    let values = cache.get(key);
    if (values === undefined) {
      values = operandValues(o);
      cache.set(key, values);
    }
    let dateIndex = indexOf.get(o.ticker!);
    if (dateIndex === undefined) {
      dateIndex = new Map(bars[o.ticker!]!.map((b, i) => [b.date, i]));
      indexOf.set(o.ticker!, dateIndex);
    }
    return values[dateIndex.get(date)!];
  };
  let dates: string[] | undefined;
  for (const t of tickers) {
    const own = bars[t]!.map((b) => b.date);
    dates = dates ? dates.filter((d) => own.includes(d)) : own;
  }
  const states: Record<string, State> = {};
  const out: RefDay[] = [];
  for (const date of [...(dates ?? [])].sort()) {
    const signals: Record<string, boolean | number> = {};
    const on: Record<string, boolean> = {};
    let ready = true;
    for (const sig of s.signals) {
      if (isDerived(sig)) continue;
      let trues = 0;
      const list = comparisons(sig);
      for (let k = 0; k < list.length; k++) {
        const c = list[k]!;
        const v = valueOf(c.left, date);
        const r = valueOf(c.right, date);
        if (v === undefined || r === undefined) {
          ready = false;
          continue;
        }
        const key = `${sig.id}/${k}`;
        states[key] = refStep(v, r, c, states[key] ?? 'unset');
        if (states[key] === 'true') trues++;
      }
      if (sig.type === 'compare') {
        signals[sig.id] = on[sig.id] = trues === 1;
      } else {
        signals[sig.id] = trues / list.length;
        on[sig.id] = trues / list.length >= sig.threshold!;
      }
    }
    if (!ready) continue;
    // Derived signals (docs/indicators.md "not / and / or"): read the other signals' states on the
    // same date, keep no state of their own, and may name signals declared later in the list.
    const byId = new Map(s.signals.map((sig) => [sig.id, sig]));
    const resolve = (id: string, path: string[]): boolean => {
      if (path.includes(id))
        throw new Error(`reference: signal cycle ${[...path, id].join(' -> ')}`);
      const sig = byId.get(id);
      if (!sig) throw new Error(`reference: unknown signal ${id}`);
      if (!isDerived(sig)) return on[id]!;
      if (on[id] === undefined) {
        const inputs = (Array.isArray(sig.of) ? sig.of : [sig.of!]).map((x) =>
          resolve(x, [...path, id]),
        );
        if (sig.type === 'not') on[id] = !inputs[0]!;
        else if (sig.type === 'and') on[id] = inputs.every((x) => x);
        else on[id] = inputs.some((x) => x);
        signals[id] = on[id];
      }
      return on[id];
    };
    for (const sig of s.signals) if (isDerived(sig)) resolve(sig.id, []);
    let chosen = s.allocations[s.allocations.length - 1]!;
    for (const a of s.allocations) {
      const w = a.when;
      if (!w) {
        chosen = a;
        break;
      }
      const all = (w.all ?? []).every((id) => on[id]);
      const any = !w.any?.length || w.any.some((id) => on[id]);
      const none = (w.none ?? []).every((id) => !on[id]);
      if (all && any && none) {
        chosen = a;
        break;
      }
    }
    out.push({ date, signals, allocation: chosen.name, holdings: chosen.holdings });
  }
  return out;
}

/**
 * Equity curve: a position is a set of share-like units per holding; each session is split into
 * the night (close to open, with the ex-date dividend and the split) and the day (open to close).
 *
 * Sessions (docs/indicators.md "Days without a decision"): every date on which every ticker the
 * strategy may hold (any allocation's holdings, the safe state's, and the days' own holdings;
 * synthetic tickers through their base; cash through its rate, so it adds no condition) has a
 * bar, from the first evaluated day on. A date where only a signal's ticker has no bar is a
 * session without a decision. Each session's returns are compounded; a session without an
 * evaluated day takes the safe state as its decision, traded like any other decision. One equity
 * point per session (`dates` names them).
 *
 * Whole shares (docs/indicators.md "Whole shares", an optional run setting): the same sessions,
 * execution times and trade decisions; only the bookkeeping differs (share counts, residual USD
 * cash). Without the option the result is exactly the fractional one.
 */
export function refBacktest(
  s: Pick<RefStrategy, 'execution' | 'costs' | 'safeState'> & {
    allocations?: RefStrategy['allocations'];
  },
  days: RefDay[],
  bars: Record<string, RefBar[]>,
  cashRate: (date: string) => number,
  options?: RefBacktestOptions,
): RefBacktestResult {
  const execution = s.execution ?? 'next_open';
  // Costs (docs/indicators.md "Costs"): an omitted slippageBps or feePct throws, unless the
  // caller passes omittedCostsAsZero: true (then 0, the pre-C2 reading).
  const costOf = (name: 'slippageBps' | 'feePct'): number => {
    const v = s.costs?.[name];
    if (v !== undefined) return v;
    if (options?.omittedCostsAsZero === true) return 0;
    throw new Error(
      `reference: costs.${name} is not given (pass omittedCostsAsZero to read it as 0)`,
    );
  };
  const costRate = costOf('slippageBps') / 1e4 + costOf('feePct') / 100;
  // Base currency (docs/indicators.md "Base currency"): three capital letters, or left out.
  const baseCurrency = options?.baseCurrency;
  if (baseCurrency !== undefined && !/^[A-Z]{3}$/.test(baseCurrency)) {
    throw new Error(`reference: base currency ${JSON.stringify(baseCurrency)} is not an ISO code`);
  }
  const foreign = baseCurrency !== undefined && baseCurrency !== 'USD';
  /** The session's FX (base units per USD), checked; 1 for a USD base (never read). */
  const fxOf = (date: string): number => {
    if (!foreign) return 1;
    const fx = options?.fxRate?.(date);
    if (fx === undefined) throw new Error(`reference: unknown FX on ${date}`);
    if (!Number.isFinite(fx) || !(fx > 0))
      throw new Error(`reference: invalid FX ${fx} on ${date}`);
    return fx;
  };
  /** A covered day's deposit rate for CASH_BASE, checked. */
  const depositOf = (day: string): number => {
    const r = options?.depositRate?.(day);
    if (r === undefined) throw new Error(`reference: unknown deposit rate on ${day}`);
    if (!Number.isFinite(r)) throw new Error(`reference: invalid deposit rate ${r} on ${day}`);
    return r;
  };
  // One ticker grammar (./ticker); a ticker outside it throws, never a silent 0 or NaN.
  const parse = (ticker: string) => {
    const t = refParseTicker(ticker);
    if (t === undefined) throw new Error(`reference: malformed ticker ${JSON.stringify(ticker)}`);
    return t;
  };
  // Steps between sessions (docs/indicators.md "Returns"): the covered days are the dates strictly
  // between two sessions on which any ticker the strategy may hold has a bar, then the session.
  // Every daily rule applies once per covered day, in date order. `mayHold` is declared below and
  // read only when a step runs.
  let stepper: ReturnType<typeof refStepper> | undefined;
  const steps = () => (stepper ??= refStepper(bars, mayHold));
  const rate = (day: string) => cashRate(day) / 100 / 252;
  /**
   * A holding's return on one covered day. `kind` is 'whole' for a covered day before the session
   * and the part for the session itself. On a day without its bar a ticker's own return is 0
   * (its move counts on its next bar); cash, financing and expense still accrue.
   */
  const dailyReturn = (ticker: string, day: string, kind: 'night' | 'day' | 'whole'): number => {
    if (ticker === 'CASH_USD') return kind === 'day' ? 0 : rate(day);
    // CASH_BASE: its deposit rate per covered day; its FX move is applied once per step (move).
    if (ticker === 'CASH_BASE') return kind === 'day' ? 0 : depositOf(day) / 100 / 252;
    const { base, L, E } = parse(ticker);
    const b = steps().barOn(base, day);
    let r = 0;
    if (b) {
      if (kind === 'day') r = b.close / b.open! - 1;
      else {
        const prev = steps().prevBar(base, day);
        if (!prev) throw new Error(`reference: no bar for ${base} before ${day}`);
        const k = b.closeIsSplitAdjusted ? 1 : b.splitFactor;
        const end = kind === 'whole' ? b.close : b.open!;
        r = ((end + b.divCash) * k) / prev.close - 1;
      }
    }
    if (kind === 'day') return L * r;
    const financing = L === 1 ? 0 : (L - 1) * rate(day);
    return L * r - financing - E / 100 / 252;
  };

  let value: Record<string, number> = {}; // money per holding
  let switches = 0;
  const conversions = { count: 0, fxSpread: 0 };
  const total = () => Object.values(value).reduce((a, b) => a + b, 0);
  const move = (prevDate: string, date: string, part: 'night' | 'day' | 'whole') => {
    const covered = part === 'day' ? [date] : steps().covered(prevDate, date);
    for (const t of Object.keys(value)) {
      if (t !== 'CASH_USD' && t !== 'CASH_BASE') {
        const base = parse(t).base;
        // A step starts at the held ticker's bar on the previous session (never credited before).
        if (part !== 'day' && !steps().barOn(base, prevDate)) {
          throw new Error(`reference: ${t} is held from ${prevDate} without a bar that day`);
        }
        if (!steps().barOn(base, date)) throw new Error(`reference: no bar for ${base} on ${date}`);
      }
      for (const day of covered) {
        const growth = 1 + dailyReturn(t, day, day === date ? part : 'whole');
        if (!Number.isFinite(growth) || !(growth > 0)) {
          throw new Error(`reference: growth ${growth} for ${t} on ${day} (equity at or below 0)`);
        }
        value[t] = value[t]! * growth;
      }
      // CASH_BASE: its USD value moves with the base currency, fx(prev) / fx(date), once per step
      // in the night part or the whole day (nothing in the open-to-close part).
      if (t === 'CASH_BASE' && part !== 'day') {
        const growth = fxOf(prevDate) / fxOf(date);
        if (!Number.isFinite(growth) || !(growth > 0)) {
          throw new Error(`reference: FX growth ${growth} for CASH_BASE on ${date}`);
        }
        value[t] = value[t]! * growth;
      }
    }
  };
  const rebalance = (holdings: { ticker: string; weight: number }[]) => {
    const before = total();
    const start = Object.keys(value).length === 0;
    const wealth = start ? 1 : before;
    const goal: Record<string, number> = {};
    for (const h of holdings) goal[h.ticker] = (wealth * h.weight) / 100;
    let traded = 0;
    for (const t of new Set([...Object.keys(value), ...Object.keys(goal)])) {
      traded += Math.abs((goal[t] ?? 0) - (value[t] ?? 0));
    }
    if (start) traded = wealth;
    // FX spread (docs/indicators.md "FX spread"): |change in CASH_BASE weight| x value x spread;
    // the start is in USD (weight 0 before), and a USD base converts nothing.
    const converted = foreign ? Math.abs((goal.CASH_BASE ?? 0) - (value.CASH_BASE ?? 0)) : 0;
    const spread = converted > 0 ? converted * fxSpread() : 0;
    if (converted > 0) {
      conversions.count++;
      conversions.fxSpread += spread / wealth;
    }
    const after = wealth - traded * costRate - spread;
    value = {};
    for (const h of holdings) value[h.ticker] = (after * h.weight) / 100;
    if (!start) switches++;
  };
  // A position's identity: its (ticker, weight) pairs as a multiset, so listing the same
  // holdings in another order is no trade (requirements 05, 13). Each pair is JSON text (no raw
  // newline inside), sorted and joined by newlines; repeated tickers stay separate entries.
  const key = (h: { ticker: string; weight: number }[]) =>
    h
      .map((x) => JSON.stringify([x.ticker, x.weight]))
      .sort()
      .join('\n');

  // Sessions: dates every ticker the strategy may hold has a bar, from the first evaluated day on.
  const decided = new Map(days.map((d) => [d.date, d.holdings]));
  const mayHold = new Set<string>();
  const addHoldings = (h: { ticker: string }[]) => {
    for (const x of h) {
      if (x.ticker === 'CASH_BASE') holdsBase = true;
      // Cash (USD or base) gives no session dates.
      if (x.ticker !== 'CASH_USD' && x.ticker !== 'CASH_BASE') mayHold.add(parse(x.ticker).base);
      else parse(x.ticker);
    }
  };
  let holdsBase = false;
  for (const a of s.allocations ?? []) addHoldings(a.holdings);
  if (s.safeState) addHoldings(s.safeState.holdings);
  for (const d of days) addHoldings(d.holdings);
  let sessions: string[] = [];
  if (mayHold.size > 0) {
    const counts = new Map<string, number>();
    for (const t of mayHold) {
      if (!bars[t]) throw new Error(`reference: no bars loaded for ${t}, which may be held`);
      for (const b of bars[t]) counts.set(b.date, (counts.get(b.date) ?? 0) + 1);
    }
    sessions = [...counts].filter(([, n]) => n === mayHold.size).map(([date]) => date);
  } else {
    // Only cash may be held: no ticker to take sessions from; the sessions are the evaluated dates.
    sessions = days.map((d) => d.date);
  }
  // An evaluated day is never dropped: if a ticker lacks its bar, valuing it fails loudly.
  const known = new Set(sessions);
  for (const d of days) if (!known.has(d.date)) sessions.push(d.date);
  sessions.sort();
  const first = days.length ? [...days.map((d) => d.date)].sort()[0]! : undefined;
  sessions = first === undefined ? [] : sessions.filter((date) => date >= first);
  const decisionOn = (date: string): RefDay['holdings'] => {
    const h = decided.get(date);
    if (h) return h;
    if (!s.safeState)
      throw new Error(`reference: ${date} is not evaluated and there is no safe state`);
    return s.safeState.holdings;
  };

  if (holdsBase && baseCurrency === undefined) {
    throw new Error('reference: the strategy may hold CASH_BASE but no base currency is given');
  }
  // The FX spread is read only when the strategy may hold CASH_BASE and the base is not USD.
  let spreadRate: number | undefined;
  const fxSpread = (): number => {
    if (spreadRate !== undefined) return spreadRate;
    const v = s.costs?.fxSpreadPct;
    if (v !== undefined) spreadRate = v / 100;
    else if (options?.omittedCostsAsZero === true) spreadRate = 0;
    else throw new Error('reference: costs not resolved: fxSpreadPct is not given');
    return spreadRate;
  };
  if (holdsBase && foreign) fxSpread();

  // Every target the strategy may trade (for the whole-share refusals).
  const targets: RefDay['holdings'][] = [
    ...(s.allocations ?? []).map((a) => a.holdings),
    ...(s.safeState ? [s.safeState.holdings] : []),
    ...days.map((d) => d.holdings),
  ];
  const ws = options?.wholeShares
    ? refWholeShareBook(options.wholeShares, { costRate, bars, cashRate, targets, mayHold })
    : undefined;
  const doMove = (prevDate: string, date: string, part: 'night' | 'day' | 'whole') =>
    ws ? ws.move(prevDate, date, part) : move(prevDate, date, part);
  const doTrade = (h: RefDay['holdings'], date: string, time: 'open' | 'close') => {
    if (ws) {
      if (ws.trade(h, date, time)) switches++;
    } else rebalance(h);
  };

  const equity: number[] = [];
  let current: string | undefined;
  let queued: RefDay['holdings'] | undefined;
  for (let i = 0; i < sessions.length; i++) {
    const d = { date: sessions[i]!, holdings: decisionOn(sessions[i]!) };
    if (i > 0) {
      const prev = sessions[i - 1]!;
      if (execution === 'next_open' && queued) {
        doMove(prev, d.date, 'night');
        doTrade(queued, d.date, 'open');
        current = key(queued);
        queued = undefined;
        doMove(prev, d.date, 'day');
      } else {
        doMove(prev, d.date, 'whole');
        if (execution === 'next_close' && queued) {
          doTrade(queued, d.date, 'close');
          current = key(queued);
          queued = undefined;
        }
      }
    }
    const want = key(d.holdings);
    if (execution === 'same_close') {
      if (want !== current) {
        doTrade(d.holdings, d.date, 'close');
        current = want;
      }
    } else if (want !== (queued ? key(queued) : current)) {
      queued = want === current ? undefined : d.holdings;
    }
    if (ws) ws.point(d.date);
    else equity.push(Object.keys(value).length === 0 ? 1 : total());
  }
  const out: RefBacktestResult = ws
    ? { ...ws.result(), dates: sessions, switches }
    : { equity, dates: sessions, switches };
  if (!ws && conversions.count > 0) {
    out.conversions = { ...conversions, tax: 'not_applied' };
  }
  if (baseCurrency !== undefined) out.base = refBaseSeries(out, sessions, baseCurrency, options!);
  return out;
}

/**
 * The base-currency series (docs/indicators.md "Base currency"): equity (and whole-share value)
 * x the session's FX. An unknown FX gives null and lists the date in unknownFx; an FX that is not
 * finite or not above 0 gives null and lists it in invalidFx. A USD base is the USD series.
 */
function refBaseSeries(
  r: RefBacktestResult,
  sessions: string[],
  currency: string,
  options: RefBacktestOptions,
): RefBaseSeries {
  const unknownFx: string[] = [];
  const invalidFx: string[] = [];
  const fx = sessions.map((date): number | null => {
    if (currency === 'USD') return 1;
    const x = options.fxRate?.(date);
    if (x === undefined) {
      unknownFx.push(date);
      return null;
    }
    if (!Number.isFinite(x) || !(x > 0)) {
      invalidFx.push(date);
      return null;
    }
    return x;
  });
  const series: RefBaseSeries = {
    currency,
    equity: r.equity.map((e, i) => (fx[i] === null ? null : e * fx[i]!)),
    unknownFx,
    invalidFx,
  };
  if (r.value) {
    series.value = r.value.map((v, i) =>
      fx[i] === null ? null : { amount: v.amount * fx[i]!, currency },
    );
  }
  return series;
}

export interface RefBaseSeries {
  currency: string;
  equity: (number | null)[];
  /** Whole shares only. */
  value?: ({ amount: number; currency: string } | null)[];
  unknownFx: string[];
  invalidFx: string[];
}

export interface RefWholeShares {
  /** Plain decimal text above 0 (digits, optionally a point and digits). */
  initialAmount: string;
  currency: string;
}

export interface RefBacktestOptions {
  wholeShares?: RefWholeShares;
  /** Read an omitted slippageBps, feePct (or a needed fxSpreadPct) as 0 (otherwise it throws). */
  omittedCostsAsZero?: boolean;
  /** ISO 4217 code; without it nothing changes and CASH_BASE is refused. */
  baseCurrency?: string;
  /** Base-currency units per USD for a session, as known before it opens; undefined if unknown. */
  fxRate?: (date: string) => number | undefined;
  /** CASH_BASE deposit rate (percent a year) in force on a date; undefined if unknown. */
  depositRate?: (date: string) => number | undefined;
}

export interface RefMoney {
  amount: number;
  currency: 'USD';
}

export interface RefTrade {
  date: string;
  time: 'open' | 'close';
  V: RefMoney;
  /** Share counts of the target's non-cash tickers (0 included). */
  shares: Record<string, number>;
  zeroShares: string[];
  residual: RefMoney;
  costs: RefMoney;
}

export interface RefBacktestResult {
  equity: number[];
  dates: string[];
  switches: number;
  /** Whole shares only: the value at each close, with its currency. */
  value?: RefMoney[];
  /** Whole shares only: each holding's share of the value at each close. */
  weights?: Record<string, number>[];
  trades?: RefTrade[];
  /** Whole shares only: the sum of cost / V per trade. */
  costs?: number;
  /** When a trade converts currency: count, FX spread paid (cost / value, summed), no tax. */
  conversions?: { count: number; fxSpread: number; tax: 'not_applied' };
  /** With a base currency: the base-currency series. */
  base?: RefBaseSeries;
}

const USD = (amount: number): RefMoney => ({ amount, currency: 'USD' });

/**
 * Bar lookup and covered days (docs/indicators.md "Returns"). `covered(prev, date)`: every date
 * strictly between the two sessions on which any ticker in `mayHold` has a bar, in date order,
 * then `date`. `barOn` is the ticker's bar on a date; `prevBar` its bar before that one.
 */
export function refStepper(bars: Record<string, RefBar[]>, mayHold: Set<string>) {
  const index = new Map<string, Map<string, number>>();
  const indexOf = (ticker: string) => {
    let ix = index.get(ticker);
    if (!ix) {
      ix = new Map((bars[ticker] ?? []).map((b, i) => [b.date, i]));
      index.set(ticker, ix);
    }
    return ix;
  };
  const union = [
    ...new Set([...mayHold].flatMap((t) => (bars[t] ?? []).map((b) => b.date))),
  ].sort();
  /** First position in `union` with a date above `d` (binary search). */
  const after = (d: string) => {
    let lo = 0;
    let hi = union.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (union[mid]! <= d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    barOn(ticker: string, date: string): RefBar | undefined {
      const i = indexOf(ticker).get(date);
      return i === undefined ? undefined : bars[ticker]![i];
    },
    prevBar(ticker: string, date: string): RefBar | undefined {
      const i = indexOf(ticker).get(date);
      return i === undefined || i < 1 ? undefined : bars[ticker]![i - 1];
    },
    covered(prevDate: string, date: string): string[] {
      const out: string[] = [];
      for (let i = after(prevDate); i < union.length && union[i]! < date; i++) out.push(union[i]!);
      out.push(date);
      return out;
    },
  };
}

// Whole-number snaps (docs/indicators.md "Whole shares"), relative |x - k| <= tol x |x|. One
// constant each, so a contract change touches one line.
const SIZING_SNAP = 1e-12; // share count x before the floor at a trade (float noise only)
const SPLIT_SNAP = 1e-9; // shares x split factor

/** Within `tol` (relative) of a whole number: that number; otherwise unchanged. */
function snapWhole(x: number, tol: number): number {
  const r = Math.round(x);
  return Math.abs(x - r) <= tol * Math.abs(x) ? r : x;
}

/**
 * Whole-share bookkeeping (docs/indicators.md "Equity curves", "Whole shares"), written from the
 * contract text: share counts per ticker as traded, and a residual in USD. The caller drives the
 * same sessions, parts and trade decisions as the fractional backtest.
 *
 * Exported for direct tests of checks that refBacktest cannot reach (an entry needs a price).
 */
export function refWholeShareBook(
  opt: RefWholeShares,
  ctx: {
    costRate: number;
    bars: Record<string, RefBar[]>;
    cashRate: (date: string) => number;
    targets: RefDay['holdings'][];
    mayHold: Set<string>;
  },
) {
  const { costRate: c, bars, cashRate } = ctx;
  // Input refusals.
  if (opt.currency !== 'USD') {
    throw new Error(
      `reference: whole shares: currency ${opt.currency} is not supported (USD only)`,
    );
  }
  if (!/^\d+(\.\d+)?$/.test(opt.initialAmount) || !(Number(opt.initialAmount) > 0)) {
    throw new Error(`reference: whole shares: initial amount ${JSON.stringify(opt.initialAmount)}`);
  }
  const initial = Number(opt.initialAmount);
  // A cost rate of 100% or more leaves no budget above 0.
  if (!(c < 1)) throw new Error(`reference: whole shares: cost rate ${c} is 100% or more`);
  for (const t of ctx.targets) {
    const names = t.map((h) => h.ticker);
    if (new Set(names).size !== names.length) {
      throw new Error(
        `reference: whole shares: a target lists a ticker twice (${names.join(', ')})`,
      );
    }
    // A synthetic ticker (one with parameters) has no traded price; CASH_BASE is not modeled.
    for (const h of t) {
      if (h.ticker === 'CASH_BASE') {
        throw new Error(
          'reference: whole shares: CASH_BASE is refused (no base-currency residual)',
        );
      }
      if (h.ticker.includes('?')) {
        throw new Error(
          `reference: whole shares: synthetic ticker ${h.ticker} has no traded price`,
        );
      }
    }
  }
  // Every ticker it may hold must have bars as traded (not split-adjusted).
  for (const base of ctx.mayHold) {
    if (bars[base]!.some((b) => b.closeIsSplitAdjusted)) {
      throw new Error(`reference: whole shares: ${base} has split-adjusted bars`);
    }
  }
  const steps = refStepper(bars, ctx.mayHold);
  const indexes = new Map<string, Map<string, number>>();
  const barAt = (ticker: string, date: string): RefBar => {
    let ix = indexes.get(ticker);
    if (!ix) {
      ix = new Map(bars[ticker]!.map((b, i) => [b.date, i]));
      indexes.set(ticker, ix);
    }
    const i = ix.get(date);
    if (i === undefined)
      throw new Error(`reference: whole shares: no bar for ${ticker} on ${date}`);
    return bars[ticker]![i]!;
  };
  const rateOn = (date: string): number => {
    const r = cashRate(date);
    if (!Number.isFinite(r))
      throw new Error(`reference: whole shares: unknown cash rate on ${date}`);
    return r;
  };
  /** A ticker's price as traded: the open (next_open trades) or the close. */
  const priceOf = (ticker: string, date: string, time: 'open' | 'close'): number => {
    const b = barAt(ticker, date);
    const p = time === 'open' ? b.open : b.close;
    if (p === undefined)
      throw new Error(`reference: whole shares: no ${time} for ${ticker} on ${date}`);
    return p;
  };

  let started = false;
  let residual = 0;
  let shares: Record<string, number> = {}; // tickers held, n > 0
  let costSum = 0;
  const value: RefMoney[] = [];
  const equity: number[] = [];
  const weights: Record<string, number>[] = [];
  const trades: RefTrade[] = [];

  return {
    move(prevDate: string, date: string, part: 'night' | 'day' | 'whole') {
      if (!started || part === 'day') return; // interest and events belong to the night / whole day
      for (const t of Object.keys(shares)) {
        if (!steps.barOn(t, prevDate)) {
          throw new Error(`reference: ${t} is held from ${prevDate} without a bar that day`);
        }
        if (!steps.barOn(t, date)) throw new Error(`reference: no bar for ${t} on ${date}`);
      }
      for (const day of steps.covered(prevDate, date)) {
        // 1. Interest for the day, read only when the cash at the start of the day is above 0.
        if (residual > 0) residual = residual * (1 + rateOn(day) / 100 / 252);
        // 2. Each held ticker with a bar that day: split (snapped within 1e-9, else the whole
        //    shares are kept and the fraction is paid as cash), then the dividend on kept shares.
        for (const t of Object.keys(shares)) {
          const b = steps.barOn(t, day);
          if (!b) continue;
          const endPrice = day !== date ? b.close : part === 'night' ? b.open : b.close;
          const product = snapWhole(shares[t]! * b.splitFactor, SPLIT_SNAP);
          const kept = Math.floor(product);
          if (product !== kept) {
            if (endPrice === undefined)
              throw new Error(`reference: whole shares: no open for ${t} on ${date}`);
            residual += (product - kept) * endPrice;
          }
          residual += kept * b.divCash;
          // A reverse split can leave 0 shares: the holding is then all cash.
          if (kept === 0) delete shares[t];
          else shares[t] = kept;
        }
      }
    },

    /** Executes a trade; returns true when it was not the first one (a switch). */
    trade(target: RefDay['holdings'], date: string, time: 'open' | 'close'): boolean {
      const tickers = new Set([
        ...Object.keys(shares),
        ...target.filter((h) => h.ticker !== 'CASH_USD').map((h) => h.ticker),
      ]);
      const p: Record<string, number> = {};
      for (const t of tickers) {
        p[t] = priceOf(t, date, time);
        if (!(p[t] > 0) || !Number.isFinite(p[t])) {
          throw new Error(`reference: whole shares: price ${p[t]} for ${t} on ${date} at a trade`);
        }
      }
      let H = 0;
      for (const [t, n] of Object.entries(shares)) H += n * p[t]!;
      const V = (started ? residual : initial) + H;
      const B = V - c * H;
      const next: Record<string, number> = {};
      const counts: Record<string, number> = {};
      const zero: string[] = [];
      for (const h of target) {
        if (h.ticker === 'CASH_USD') continue;
        // x = (weight x B) / (100 x p x (1 + c)), in that order; snap (SIZING_SNAP); then floor.
        const x = (h.weight * B) / (100 * p[h.ticker]! * (1 + c));
        const n = Math.floor(snapWhole(x, SIZING_SNAP));
        if (!(n >= 0)) throw new Error(`reference: whole shares: share count ${n} for ${h.ticker}`);
        counts[h.ticker] = n;
        if (n === 0) zero.push(h.ticker);
        else next[h.ticker] = n;
      }
      let traded = 0;
      for (const t of tickers) traded += Math.abs((next[t] ?? 0) - (shares[t] ?? 0)) * p[t]!;
      const costs = c * traded;
      let bought = 0;
      for (const [t, n] of Object.entries(next)) bought += n * p[t]!;
      let rest = V - bought - costs;
      if (rest < 0) {
        if (rest >= -1e-9 * V) rest = 0;
        else throw new Error(`reference: whole shares: residual ${rest} below 0 on ${date}`);
      }
      const wasStarted = started;
      started = true;
      shares = next;
      residual = rest;
      costSum += costs / V;
      trades.push({
        date,
        time,
        V: USD(V),
        shares: counts,
        zeroShares: zero,
        residual: USD(rest),
        costs: USD(costs),
      });
      return wasStarted;
    },

    /** The point at the session's close. */
    point(date: string) {
      if (!started) {
        value.push(USD(initial));
        equity.push(1);
        weights.push({});
        return;
      }
      const at: Record<string, number> = {};
      let v = residual;
      for (const [t, n] of Object.entries(shares)) {
        at[t] = n * priceOf(t, date, 'close');
        v += at[t];
      }
      const w: Record<string, number> = {};
      for (const [t, x] of Object.entries(at)) w[t] = x / v;
      if (residual > 0) w.CASH_USD = residual / v;
      value.push(USD(v));
      equity.push(v / initial);
      weights.push(w);
    },

    result() {
      return { equity, value, weights, trades, costs: costSum };
    },
  };
}

export * from './metrics';
export * from './ticker';
export * from './statistics';
export * from './statistics-lab';
