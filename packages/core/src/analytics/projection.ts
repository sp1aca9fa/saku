// Monte Carlo goal projection (requirements 09 "Monte Carlo goal projection"; docs/analytics.md
// "Statistics", "Monte Carlo goal projection"): the assets' daily bars are resampled jointly with
// the stationary bootstrap, the caller re-runs the strategy on each simulated path, and the
// share of paths reaching the goal is reported with its Wilson interval and end-value ranges.
// float64 analytics: a projection, never a booked amount; amounts carry their currency.
import type { RawBar, TradingDate } from '../domain';
import { isTradingDate } from '../time';
import type { EquitySample } from './metrics';
import { DEFAULT_MEAN_BLOCK, createRng, stationaryBootstrap } from './random';
import { type Statistic, noValue, ok } from './statistic';

export interface GoalProjectionInput {
  /** Raw bars of every series the strategy reads or may hold, all ending on the same date (h). */
  history: Record<string, readonly RawBar[]>;
  /** The simulated sessions after h, strictly ascending; the last is the goal date. */
  future: readonly TradingDate[];
  /** The caller's strategy run on history plus simulated bars: equity on h and every future session. */
  run: (bars: Record<string, RawBar[]>) => readonly EquitySample[];
  /** Amount at h's close (>= 0), monthly contribution (>= 0) and goal (> 0), all in `currency`. */
  initial: number;
  monthly: number;
  goal: number;
  currency: string;
  /** Required and recorded with the result: the same seed draws the same paths. */
  seed: number;
  paths?: number;
  meanBlock?: number;
  /** The first date a sample day may have. */
  sampleFrom?: TradingDate;
}

export interface GoalProjection {
  /** Paths whose value on the goal date is at least the goal. */
  reached: number;
  paths: number;
  probability: number;
  /** Wilson score interval at 95% of the probability (simulation noise only). */
  low: number;
  high: number;
  /** End values at the 5th, 25th, 50th, 75th and 95th percentiles (nearest rank). */
  endValues: { p5: number; p25: number; p50: number; p75: number; p95: number };
  sampleDays: number;
  /** The first and last sample day. */
  sampleStart: TradingDate;
  sampleEnd: TradingDate;
  meanBlock: number;
  seed: number;
  currency: string;
}

export const PROJECTION_PATHS = 10_000;
/** A sample shorter than a year of sessions says nothing about a year. */
export const MIN_SAMPLE_DAYS = 252;
/** PhiInv(0.975). */
export const Z95 = 1.959963984540054;

/** Wilson score interval at 95% for `k` successes in `n` trials (Wilson 1927). */
export function wilson95(k: number, n: number): { low: number; high: number } {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(k) || k < 0 || k > n) {
    throw new Error('wilson95: k and n are integers, 0 <= k <= n, n >= 1.');
  }
  const p = k / n;
  const z2 = Z95 * Z95;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // At k = 0 and k = n the exact bounds are 0 and 1; rounding is not left to decide them.
  return {
    low: k === 0 ? 0 : Math.max(0, center - half),
    high: k === n ? 1 : Math.min(1, center + half),
  };
}

/** One sampled day of one series, relative to its previous close. */
interface Relative {
  c: number;
  o: number | undefined;
  hi: number | undefined;
  lo: number | undefined;
  y: number;
}

const finitePositive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finiteOrMissing = (v: unknown) =>
  v === undefined || (typeof v === 'number' && Number.isFinite(v));

