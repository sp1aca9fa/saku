// Reference robustness-lab statistics (docs/analytics.md "Statistics": walk-forward folds,
// parameter sweep, crisis replays, Monte Carlo goal projection; requirements 09), written from
// that text alone with plain loops. It never imports @saku/core.

import type { RefBar } from './index';
import { refDays, refMetrics, type RefEquitySample, type RefMetric } from './metrics';
import {
  REF_DEFAULT_MEAN_BLOCK,
  RefRandom,
  refCheckEquity,
  refIsRealDate,
  refNearTie,
  refStationaryBootstrap,
  type RefStatistic,
  type RefStatisticReason,
} from './statistics';

const yes = <T>(value: T): RefStatistic<T> => ({ ok: true, value });
const not = <T>(reason: RefStatisticReason): RefStatistic<T> => ({ ok: false, reason });

/** The date `k` calendar days after `date` (UTC midnight arithmetic). */
function addDays(date: string, k: number): string {
  const t = new Date(0);
  t.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8)));
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() + k);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---- Walk-forward folds ----

export interface RefWalkForwardFold {
  /** B_q. */
  start: string;
  /** The date of the fold's last own point; undefined when the fold holds no point. */
  end: string | undefined;
  strategy: RefMetric<number>;
  benchmark: RefMetric<number>;
  beat: boolean | undefined;
}

export interface RefWalkForward {
  folds: RefWalkForwardFold[];
  won: number;
  measured: number;
}

/** The fold's series: the last point dated before `from` (q > 0), then `from <= t < to` (or `<= to`). */
function cutFold(
  list: readonly RefEquitySample[],
  from: string,
  to: string,
  first: boolean,
  last: boolean,
): { series: RefEquitySample[]; own: RefEquitySample[] } {
  const own: RefEquitySample[] = [];
  let before: RefEquitySample | undefined;
  for (const p of list) {
    if (p.date < from) before = p;
    else if (p.date < to || (last && p.date === to)) own.push(p);
  }
  const series = !first && before !== undefined ? [before, ...own] : [...own];
  return { series, own };
}

/** Fixed-parameter walk-forward: the yearly Sharpe ratio per fold, strategy against benchmark. */
export function refWalkForward(input: {
  points: readonly RefEquitySample[];
  benchmark: readonly RefEquitySample[];
  /** Required: the Sharpe ratio is excess over the cash return. */
  cashReturn: (date: string) => number | undefined;
  folds?: number;
}): RefStatistic<RefWalkForward> {
  if (typeof input.cashReturn !== 'function') {
    throw new Error('reference walk-forward: cashReturn is required');
  }
  refCheckEquity('points', input.points);
  refCheckEquity('benchmark', input.benchmark);
  const wanted = input.folds ?? 10;
  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new Error('reference walk-forward: folds is not an integer >= 1');
  }
  const pts = input.points;
  if (pts.length === 0) return not('tooShort');
  const t0 = pts[0]!.date;
  const D = refDays(t0, pts[pts.length - 1]!.date);
  const K = Math.min(wanted, Math.floor(D / 365));
  if (K < 2) return not('tooShort');
  const B: string[] = [];
  for (let q = 0; q <= K; q++) B.push(addDays(t0, Math.floor((q * D) / K)));

  const folds: RefWalkForwardFold[] = [];
  let won = 0;
  let measured = 0;
  for (let q = 0; q < K; q++) {
    const first = q === 0;
    const last = q === K - 1;
    const mine = cutFold(pts, B[q]!, B[q + 1]!, first, last);
    const theirs = cutFold(input.benchmark, B[q]!, B[q + 1]!, first, last);
    const strategy = refMetrics({ points: mine.series, cashReturn: input.cashReturn }).sharpe;
    const benchmark = refMetrics({ points: theirs.series, cashReturn: input.cashReturn }).sharpe;
    let beat: boolean | undefined;
    if (strategy.ok && benchmark.ok) {
      measured++;
      beat = strategy.value > benchmark.value && !refNearTie(strategy.value, benchmark.value);
      if (beat) won++;
    }
    const end = mine.own.length > 0 ? mine.own[mine.own.length - 1]!.date : undefined;
    folds.push({ start: B[q]!, end, strategy, benchmark, beat });
  }
  // Nothing measured: no value, with the first fold's reason (its strategy's, else its
  // benchmark's).
  if (measured === 0) {
    const f = folds[0]!;
    if (!f.strategy.ok) return not(f.strategy.reason);
    if (!f.benchmark.ok) return not(f.benchmark.reason);
  }
  return yes({ folds, won, measured });
}

