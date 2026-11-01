// The information-parity metric set (requirements 08) from a strategy's per-session equity.
// The contract, with every formula, minimum and source: docs/analytics.md "Metrics". The
// reference implementation computes the same from that text alone; keep both in step through
// the doc, never by copying code. float64 analytics (requirements 06), 252-day annualization.
// A metric that lacks data is "no value" with a reason, never 0 or a guess.
import type { TradingDate } from '../domain';
import { CASH_USD, parseTicker } from '../strategy/backtest';
import { isTradingDate } from '../time';

export interface EquitySample {
  date: TradingDate;
  equity: number;
}

export interface MetricsPoint extends EquitySample {
  /** Weights held at the date's close (shares summing to 1), keyed by ticker. */
  weights?: Record<string, number>;
  /** True when the strategy traded on the date. */
  traded?: boolean;
}

export interface MetricsInput {
  /** The strategy's equity, one point per session (a backtest's points fit). */
  points: readonly MetricsPoint[];
  /** The cash's simple return over the session ending at the date's close; undefined when unknown. */
  cashReturn?: (date: TradingDate) => number | undefined;
  /** Benchmarks' equity by id. */
  benchmarks?: Record<string, readonly EquitySample[]>;
  /** The same backtest with zero costs, on the same dates (cost drag). */
  gross?: readonly EquitySample[];
  /** Downside deviation's target: the cash return (default) or zero. */
  downsideTarget?: 'cash' | 'zero';
  /** A yearly return (0.1 = 10% a year) the rolling 5-year windows are measured against. */
  rollingTarget?: number;
}

export const NO_VALUE_REASONS = [
  'tooShort',
  'equityNotPositive',
  'cashRateMissing',
  'noDispersion',
  'noDrawdown',
  'holdingsMissing',
  'grossMissing',
] as const;
export type NoValueReason = (typeof NO_VALUE_REASONS)[number];

export type Metric<T> = { ok: true; value: T } | { ok: false; reason: NoValueReason };

export interface LongestDrawdown {
  /** Calendar days from the peak to the recovery, or to the last date when not recovered. */
  days: number;
  peak: TradingDate;
  trough: TradingDate;
  /** The first date back at the peak; undefined when not recovered yet. */
  recovery: TradingDate | undefined;
  /** Calendar days from the trough to the recovery; undefined when not recovered yet. */
  recoveryDays: number | undefined;
  /** The episode's deepest drawdown (<= 0). */
  depth: number;
}

export interface PeriodExtreme {
  /** The calendar year, `YYYY`. */
  year: string;
  return: number;
  /** How many complete calendar years there are. */
  years: number;
}

export interface PositiveMonths {
  share: number;
  positive: number;
  months: number;
}

export interface RollingWindows {
  median: number;
  min: number;
  max: number;
  windows: number;
  /** Share of windows meeting the target; undefined without a target. */
  share: number | undefined;
  meeting: number | undefined;
}

export interface MetricSet {
  cagr: Metric<number>;
  cumulativeReturn: Metric<number>;
  volatility: Metric<number>;
  downsideDeviation: Metric<number>;
  sharpe: Metric<number>;
  sortino: Metric<number>;
  calmar: Metric<number>;
  maxDrawdown: Metric<number>;
  averageDrawdown: Metric<number>;
  longestDrawdown: Metric<LongestDrawdown | null>;
  ulcerIndex: Metric<number>;
  beta: Record<string, Metric<number>>;
  correlation: Record<string, Metric<number>>;
  var95: Metric<number>;
  cvar95: Metric<number>;
  bestYear: Metric<PeriodExtreme>;
  worstYear: Metric<PeriodExtreme>;
  positiveMonths: Metric<PositiveMonths>;
  rolling5y: Metric<RollingWindows>;
  switchesPerYear: Metric<number>;
  averageExposure: Metric<number>;
  costDrag: Metric<number>;
}

/** The metric ids, in display order (each has its texts under `metrics.<id>`). */
export const METRIC_IDS = [
  'cagr',
  'cumulativeReturn',
  'volatility',
  'downsideDeviation',
  'sharpe',
  'sortino',
  'calmar',
  'maxDrawdown',
  'averageDrawdown',
  'longestDrawdown',
  'ulcerIndex',
  'beta',
  'correlation',
  'var95',
  'cvar95',
  'bestYear',
  'worstYear',
  'positiveMonths',
  'rolling5y',
  'switchesPerYear',
  'averageExposure',
  'costDrag',
] as const satisfies readonly (keyof MetricSet)[];

