// Time stability and crisis replays (requirements 09 "Robustness score components"; docs/analytics.md
// "Statistics": "Walk-forward folds", "Crisis replays"). The Sharpe ratio and drawdown are those of
// "Metrics"; a period the data does not cover is no value, never a pass.
import type { TradingDate } from '../domain';
import { isTradingDate } from '../time';
import {
  type EquitySample,
  MIN_SPAN_DAYS,
  type Metric,
  calendarDays,
  checkSeries,
  metrics,
} from './metrics';
import { type Statistic, nearTie, noValue, ok } from './statistic';

type CashReturn = (date: TradingDate) => number | undefined;

const DAY_MS = 86_400_000;
const addDays = (date: TradingDate, days: number): TradingDate =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export interface Fold {
  /** The fold's first boundary date (B_q). */
  start: TradingDate;
  /** The last date of the fold's series. */
  end: TradingDate;
  /** Yearly Sharpe of the strategy and of the benchmark over the fold. */
  strategy: Metric<number>;
  benchmark: Metric<number>;
  /** The strategy's Sharpe is higher, not tied; undefined when either has no value. */
  beat: boolean | undefined;
}

export interface WalkForward {
  folds: Fold[];
  /** Folds the strategy beat. */
  won: number;
  /** Folds where both have a value. */
  measured: number;
}

/** The default number of walk-forward folds (each at least a year). */
export const WALK_FORWARD_FOLDS = 10;

/**
 * Fold q's series: the last point before `from` (q > 0), then the points in [from, to), the last
 * fold's also those dated `to` (t_(n-1)). A benchmark point after the strategy's last date is in
 * no fold: the benchmark is cut by the same boundaries, so both cover the same period.
 */
function foldSeries(
  series: readonly EquitySample[],
  from: TradingDate,
  to: TradingDate,
  first: boolean,
  last: boolean,
): EquitySample[] {
  const out: EquitySample[] = [];
  let before: EquitySample | undefined;
  for (const p of series) {
    if (p.date < from) before = p;
    else if (p.date < to || (last && p.date === to)) out.push(p);
  }
  return !first && before ? [before, ...out] : out;
}

/**
 * Walk-forward folds of a fixed strategy: K equal calendar spans of at least a year (at most
 * `folds`), the strategy's and the benchmark's Sharpe ratio per fold.
 */
export function walkForward(input: {
  points: readonly EquitySample[];
  benchmark: readonly EquitySample[];
  /** Required: the Sharpe ratio is over the cash return (unknown stays unknown). */
  cashReturn: CashReturn;
  folds?: number;
}): Statistic<WalkForward> {
  const { points, benchmark } = input;
  checkSeries(points, 'points');
  checkSeries(benchmark, 'benchmark');
  const wanted = input.folds ?? WALK_FORWARD_FOLDS;
  if (!Number.isInteger(wanted) || wanted < 2) {
    throw new Error('walkForward: folds is an integer >= 2.');
  }
  if (points.length < 2) return noValue('tooShort');
  const t0 = points[0]!.date;
  const D = calendarDays(t0, points.at(-1)!.date);
  const K = Math.min(wanted, Math.floor(D / MIN_SPAN_DAYS));
  if (K < 2) return noValue('tooShort');
  const bounds = Array.from({ length: K + 1 }, (_, q) => addDays(t0, Math.floor((q * D) / K)));
  const folds: Fold[] = [];
  for (let q = 0; q < K; q++) {
    const last = q === K - 1;
    const s = foldSeries(points, bounds[q]!, bounds[q + 1]!, q === 0, last);
    const b = foldSeries(benchmark, bounds[q]!, bounds[q + 1]!, q === 0, last);
    const strategy = metrics({ points: s, cashReturn: input.cashReturn }).sharpe;
    const bench = metrics({ points: b, cashReturn: input.cashReturn }).sharpe;
    folds.push({
      start: bounds[q]!,
      end: s.at(-1)?.date ?? bounds[q]!,
      strategy,
      benchmark: bench,
      beat:
        strategy.ok && bench.ok
          ? strategy.value > bench.value && !nearTie(strategy.value, bench.value)
          : undefined,
    });
  }
  const measured = folds.filter((f) => f.beat !== undefined).length;
  if (measured === 0) {
    const first = folds[0]!;
    const m = !first.strategy.ok ? first.strategy : first.benchmark;
    return noValue(m.ok ? 'tooShort' : m.reason);
  }
  return ok({ folds, won: folds.filter((f) => f.beat === true).length, measured });
}

