// Reference implementation of the core math (requirements 04, layer E; docs/indicators.md):
// adjusted series, indicators, signals, allocations and equity curves, written apart from
// packages/core and on purpose with other algorithms (prefix sums, Welford's variance, explicit
// state machines). It never imports @saku/core. When the two disagree, find the root cause;
// never copy one into the other.

export interface RefBar {
  date: string;
  open?: number;
  close: number;
  divCash: number;
  splitFactor: number;
  closeIsSplitAdjusted: boolean;
}

export interface RefOperand {
  indicator?: 'price' | 'sma' | 'volatility';
  ticker?: string;
  length?: number;
  totalReturn?: boolean;
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
    if (o.indicator === 'price') return series[i];
    if (o.indicator === 'sma') return refSma(series, o.length!)[i];
    return refVolatility(series, o.length!)[i];
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
  const key = (h: { ticker: string; weight: number }[]) =>
    h.map((x) => `${x.ticker}:${x.weight}`).join(',');

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
