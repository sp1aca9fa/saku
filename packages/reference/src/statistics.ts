// Reference statistics (docs/analytics.md "Statistics"; requirements 09): the random numbers, the
// normal distribution, the stationary block bootstrap and the overfitting statistics (effective
// number of trials, deflated Sharpe ratio, PBO by CSCV), written from that text alone and as
// literally as it reads. It never imports @saku/core. The walk-forward folds, the parameter
// sweep, the crisis replays and the goal projection are in ./statistics-lab.ts.
//
// On purpose with other methods than an optimized version would use: SplitMix64 in BigInt, the
// normal distribution from Marsaglia's series and the Laplace continued fraction (evaluated
// backwards), its inverse by plain bisection, and PBO recomputing every set's sums from the
// blocks for every combination.

import type { RefEquitySample, RefNoValueReason } from './metrics';
import { REF_DISPERSION_FLOOR, REF_MIN_RETURNS } from './metrics';

// ---- Results ----

export type RefStatisticReason = RefNoValueReason | 'tooFewTrials' | 'notCovered' | 'datesDiffer';

export type RefStatistic<T> = { ok: true; value: T } | { ok: false; reason: RefStatisticReason };

const yes = <T>(value: T): RefStatistic<T> => ({ ok: true, value });
const not = <T>(reason: RefStatisticReason): RefStatistic<T> => ({ ok: false, reason });

/** The near-tie rule: tied when |a - b| <= 1e-9 x max(|a|, |b|) (two zeros are tied). */
export function refNearTie(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

// ---- Random numbers ----

const TWO_32 = 4294967296;
const MASK_64 = (1n << 64n) - 1n;

/** SplitMix64 outputs from the 64-bit start `x` (Vigna, splitmix64.c), as unsigned BigInts. */
export function refSplitMix64(x: bigint, count: number): bigint[] {
  const out: bigint[] = [];
  let state = x & MASK_64;
  for (let c = 0; c < count; c++) {
    state = (state + 0x9e3779b97f4a7c15n) & MASK_64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    out.push(z ^ (z >> 31n));
  }
  return out;
}

const isWord = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < TWO_32;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** xoshiro128** (Blackman and Vigna 2018, xoshiro128starstar.c), seeded by SplitMix64. */
export class RefRandom {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** Seeded from `(seed, stream)`, each an integer in 0 .. 2^32 - 1 (`stream` 0 when not given). */
  constructor(seed: number, stream = 0) {
    if (!isWord(seed)) throw new Error('reference random: seed is not an integer in 0 .. 2^32 - 1');
    if (!isWord(stream)) {
      throw new Error('reference random: stream is not an integer in 0 .. 2^32 - 1');
    }
    const [z1, z2] = refSplitMix64(BigInt(seed) * 4294967296n + BigInt(stream), 2);
    this.s0 = Number(z1! & 0xffffffffn);
    this.s1 = Number(z1! >> 32n);
    this.s2 = Number(z2! & 0xffffffffn);
    this.s3 = Number(z2! >> 32n);
  }

  /** A generator in the given state (four unsigned 32-bit words), for the check values. */
  static fromState(s0: number, s1: number, s2: number, s3: number): RefRandom {
    const r = new RefRandom(0, 0);
    r.s0 = s0 >>> 0;
    r.s1 = s1 >>> 0;
    r.s2 = s2 >>> 0;
    r.s3 = s3 >>> 0;
    return r;
  }

  /** One output, an unsigned 32-bit integer. */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** A float in [0, 1) with 53 random bits: two outputs a then b. */
  float(): number {
    const a = this.next();
    const b = this.next();
    return ((a >>> 5) * 67108864 + (b >>> 6)) / 9007199254740992;
  }

  /** An integer in [0, n), n an integer in 1 .. 2^32, by rejection (no modulo bias). */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
      throw new Error('reference random: int(n) needs an integer n in 1 .. 2^32');
    }
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }
}

// ---- Normal distribution ----

/** The standard normal density, exp(-x^2/2) split as Cody does so x^2 adds no rounding. */
function density(x: number): number {
  const xh = Math.trunc(x * 16) / 16; // a few bits: xh * xh is exact
  const rest = (x - xh) * (x + xh); // x^2 - xh^2
  return (Math.exp(-(xh * xh) / 2) * Math.exp(-rest / 2)) / Math.sqrt(2 * Math.PI);
}

/**
 * Upper tail Q(x) = 1 - Phi(x) for x >= 1 by the Laplace continued fraction
 * Q(x) = density(x) / (x + 1/(x + 2/(x + 3/(x + ...)))), evaluated backwards from 3000 terms
 * (checked against 420-digit values: at x = 1 it has converged to the last bits by 2000 terms,
 * at x = 2 by 200).
 */