/** Statistics of daily returns need at least this many returns. */
export const MIN_RETURNS = 20;
/** Yearly figures need at least this many calendar days (returns under a year are not annualized). */
export const MIN_SPAN_DAYS = 365;
/** A daily spread at or below this is zero (float rounding, never a real spread). */
export const DISPERSION_FLOOR = 1e-12;
/** Near-tie rule (relative): a drawdown within it of the peak is at the peak. */
export const TIE = 1e-9;
const TRADING_DAYS = 252;
const YEAR_DAYS = 365.25;
const DAY_MS = 86_400_000;

const value = <T>(v: T): Metric<T> => ({ ok: true, value: v });
const none = <T>(reason: NoValueReason): Metric<T> => ({ ok: false, reason });

/** Calendar days from `a` to `b` (UTC midnights, an exact integer). */
export function calendarDays(a: TradingDate, b: TradingDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Refuses a malformed series (dates, order, finite equity); see "Input rules". */
export function checkSeries(series: readonly EquitySample[], name: string): void {
  series.forEach((p, i) => {
    if (typeof p.date !== 'string' || !isTradingDate(p.date)) {
      throw new Error(`${name}: ${String(p.date)} is not a YYYY-MM-DD date.`);
    }
    if (i > 0 && p.date <= series[i - 1]!.date) {
      throw new Error(`${name}: dates are not strictly ascending at ${p.date}.`);
    }
    if (typeof p.equity !== 'number' || !Number.isFinite(p.equity)) {
      throw new Error(`${name}: equity on ${p.date} is not a finite number.`);
    }
  });
}

const positive = (series: readonly EquitySample[]) => series.every((p) => p.equity > 0);

const mean = (x: readonly number[]) => {
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
};

/** Sample standard deviation (n - 1). */
const sampleSd = (x: readonly number[]) => {
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  return Math.sqrt(s / (x.length - 1));
};

/** Root mean square of the shortfalls below 0, over all values (Sortino and Price). */
const semiDeviation = (x: readonly number[]) => {
  let s = 0;
  for (const v of x) if (v < 0) s += v * v;
  return Math.sqrt(s / x.length);
};

const returnsOf = (series: readonly EquitySample[]) => {
  const r: number[] = [];
  for (let i = 1; i < series.length; i++) r.push(series[i]!.equity / series[i - 1]!.equity - 1);
  return r;
};

function cagrOf(series: readonly EquitySample[]): Metric<number> {
  if (series.length < 2) return none('tooShort');
  if (!positive(series)) return none('equityNotPositive');
  const first = series[0]!;
  const last = series.at(-1)!;
  const span = calendarDays(first.date, last.date);
  if (span < MIN_SPAN_DAYS) return none('tooShort');
  return value((last.equity / first.equity) ** (YEAR_DAYS / span) - 1);
}

interface Episode {
  /** Index of the point before the first under-water point. */
  peak: number;
  trough: number;
  /** Index of the first point back at the peak; undefined when not recovered. */
  recovery: number | undefined;
  depth: number;
}

/** The drawdown series and its episodes (docs/analytics.md "Notation"). */
function drawdowns(points: readonly EquitySample[]): { d: number[]; episodes: Episode[] } {
  const d: number[] = [];
  let peak = -Infinity;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    d.push(p.equity / peak - 1);
  }
  const episodes: Episode[] = [];
  let open: Episode | undefined;
  d.forEach((v, i) => {
    const under = v < -TIE;
    if (under) {
      if (!open) open = { peak: i - 1, trough: i, recovery: undefined, depth: v };
      else if (v < open.depth) {
        open.trough = i;
        open.depth = v;
      }
    } else if (open) {
      open.recovery = i;
      episodes.push(open);
      open = undefined;
    }
  });
  if (open) episodes.push(open);
  return { d, episodes };
}