// ---- Parameter sweep ----

export type RefPathStep = string | number;

export interface RefSweepParameter {
  /** Paths into the strategy that all take the same value. */
  paths: readonly (readonly RefPathStep[])[];
  /** A non-empty list without repeats. */
  values: readonly unknown[];
}

export interface RefSweepVariant {
  index: number[];
  values: unknown[];
  strategy: unknown;
}

/** Whether `path` already exists in `root` (keys of objects, in-range indexes of arrays). */
function pathExists(root: unknown, path: readonly RefPathStep[]): boolean {
  if (path.length === 0) return false;
  let here: unknown = root;
  for (const step of path) {
    if (Array.isArray(here)) {
      if (typeof step !== 'number' || !Number.isInteger(step) || step < 0) return false;
      if (step >= here.length) return false;
      here = here[step];
    } else if (here !== null && typeof here === 'object') {
      if (typeof step !== 'string' || !Object.prototype.hasOwnProperty.call(here, step)) {
        return false;
      }
      here = (here as Record<string, unknown>)[step];
    } else {
      return false;
    }
  }
  return true;
}

function setPath(root: unknown, path: readonly RefPathStep[], value: unknown): void {
  let here = root as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++)
    here = here[path[i]!] as Record<string | number, unknown>;
  here[path[path.length - 1]!] = structuredClone(value);
}

/** The grid's variants: the Cartesian product, first parameter outermost, last fastest. */
export function refSweepVariants(
  strategy: unknown,
  grid: readonly RefSweepParameter[],
): RefSweepVariant[] {
  grid.forEach((param, g) => {
    if (param.paths.length === 0) throw new Error(`reference sweep: parameter ${g} has no path`);
    for (const path of param.paths) {
      if (!pathExists(strategy, path)) {
        throw new Error(`reference sweep: path ${JSON.stringify(path)} is not in the strategy`);
      }
    }
    if (param.values.length === 0) throw new Error(`reference sweep: parameter ${g} has no value`);
    // A path equal to, or a prefix of, a path of another parameter is refused.
    for (let other = 0; other < grid.length; other++) {
      if (other === g) continue;
      for (const a of param.paths) {
        for (const b of grid[other]!.paths) {
          let prefix = a.length <= b.length;
          for (let i = 0; prefix && i < a.length; i++) if (a[i] !== b[i]) prefix = false;
          if (prefix) {
            throw new Error(
              `reference sweep: path ${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`,
            );
          }
        }
      }
    }
    const seen = new Set<string>();
    for (const v of param.values) {
      const key = JSON.stringify(v);
      if (seen.has(key)) throw new Error(`reference sweep: parameter ${g} repeats ${key}`);
      seen.add(key);
    }
  });
  const sizes = grid.map((p) => p.values.length);
  let count = 1;
  for (const s of sizes) count *= s;
  const out: RefSweepVariant[] = [];
  for (let flat = 0; flat < count; flat++) {
    // Mixed-radix digits of `flat`, the last parameter the lowest digit.
    const index: number[] = new Array(grid.length).fill(0);
    let rest = flat;
    for (let g = grid.length - 1; g >= 0; g--) {
      index[g] = rest % sizes[g]!;
      rest = Math.floor(rest / sizes[g]!);
    }
    const values = index.map((v, g) => grid[g]!.values[v]);
    const copy = structuredClone(strategy);
    grid.forEach((param, g) => {
      for (const path of param.paths) setPath(copy, path, values[g]);
    });
    out.push({ index, values, strategy: copy });
  }
  return out;
}