function upperTail(x: number): number {
  let f = x;
  for (let n = 3000; n >= 1; n--) f = x + n / f;
  return density(x) / f;
}

/** Phi(z), the standard normal distribution function. */
export function refPhi(z: number): number {
  if (Number.isNaN(z)) throw new Error('reference Phi: z is not a number');
  if (z === -Infinity) return 0;
  if (z === Infinity) return 1;
  if (z <= -1) return upperTail(-z);
  if (z >= 1) return 1 - upperTail(z);
  // Marsaglia (2004): Phi(z) = 1/2 + density(z) (z + z^3/3 + z^5/(3 x 5) + ...), all terms of
  // one sign, summed until a term no longer changes the sum.
  let sum = 0;
  let term = z;
  for (let k = 1; sum + term !== sum; k++) {
    sum += term;
    term = (term * z * z) / (2 * k + 1);
  }
  return 0.5 + density(z) * sum;
}

/** The lower quantile for q in (0, 0.5) by bisection on Phi over [-40, 0]. */
function lowerQuantile(q: number): number {
  let lo = -40;
  let hi = 0;
  for (;;) {
    const mid = lo + (hi - lo) / 2;
    if (mid === lo || mid === hi) break;
    if (refPhi(mid) < q) lo = mid;
    else hi = mid;
  }
  return Math.abs(refPhi(lo) - q) <= Math.abs(refPhi(hi) - q) ? lo : hi;
}

/**
 * PhiInv(p), the inverse of Phi. The upper tail from q = 1 - p (exact for p >= 0.5) as
 * -PhiInv(q). p = 0 is -Infinity and p = 1 is +Infinity; outside [0, 1] it throws.
 */
export function refPhiInv(p: number): number {
  if (!(p >= 0 && p <= 1)) throw new Error('reference PhiInv: p is not in [0, 1]');
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p === 0.5) return 0;
  if (p < 0.5) return lowerQuantile(p);
  return -lowerQuantile(1 - p);
}

// ---- Stationary block bootstrap ----

/** The default mean block length, 20 trading days (a choice: about one month). */
export const REF_DEFAULT_MEAN_BLOCK = 20;

/**
 * Day indexes of one bootstrapped path of `L` days from a sample of `n` days (Politis and
 * Romano 1994): day 0 `i = int(n)`; each next day `u = float()`, a new block (`i = int(n)`) when
 * `u < 1 / meanBlock`, else `i = (i + 1) mod n`.
 */
export function refStationaryBootstrap(
  rng: RefRandom,
  n: number,
  L: number,
  meanBlock = REF_DEFAULT_MEAN_BLOCK,
): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('reference bootstrap: n is not >= 1');
  if (!Number.isInteger(L) || L < 0) throw new Error('reference bootstrap: L is not >= 0');
  if (typeof meanBlock !== 'number' || !Number.isFinite(meanBlock) || meanBlock < 1) {
    throw new Error('reference bootstrap: meanBlock is not a finite number >= 1');
  }
  const days: number[] = [];
  if (L === 0) return days;
  let i = rng.int(n);
  days.push(i);
  for (let d = 1; d < L; d++) {
    const u = rng.float();
    if (u < 1 / meanBlock) i = rng.int(n);
    else i = (i + 1) % n;
    days.push(i);
  }
  return days;
}

// ---- Trials ----

export interface RefTrialsInput {
  /** Every variant tried, each its equity (dates strictly ascending, finite). */
  trials: readonly (readonly RefEquitySample[])[];
  /** The cash's simple return over the session ending at the date's close (asOf). */
  cashReturn?: (date: string) => number | undefined;
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** A real `YYYY-MM-DD` calendar date. */
export function refIsRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const lengths = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= lengths[m - 1]!;
}

/** Throws on a caller error: an unreal date, dates not strictly ascending, a non-finite equity. */
export function refCheckEquity(name: string, list: readonly RefEquitySample[]): void {
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (!refIsRealDate(p.date)) throw new Error(`reference: ${name}[${i}] has no real date`);
    if (i > 0 && !(list[i - 1]!.date < p.date)) {
      throw new Error(`reference: ${name} dates are not strictly ascending at ${p.date}`);
    }
    if (typeof p.equity !== 'number' || !Number.isFinite(p.equity)) {
      throw new Error(`reference: ${name} equity on ${p.date} is not a finite number`);
    }
  }
}

