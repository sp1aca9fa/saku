// Overfitting statistics (requirements 09 "Overfitting statistics"; docs/analytics.md
// "Statistics": "Trials", "Effective number of independent trials", "Deflated Sharpe ratio",
// "Probability of backtest overfitting"). float64 analytics. A doubtful input gives no value
// with a reason; a trial is never dropped (dropping a tried variant understates the selection).
import type { TradingDate } from '../domain';
import { DISPERSION_FLOOR, type EquitySample, MIN_RETURNS, checkSeries } from './metrics';
import { normalCdf, normalUpperQuantile } from './normal';
import { type Statistic, nearTie, noValue, ok } from './statistic';

export interface TrialsInput {
  /** Every variant tried, each its equity per session. */
  trials: readonly (readonly EquitySample[])[];
  /** The cash's simple return over the session ending at the date's close; undefined when unknown. */
  cashReturn: (date: TradingDate) => number | undefined;
}

export interface AlignedTrials {
  /** The common dates the returns end on (`a_1 .. a_k`). */
  dates: TradingDate[];
  /** Per trial, its daily excess returns on the common dates (`T` each). */
  excess: number[][];
}

const mean = (x: readonly number[]) => {
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
};
const sampleSd = (x: readonly number[]) => {
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  return Math.sqrt(s / (x.length - 1));
};

/** Every trial's daily excess returns over the dates all trials have ("Trials"). */
export function alignTrials(input: TrialsInput): Statistic<AlignedTrials> {
  const { trials } = input;
  trials.forEach((t, j) => checkSeries(t, `trial ${j}`));
  if (trials.length === 0) return noValue('tooFewTrials');
  if (trials.some((t) => t.some((p) => p.equity <= 0))) return noValue('equityNotPositive');
  const count = new Map<TradingDate, number>();
  for (const t of trials) for (const p of t) count.set(p.date, (count.get(p.date) ?? 0) + 1);
  const common = [...count]
    .filter(([, n]) => n === trials.length)
    .map(([d]) => d)
    .sort();
  // A trial's own date strictly between two consecutive common dates: its return over that step
  // spans two of its sessions and another trial's one, so the rows would not compare.
  if (common.length >= 2) {
    const first = common[0]!;
    const last = common.at(-1)!;
    const shared = new Set(common);
    for (const t of trials) {
      if (t.some((p) => p.date > first && p.date < last && !shared.has(p.date))) {
        return noValue('datesDiffer');
      }
    }
  }
  if (common.length - 1 < MIN_RETURNS) return noValue('tooShort');
  const cash: number[] = [];
  for (const d of common.slice(1)) {
    const c = input.cashReturn(d);
    if (typeof c !== 'number' || !Number.isFinite(c)) return noValue('cashRateMissing');
    cash.push(c);
  }
  const excess = trials.map((t) => {
    const at = new Map(t.map((p) => [p.date, p.equity]));
    const x: number[] = [];
    for (let i = 1; i < common.length; i++) {
      x.push(at.get(common[i]!)! / at.get(common[i - 1]!)! - 1 - cash[i - 1]!);
    }
    return x;
  });
  if (excess.some((x) => !(sampleSd(x) > DISPERSION_FLOOR))) return noValue('noDispersion');
  return ok({ dates: common.slice(1), excess });
}

/** Refuses a malformed returns matrix (a caller error, not a data state). */
function checkMatrix(excess: readonly (readonly number[])[]): void {
  const T = excess[0]?.length ?? 0;
  for (const x of excess) {
    if (x.length !== T) throw new Error('Trials: every trial has the same number of returns.');
    if (x.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('Trials: a return is not a finite number.');
    }
  }
}

/** Daily Sharpe ratio (not annualized): mean / sample sd. */
export function dailySharpe(x: readonly number[]): number {
  return mean(x) / sampleSd(x);
}

export interface EffectiveTrials {
  /** N, real, 1 <= N <= M. */
  effective: number;
  /** M, the trials tried. */
  trials: number;
  /** The average pairwise correlation clamped to [0, 1]; undefined for one trial. */
  averageCorrelation: number | undefined;
  returns: number;
}