export type RefSweepEntry<S, R> =
  | { index: number[]; values: unknown[]; strategy: S; error?: undefined; result: R }
  | { index: number[]; values: unknown[]; strategy?: undefined; error: string; result?: undefined };

/**
 * The sweep driver: every variant validated by the caller's `validate` (a failing one is kept
 * with its error), every valid one run by `evaluate`, in variant order.
 */
export function refSweep<S, R>(
  strategy: unknown,
  grid: readonly RefSweepParameter[],
  validate: (s: unknown) => { ok: true; strategy: S } | { ok: false; error: string },
  evaluate: (s: S) => R,
): RefSweepEntry<S, R>[] {
  return refSweepVariants(strategy, grid).map((v) => {
    const checked = validate(v.strategy);
    if (!checked.ok) return { index: v.index, values: v.values, error: checked.error };
    return {
      index: v.index,
      values: v.values,
      strategy: checked.strategy,
      result: evaluate(checked.strategy),
    };
  });
}

/** Grid points one step away in exactly one parameter: by parameter, previous before next. */
export function refNeighbors(sizes: readonly number[], index: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let g = 0; g < sizes.length; g++) {
    for (const step of [-1, 1]) {
      const v = index[g]! + step;
      if (v < 0 || v >= sizes[g]!) continue;
      const n = [...index];
      n[g] = v;
      out.push(n);
    }
  }
  return out;
}

// ---- Crisis replays ----

export interface RefCrisisWindow {
  id: string;
  /** Peak close. */
  start: string;
  /** Trough close. */
  end: string;
  /** Where the dates come from (shown from the data). */
  source: string;
}

export interface RefReplay {
  maxDrawdown: number;
  return: number;
}

export interface RefCrisisResult {
  windows: (RefCrisisWindow & {
    strategy: RefStatistic<RefReplay>;
    benchmark: RefStatistic<RefReplay>;
    shallower: boolean | undefined;
  })[];
  covered: number;
  shallower: number;
}

function replay(list: readonly RefEquitySample[], w: RefCrisisWindow): RefStatistic<RefReplay> {
  const hasBefore = list.some((p) => p.date <= w.start);
  const hasAfter = list.some((p) => p.date >= w.end);
  if (!hasBefore || !hasAfter) return not('notCovered');
  let from = -1;
  let to = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.date <= w.start) from = i;
    if (list[i]!.date <= w.end) to = i;
  }
  const series = list.slice(from, to + 1);
  if (series.some((p) => p.equity <= 0)) return not('equityNotPositive');
  let worst = 0;
  for (let i = 0; i < series.length; i++) {
    let peak = series[0]!.equity;
    for (let j = 1; j <= i; j++) peak = Math.max(peak, series[j]!.equity);
    worst = Math.min(worst, series[i]!.equity / peak - 1);
  }
  return yes({
    maxDrawdown: worst,
    return: series[series.length - 1]!.equity / series[0]!.equity - 1,
  });
}