export interface RefAlignedRows {
  /** x[j][i - 1] = x_(j,i), i = 1 .. T. */
  x: number[][];
  T: number;
  /** The common dates a_0 .. a_T. */
  dates: string[];
}

/**
 * The aligned excess returns of the trials with the no-value reasons in the contract's order:
 * fewer than `minTrials` (`tooFewTrials`), any equity <= 0, a trial's date strictly between two
 * consecutive common dates (`datesDiffer`), T < MIN_RETURNS, an unknown cash return, a trial
 * without swings.
 */
export function refAlignedExcessReturns(
  input: RefTrialsInput,
  minTrials = 1,
): RefStatistic<RefAlignedRows> {
  input.trials.forEach((t, j) => refCheckEquity(`trial ${j}`, t));
  const M = input.trials.length;
  if (M < minTrials) return not('tooFewTrials');
  for (const trial of input.trials) {
    for (const p of trial) if (p.equity <= 0) return not('equityNotPositive');
  }
  // Common dates, in order: trial 0's dates that every other trial has.
  const others = input.trials.slice(1).map((t) => new Set(t.map((p) => p.date)));
  const common: string[] = [];
  for (const p of input.trials[0]!) {
    if (others.every((set) => set.has(p.date))) common.push(p.date);
  }
  // A date strictly between two consecutive common dates is one strictly between the first and
  // the last common date that is not itself common; dates outside that range are only cut.
  if (common.length >= 2) {
    const isCommon = new Set(common);
    const first = common[0]!;
    const last = common[common.length - 1]!;
    for (const trial of input.trials) {
      for (const p of trial) {
        if (p.date > first && p.date < last && !isCommon.has(p.date)) return not('datesDiffer');
      }
    }
  }
  const T = common.length - 1;
  if (T < REF_MIN_RETURNS) return not('tooShort');
  const cash: number[] = [];
  for (let i = 1; i <= T; i++) {
    const c = input.cashReturn?.(common[i]!);
    if (typeof c !== 'number' || !Number.isFinite(c)) return not('cashRateMissing');
    cash.push(c);
  }
  const x: number[][] = [];
  for (const trial of input.trials) {
    const byDate = new Map<string, number>();
    for (const p of trial) byDate.set(p.date, p.equity);
    const row: number[] = [];
    for (let i = 1; i <= T; i++) {
      row.push(byDate.get(common[i]!)! / byDate.get(common[i - 1]!)! - 1 - cash[i - 1]!);
    }
    x.push(row);
  }
  for (const row of x) if (!(sampleSd(row) > REF_DISPERSION_FLOOR)) return not('noDispersion');
  return yes({ x, T, dates: common });
}

function average(xs: number[]): number {
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}

function sampleSd(xs: number[]): number {
  const mu = average(xs);
  let s = 0;
  for (const v of xs) s += (v - mu) * (v - mu);
  return Math.sqrt(s / (xs.length - 1));
}

/** The daily Sharpe ratio mean / sample sd. */
function dailySharpe(xs: number[]): number {
  return average(xs) / sampleSd(xs);
}

function pearson(a: number[], b: number[]): number {
  const ma = average(a);
  const mb = average(b);
  let cov = 0;
  for (let i = 0; i < a.length; i++) cov += (a[i]! - ma) * (b[i]! - mb);
  cov /= a.length - 1;
  const r = cov / (sampleSd(a) * sampleSd(b));
  return Math.min(1, Math.max(-1, r));
}

// ---- Effective number of independent trials ----

export interface RefEffectiveTrials {
  effective: number;
  trials: number;
  averageCorrelation: number | undefined;
  returns: number;
}

function effectiveOf(x: number[][], T: number): RefEffectiveTrials {
  const M = x.length;
  if (M === 1) return { effective: 1, trials: 1, averageCorrelation: undefined, returns: T };
  let total = 0;
  let pairs = 0;
  for (let j = 0; j < M; j++) {
    for (let l = j + 1; l < M; l++) {
      total += pearson(x[j]!, x[l]!);
      pairs++;
    }
  }
  const rho = Math.min(1, Math.max(0, total / pairs));
  return { effective: rho + (1 - rho) * M, trials: M, averageCorrelation: rho, returns: T };
}

/**
 * N = rho + (1 - rho) x M from a returns matrix (one row per trial), rho the average pairwise
 * correlation clamped to [0, 1]. No trial: `tooFewTrials`; a row with fewer than 2 returns or
 * sd <= DISPERSION_FLOOR: `noDispersion`; rows of unequal length or a non-finite return throw.
 */