/** Complete calendar periods' returns (`key` cuts a date to its period). */
function periodReturns(
  points: readonly EquitySample[],
  key: (date: TradingDate) => string,
  previous: (period: string) => string,
  next: (period: string) => string,
): { period: string; return: number }[] {
  const lastIn = new Map<string, number>();
  for (const p of points) lastIn.set(key(p.date), p.equity);
  const out: { period: string; return: number }[] = [];
  for (const [period, end] of lastIn) {
    const before = lastIn.get(previous(period));
    if (before === undefined || !lastIn.has(next(period))) continue;
    out.push({ period, return: end / before - 1 });
  }
  return out;
}

const yearKey = (date: TradingDate) => date.slice(0, 4);
const shiftYear = (year: string, by: number) => String(Number(year) + by).padStart(4, '0');
const monthKey = (date: TradingDate) => date.slice(0, 7);
const shiftMonth = (month: string, by: number) => {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
};

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The date five calendar years earlier; Feb 29 becomes Feb 28 when that year has none. */
export function fiveYearsBefore(date: TradingDate): TradingDate {
  const y = Number(date.slice(0, 4)) - 5;
  let md = date.slice(5);
  if (md === '02-29' && !isLeap(y)) md = '02-28';
  return `${String(y).padStart(4, '0')}-${md}`;
}