/** Each crisis window replayed on the strategy and the benchmark. */
export function refCrisisReplays(input: {
  strategy: readonly RefEquitySample[];
  benchmark: readonly RefEquitySample[];
  /** Required input data; there is no built-in list. */
  windows: readonly RefCrisisWindow[];
}): RefStatistic<RefCrisisResult> {
  refCheckEquity('strategy', input.strategy);
  refCheckEquity('benchmark', input.benchmark);
  const windows = input.windows;
  if (!Array.isArray(windows)) throw new Error('reference crisis: windows are required');
  const ids = new Set<string>();
  for (const w of windows) {
    if (typeof w.id !== 'string' || w.id === '' || ids.has(w.id)) {
      throw new Error(`reference crisis: window id ${JSON.stringify(w.id)} is empty or repeated`);
    }
    ids.add(w.id);
    if (!refIsRealDate(w.start) || !refIsRealDate(w.end) || !(w.start < w.end)) {
      throw new Error(`reference crisis: window ${w.id} has no real start before its end`);
    }
    if (typeof w.source !== 'string') {
      throw new Error(`reference crisis: window ${w.id} has no source`);
    }
  }
  let covered = 0;
  let shallowerCount = 0;
  const out: RefCrisisResult['windows'] = [];
  for (const w of windows) {
    const s = replay(input.strategy, w);
    const b = replay(input.benchmark, w);
    let shallower: boolean | undefined;
    if (s.ok && b.ok) {
      covered++;
      shallower =
        s.value.maxDrawdown > b.value.maxDrawdown &&
        !refNearTie(s.value.maxDrawdown, b.value.maxDrawdown);
      if (shallower) shallowerCount++;
    }
    out.push({ ...w, strategy: s, benchmark: b, shallower });
  }
  // Nothing covered: no value, the first window's reason (its strategy's, else its
  // benchmark's), `notCovered` for an empty list.
  if (covered === 0) {
    if (out.length === 0) return not('notCovered');
    const w = out[0]!;
    if (!w.strategy.ok) return not(w.strategy.reason);
    if (!w.benchmark.ok) return not(w.benchmark.reason);
  }
  return yes({ windows: out, covered, shallower: shallowerCount });
}

// ---- Monte Carlo goal projection ----

/** One date of the run's output. */
export interface RefProjectionSample {
  date: string;
  equity: number;
  /** Weights held at the date's close (as in "Metrics"). */
  weights?: Record<string, number>;
  /** The decision made at the date's close: target shares by ticker. */
  decision?: Record<string, number>;
}

/** The same tickers with the same shares (`===`), or absent on both. */
function sameShares(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  }
  return true;
}

export interface RefProjectionInput {
  /** Raw bars of every series, all ending on the same date h. */
  history: Record<string, readonly RefBar[]>;
  /** The simulated sessions after h, strictly ascending; the last is the goal date. */
  future: readonly string[];
  /** The caller's run: equity on h and every future session, optionally weights and decisions. */
  run: (bars: Record<string, RefBar[]>) => readonly RefProjectionSample[];
  initial: number;
  monthly: number;
  goal: number;
  currency: string;
  paths?: number;
  meanBlock?: number;
  seed: number;
  sampleFrom?: string;
}

export interface RefProjection {
  reached: number;
  paths: number;
  probability: number;
  /** Wilson score interval at 95%. */
  low: number;
  high: number;
  /** End values at the 5th .. 95th percentiles (nearest rank). */
  endValues: { p5: number; p25: number; p50: number; p75: number; p95: number };
  sampleDays: number;
  sampleStart: string;
  sampleEnd: string;
  meanBlock: number;
  seed: number;
  currency: string;
}

export const REF_WILSON_Z = 1.959963984540054;

/** Wilson score interval at 95% for `reached` of `P`, clamped to [0, 1]. */
export function refWilson(reached: number, P: number): { low: number; high: number } {
  const z = REF_WILSON_Z;
  const p = reached / P;
  const center = (p + (z * z) / (2 * P)) / (1 + (z * z) / P);
  const half = (z / (1 + (z * z) / P)) * Math.sqrt((p * (1 - p)) / P + (z * z) / (4 * P * P));
  // Exact at the ends: low = 0 when none reached, high = 1 when all did (not left to rounding).
  return {
    low: reached === 0 ? 0 : Math.max(0, center - half),
    high: reached === P ? 1 : Math.min(1, center + half),
  };
}

