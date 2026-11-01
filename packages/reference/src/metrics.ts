// Reference metrics (docs/analytics.md "Metrics"; requirements 08, "Information-parity metric
// set"), written from that text alone and as literally as it reads: every metric is recomputed
// from its own loops over the points, with no shared running state. It never imports @saku/core.
// A doubtful or too short input gives no value with a reason, never a number; an unknown cash
// return is never read as 0.

export type RefTradingDate = string;

export interface RefEquitySample {
  date: RefTradingDate;
  equity: number;
}

export interface RefMetricsPoint extends RefEquitySample {
  /** Weights held at the date's close (shares summing to 1), keyed by ticker. */
  weights?: Record<string, number>;
  /** True when the strategy traded on the date. */
  traded?: boolean;
}

export interface RefMetricsInput {
  points: readonly RefMetricsPoint[];
  cashReturn?: (date: RefTradingDate) => number | undefined;
  benchmarks?: Record<string, readonly RefEquitySample[]>;
  gross?: readonly RefEquitySample[];
  downsideTarget?: 'cash' | 'zero';
  rollingTarget?: number;
}

export type RefNoValueReason =
  | 'tooShort'
  | 'equityNotPositive'
  | 'cashRateMissing'
  | 'noDispersion'
  | 'noDrawdown'
  | 'holdingsMissing'
  | 'grossMissing';

export type RefMetric<T> = { ok: true; value: T } | { ok: false; reason: RefNoValueReason };

export interface RefLongestDrawdown {
  days: number;
  peak: RefTradingDate;
  trough: RefTradingDate;
  recovery: RefTradingDate | undefined;
  recoveryDays: number | undefined;
  depth: number;
}

export interface RefYear {
  /** The trading date's first 4 characters. */
  year: string;
  return: number;
  years: number;
}

export interface RefPositiveMonths {
  share: number;
  positive: number;
  months: number;
}

export interface RefRolling5y {
  median: number;
  min: number;
  max: number;
  windows: number;
  share: number | undefined;
  meeting: number | undefined;
}

export interface RefMetricSet {
  cagr: RefMetric<number>;
  cumulativeReturn: RefMetric<number>;
  volatility: RefMetric<number>;
  downsideDeviation: RefMetric<number>;
  sharpe: RefMetric<number>;
  sortino: RefMetric<number>;
  calmar: RefMetric<number>;
  maxDrawdown: RefMetric<number>;
  averageDrawdown: RefMetric<number>;
  longestDrawdown: RefMetric<RefLongestDrawdown | null>;
  ulcerIndex: RefMetric<number>;
  beta: Record<string, RefMetric<number>>;
  correlation: Record<string, RefMetric<number>>;
  var95: RefMetric<number>;
  cvar95: RefMetric<number>;
  bestYear: RefMetric<RefYear>;
  worstYear: RefMetric<RefYear>;
  positiveMonths: RefMetric<RefPositiveMonths>;
  rolling5y: RefMetric<RefRolling5y>;
  switchesPerYear: RefMetric<number>;
  averageExposure: RefMetric<number>;
  costDrag: RefMetric<number>;
}

// Constants (docs/analytics.md "Notation").
export const REF_MIN_RETURNS = 20;
export const REF_MIN_SPAN_DAYS = 365;
export const REF_DISPERSION_FLOOR = 1e-12;
const TIE = 1e-9;

const ok = <T>(value: T): RefMetric<T> => ({ ok: true, value });
const no = <T>(reason: RefNoValueReason): RefMetric<T> => ({ ok: false, reason });

// ---- Dates ----

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthLength = (y: number, m: number) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

/** A real `YYYY-MM-DD` calendar date (proleptic Gregorian). */
function isRealDate(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= monthLength(y, mo);
}

/** UTC midnight of a valid date in ms (setUTCFullYear, so years below 100 are not shifted). */
function utcMidnight(s: string): number {
  const t = new Date(0);
  t.setUTCFullYear(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime();
}

/** Calendar days from date `a` to date `b`, both read as UTC midnight. */
export function refDays(a: string, b: string): number {
  return Math.round((utcMidnight(b) - utcMidnight(a)) / 86_400_000);
}

// ---- Input rules (refused: throws) ----

function checkSeries(name: string, list: readonly RefEquitySample[]): void {
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (!isRealDate(p.date)) {
      throw new Error(`reference metrics: ${name}[${i}] has no real YYYY-MM-DD date`);
    }
    if (i > 0 && !(list[i - 1]!.date < p.date)) {
      throw new Error(`reference metrics: ${name} dates are not strictly ascending at ${p.date}`);
    }
    if (typeof p.equity !== 'number' || !Number.isFinite(p.equity)) {
      throw new Error(`reference metrics: ${name} equity on ${p.date} is not a finite number`);
    }
  }
}

