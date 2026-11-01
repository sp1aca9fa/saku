// Reference implementation of the core math (requirements 04, layer E; docs/indicators.md):
// adjusted series, indicators, signals, allocations and equity curves, written apart from
// packages/core and on purpose with other algorithms (prefix sums, Welford's variance, explicit
// state machines). It never imports @saku/core. When the two disagree, find the root cause;
// never copy one into the other.

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
  type: 'compare' | 'ensemble';
  members?: RefComparison[];
  threshold?: number;
}

export interface RefStrategy {
  execution?: 'next_open' | 'next_close' | 'same_close';
  costs?: { slippageBps?: number; feePct?: number };
  signals: RefSignal[];
  allocations: {
    name: string;
    when?: { all?: string[]; any?: string[]; none?: string[] };
    holdings: { ticker: string; weight: number }[];
  }[];
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

/** One comparison step as a state machine (tolerance band, near-ties, plain first day). */
function refStep(value: number, ref: number, c: RefComparison, state: State): State {
  const t = (c.tolerancePct ?? 0) / 100;
  const hi = ref * (1 + t);
  const lo = ref * (1 - t);
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
  const comparisons = (sig: RefSignal): RefComparison[] =>
    sig.type === 'compare' ? [sig as RefComparison] : sig.members!;
  const tickers = new Set<string>();
  for (const sig of s.signals) {
    for (const c of comparisons(sig)) {
      if (c.left.ticker) tickers.add(c.left.ticker);
      if (c.right.ticker) tickers.add(c.right.ticker);
    }
  }
  const valueOf = (o: RefOperand, date: string): number | undefined => {
    if (o.threshold !== undefined && o.indicator === undefined) return o.threshold;
    const list = bars[o.ticker!]!;
    const i = list.findIndex((b) => b.date === date);
    const series = o.totalReturn ? refTotalReturn(list) : refPrice(list);
    switch (o.indicator) {
      case 'price':
        return series[i];
      case 'sma':
        return refSma(series, o.length!)[i];
      case 'ema':
        return refEma(series, o.length!)[i];
      case 'return':
        return refReturn(series, o.length!)[i];
      case 'drawdown':
        return refDrawdown(series, o.length)[i];
      case 'high':
        return refHigh(series, o.length!)[i];
      case 'low':
        return refLow(series, o.length!)[i];
      case 'volatility': {
        const method = o.method ?? 'close';
        if (method === 'close') return refVolatility(series, o.length!)[i];
        const d = refOhlc(list, o.totalReturn ?? false);
        if (method === 'parkinson') return refParkinson(d, o.length!)[i];
        if (method === 'garman_klass') return refGarmanKlass(d, o.length!)[i];
        return refYangZhang(d, o.length!)[i];
      }
      default:
        throw new Error(`reference: unknown indicator ${String(o.indicator)}`);
    }
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
 */
export function refBacktest(
  s: Pick<RefStrategy, 'execution' | 'costs'>,
  days: RefDay[],
  bars: Record<string, RefBar[]>,
  cashRate: (date: string) => number,
): { equity: number[]; switches: number } {
  const execution = s.execution ?? 'next_open';
  const costRate = (s.costs?.slippageBps ?? 0) / 1e4 + (s.costs?.feePct ?? 0) / 100;
  const parse = (ticker: string) => {
    const q = ticker.includes('?') ? ticker.slice(ticker.indexOf('?') + 1) : '';
    let L = 1;
    let E = 0;
    for (const part of q.split('&')) {
      const [k, v] = part.split('=');
      if (k === 'L') L = Number(v);
      if (k === 'E') E = Number(v);
    }
    return { base: ticker.split('?')[0]!, L, E };
  };
  const ret = (ticker: string, date: string, part: 'night' | 'day' | 'whole'): number => {
    const daily = cashRate(date) / 100 / 252;
    if (ticker === 'CASH_USD') return part === 'day' ? 0 : daily;
    const { base, L, E } = parse(ticker);
    const list = bars[base]!;
    const i = list.findIndex((b) => b.date === date);
    const b = list[i]!;
    const p = list[i - 1]!;
    const k = b.closeIsSplitAdjusted ? 1 : b.splitFactor;
    let r: number;
    if (part === 'whole') r = ((b.close + b.divCash) * k) / p.close - 1;
    else if (part === 'night') r = ((b.open! + b.divCash) * k) / p.close - 1;
    else r = b.close / b.open! - 1;
    return part === 'day' ? L * r : L * r - (L - 1) * daily - E / 100 / 252;
  };

  let value: Record<string, number> = {}; // money per holding
  let switches = 0;
  const total = () => Object.values(value).reduce((a, b) => a + b, 0);
  const move = (date: string, part: 'night' | 'day' | 'whole') => {
    for (const t of Object.keys(value)) value[t] = value[t]! * (1 + ret(t, date, part));
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
    const after = wealth - traded * costRate;
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

  const equity: number[] = [];
  let current: string | undefined;
  let queued: RefDay['holdings'] | undefined;
  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    if (i > 0) {
      if (execution === 'next_open' && queued) {
        move(d.date, 'night');
        rebalance(queued);
        current = key(queued);
        queued = undefined;
        move(d.date, 'day');
      } else {
        move(d.date, 'whole');
        if (execution === 'next_close' && queued) {
          rebalance(queued);
          current = key(queued);
          queued = undefined;
        }
      }
    }
    const want = key(d.holdings);
    if (execution === 'same_close') {
      if (want !== current) {
        rebalance(d.holdings);
        current = want;
      }
    } else if (want !== (queued ? key(queued) : current)) {
      queued = want === current ? undefined : d.holdings;
    }
    equity.push(Object.keys(value).length === 0 ? 1 : total());
  }
  return { equity, switches };
}