/**
 * Effective number of independent trials, N = rho + (1 - rho) M, rho the average pairwise
 * Pearson correlation of the trials' returns, clamped to [0, 1]. A common approximation under a
 * constant average correlation; its source is unconfirmed (owner check C42), as the contract says
 * (docs/analytics.md "Effective number of independent trials"). No trial: `tooFewTrials`; a trial
 * without swings (its correlation undefined): `noDispersion`.
 */
export function effectiveTrials(
  excess: readonly (readonly number[])[],
): Statistic<EffectiveTrials> {
  checkMatrix(excess);
  const M = excess.length;
  if (M === 0) return noValue('tooFewTrials');
  if (excess.some((x) => !(sampleSd(x) > DISPERSION_FLOOR))) return noValue('noDispersion');
  const T = excess[0]!.length;
  if (M === 1) return ok({ effective: 1, trials: 1, averageCorrelation: undefined, returns: T });
  const centered = excess.map((x) => {
    const m = mean(x);
    return x.map((v) => v - m);
  });
  const norms = centered.map((d) => Math.sqrt(d.reduce((s, v) => s + v * v, 0)));
  let sum = 0;
  let pairs = 0;
  for (let j = 0; j < M; j++) {
    for (let l = j + 1; l < M; l++) {
      let cov = 0;
      const a = centered[j]!;
      const b = centered[l]!;
      for (let i = 0; i < T; i++) cov += a[i]! * b[i]!;
      sum += Math.min(1, Math.max(-1, cov / (norms[j]! * norms[l]!)));
      pairs++;
    }
  }
  const rho = Math.min(1, Math.max(0, sum / pairs));
  return ok({ effective: rho + (1 - rho) * M, trials: M, averageCorrelation: rho, returns: T });
}

/** Euler-Mascheroni constant. */
export const EULER_GAMMA = 0.5772156649015329;

/**
 * Expected maximum daily Sharpe of N independent trials without skill (Bailey and Lopez de Prado
 * 2014): sqrt(V) x ((1 - gamma) PhiInv(1 - 1/N) + gamma PhiInv(1 - 1/(N e))), 0 for N = 1, and
 * floored at 0 (the approximation turns negative for N just above 1; the true maximum is >= 0).
 */
export function expectedMaxSharpe(trialSharpeVariance: number, effective: number): number {
  if (!Number.isFinite(effective) || effective < 1) {
    throw new Error('expectedMaxSharpe: the effective number of trials is >= 1.');
  }
  if (!Number.isFinite(trialSharpeVariance) || trialSharpeVariance < 0) {
    throw new Error('expectedMaxSharpe: the variance of the trial Sharpes is >= 0.');
  }
  if (effective === 1) return 0;
  const z =
    (1 - EULER_GAMMA) * normalUpperQuantile(1 / effective) +
    EULER_GAMMA * normalUpperQuantile(1 / (effective * Math.E));
  return Math.max(0, Math.sqrt(trialSharpeVariance) * z);
}

export interface DeflatedSharpeMoments {
  /** The selected trial's daily Sharpe. */
  sharpe: number;
  /** Its number of returns T. */
  returns: number;
  /** Skewness g3 and kurtosis g4 (not excess; 3 for a normal distribution). */
  skewness: number;
  kurtosis: number;
  /** Sample variance of all trials' daily Sharpes (unused when N = 1). */
  trialSharpeVariance: number;
  /** N, the effective number of independent trials. */
  effectiveTrials: number;
}

export interface DeflatedSharpe {
  /** The probability that the true Sharpe is above the expected maximum of N unskilled trials. */
  probability: number;
  /** Daily Sharpe of the selected trial. */
  sharpe: number;
  /** SR0, the expected maximum daily Sharpe of N trials without skill. */
  expectedMaxSharpe: number;
  skewness: number;
  kurtosis: number;
  returns: number;
  effectiveTrials: number;
}

/** The deflated Sharpe ratio from the selected trial's moments (the paper's formula). */
export function deflatedSharpeFromMoments(m: DeflatedSharpeMoments): Statistic<DeflatedSharpe> {
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`deflatedSharpe: ${k} is not a finite number.`);
    }
  }
  if (m.returns < 2) return noValue('tooShort');
  const sr0 = expectedMaxSharpe(m.trialSharpeVariance, m.effectiveTrials);
  const square = 1 - m.skewness * m.sharpe + ((m.kurtosis - 1) / 4) * m.sharpe * m.sharpe;
  if (!(square > DISPERSION_FLOOR)) return noValue('noDispersion');
  const z = ((m.sharpe - sr0) * Math.sqrt(m.returns - 1)) / Math.sqrt(square);
  return ok({
    probability: normalCdf(z),
    sharpe: m.sharpe,
    expectedMaxSharpe: sr0,
    skewness: m.skewness,
    kurtosis: m.kurtosis,
    returns: m.returns,
    effectiveTrials: m.effectiveTrials,
  });
}