function checkInput(input: RefMetricsInput): void {
  checkSeries('points', input.points);
  for (const p of input.points) {
    if (p.weights !== undefined && p.weights !== null && typeof p.weights === 'object') {
      for (const [ticker, w] of Object.entries(p.weights)) {
        if (typeof w !== 'number' || !Number.isFinite(w)) {
          throw new Error(`reference metrics: weight of ${ticker} on ${p.date} is not finite`);
        }
      }
    }
  }
  for (const [id, list] of Object.entries(input.benchmarks ?? {})) {
    checkSeries(`benchmark ${id}`, list);
  }
  if (input.gross !== undefined) {
    checkSeries('gross', input.gross);
    const same =
      input.gross.length === input.points.length &&
      input.gross.every((g, i) => g.date === input.points[i]!.date);
    if (!same) throw new Error('reference metrics: gross dates are not those of points');
  }
  if (
    input.rollingTarget !== undefined &&
    (typeof input.rollingTarget !== 'number' || !Number.isFinite(input.rollingTarget))
  ) {
    throw new Error('reference metrics: rollingTarget is not a finite number');
  }
}

// ---- Helpers ----

const sum = (xs: number[]) => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};
const mean = (xs: number[]) => sum(xs) / xs.length;
/** Sample standard deviation (count - 1). */
const sd = (xs: number[]) => {
  const mu = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - mu) * (x - mu);
  return Math.sqrt(s / (xs.length - 1));
};

const returnsOf = (e: number[]) => {
  const r: number[] = [];
  for (let i = 1; i < e.length; i++) r.push(e[i]! / e[i - 1]! - 1);
  return r;
};

/** CAGR of one series, with its own no-value reasons in order (points, span). */
function cagrOf(list: readonly RefEquitySample[]): RefMetric<number> {
  if (list.length < 2) return no('tooShort');
  if (list.some((p) => p.equity <= 0)) return no('equityNotPositive');
  const span = refDays(list[0]!.date, list[list.length - 1]!.date);
  if (span < REF_MIN_SPAN_DAYS) return no('tooShort');
  const years = span / 365.25;
  return ok((list[list.length - 1]!.equity / list[0]!.equity) ** (1 / years) - 1);
}

/** The `L` parameter of a ticker: 1 without it, 0 for cash; undefined when unreadable. */
function leverageOf(ticker: string): number | undefined {
  const q = ticker.indexOf('?');
  const base = q < 0 ? ticker : ticker.slice(0, q);
  if (base === 'CASH_USD') return 0;
  if (q < 0) return 1;
  const found: string[] = [];
  for (const part of ticker.slice(q + 1).split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key === 'L') found.push(eq < 0 ? '' : part.slice(eq + 1));
  }
  if (found.length === 0) return 1;
  if (found.length > 1) return undefined;
  const text = found[0]!;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return undefined;
  const L = Number(text);
  return Number.isFinite(L) ? L : undefined;
}

/** The calendar period before / after a year ('YYYY') or month ('YYYY-MM'). */
function shiftPeriod(p: string, by: 1 | -1): string {
  const pad4 = (y: number) => String(y).padStart(4, '0');
  if (p.length === 4) return pad4(Number(p) + by);
  let y = Number(p.slice(0, 4));
  let m = Number(p.slice(5, 7)) + by;
  if (m === 0) {
    m = 12;
    y--;
  }
  if (m === 13) {
    m = 1;
    y++;
  }
  return `${pad4(y)}-${String(m).padStart(2, '0')}`;
}

/** Complete calendar periods (cut by the date's first `width` characters) and their returns. */
function completePeriods(
  pts: readonly RefEquitySample[],
  width: 4 | 7,
): { period: string; ret: number }[] {
  const lastIn = new Map<string, number>(); // period -> equity of its last point
  const order: string[] = [];
  for (const p of pts) {
    const key = p.date.slice(0, width);
    if (!lastIn.has(key)) order.push(key);
    lastIn.set(key, p.equity);
  }
  const out: { period: string; ret: number }[] = [];
  for (const key of order) {
    const before = shiftPeriod(key, -1);
    const after = shiftPeriod(key, 1);
    if (lastIn.has(before) && lastIn.has(after)) {
      out.push({ period: key, ret: lastIn.get(key)! / lastIn.get(before)! - 1 });
    }
  }
  return out;
}