interface Relative {
  c: number;
  o: number | undefined;
  hi: number | undefined;
  lo: number | undefined;
  y: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkProjection(input: RefProjectionInput): string {
  const ids = Object.keys(input.history);
  if (ids.length === 0) throw new Error('reference projection: no history series');
  let h: string | undefined;
  for (const id of ids) {
    const bars = input.history[id]!;
    if (bars.length === 0) throw new Error(`reference projection: ${id} has no bar`);
    bars.forEach((bar, i) => {
      if (!refIsRealDate(bar.date)) throw new Error(`reference projection: ${id}[${i}] date`);
      if (i > 0 && !(bars[i - 1]!.date < bar.date)) {
        throw new Error(`reference projection: ${id} dates are not strictly ascending`);
      }
      if (!finite(bar.close) || bar.close <= 0) {
        throw new Error(`reference projection: ${id} close on ${bar.date} is not positive`);
      }
      if (!finite(bar.splitFactor) || bar.splitFactor <= 0) {
        throw new Error(`reference projection: ${id} split factor on ${bar.date} is not positive`);
      }
      if (!finite(bar.divCash)) throw new Error(`reference projection: ${id} dividend not finite`);
      for (const f of [bar.open, bar.high, bar.low]) {
        if (f !== undefined && !finite(f)) {
          throw new Error(
            `reference projection: ${id} open, high or low on ${bar.date} not finite`,
          );
        }
      }
      if (typeof bar.closeIsSplitAdjusted !== 'boolean') {
        throw new Error(`reference projection: ${id} closeIsSplitAdjusted is not a boolean`);
      }
    });
    const end = bars[bars.length - 1]!.date;
    if (h === undefined) h = end;
    else if (end !== h) throw new Error('reference projection: series end on different dates');
  }
  if (input.future.length === 0) throw new Error('reference projection: no future session');
  input.future.forEach((d, i) => {
    const before = i === 0 ? h! : input.future[i - 1]!;
    if (!refIsRealDate(d) || !(before < d)) {
      throw new Error(`reference projection: future dates are not real and ascending after h`);
    }
  });
  if (!finite(input.initial) || input.initial < 0) throw new Error('reference projection: initial');
  if (!finite(input.monthly) || input.monthly < 0) throw new Error('reference projection: monthly');
  if (!finite(input.goal) || input.goal <= 0) throw new Error('reference projection: goal');
  const paths = input.paths ?? 10000;
  if (!Number.isInteger(paths) || paths < 1) throw new Error('reference projection: paths');
  const meanBlock = input.meanBlock ?? REF_DEFAULT_MEAN_BLOCK;
  if (!finite(meanBlock) || meanBlock < 1) throw new Error('reference projection: meanBlock');
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 4294967295) {
    throw new Error('reference projection: seed is not an integer in 0 .. 2^32 - 1');
  }
  if (input.sampleFrom !== undefined && !refIsRealDate(input.sampleFrom)) {
    throw new Error('reference projection: sampleFrom is not a real date');
  }
  if (typeof input.currency !== 'string' || input.currency === '') {
    throw new Error('reference projection: currency');
  }
  return h!;
}