/** Population skewness m3 / m2^1.5 and kurtosis m4 / m2^2 (central moments divided by T). */
export function moments(x: readonly number[]): { skewness: number; kurtosis: number } {
  const m = mean(x);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= x.length;
  m3 /= x.length;
  m4 /= x.length;
  return { skewness: m3 / m2 ** 1.5, kurtosis: m4 / (m2 * m2) };
}

/** Sample variance (n - 1). */
const sampleVariance = (x: readonly number[]) => {
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  return s / (x.length - 1);
};

/**
 * The deflated Sharpe ratio of trial `selected` among the aligned trials (Bailey and Lopez de
 * Prado 2014), with N their effective number and V the sample variance of their daily Sharpes.
 */
export function deflatedSharpe(
  excess: readonly (readonly number[])[],
  selected: number,
): Statistic<DeflatedSharpe> {
  checkMatrix(excess);
  if (!Number.isInteger(selected) || selected < 0 || selected >= excess.length) {
    throw new Error(`deflatedSharpe: no trial ${selected}.`);
  }
  const x = excess[selected]!;
  if (x.length < MIN_RETURNS) return noValue('tooShort');
  if (excess.some((t) => !(sampleSd(t) > DISPERSION_FLOOR))) return noValue('noDispersion');
  const sharpes = excess.map(dailySharpe);
  const n = effectiveTrials(excess);
  if (!n.ok) return n;
  const effective = n.value.effective;
  const { skewness, kurtosis } = moments(x);
  return deflatedSharpeFromMoments({
    sharpe: sharpes[selected]!,
    returns: x.length,
    skewness,
    kurtosis,
    trialSharpeVariance: sharpes.length > 1 ? sampleVariance(sharpes) : 0,
    effectiveTrials: effective,
  });
}

export interface BacktestOverfitting {
  /** Share of the splits where the in-sample best is at or below the out-of-sample median. */
  pbo: number;
  combinations: number;
  trials: number;
  partitions: number;
  rowsUsed: number;
  /** The oldest rows left over by the equal blocks. */
  rowsDropped: number;
}

/** The default number of partitions S (the paper's example). */
export const PBO_PARTITIONS = 16;

/** Every choice of k of 0 .. n-1, in lexicographic order. */
function* combinations(n: number, k: number): Generator<number[]> {
  const c = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield c.slice();
    let i = k - 1;
    while (i >= 0 && c[i] === n - k + i) i--;
    if (i < 0) return;
    c[i]!++;
    for (let j = i + 1; j < k; j++) c[j] = c[j - 1]! + 1;
  }
}

/**
 * Probability of backtest overfitting by combinatorially symmetric cross-validation (Bailey,
 * Borwein, Lopez de Prado and Zhu 2017), metric the daily Sharpe from block sums, mid-ranks and
 * the near-tie rule for ties.
 */