export interface CrisisWindow {
  /** A stable id; a name text, when the content has one, is `statistics.crisisSurvival.windows.<id>`. */
  id: string;
  /** The peak's date. */
  start: TradingDate;
  /** The trough's date. */
  end: TradingDate;
  /** Where the dates come from. */
  source: string;
}

export interface CrisisFigures {
  /** The deepest running-peak drawdown inside the window (<= 0). */
  maxDrawdown: number;
  /** Last / first - 1 over the window. */
  return: number;
}

export interface CrisisReplay {
  id: string;
  start: TradingDate;
  end: TradingDate;
  strategy: Statistic<CrisisFigures>;
  benchmark: Statistic<CrisisFigures>;
  /** The strategy fell less deep than the benchmark, not tied; undefined unless both covered. */
  shallower: boolean | undefined;
}

export interface CrisisReplays {
  windows: CrisisReplay[];
  /** Windows where both have a value. */
  covered: number;
  /** Of those, where the strategy fell less deep. */
  shallower: number;
}

function inWindow(series: readonly EquitySample[], w: CrisisWindow): Statistic<CrisisFigures> {
  if (series.length === 0 || series[0]!.date > w.start || series.at(-1)!.date < w.end) {
    return noValue('notCovered');
  }
  let s = 0;
  let e = 0;
  series.forEach((p, i) => {
    if (p.date <= w.start) s = i;
    if (p.date <= w.end) e = i;
  });
  const slice = series.slice(s, e + 1);
  if (slice.some((p) => p.equity <= 0)) return noValue('equityNotPositive');
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of slice) {
    peak = Math.max(peak, p.equity);
    maxDrawdown = Math.min(maxDrawdown, p.equity / peak - 1);
  }
  return ok({ maxDrawdown, return: slice.at(-1)!.equity / slice[0]!.equity - 1 });
}

/**
 * Strategy vs benchmark drawdown inside each crisis window. The windows are data passed in (core
 * has no built-in list: which crises matter depends on the install's market; a template is in
 * `templates/crises/`).
 */
export function crisisReplays(input: {
  points: readonly EquitySample[];
  benchmark: readonly EquitySample[];
  windows: readonly CrisisWindow[];
}): Statistic<CrisisReplays> {
  checkSeries(input.points, 'points');
  checkSeries(input.benchmark, 'benchmark');
  const { windows } = input;
  if (!Array.isArray(windows)) throw new Error('crisisReplays: the windows are required.');
  const ids = new Set<string>();
  for (const w of windows) {
    if (typeof w.id !== 'string' || w.id === '' || typeof w.source !== 'string') {
      throw new Error('crisisReplays: a window has an id and a source.');
    }
    if (!isTradingDate(w.start) || !isTradingDate(w.end) || w.start >= w.end) {
      throw new Error(`crisis ${w.id}: start and end are YYYY-MM-DD dates, start before end.`);
    }
    if (ids.has(w.id)) throw new Error(`crisis ${w.id} is listed twice.`);
    ids.add(w.id);
  }
  const out = windows.map((w): CrisisReplay => {
    const strategy = inWindow(input.points, w);
    const benchmark = inWindow(input.benchmark, w);
    return {
      id: w.id,
      start: w.start,
      end: w.end,
      strategy,
      benchmark,
      shallower:
        strategy.ok && benchmark.ok
          ? strategy.value.maxDrawdown > benchmark.value.maxDrawdown &&
            !nearTie(strategy.value.maxDrawdown, benchmark.value.maxDrawdown)
          : undefined,
    };
  });
  const covered = out.filter((w) => w.shallower !== undefined).length;
  if (covered === 0) {
    const first = out[0];
    if (!first) return noValue('notCovered');
    const m = !first.strategy.ok ? first.strategy : first.benchmark;
    return noValue(m.ok ? 'notCovered' : m.reason);
  }
  return ok({
    windows: out,
    covered,
    shallower: out.filter((w) => w.shallower === true).length,
  });
}