/** The probability of reaching `goal` by the last future session, from bootstrapped paths. */
export function refGoalProjection(input: RefProjectionInput): RefStatistic<RefProjection> {
  const h = checkProjection(input);
  const paths = input.paths ?? 10000;
  const meanBlock = input.meanBlock ?? REF_DEFAULT_MEAN_BLOCK;
  const ids = Object.keys(input.history);

  // Sample days: common dates d >= sampleFrom whose every series' previous bar is dated the
  // previous common date.
  const sets = ids.map((id) => new Set(input.history[id]!.map((b) => b.date)));
  const common = input.history[ids[0]!]!.map((b) => b.date).filter((d) =>
    sets.every((s) => s.has(d)),
  );
  const sampleDates: string[] = [];
  const relatives: Record<string, Relative>[] = [];
  for (let k = 1; k < common.length; k++) {
    const d = common[k]!;
    if (input.sampleFrom !== undefined && d < input.sampleFrom) continue;
    const day: Record<string, Relative> = {};
    let whole = true;
    for (const id of ids) {
      const bars = input.history[id]!;
      const at = bars.findIndex((b) => b.date === d);
      if (at < 1 || bars[at - 1]!.date !== common[k - 1]) {
        whole = false;
        break;
      }
      const bar = bars[at]!;
      const p = bars[at - 1]!;
      const f = bar.closeIsSplitAdjusted ? 1 : bar.splitFactor;
      day[id] = {
        c: (bar.close * f) / p.close,
        o: bar.open === undefined ? undefined : (bar.open * f) / p.close,
        hi: bar.high === undefined ? undefined : (bar.high * f) / p.close,
        lo: bar.low === undefined ? undefined : (bar.low * f) / p.close,
        y: (bar.divCash * f) / p.close,
      };
    }
    if (!whole) continue;
    sampleDates.push(d);
    relatives.push(day);
  }
  if (sampleDates.length < 252) return not('tooShort');

  const L = input.future.length;
  const ends: number[] = [];
  let reached = 0;
  let pastOfPath0: RefProjectionSample[] = [];
  for (let path = 0; path < paths; path++) {
    const rng = new RefRandom(input.seed, path);
    const draws = refStationaryBootstrap(rng, sampleDates.length, L, meanBlock);
    const bars: Record<string, RefBar[]> = {};
    for (const id of ids) {
      const real = input.history[id]!;
      const list: RefBar[] = real.map((b) => ({ ...b }));
      const adjusted = real[real.length - 1]!.closeIsSplitAdjusted;
      let P = real[real.length - 1]!.close;
      for (let i = 0; i < L; i++) {
        const r = relatives[draws[i]!]![id]!;
        const bar: RefBar = {
          date: input.future[i]!,
          close: r.c * P,
          divCash: r.y * P,
          splitFactor: 1,
          closeIsSplitAdjusted: adjusted,
        };
        if (r.o !== undefined) bar.open = r.o * P;
        if (r.hi !== undefined) bar.high = r.hi * P;
        if (r.lo !== undefined) bar.low = r.lo * P;
        list.push(bar);
        P = bar.close;
      }
      bars[id] = list;
    }

    const out = input.run(bars);
    // Look-ahead guard: the output up to h (the real history), its dates, equities, weights and
    // decisions, is path 0's on every path.
    const past = out.filter((x) => x.date <= h);
    if (path === 0) pastOfPath0 = past;
    else {
      const same =
        past.length === pastOfPath0.length &&
        past.every((x, i) => {
          const y = pastOfPath0[i]!;
          return (
            x.date === y.date &&
            x.equity === y.equity &&
            sameShares(x.weights, y.weights) &&
            sameShares(x.decision, y.decision)
          );
        });
      if (!same) {
        throw new Error(
          `reference projection: the run's output up to ${h} differs on path ${path} (look-ahead)`,
        );
      }
    }
    const equityOn = new Map<string, number>();
    for (const s of out) equityOn.set(s.date, s.equity);
    const sessions = [h, ...input.future];
    const e: number[] = [];
    for (const d of sessions) {
      const v = equityOn.get(d);
      if (v === undefined) throw new Error(`reference projection: the run has no equity on ${d}`);
      if (!finite(v)) throw new Error(`reference projection: the run's equity on ${d} not finite`);
      e.push(v);
    }
    if (e[0]! <= 0) return not('equityNotPositive');

    let W = input.initial;
    let lost = false;
    for (let i = 1; i < sessions.length; i++) {
      if (lost) continue;
      if (e[i]! <= 0) {
        lost = true;
        W = 0;
        continue;
      }
      const C = sessions[i]!.slice(0, 7) !== sessions[i - 1]!.slice(0, 7) ? input.monthly : 0;
      W = (W * e[i]!) / e[i - 1]! + C;
    }
    if (lost) W = 0;
    ends.push(W);
    if (!lost && W >= input.goal) reached++;
  }

  const sorted = [...ends].sort((a, b) => a - b);
  const nearestRank = (q: number) => sorted[Math.floor((q * paths + 99) / 100) - 1]!;
  const { low, high } = refWilson(reached, paths);
  return yes({
    reached,
    paths,
    probability: reached / paths,
    low,
    high,
    endValues: {
      p5: nearestRank(5),
      p25: nearestRank(25),
      p50: nearestRank(50),
      p75: nearestRank(75),
      p95: nearestRank(95),
    },
    sampleDays: sampleDates.length,
    sampleStart: sampleDates[0]!,
    sampleEnd: sampleDates[sampleDates.length - 1]!,
    meanBlock,
    seed: input.seed,
    currency: input.currency,
  });
}
