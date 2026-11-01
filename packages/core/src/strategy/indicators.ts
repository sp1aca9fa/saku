// Indicators (requirements 06) over one ticker's daily series, one value per bar; `undefined`
// during the warm-up and wherever the data cannot give a value (never a guess). Formulas: the
// contract in docs/indicators.md ("Indicators (A2)" and "Indicators (B1, v1)"); the reference
// implementation computes the same from that text alone. Percent values are x 100; annualization
// uses 252 trading days (requirements 06).

/**
 * Simple moving average of the last `length` values (warm-up: length - 1 bars). Each value is
 * summed from its own window, so a longer history never changes it (incremental = full).
 */
export function sma(values: number[], length: number): (number | undefined)[] {
  return values.map((_, i) =>
    i < length - 1
      ? undefined
      : values.slice(i - length + 1, i + 1).reduce((a, b) => a + b, 0) / length,
  );
}

/**
 * Close-to-close volatility in percent, annualized with 252 days: the sample standard deviation
 * (n - 1) of the last `length` simple daily returns, times sqrt(252), times 100. Warm-up: `length`
 * bars (it needs length + 1 values).
 */
export function volatility(values: number[], length: number): (number | undefined)[] {
  const returns = values.map((v, i) => (i === 0 ? NaN : v / values[i - 1]! - 1));
  return values.map((_, i) => {
    if (i < length) return undefined;
    const window = returns.slice(i - length + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / length;
    const variance = window.reduce((a, r) => a + (r - mean) ** 2, 0) / (length - 1);
    return Math.sqrt(variance) * Math.sqrt(252) * 100;
  });
}

/**
 * Exponential moving average (docs/indicators.md, B1): alpha = 2 / (N + 1); the first value, at
 * bar N - 1, is the mean of the first N values (the seed; TradingView's convention, assumed until
 * golden values settle it); then EMA_t = alpha x v_t + (1 - alpha) x EMA_t-1. Warm-up N - 1
 * bars. Depends on every value since the series' first one: incremental and full recomputation
 * agree on the same stored history (the same operations in the same order), but a history that
 * starts earlier changes it.
 */
export function ema(values: number[], length: number): (number | undefined)[] {
  const alpha = 2 / (length + 1);
  const out = new Array<number | undefined>(values.length).fill(undefined);
  if (values.length < length) return out;
  let level = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = level;
  for (let i = length; i < values.length; i++) {
    level = alpha * values[i]! + (1 - alpha) * level;
    out[i] = level;
  }
  return out.map(finiteOrUndefined);
}

/**
 * Return over N days in percent (docs/indicators.md, B1): (v_t / v_t-N - 1) x 100, simple (not
 * log; assumed until golden values settle it). Warm-up N bars. A non-positive or non-finite
 * value at either end is a data error: no value.
 */
export function periodReturn(values: number[], length: number): (number | undefined)[] {
  return values.map((v, i) => {
    if (i < length) return undefined;
    const from = values[i - length]!;
    if (!positive(v) || !positive(from)) return undefined;
    return finiteOrUndefined((v / from - 1) * 100);
  });
}

/**
 * Drawdown in percent (docs/indicators.md, B1): (v_t / max - 1) x 100, at most 0. With `length`
 * N, the max of the last N values (today included; warm-up N - 1 bars); without, the max since
 * the series' first value (all-time high; no warm-up, depends on every value since the first). A
 * non-positive or non-finite value in the window is a data error: no value for that window (for
 * the all-time drawdown, from that day on).
 */
export function drawdown(values: number[], length?: number): (number | undefined)[] {
  if (length === undefined) {
    let peak = -Infinity;
    let broken = false;
    return values.map((v) => {
      if (!positive(v)) broken = true;
      if (broken) return undefined;
      peak = Math.max(peak, v);
      return Math.min(0, (v / peak - 1) * 100);
    });
  }
  return values.map((v, i) => {
    if (i < length - 1) return undefined;
    const window = values.slice(i - length + 1, i + 1);
    if (!window.every(positive)) return undefined;
    return Math.min(0, (v / Math.max(...window) - 1) * 100);
  });
}

/**
 * The highest of the last N series values, today included (docs/indicators.md, B1: series
 * values, i.e. closes on the series' basis, not the day's highs; assumed until golden values
 * settle it). Warm-up N - 1 bars.
 */
export function rollingHigh(values: number[], length: number): (number | undefined)[] {
  return rolling(values, length, (w) => Math.max(...w));
}

/** The lowest of the last N series values, today included (as `rollingHigh`). */
export function rollingLow(values: number[], length: number): (number | undefined)[] {
  return rolling(values, length, (w) => Math.min(...w));
}

function rolling(
  values: number[],
  length: number,
  of: (window: number[]) => number,
): (number | undefined)[] {
  return values.map((_, i) => {
    if (i < length - 1) return undefined;
    const window = values.slice(i - length + 1, i + 1);
    if (!window.every(Number.isFinite)) return undefined;
    return of(window);
  });
}

/**
 * One day on the series' basis (docs/indicators.md, B1 "Open, high and low on the series'
 * basis"): `close` is the series value; open, high and low are scaled by the same factor as the
 * close against its raw close, so ratios within the day are the raw ones. Open, high or low are
 * missing (`undefined`) when the source gave none.
 */
export interface SeriesBar {
  open?: number;
  high?: number;
  low?: number;
  close: number;
}

/** A day the range-based volatilities can read: O, H, L and C present, positive and finite, H >= L. */
interface FullBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * The day when it is usable, else undefined (docs/indicators.md, B1 "Open, high and low on the
 * series' basis"). A missing open, high or low gives no value for any window holding the day
 * (never estimated from the close); a high below a low, an open or close outside [low, high], or
 * a non-positive or non-finite value is a data error (layer A reports it) and gives no value
 * either. Checked on the series basis: all four are scaled by one positive factor, which keeps
 * their order exact, so the result is the raw bar's.
 */
function full(b: SeriesBar): FullBar | undefined {
  const { open, high, low, close } = b;
  if (open === undefined || high === undefined || low === undefined) return undefined;
  if (![open, high, low, close].every(positive)) return undefined;
  if (high < low) return undefined;
  if (open < low || open > high || close < low || close > high) return undefined;
  return { open, high, low, close };
}

/** The last N usable days ending at bar i, or undefined when one of them is not usable. */
function fullWindow(bars: SeriesBar[], i: number, length: number): FullBar[] | undefined {
  const window: FullBar[] = [];
  for (let j = i - length + 1; j <= i; j++) {
    const b = full(bars[j]!);
    if (!b) return undefined;
    window.push(b);
  }
  return window;
}

/** sqrt(252 x variance) x 100; a negative or non-finite variance (inconsistent data) gives none. */
const annualized = (variance: number): number | undefined =>
  Number.isFinite(variance) && variance >= 0 ? Math.sqrt(252 * variance) * 100 : undefined;

/**
 * Parkinson volatility in percent (docs/indicators.md, B1): sqrt(252 x S / (4 ln 2 x N)) x 100,
 * S the sum over the last N days of (ln(H/L))^2. Warm-up N - 1 bars.
 */
export function parkinson(bars: SeriesBar[], length: number): (number | undefined)[] {
  return bars.map((_, i) => {
    if (i < length - 1) return undefined;
    const window = fullWindow(bars, i, length);
    if (!window) return undefined;
    const s = window.reduce((a, b) => a + Math.log(b.high / b.low) ** 2, 0);
    return annualized(s / (4 * Math.LN2 * length));
  });
}

/**
 * Garman-Klass volatility in percent (docs/indicators.md, B1): sqrt(252 x mean over the last N
 * days of [0.5 (ln(H/L))^2 - (2 ln 2 - 1)(ln(C/O))^2]) x 100. Warm-up N - 1 bars.
 */
export function garmanKlass(bars: SeriesBar[], length: number): (number | undefined)[] {
  return bars.map((_, i) => {
    if (i < length - 1) return undefined;
    const window = fullWindow(bars, i, length);
    if (!window) return undefined;
    const sum = window.reduce(
      (a, b) =>
        a +
        0.5 * Math.log(b.high / b.low) ** 2 -
        (2 * Math.LN2 - 1) * Math.log(b.close / b.open) ** 2,
      0,
    );
    return annualized(sum / length);
  });
}

/**
 * Yang-Zhang volatility in percent (docs/indicators.md, B1), N >= 2, over the last N days:
 * sqrt(252 x (s_o + k s_c + (1 - k) s_rs)) x 100, s_o the sample variance (n - 1) of the
 * overnight ln(O_t / C_t-1), s_c the sample variance of ln(C_t / O_t), s_rs the mean of
 * ln(H/C) ln(H/O) + ln(L/C) ln(L/O), k = 0.34 / (1.34 + (N + 1) / (N - 1)). Warm-up N bars (the
 * first overnight return needs the close before the window; only that close is read of it).
 */
export function yangZhang(bars: SeriesBar[], length: number): (number | undefined)[] {
  const k = 0.34 / (1.34 + (length + 1) / (length - 1));
  return bars.map((_, i) => {
    if (i < length) return undefined;
    const window = fullWindow(bars, i, length);
    const before = bars[i - length]!.close;
    if (!window || !positive(before)) return undefined;
    const overnight = window.map((b, j) =>
      Math.log(b.open / (j === 0 ? before : window[j - 1]!.close)),
    );
    const intraday = window.map((b) => Math.log(b.close / b.open));
    const rs =
      window.reduce(
        (a, b) =>
          a +
          Math.log(b.high / b.close) * Math.log(b.high / b.open) +
          Math.log(b.low / b.close) * Math.log(b.low / b.open),
        0,
      ) / length;
    return annualized(sampleVariance(overnight) + k * sampleVariance(intraday) + (1 - k) * rs);
  });
}

function sampleVariance(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
}

const positive = (v: number) => Number.isFinite(v) && v > 0;
const finiteOrUndefined = (v: number | undefined) =>
  v !== undefined && Number.isFinite(v) ? v : undefined;