export function refEffectiveTrials(
  x: readonly (readonly number[])[],
): RefStatistic<RefEffectiveTrials> {
  for (const row of x) {
    if (row.length !== x[0]!.length) throw new Error('reference effective trials: unequal rows');
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error('reference effective trials: a return is not a finite number');
      }
    }
  }
  if (x.length === 0) return not('tooFewTrials');
  const rows = x.map((row) => [...row]);
  for (const row of rows) {
    if (row.length < 2 || !(sampleSd(row) > REF_DISPERSION_FLOOR)) return not('noDispersion');
  }
  return yes(effectiveOf(rows, rows[0]!.length));
}

/** The effective number of trials of the trials' aligned excess returns. */
export function refEffectiveTrialsOfTrials(
  input: RefTrialsInput,
): RefStatistic<RefEffectiveTrials> {
  const rows = refAlignedExcessReturns(input, 1);
  if (!rows.ok) return not(rows.reason);
  return refEffectiveTrials(rows.value.x);
}

// ---- Deflated Sharpe ratio ----

export const REF_EULER_GAMMA = 0.5772156649015329;
export const REF_E = 2.718281828459045;

export interface RefDsrMoments {
  /** The selected trial's daily Sharpe ratio. */
  sharpe: number;
  /** Its returns T. */
  returns: number;
  /** N, the effective number of trials. */
  effectiveTrials: number;
  /** V, the sample variance of the trials' daily Sharpe ratios (unused when N = 1). */
  sharpeVariance: number | undefined;
  /** g3 and g4 (not excess kurtosis). */
  skewness: number;
  kurtosis: number;
}

/** SR0 = sqrt(V) ((1 - gamma) PhiInv(1 - 1/N) + gamma PhiInv(1 - 1/(N e))), floored at 0. */
export function refExpectedMaxSharpe(N: number, V: number | undefined): number {
  if (N === 1) return 0;
  if (V === undefined || !(V >= 0)) {
    throw new Error('reference DSR: the variance of the Sharpe ratios is needed when N > 1');
  }
  if (V === 0) return 0;
  const z =
    (1 - REF_EULER_GAMMA) * refPhiInv(1 - 1 / N) + REF_EULER_GAMMA * refPhiInv(1 - 1 / (N * REF_E));
  return Math.max(0, Math.sqrt(V) * z);
}

/** The deflated Sharpe ratio from its moments (the paper's worked example uses this directly). */
export function refDeflatedSharpeFromMoments(
  m: RefDsrMoments,
): RefStatistic<{ probability: number; expectedMaxSharpe: number }> {
  const SR0 = refExpectedMaxSharpe(m.effectiveTrials, m.sharpeVariance);
  const square = 1 - m.skewness * m.sharpe + ((m.kurtosis - 1) / 4) * m.sharpe * m.sharpe;
  if (!(square > REF_DISPERSION_FLOOR)) return not('noDispersion');
  const zScore = ((m.sharpe - SR0) * Math.sqrt(m.returns - 1)) / Math.sqrt(square);
  return yes({ probability: refPhi(zScore), expectedMaxSharpe: SR0 });
}

export interface RefDeflatedSharpe {
  probability: number;
  sharpe: number;
  expectedMaxSharpe: number;
  skewness: number;
  kurtosis: number;
  returns: number;
  effectiveTrials: number;
}

/** The deflated Sharpe ratio of trial `selected` among all trials tried. */
export function refDeflatedSharpe(
  input: RefTrialsInput & { selected: number },
): RefStatistic<RefDeflatedSharpe> {
  // A caller error, so before any data state (with no trial, no index is in range).
  const sel = input.selected;
  if (!Number.isInteger(sel) || sel < 0 || sel >= input.trials.length) {
    throw new Error('reference DSR: selected is not the index of a trial');
  }
  const rows = refAlignedExcessReturns(input, 1);
  if (!rows.ok) return not(rows.reason);
  const { x, T } = rows.value;
  const M = x.length;
  const own = x[input.selected]!;
  const SR = dailySharpe(own);
  // Population central moments m_k = sum((x - mean)^k) / T.
  const mu = average(own);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of own) {
    const dev = v - mu;
    m2 += dev ** 2;
    m3 += dev ** 3;
    m4 += dev ** 4;
  }
  m2 /= T;
  m3 /= T;
  m4 /= T;
  const g3 = m3 / m2 ** 1.5;
  const g4 = m4 / (m2 * m2);
  let V: number | undefined;
  if (M > 1) {
    const sharpes = x.map(dailySharpe);
    const ms = average(sharpes);
    let s = 0;
    for (const v of sharpes) s += (v - ms) * (v - ms);
    V = s / (M - 1);
  }
  const N = effectiveOf(x, T).effective;
  const d = refDeflatedSharpeFromMoments({
    sharpe: SR,
    returns: T,
    effectiveTrials: N,
    sharpeVariance: V,
    skewness: g3,
    kurtosis: g4,
  });
  if (!d.ok) return not(d.reason);
  return yes({
    probability: d.value.probability,
    sharpe: SR,
    expectedMaxSharpe: d.value.expectedMaxSharpe,
    skewness: g3,
    kurtosis: g4,
    returns: T,
    effectiveTrials: N,
  });
}