function checkInput(input: GoalProjectionInput): void {
  const names = Object.keys(input.history);
  if (names.length === 0) throw new Error('goalProjection: no series in the history.');
  let end: TradingDate | undefined;
  for (const name of names) {
    const bars = input.history[name]!;
    if (bars.length === 0) throw new Error(`goalProjection: ${name} has no bars.`);
    bars.forEach((b, i) => {
      if (typeof b.date !== 'string' || !isTradingDate(b.date)) {
        throw new Error(`goalProjection: ${name}: ${String(b.date)} is not a YYYY-MM-DD date.`);
      }
      if (i > 0 && b.date <= bars[i - 1]!.date) {
        throw new Error(`goalProjection: ${name}: dates are not strictly ascending at ${b.date}.`);
      }
      if (!finitePositive(b.close) || !finitePositive(b.splitFactor)) {
        throw new Error(`goalProjection: ${name}: close or split on ${b.date} is not positive.`);
      }
      if (
        !(typeof b.divCash === 'number' && Number.isFinite(b.divCash) && b.divCash >= 0) ||
        !finiteOrMissing(b.open) ||
        !finiteOrMissing(b.high) ||
        !finiteOrMissing(b.low)
      ) {
        throw new Error(`goalProjection: ${name}: a field on ${b.date} is not a finite number.`);
      }
    });
    const last = bars.at(-1)!.date;
    if (end !== undefined && last !== end) {
      throw new Error('goalProjection: every series ends on the same date.');
    }
    end = last;
  }
  const { future } = input;
  if (future.length === 0) throw new Error('goalProjection: no future session.');
  future.forEach((d, i) => {
    if (typeof d !== 'string' || !isTradingDate(d)) {
      throw new Error(`goalProjection: ${String(d)} is not a YYYY-MM-DD date.`);
    }
    if (d <= (i === 0 ? end! : future[i - 1]!)) {
      throw new Error(`goalProjection: future sessions are strictly ascending after ${end}.`);
    }
  });
  const amount = (v: number, name: string, positive: boolean) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (positive && v === 0)) {
      throw new Error(`goalProjection: ${name} is a finite number ${positive ? '> 0' : '>= 0'}.`);
    }
  };
  amount(input.initial, 'initial', false);
  amount(input.monthly, 'monthly', false);
  amount(input.goal, 'goal', true);
  if (typeof input.currency !== 'string' || input.currency === '') {
    throw new Error('goalProjection: the currency is required.');
  }
  const paths = input.paths ?? PROJECTION_PATHS;
  if (!Number.isInteger(paths) || paths < 1 || paths > 4_294_967_296) {
    throw new Error('goalProjection: paths is an integer in 1 .. 2^32.');
  }
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed >= 4_294_967_296) {
    throw new Error('goalProjection: the seed is an integer in 0 .. 2^32 - 1.');
  }
  const meanBlock = input.meanBlock ?? DEFAULT_MEAN_BLOCK;
  if (typeof meanBlock !== 'number' || !Number.isFinite(meanBlock) || meanBlock < 1) {
    throw new Error('goalProjection: meanBlock is a number >= 1.');
  }
  if (input.sampleFrom !== undefined && !isTradingDate(input.sampleFrom)) {
    throw new Error('goalProjection: sampleFrom is a YYYY-MM-DD date.');
  }
}

/** The sample days ("Sample days"): every series has them, and its own previous bar is the previous common date. */
function sample(input: GoalProjectionInput, names: readonly string[]) {
  const index = names.map((n) => new Map(input.history[n]!.map((b, i) => [b.date, i])));
  const common = [...index[0]!.keys()].filter((d) => index.every((m) => m.has(d)));
  const days: TradingDate[] = [];
  const rows: Relative[][] = [];
  for (let j = 1; j < common.length; j++) {
    const d = common[j]!;
    if (input.sampleFrom !== undefined && d < input.sampleFrom) continue;
    const row: Relative[] = [];
    let usable = true;
    names.forEach((n, s) => {
      const bars = input.history[n]!;
      const i = index[s]!.get(d)!;
      if (i === 0 || bars[i - 1]!.date !== common[j - 1]) {
        usable = false;
        return;
      }
      const b = bars[i]!;
      const prev = bars[i - 1]!.close;
      const k = b.closeIsSplitAdjusted ? 1 : b.splitFactor;
      const rel = (v: number | undefined) => (v === undefined ? undefined : (v * k) / prev);
      row.push({
        c: (b.close * k) / prev,
        o: rel(b.open),
        hi: rel(b.high),
        lo: rel(b.low),
        y: (b.divCash * k) / prev,
      });
    });
    if (usable) {
      days.push(d);
      rows.push(row);
    }
  }
  return { days, rows };
}

const monthOf = (date: TradingDate) => date.slice(0, 7);