const median = (sorted: readonly number[]) => {
  const k = sorted.length;
  const mid = Math.floor(k / 2);
  return k % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function rolling5y(points: readonly EquitySample[], target: number | undefined) {
  const growth: number[] = [];
  let s = -1; // the last point dated on or before the window start
  points.forEach((p, i) => {
    const start = fiveYearsBefore(p.date);
    while (s + 1 < i && points[s + 1]!.date <= start) s++;
    if (s < 0) return;
    const from = points[s]!;
    growth.push((p.equity / from.equity) ** (YEAR_DAYS / calendarDays(from.date, p.date)) - 1);
  });
  if (growth.length === 0) return none<RollingWindows>('tooShort');
  const sorted = [...growth].sort((a, b) => a - b);
  const meeting = target === undefined ? undefined : growth.filter((g) => g >= target).length;
  return value<RollingWindows>({
    median: median(sorted),
    min: sorted[0]!,
    max: sorted.at(-1)!,
    windows: growth.length,
    meeting,
    share: meeting === undefined ? undefined : meeting / growth.length,
  });
}

/**
 * The ticker's exposure per unit weight: its leverage `L`, 0 for cash. Read through the one
 * ticker grammar (`parseTicker`, docs/indicators.md "Synthetic leverage"); NaN when the ticker is
 * malformed (`holdingsMissing`): an `L` given without a number (`?L=`, `?L`), with an exponent,
 * twice, or not above 0 is unknown, never the 0 that `Number('')` would read (docs/analytics.md,
 * `averageExposure`).
 */
function leverageOf(ticker: string): number {
  if (ticker === CASH_USD) return 0;
  try {
    return parseTicker(ticker).leverage;
  } catch {
    return Number.NaN;
  }
}

function versus(
  points: readonly EquitySample[],
  benchmark: readonly EquitySample[],
): { beta: Metric<number>; correlation: Metric<number> } {
  const both = (m: Metric<number>) => ({ beta: m, correlation: m });
  if (!positive(benchmark)) return both(none('equityNotPositive'));
  const at = new Map(benchmark.map((b) => [b.date, b.equity]));
  const aligned = points.filter((p) => at.has(p.date));
  const s = returnsOf(aligned);
  const b = returnsOf(aligned.map((p) => ({ date: p.date, equity: at.get(p.date)! })));
  if (s.length < MIN_RETURNS) return both(none('tooShort'));
  const ms = mean(s);
  const mb = mean(b);
  let cov = 0;
  for (let j = 0; j < s.length; j++) cov += (s[j]! - ms) * (b[j]! - mb);
  cov /= s.length - 1;
  const sdS = sampleSd(s);
  const sdB = sampleSd(b);
  if (!(sdB > DISPERSION_FLOOR)) return both(none('noDispersion'));
  return {
    beta: value(cov / (sdB * sdB)),
    correlation:
      sdS > DISPERSION_FLOOR
        ? value(Math.min(1, Math.max(-1, cov / (sdS * sdB))))
        : none('noDispersion'),
  };
}

/** Every metric of the set (docs/analytics.md "Metrics"). */
export function metrics(input: MetricsInput): MetricSet {
  const { points } = input;
  checkSeries(points, 'points');
  for (const p of points) {
    for (const [ticker, w] of Object.entries(p.weights ?? {})) {
      if (typeof w !== 'number' || !Number.isFinite(w)) {
        throw new Error(`points: weight of ${ticker} on ${p.date} is not a finite number.`);
      }
    }
  }
  for (const [id, series] of Object.entries(input.benchmarks ?? {})) checkSeries(series, id);
  if (input.gross) {
    checkSeries(input.gross, 'gross');
    const g = input.gross;
    if (g.length !== points.length || g.some((p, i) => p.date !== points[i]!.date)) {
      throw new Error('gross: dates differ from the points.');
    }
  }
  const target = input.rollingTarget;
  if (target !== undefined && (typeof target !== 'number' || !Number.isFinite(target))) {
    throw new Error('rollingTarget is not a finite number.');
  }
  const benchmarkIds = Object.keys(input.benchmarks ?? {});
  const perBenchmark = (m: Metric<number>) => Object.fromEntries(benchmarkIds.map((id) => [id, m]));

  const n = points.length;
  const everyNone = (reason: NoValueReason): MetricSet => {
    const m = none<never>(reason);
    return {
      ...(Object.fromEntries(METRIC_IDS.map((id) => [id, m])) as unknown as MetricSet),
      beta: perBenchmark(m),
      correlation: perBenchmark(m),
    };
  };
  if (n < 2) return everyNone('tooShort');
  if (!positive(points)) return everyNone('equityNotPositive');

  const r = returnsOf(points);
  const m = r.length;
  const enough = m >= MIN_RETURNS;
  const span = calendarDays(points[0]!.date, points[n - 1]!.date);
  const years = span / YEAR_DAYS;

  // Cash returns of each return's session; undefined when any is unknown.
  let cash: number[] | undefined;
  if (input.cashReturn) {
    cash = [];
    for (let i = 1; i < n; i++) {
      const c = input.cashReturn(points[i]!.date);
      if (typeof c !== 'number' || !Number.isFinite(c)) {
        cash = undefined;
        break;
      }
      cash.push(c);
    }
  }
  const excess = cash && r.map((v, i) => v - cash[i]!);

  const cagr = cagrOf(points);
  const { d, episodes } = drawdowns(points);
  let maxDrawdown = 0;
  for (const v of d) if (v < maxDrawdown) maxDrawdown = v;

  const volatility: Metric<number> = enough
    ? value(sampleSd(r) * Math.sqrt(TRADING_DAYS))
    : none('tooShort');

  let downsideDeviation: Metric<number>;
  if (!enough) downsideDeviation = none('tooShort');
  else if (input.downsideTarget === 'zero') {
    downsideDeviation = value(semiDeviation(r) * Math.sqrt(TRADING_DAYS));
  } else if (!excess) downsideDeviation = none('cashRateMissing');
  else downsideDeviation = value(semiDeviation(excess) * Math.sqrt(TRADING_DAYS));

  let sharpe: Metric<number>;
  let sortino: Metric<number>;
  if (!enough) sharpe = sortino = none('tooShort');
  else if (!excess) sharpe = sortino = none('cashRateMissing');
  else {
    const mx = mean(excess);
    const sd = sampleSd(excess);
    const dd = semiDeviation(excess);
    sharpe =
      sd > DISPERSION_FLOOR ? value((mx / sd) * Math.sqrt(TRADING_DAYS)) : none('noDispersion');
    sortino =
      dd > DISPERSION_FLOOR ? value((mx / dd) * Math.sqrt(TRADING_DAYS)) : none('noDispersion');
  }

  let calmar: Metric<number>;
  if (!cagr.ok) calmar = cagr;
  else if (!(maxDrawdown < -TIE)) calmar = none('noDrawdown');
  else calmar = value(cagr.value / Math.abs(maxDrawdown));

  let longest: Episode | undefined;
  const lastIndex = n - 1;
  const lengthOf = (e: Episode) =>
    calendarDays(points[e.peak]!.date, points[e.recovery ?? lastIndex]!.date);
  for (const e of episodes) if (!longest || lengthOf(e) > lengthOf(longest)) longest = e;

  let var95: Metric<number>;
  let cvar95: Metric<number>;
  if (!enough) var95 = cvar95 = none('tooShort');
  else {
    const sorted = [...r].sort((a, b) => a - b);
    const k = Math.floor((m + 19) / 20);
    var95 = value(sorted[k - 1]!);
    cvar95 = value(mean(sorted.slice(0, k)));
  }

  const calendarYears = periodReturns(
    points,
    yearKey,
    (y) => shiftYear(y, -1),
    (y) => shiftYear(y, 1),
  );
  let bestYear: Metric<PeriodExtreme>;
  let worstYear: Metric<PeriodExtreme>;
  if (calendarYears.length === 0) bestYear = worstYear = none('tooShort');
  else {
    let best = calendarYears[0]!;
    let worst = calendarYears[0]!;
    for (const y of calendarYears) {
      if (y.return > best.return) best = y;
      if (y.return < worst.return) worst = y;
    }
    const count = calendarYears.length;
    bestYear = value({ year: best.period, return: best.return, years: count });
    worstYear = value({ year: worst.period, return: worst.return, years: count });
  }

  const months = periodReturns(
    points,
    monthKey,
    (mo) => shiftMonth(mo, -1),
    (mo) => shiftMonth(mo, 1),
  );
  const up = months.filter((mo) => mo.return > 0).length;
  const positiveMonths: Metric<PositiveMonths> =
    months.length === 0
      ? none('tooShort')
      : value({ share: up / months.length, positive: up, months: months.length });

  let switchesPerYear: Metric<number>;
  if (!points.every((p) => typeof p.traded === 'boolean'))
    switchesPerYear = none('holdingsMissing');
  else if (span < MIN_SPAN_DAYS) switchesPerYear = none('tooShort');
  else {
    const trades = points.filter((p) => p.traded).length;
    switchesPerYear = value(Math.max(0, trades - 1) / years);
  }

  const exposures: number[] = [];
  for (const p of points.slice(0, n - 1)) {
    if (!p.weights) break;
    let x = 0;
    for (const [ticker, w] of Object.entries(p.weights)) x += w * leverageOf(ticker);
    if (!Number.isFinite(x)) break;
    exposures.push(x);
  }
  const averageExposure: Metric<number> =
    exposures.length === n - 1 ? value(mean(exposures)) : none('holdingsMissing');

  let costDrag: Metric<number>;
  if (!input.gross) costDrag = none('grossMissing');
  else {
    const gross = cagrOf(input.gross);
    if (!gross.ok) costDrag = gross;
    else if (!cagr.ok) costDrag = cagr;
    else costDrag = value(gross.value - cagr.value);
  }

  const beta: Record<string, Metric<number>> = {};
  const correlation: Record<string, Metric<number>> = {};
  for (const id of benchmarkIds) {
    const v = versus(points, input.benchmarks![id]!);
    beta[id] = v.beta;
    correlation[id] = v.correlation;
  }

  return {
    cagr,
    cumulativeReturn: value(points[n - 1]!.equity / points[0]!.equity - 1),
    volatility,
    downsideDeviation,
    sharpe,
    sortino,
    calmar,
    maxDrawdown: value(maxDrawdown),
    averageDrawdown: value(episodes.length === 0 ? 0 : mean(episodes.map((e) => e.depth))),
    longestDrawdown: value(
      longest
        ? {
            days: lengthOf(longest),
            peak: points[longest.peak]!.date,
            trough: points[longest.trough]!.date,
            recovery: longest.recovery === undefined ? undefined : points[longest.recovery]!.date,
            recoveryDays:
              longest.recovery === undefined
                ? undefined
                : calendarDays(points[longest.trough]!.date, points[longest.recovery]!.date),
            depth: longest.depth,
          }
        : null,
    ),
    ulcerIndex: value(Math.sqrt(mean(d.map((v) => v * v)))),
    beta,
    correlation,
    var95,
    cvar95,
    bestYear,
    worstYear,
    positiveMonths,
    rolling5y: rolling5y(points, target),
    switchesPerYear,
    averageExposure,
    costDrag,
  };
}