/** `(Y - 5)-MM-DD`; Feb 29 becomes Feb 28 when that year has none; undefined before year 0. */
function fiveYearsBefore(date: string): string | undefined {
  const y = Number(date.slice(0, 4)) - 5;
  if (y < 0) return undefined;
  let md = date.slice(4);
  if (md === '-02-29' && !isLeap(y)) md = '-02-28';
  return `${String(y).padStart(4, '0')}${md}`;
}

// ---- The metric set ----

export function refMetrics(input: RefMetricsInput): RefMetricSet {
  checkInput(input);
  const pts = input.points;
  const benchIds = Object.keys(input.benchmarks ?? {});

  // Global reasons first: fewer than 2 points, then a wiped-out `points`.
  const global: RefNoValueReason | undefined =
    pts.length < 2 ? 'tooShort' : pts.some((p) => p.equity <= 0) ? 'equityNotPositive' : undefined;
  if (global !== undefined) {
    const each = () => Object.fromEntries(benchIds.map((id) => [id, no<number>(global)]));
    return {
      cagr: no(global),
      cumulativeReturn: no(global),
      volatility: no(global),
      downsideDeviation: no(global),
      sharpe: no(global),
      sortino: no(global),
      calmar: no(global),
      maxDrawdown: no(global),
      averageDrawdown: no(global),
      longestDrawdown: no(global),
      ulcerIndex: no(global),
      beta: each(),
      correlation: each(),
      var95: no(global),
      cvar95: no(global),
      bestYear: no(global),
      worstYear: no(global),
      positiveMonths: no(global),
      rolling5y: no(global),
      switchesPerYear: no(global),
      averageExposure: no(global),
      costDrag: no(global),
    };
  }

  const n = pts.length;
  const e = pts.map((p) => p.equity);
  const t = pts.map((p) => p.date);
  const r = returnsOf(e); // r[i - 1] is r_i
  const m = r.length;
  const span = refDays(t[0]!, t[n - 1]!);
  const years = span / 365.25;

  // Cash returns c_i = cashReturn(t_i), i = 1 .. m; undefined or not finite is unknown.
  const cash: (number | undefined)[] = [];
  for (let i = 1; i < n; i++) {
    const c = input.cashReturn?.(t[i]!);
    cash.push(typeof c === 'number' && Number.isFinite(c) ? c : undefined);
  }
  const cashKnown = cash.every((c) => c !== undefined);

  // cagr
  const cagr = cagrOf(pts);

  // cumulativeReturn
  const cumulativeReturn = ok(e[n - 1]! / e[0]! - 1);

  // volatility
  const volatility: RefMetric<number> =
    m < REF_MIN_RETURNS ? no('tooShort') : ok(sd(r) * Math.sqrt(252));

  // downsideDeviation
  let downsideDeviation: RefMetric<number>;
  const zeroTarget = input.downsideTarget === 'zero';
  if (m < REF_MIN_RETURNS) downsideDeviation = no('tooShort');
  else if (!zeroTarget && !cashKnown) downsideDeviation = no('cashRateMissing');
  else {
    let s = 0;
    for (let j = 0; j < m; j++) {
      const g = zeroTarget ? 0 : cash[j]!;
      const below = Math.min(0, r[j]! - g);
      s += below * below;
    }
    downsideDeviation = ok(Math.sqrt(s / m) * Math.sqrt(252));
  }

  // sharpe and sortino: excess returns x_i = r_i - c_i
  let sharpe: RefMetric<number>;
  let sortino: RefMetric<number>;
  if (m < REF_MIN_RETURNS) {
    sharpe = sortino = no('tooShort');
  } else if (!cashKnown) {
    sharpe = sortino = no('cashRateMissing');
  } else {
    const x = r.map((ri, j) => ri - cash[j]!);
    const sdx = sd(x);
    sharpe = sdx > REF_DISPERSION_FLOOR ? ok((mean(x) / sdx) * Math.sqrt(252)) : no('noDispersion');
    let s = 0;
    for (const xi of x) s += Math.min(0, xi) ** 2;
    const daily = Math.sqrt(s / m);
    sortino =
      daily > REF_DISPERSION_FLOOR ? ok((mean(x) / daily) * Math.sqrt(252)) : no('noDispersion');
  }

  // Drawdown series: P_i = max(e_0 .. e_i), d_i = e_i / P_i - 1.
  const d: number[] = [];
  for (let i = 0; i < n; i++) {
    let peak = -Infinity;
    for (let j = 0; j <= i; j++) if (e[j]! > peak) peak = e[j]!;
    d.push(e[i]! / peak - 1);
  }

  // maxDrawdown (exact, no tie rule)
  let minD = d[0]!;
  for (const di of d) if (di < minD) minD = di;
  const maxDrawdown = ok(minD);

  // Episodes: maximal runs of consecutive under-water points (d_i < -TIE).
  const episodes: { a: number; b: number; trough: number }[] = [];
  for (let i = 1; i < n; i++) {
    if (!(d[i]! < -TIE)) continue;
    if (i > 1 && d[i - 1]! < -TIE) continue; // not the start of a run
    let b = i;
    while (b + 1 < n && d[b + 1]! < -TIE) b++;
    let trough = i;
    for (let j = i; j <= b; j++) if (d[j]! < d[trough]!) trough = j; // first on a tie
    episodes.push({ a: i, b, trough });
  }

  // averageDrawdown
  const averageDrawdown = ok(episodes.length === 0 ? 0 : mean(episodes.map((ep) => d[ep.trough]!)));

  // longestDrawdown
  let longest: RefLongestDrawdown | null = null;
  for (const ep of episodes) {
    const recovered = ep.b + 1 <= n - 1;
    const peakDate = t[ep.a - 1]!;
    const troughDate = t[ep.trough]!;
    const recovery = recovered ? t[ep.b + 1]! : undefined;
    const days = refDays(peakDate, recovery ?? t[n - 1]!);
    if (longest === null || days > longest.days) {
      longest = {
        days,
        peak: peakDate,
        trough: troughDate,
        recovery,
        recoveryDays: recovery === undefined ? undefined : refDays(troughDate, recovery),
        depth: d[ep.trough]!,
      };
    }
  }
  const longestDrawdown = ok(longest);

  // calmar
  let calmar: RefMetric<number>;
  if (!cagr.ok) calmar = no(cagr.reason);
  else if (!(minD < -TIE)) calmar = no('noDrawdown');
  else calmar = ok(cagr.value / Math.abs(minD));

  // ulcerIndex
  let sq = 0;
  for (const di of d) sq += di * di;
  const ulcerIndex = ok(Math.sqrt(sq / n));

  // beta and correlation, per benchmark
  const beta: Record<string, RefMetric<number>> = {};
  const correlation: Record<string, RefMetric<number>> = {};
  for (const id of benchIds) {
    const bench = input.benchmarks![id]!;
    if (bench.some((p) => p.equity <= 0)) {
      beta[id] = correlation[id] = no('equityNotPositive');
      continue;
    }
    const bByDate = new Map(bench.map((p) => [p.date, p.equity]));
    const aligned = pts
      .filter((p) => bByDate.has(p.date))
      .map((p) => ({ s: p.equity, b: bByDate.get(p.date)! }));
    const k = aligned.length - 1;
    if (k < REF_MIN_RETURNS) {
      beta[id] = correlation[id] = no('tooShort');
      continue;
    }
    const s: number[] = [];
    const b: number[] = [];
    for (let j = 1; j <= k; j++) {
      s.push(aligned[j]!.s / aligned[j - 1]!.s - 1);
      b.push(aligned[j]!.b / aligned[j - 1]!.b - 1);
    }
    const ms = mean(s);
    const mb = mean(b);
    let cov = 0;
    let varB = 0;
    for (let j = 0; j < k; j++) {
      cov += (s[j]! - ms) * (b[j]! - mb);
      varB += (b[j]! - mb) ** 2;
    }
    cov /= k - 1;
    varB /= k - 1;
    const sdB = Math.sqrt(varB);
    if (!(sdB > REF_DISPERSION_FLOOR)) {
      beta[id] = correlation[id] = no('noDispersion');
      continue;
    }
    beta[id] = ok(cov / varB);
    const sdS = sd(s);
    correlation[id] = !(sdS > REF_DISPERSION_FLOOR)
      ? no('noDispersion')
      : ok(Math.max(-1, Math.min(1, cov / (sdS * sdB))));
  }

  // var95 and cvar95: k = ceil(m / 20) = floor((m + 19) / 20); the k-th worst return.
  let var95: RefMetric<number>;
  let cvar95: RefMetric<number>;
  if (m < REF_MIN_RETURNS) {
    var95 = cvar95 = no('tooShort');
  } else {
    const sorted = [...r].sort((p, q) => p - q);
    const k = Math.floor((m + 19) / 20);
    var95 = ok(sorted[k - 1]!);
    cvar95 = ok(mean(sorted.slice(0, k)));
  }

  // bestYear and worstYear over complete calendar years (earliest on a tie).
  const fullYears = completePeriods(pts, 4);
  let bestYear: RefMetric<RefYear>;
  let worstYear: RefMetric<RefYear>;
  if (fullYears.length === 0) {
    bestYear = worstYear = no('tooShort');
  } else {
    let best = fullYears[0]!;
    let worst = fullYears[0]!;
    for (const y of fullYears) {
      if (y.ret > best.ret) best = y;
      if (y.ret < worst.ret) worst = y;
    }
    bestYear = ok({ year: best.period, return: best.ret, years: fullYears.length });
    worstYear = ok({ year: worst.period, return: worst.ret, years: fullYears.length });
  }

  // positiveMonths over complete calendar months (0 is not positive).
  const fullMonths = completePeriods(pts, 7);
  let positiveMonths: RefMetric<RefPositiveMonths>;
  if (fullMonths.length === 0) positiveMonths = no('tooShort');
  else {
    const positive = fullMonths.filter((x) => x.ret > 0).length;
    positiveMonths = ok({
      share: positive / fullMonths.length,
      positive,
      months: fullMonths.length,
    });
  }

  // rolling5y: one calendar window ending at every point that has a point 5 years before.
  const growth: number[] = [];
  for (let i = 0; i < n; i++) {
    const D = fiveYearsBefore(t[i]!);
    if (D === undefined) continue;
    let s = -1;
    for (let j = 0; j < n; j++) if (t[j]! <= D) s = j;
    if (s < 0) continue;
    growth.push((e[i]! / e[s]!) ** (365.25 / refDays(t[s]!, t[i]!)) - 1);
  }
  let rolling5y: RefMetric<RefRolling5y>;
  if (growth.length === 0) rolling5y = no('tooShort');
  else {
    const sorted = [...growth].sort((p, q) => p - q);
    const w = sorted.length;
    const median = w % 2 === 1 ? sorted[(w - 1) / 2]! : (sorted[w / 2 - 1]! + sorted[w / 2]!) / 2;
    const target = input.rollingTarget;
    const meeting = target === undefined ? undefined : growth.filter((g) => g >= target).length;
    rolling5y = ok({
      median,
      min: sorted[0]!,
      max: sorted[w - 1]!,
      windows: w,
      share: meeting === undefined ? undefined : meeting / w,
      meeting,
    });
  }

  // switchesPerYear: S = traded points, less 1 when there is any.
  let switchesPerYear: RefMetric<number>;
  if (!pts.every((p) => typeof p.traded === 'boolean')) switchesPerYear = no('holdingsMissing');
  else if (span < REF_MIN_SPAN_DAYS) switchesPerYear = no('tooShort');
  else {
    const traded = pts.filter((p) => p.traded === true).length;
    switchesPerYear = ok((traded > 0 ? traded - 1 : 0) / years);
  }

  // averageExposure: mean over points 0 .. n-2 of sum(weight x L).
  let averageExposure: RefMetric<number>;
  {
    const x: number[] = [];
    let missing = false;
    for (let i = 0; i <= n - 2 && !missing; i++) {
      const w = pts[i]!.weights;
      if (w === undefined || w === null || typeof w !== 'object') {
        missing = true;
        break;
      }
      let xi = 0;
      for (const [ticker, weight] of Object.entries(w)) {
        const L = leverageOf(ticker);
        if (L === undefined) {
          missing = true;
          break;
        }
        xi += weight * L;
      }
      x.push(xi);
    }
    averageExposure = missing ? no('holdingsMissing') : ok(mean(x));
  }

  // costDrag: cagr(gross) - cagr(points).
  let costDrag: RefMetric<number>;
  if (input.gross === undefined) costDrag = no('grossMissing');
  else {
    const g = cagrOf(input.gross);
    if (!g.ok) costDrag = no(g.reason);
    else if (!cagr.ok) costDrag = no(cagr.reason);
    else costDrag = ok(g.value - cagr.value);
  }

  return {
    cagr,
    cumulativeReturn,
    volatility,
    downsideDeviation,
    sharpe,
    sortino,
    calmar,
    maxDrawdown,
    averageDrawdown,
    longestDrawdown,
    ulcerIndex,
    beta,
    correlation,
    var95,
    cvar95,
    bestYear,
    worstYear,
    positiveMonths,
    rolling5y,
    switchesPerYear,
    averageExposure,
    costDrag,
  };
}