/** The nearest-rank percentile: the ceil(q x n / 100)-th smallest. */
function nearestRank(sorted: readonly number[], q: number): number {
  const k = Math.floor((q * sorted.length + 99) / 100);
  return sorted[Math.max(1, k) - 1]!;
}

/**
 * The probability of reaching `goal` by the last future session, with contributions, over
 * bootstrapped paths (path p draws from the generator seeded with (seed, p)).
 */
export function goalProjection(input: GoalProjectionInput): Statistic<GoalProjection> {
  checkInput(input);
  const paths = input.paths ?? PROJECTION_PATHS;
  const meanBlock = input.meanBlock ?? DEFAULT_MEAN_BLOCK;
  const names = Object.keys(input.history).sort();
  const { days, rows } = sample(input, names);
  if (days.length < MIN_SAMPLE_DAYS) return noValue('tooShort');
  const h = input.history[names[0]!]!.at(-1)!.date;
  const L = input.future.length;
  const ends: number[] = [];
  let reached = 0;
  let firstPast: readonly EquitySample[] = [];
  for (let p = 0; p < paths; p++) {
    const draw = stationaryBootstrap(createRng(input.seed, p), days.length, L, meanBlock);
    const bars: Record<string, RawBar[]> = {};
    names.forEach((n, s) => {
      const history = input.history[n]!;
      const adjusted = history.at(-1)!.closeIsSplitAdjusted;
      let P = history.at(-1)!.close;
      const synthetic: RawBar[] = draw.map((i, t) => {
        const r = rows[i]![s]!;
        const scale = (v: number | undefined) => (v === undefined ? undefined : v * P);
        const bar: RawBar = {
          date: input.future[t]!,
          close: r.c * P,
          closeIsSplitAdjusted: adjusted,
          divCash: r.y * P,
          splitFactor: 1,
        };
        const open = scale(r.o);
        const high = scale(r.hi);
        const low = scale(r.lo);
        if (open !== undefined) bar.open = open;
        if (high !== undefined) bar.high = high;
        if (low !== undefined) bar.low = low;
        P = bar.close;
        return bar;
      });
      bars[n] = [...history, ...synthetic];
    });
    const output = input.run(bars);
    const equity = new Map(output.map((e) => [e.date, e.equity]));
    // Look-ahead guard: the run's past (dates up to h) must not change with the simulated future.
    const past = output.filter((e) => e.date <= h);
    if (p === 0) firstPast = past;
    else if (
      past.length !== firstPast.length ||
      past.some((e, i) => e.date !== firstPast[i]!.date || e.equity !== firstPast[i]!.equity)
    ) {
      throw new Error(
        `goalProjection: path ${p} changes the run's equity on or before ${h}: the run reads simulated bars before they happen.`,
      );
    }
    const at = (date: TradingDate) => {
      const e = equity.get(date);
      if (typeof e !== 'number' || !Number.isFinite(e)) {
        throw new Error(`goalProjection: the run has no finite equity on ${date}.`);
      }
      return e;
    };
    let previous = at(h);
    if (previous <= 0) return noValue('equityNotPositive');
    let wealth = input.initial;
    let lost = false;
    let month = monthOf(h);
    for (const f of input.future) {
      const e = at(f);
      if (!lost) {
        if (e <= 0) {
          lost = true;
          wealth = 0;
        } else {
          wealth = (wealth * e) / previous + (monthOf(f) !== month ? input.monthly : 0);
          previous = e;
        }
      }
      month = monthOf(f);
    }
    ends.push(wealth);
    if (!lost && wealth >= input.goal) reached++;
  }
  const sorted = [...ends].sort((a, b) => a - b);
  const { low, high } = wilson95(reached, paths);
  return ok({
    reached,
    paths,
    probability: reached / paths,
    low,
    high,
    endValues: {
      p5: nearestRank(sorted, 5),
      p25: nearestRank(sorted, 25),
      p50: nearestRank(sorted, 50),
      p75: nearestRank(sorted, 75),
      p95: nearestRank(sorted, 95),
    },
    sampleDays: days.length,
    sampleStart: days[0]!,
    sampleEnd: days.at(-1)!,
    meanBlock,
    seed: input.seed,
    currency: input.currency,
  });
}