export function backtestOverfitting(
  excess: readonly (readonly number[])[],
  partitions = PBO_PARTITIONS,
): Statistic<BacktestOverfitting> {
  checkMatrix(excess);
  if (!Number.isInteger(partitions) || partitions < 2 || partitions % 2 !== 0) {
    throw new Error('backtestOverfitting: the partitions are an even integer >= 2.');
  }
  const M = excess.length;
  if (M < 2) return noValue('tooFewTrials');
  const S = partitions;
  const T = excess[0]!.length;
  const b = Math.floor(T / S);
  if ((S / 2) * b < MIN_RETURNS) return noValue('tooShort');
  const dropped = T - S * b;
  // s1[j][k], s2[j][k]: sums of trial j's returns and squares over block k, in row order.
  const s1: number[][] = [];
  const s2: number[][] = [];
  for (const x of excess) {
    const a: number[] = [];
    const q: number[] = [];
    for (let k = 0; k < S; k++) {
      let sum = 0;
      let squares = 0;
      for (let i = dropped + k * b; i < dropped + (k + 1) * b; i++) {
        sum += x[i]!;
        squares += x[i]! * x[i]!;
      }
      a.push(sum);
      q.push(squares);
    }
    s1.push(a);
    s2.push(q);
  }
  // The floor scales with the returns' size: for a constant return the subtraction leaves only
  // rounding, growing with the rows (about m x 1e-16 of S2 / m: 4e-13 at m = 4,000), which a
  // fixed floor would read as a spread. 1e-9 leaves a wide margin; a real spread below about
  // 3e-5 of the mean return (a daily Sharpe above about 30,000) is lost, none is invented.
  const floor2 = DISPERSION_FLOOR * DISPERSION_FLOOR;
  /** Each trial's Sharpe over the blocks (ascending); undefined when any has no dispersion. */
  const sharpesOver = (blocks: readonly number[]): number[] | undefined => {
    const m = blocks.length * b;
    const out: number[] = [];
    for (let j = 0; j < M; j++) {
      let S1 = 0;
      let S2 = 0;
      for (const k of blocks) {
        S1 += s1[j]![k]!;
        S2 += s2[j]![k]!;
      }
      const variance = (S2 - (S1 * S1) / m) / (m - 1);
      if (!(variance > Math.max(floor2, (1e-9 * S2) / m))) return undefined;
      out.push(S1 / m / Math.sqrt(variance));
    }
    return out;
  };
  let total = 0;
  let overfit = 0;
  for (const chosen of combinations(S, S / 2)) {
    const rest: number[] = [];
    for (let k = 0, i = 0; k < S; k++) {
      if (chosen[i] === k) i++;
      else rest.push(k);
    }
    const inSample = sharpesOver(chosen);
    const outOfSample = sharpesOver(rest);
    if (!inSample || !outOfSample) return noValue('noDispersion');
    let best = inSample[0]!;
    for (const v of inSample) if (v > best) best = v;
    const star = inSample.findIndex((v) => nearTie(v, best));
    const v = outOfSample[star]!;
    let less = 0;
    let tied = 0;
    for (const w of outOfSample) {
      if (nearTie(w, v)) tied++;
      else if (w < v) less++;
    }
    const w = (less + (tied + 1) / 2) / (M + 1);
    if (Math.log(w / (1 - w)) <= 0) overfit++;
    total++;
  }
  return ok({
    pbo: overfit / total,
    combinations: total,
    trials: M,
    partitions: S,
    rowsUsed: S * b,
    rowsDropped: dropped,
  });
}

export interface Overfitting {
  effectiveTrials: Statistic<EffectiveTrials>;
  deflatedSharpe: Statistic<DeflatedSharpe>;
  overfittingProbability: Statistic<BacktestOverfitting>;
}

/** The overfitting statistics of trial `selected` among every trial tried. */
export function overfitting(
  input: TrialsInput & { selected: number; partitions?: number },
): Overfitting {
  // Caller errors throw before any no-value reason (docs/analytics.md "Caller errors and the
  // order of reasons"): a malformed series, `selected` outside 0..M-1 (so no trial throws), and
  // partitions odd or below 2.
  input.trials.forEach((t, j) => checkSeries(t, `trial ${j}`));
  if (
    !Number.isInteger(input.selected) ||
    input.selected < 0 ||
    input.selected >= input.trials.length
  ) {
    throw new Error(`overfitting: no trial ${input.selected}.`);
  }
  const partitions = input.partitions ?? PBO_PARTITIONS;
  if (!Number.isInteger(partitions) || partitions < 2 || partitions % 2 !== 0) {
    throw new Error('backtestOverfitting: the partitions are an even integer >= 2.');
  }
  // PBO compares at least 2 trials: fewer is `tooFewTrials` before any per-trial reason.
  const pboTooFew =
    input.trials.length < 2 ? noValue<BacktestOverfitting>('tooFewTrials') : undefined;
  const aligned = alignTrials(input);
  if (!aligned.ok) {
    return {
      effectiveTrials: aligned,
      deflatedSharpe: aligned,
      overfittingProbability: pboTooFew ?? aligned,
    };
  }
  const { excess } = aligned.value;
  return {
    effectiveTrials: effectiveTrials(excess),
    deflatedSharpe: deflatedSharpe(excess, input.selected),
    overfittingProbability: pboTooFew ?? backtestOverfitting(excess, partitions),
  };
}