// ---- Probability of backtest overfitting (CSCV) ----

export interface RefPbo {
  pbo: number;
  combinations: number;
  trials: number;
  partitions: number;
  rowsUsed: number;
  rowsDropped: number;
}

/** Every choice of `k` of 0 .. n-1, in lexicographic order of the chosen indexes. */
function choose(n: number, k: number): number[][] {
  const out: number[][] = [];
  const walk = (from: number, picked: number[]) => {
    if (picked.length === k) {
      out.push([...picked]);
      return;
    }
    for (let i = from; i < n; i++) {
      picked.push(i);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/** PBO by combinatorially symmetric cross-validation, metric the daily Sharpe ratio. */
export function refPbo(input: RefTrialsInput & { partitions?: number }): RefStatistic<RefPbo> {
  const S = input.partitions ?? 16;
  if (!Number.isInteger(S) || S < 2 || S % 2 !== 0) {
    throw new Error('reference PBO: partitions is not an even integer >= 2');
  }
  const rows = refAlignedExcessReturns(input, 2);
  if (!rows.ok) return not(rows.reason);
  const { x, T } = rows.value;
  const M = x.length;
  const b = Math.floor(T / S);
  const dropped = T - S * b;
  if ((S / 2) * b < REF_MIN_RETURNS) return not('tooShort');

  // Block sums per trial and block, summed in row order (the oldest `dropped` rows left out).
  const s1: number[][] = [];
  const s2: number[][] = [];
  for (let j = 0; j < M; j++) {
    s1.push([]);
    s2.push([]);
    for (let k = 0; k < S; k++) {
      let a = 0;
      let q = 0;
      for (let r = dropped + k * b; r < dropped + (k + 1) * b; r++) {
        a += x[j]![r]!;
        q += x[j]![r]! * x[j]![r]!;
      }
      s1[j]!.push(a);
      s2[j]!.push(q);
    }
  }

  const setSharpe = (j: number, blocks: number[]): number | undefined => {
    let A = 0;
    let Q = 0;
    for (const k of blocks) {
      A += s1[j]![k]!;
      Q += s2[j]![k]!;
    }
    const m = blocks.length * b;
    const variance = (Q - (A * A) / m) / (m - 1);
    // Floor scaled with the returns' size: for a constant return the subtraction leaves only
    // rounding, growing with the rows (about m x 1e-16 of S2 / m); 1e-9 leaves a wide margin.
    const floor = Math.max(REF_DISPERSION_FLOOR * REF_DISPERSION_FLOOR, (1e-9 * Q) / m);
    if (!(variance > floor)) return undefined;
    return A / m / Math.sqrt(variance);
  };

  const combos = choose(S, S / 2);
  let overfit = 0;
  for (const chosen of combos) {
    const rest: number[] = [];
    for (let k = 0; k < S; k++) if (!chosen.includes(k)) rest.push(k);
    const inSample: number[] = [];
    const outOfSample: number[] = [];
    for (let j = 0; j < M; j++) {
      const a = setSharpe(j, chosen);
      const o = setSharpe(j, rest);
      if (a === undefined || o === undefined) return not('noDispersion');
      inSample.push(a);
      outOfSample.push(o);
    }
    let best = inSample[0]!;
    for (const v of inSample) if (v > best) best = v;
    let star = 0;
    while (!refNearTie(inSample[star]!, best)) star++;
    const mine = outOfSample[star]!;
    let less = 0;
    let tied = 0;
    for (const v of outOfSample) {
      if (refNearTie(v, mine)) tied++;
      else if (v < mine) less++;
    }
    const rank = less + (tied + 1) / 2;
    const w = rank / (M + 1);
    const lambda = Math.log(w / (1 - w));
    if (lambda <= 0) overfit++;
  }
  return yes({
    pbo: overfit / combos.length,
    combinations: combos.length,
    trials: M,
    partitions: S,
    rowsUsed: S * b,
    rowsDropped: dropped,
  });
}
