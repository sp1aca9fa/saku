// Core metrics against the independent reference (requirements 13; docs/analytics.md "Metrics")
// on synthetic random inputs: every metric has the same value-or-no-value and the same reason, and
// values agree within 1e-9 relative (1e-12 absolute near 0). Where they disagree, find the root
// cause against the doc; never copy one into the other.
import { refMetrics } from '@saku/reference';
import type { RefMetricsInput } from '@saku/reference';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EquitySample, MetricsInput, MetricsPoint } from './metrics';
import { metrics } from './metrics';

/** A small seeded generator (mulberry32), so failures reproduce. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Close to a fixed tolerance: 1e-9 relative, 1e-12 absolute near 0. */
function close(a: number, b: number): boolean {
  if (Object.is(a, b)) return true;
  return Math.abs(a - b) <= Math.max(1e-9 * Math.max(Math.abs(a), Math.abs(b)), 1e-12);
}

/** The first difference between a core and a reference value, or undefined (keys compared too). */
function diff(a: unknown, b: unknown, path: string): string | undefined {
  if (typeof a === 'number' && typeof b === 'number') {
    return close(a, b) ? undefined : `${path}: core ${a}, reference ${b}`;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys core [${ka}], reference [${kb}]`;
    for (const k of ka) {
      const d = diff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d) return d;
    }
    return undefined;
  }
  return Object.is(a, b) ? undefined : `${path}: core ${String(a)}, reference ${String(b)}`;
}

/** Same throw-or-result; on results, the first metric that differs. */
function compare(input: MetricsInput): string | undefined {
  let core: unknown;
  let ref: unknown;
  let coreError: unknown;
  let refError: unknown;
  try {
    core = metrics(input);
  } catch (e) {
    coreError = e;
  }
  try {
    ref = refMetrics(input as RefMetricsInput);
  } catch (e) {
    refError = e;
  }
  if (coreError || refError) {
    if (coreError && refError) return undefined;
    return `throws: core ${String(coreError)}, reference ${String(refError)}`;
  }
  return diff(core, ref, 'metrics');
}

const SIZES = ['empty', 'tiny', 'short', 'year', 'long'] as const;
const STARTS = ['2000-02-25', '2003-12-29', '2004-02-27', '2011-12-28', '2015-02-26', '1999-06-30'];

/** Business-day-like dates with gaps, crossing month and year ends and Feb 29. */
function makeDates(rnd: () => number, size: (typeof SIZES)[number]): string[] {
  const n =
    size === 'empty'
      ? Math.floor(rnd() * 2)
      : size === 'tiny'
        ? 2 + Math.floor(rnd() * 3)
        : size === 'short'
          ? 5 + Math.floor(rnd() * 40)
          : size === 'year'
            ? 150 + Math.floor(rnd() * 350)
            : 800 + Math.floor(rnd() * 700);
  let date = STARTS[Math.floor(rnd() * STARTS.length)]!;
  date = addDays(date, Math.floor(rnd() * 400) - 200);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(date);
    const u = rnd();
    // Mostly sessions a day or a weekend apart; sometimes a gap of weeks or more than a year.
    const step =
      u < 0.55
        ? 1
        : u < 0.9
          ? 2 + Math.floor(rnd() * 3)
          : u < 0.99
            ? 10 + Math.floor(rnd() * 60)
            : 200 + Math.floor(rnd() * 500);
    date = addDays(date, step);
  }
  return out;
}

const gauss = (rnd: () => number) =>
  Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

type EquityMode = 'walk' | 'flat' | 'cashOnly' | 'neverRecovers' | 'wipedOut' | 'nearTies';

function makeEquity(
  rnd: () => number,
  n: number,
  mode: EquityMode,
  cash: (number | undefined)[],
): number[] {
  const e: number[] = [];
  let v = 1 + rnd() * 999;
  let flatLeft = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      if (mode === 'flat') {
        // unchanged
      } else if (mode === 'cashOnly') {
        v *= 1 + (Number.isFinite(cash[i]) ? cash[i]! : 0.0001);
      } else if (mode === 'nearTies' && rnd() < 0.3) {
        // Back to within or just outside the near-tie band of the running peak.
        const peak = Math.max(...e);
        v = peak * (1 - (rnd() < 0.5 ? 5e-10 : 2e-9));
      } else if (flatLeft > 0) {
        flatLeft--;
      } else if (rnd() < 0.03) {
        flatLeft = 1 + Math.floor(rnd() * 30);
      } else {
        const drift = mode === 'neverRecovers' && i > n / 2 ? -0.004 : 0.0004;
        v *= Math.max(0.5, 1 + drift + 0.012 * gauss(rnd));
      }
    }
    e.push(v);
  }
  if (mode === 'wipedOut' && n > 0) e[Math.floor(rnd() * n)] = rnd() < 0.5 ? 0 : -1;
  return e;
}

const TICKERS = ['SPY', 'QQQ?L=3&E=0.9', 'SH?L=-1', 'CASH_USD', 'TLT?E=0.2', 'UPRO?L=2.5'];

type Choice = {
  seed: number;
  size: (typeof SIZES)[number];
  equity: EquityMode;
  cash: 'none' | 'full' | 'gaps' | 'nan';
  benchmarks: number;
  weights: 'none' | 'all' | 'lastMissing' | 'oneMissing' | 'empty' | 'unreadable';
  traded: 'all' | 'oneMissing' | 'notBoolean' | 'none';
  gross: 'none' | 'normal' | 'notPositive';
  rollingTarget: number | undefined;
  downsideTarget: 'cash' | 'zero' | 'other' | undefined;
};

function build(c: Choice): MetricsInput {
  const rnd = random(c.seed);
  const dates = makeDates(rnd, c.size);
  const n = dates.length;
  const cashBy = dates.map((_, i) => {
    if (c.cash === 'gaps' && rnd() < 0.05) return undefined;
    if (c.cash === 'nan' && i === n - 1) return Number.NaN;
    return 0.00012 + 0.00004 * rnd();
  });
  const equity = makeEquity(rnd, n, c.equity, cashBy);
  const cashMap = new Map(dates.map((d, i) => [d, cashBy[i]]));
  const missingWeight = Math.floor(rnd() * Math.max(1, n - 1));
  const missingTraded = Math.floor(rnd() * Math.max(1, n));
  const points: MetricsPoint[] = dates.map((date, i) => {
    const p: MetricsPoint = { date, equity: equity[i]! };
    const skip =
      c.weights === 'none' ||
      (c.weights === 'lastMissing' && i === n - 1) ||
      (c.weights === 'oneMissing' && i === missingWeight);
    if (!skip) {
      const w: Record<string, number> = {};
      if (c.weights !== 'empty') {
        const k = Math.floor(rnd() * 3);
        for (let j = 0; j < k; j++) w[TICKERS[Math.floor(rnd() * TICKERS.length)]!] = rnd();
        if (c.weights === 'unreadable' && i === missingWeight) {
          w[['ABC?L=x', 'ABC?L=', 'ABC?L', 'ABC?E=1&L=y'][Math.floor(rnd() * 4)]!] = 0.5;
        }
      }
      p.weights = w;
    }
    if (c.traded !== 'none') {
      if (c.traded === 'oneMissing' && i === missingTraded) {
        // left out
      } else if (c.traded === 'notBoolean' && i === missingTraded) {
        (p as { traded?: unknown }).traded = 1;
      } else {
        p.traded = rnd() < 0.05;
      }
    }
    return p;
  });

  const benchmarks: Record<string, EquitySample[]> = {};
  for (let b = 0; b < c.benchmarks; b++) {
    const kind = Math.floor(rnd() * 6);
    const keep = [1, 0.95, 0.5, 0.05][Math.floor(rnd() * 4)]!;
    const set = new Set<string>();
    for (const d of dates) {
      if (rnd() < keep) set.add(d);
      if (rnd() < 0.1) set.add(addDays(d, 1)); // a date the strategy may not have
    }
    const own = [...set].sort();
    const at = new Map(dates.map((d, i) => [d, equity[i]!]));
    let v = 50 + rnd() * 100;
    const series = own.map((date) => {
      if (kind === 0)
        v = 77; // flat: no dispersion
      else if (kind === 1 && at.has(date))
        v = at.get(date)!; // the strategy itself
      else if (kind === 2 && at.has(date)) v = at.get(date)! * (2 + 0.01 * gauss(rnd));
      else v *= Math.max(0.5, 1 + 0.0003 + 0.01 * gauss(rnd));
      return { date, equity: v };
    });
    if (kind === 3 && series.length > 0) series[Math.floor(rnd() * series.length)]!.equity = 0;
    benchmarks[`b${b}`] = series;
  }

  const input: MetricsInput = { points };
  if (c.cash !== 'none') input.cashReturn = (date) => cashMap.get(date);
  if (c.benchmarks > 0) input.benchmarks = benchmarks;
  if (c.gross !== 'none') {
    const gross = points.map((p, i) => ({ date: p.date, equity: p.equity * 1.00002 ** i }));
    if (c.gross === 'notPositive' && n > 0) gross[Math.floor(rnd() * n)]!.equity = -2;
    input.gross = gross;
  }
  if (c.rollingTarget !== undefined) input.rollingTarget = c.rollingTarget;
  if (c.downsideTarget !== undefined) {
    input.downsideTarget = c.downsideTarget as MetricsInput['downsideTarget'];
  }
  return input;
}

const choice: fc.Arbitrary<Choice> = fc.record({
  seed: fc.integer(),
  size: fc.constantFrom(...SIZES),
  equity: fc.constantFrom<EquityMode>(
    'walk',
    'walk',
    'walk',
    'flat',
    'cashOnly',
    'neverRecovers',
    'wipedOut',
    'nearTies',
  ),
  cash: fc.constantFrom<Choice['cash']>('none', 'full', 'full', 'gaps', 'nan'),
  benchmarks: fc.integer({ min: 0, max: 3 }),
  weights: fc.constantFrom<Choice['weights']>(
    'none',
    'all',
    'all',
    'lastMissing',
    'oneMissing',
    'empty',
    'unreadable',
  ),
  traded: fc.constantFrom<Choice['traded']>('all', 'all', 'oneMissing', 'notBoolean', 'none'),
  gross: fc.constantFrom<Choice['gross']>('none', 'normal', 'notPositive'),
  rollingTarget: fc.option(fc.double({ min: -0.3, max: 0.4, noNaN: true }), { nil: undefined }),
  downsideTarget: fc.constantFrom<Choice['downsideTarget']>(undefined, 'cash', 'zero', 'other'),
});

describe('metrics: core vs reference', () => {
  it('agree on random inputs (value or no value, reason, values within 1e-9)', () => {
    fc.assert(
      fc.property(choice, (c) => {
        const d = compare(build(c));
        if (d) throw new Error(d);
      }),
      { seed: 20261101, numRuns: 400 },
    );
  }, 60_000);

  it('agree on refused inputs: both throw, before any no-value reason', () => {
    const faults: ((input: MetricsInput) => void)[] = [
      (x) => ((x.points as MetricsPoint[])[0]!.date = '2021-02-29'),
      (x) => ((x.points as MetricsPoint[])[0]!.date = '2021-2-03'),
      (x) => ((x.points as MetricsPoint[])[0]!.equity = Number.NaN),
      (x) => ((x.points as MetricsPoint[])[0]!.equity = Infinity),
      (x) => ((x.points as MetricsPoint[])[0]!.weights = { SPY: Number.NaN }),
      (x) => (x.rollingTarget = Number.NaN),
      (x) => (x.rollingTarget = null as unknown as number),
      (x) => (x.gross = [{ date: '1990-01-01', equity: 1 }]),
      (x) => (x.benchmarks = { b: [{ date: 'x', equity: 1 }] }),
      (x) =>
        (x.benchmarks = {
          b: [
            { date: '2020-01-02', equity: 1 },
            { date: '2020-01-02', equity: 2 },
          ],
        }),
    ];
    fc.assert(
      fc.property(choice, fc.integer({ min: 0, max: faults.length - 1 }), (c, f) => {
        const input = build({ ...c, size: c.size === 'empty' ? 'tiny' : c.size });
        // A wiped-out or one-point curve is still refused first.
        if (c.size === 'empty') (input.points as MetricsPoint[]).splice(1);
        faults[f]!(input);
        expect(() => metrics(input)).toThrow();
        expect(() => refMetrics(input as RefMetricsInput)).toThrow();
      }),
      { seed: 20261102, numRuns: 200 },
    );
  });

  // The readings the reference took literally from the doc, checked against core one by one.
  describe('literal readings', () => {
    const dates = makeDates(random(7), 'long');
    const eq = makeEquity(random(8), dates.length, 'walk', []);
    const base = (): MetricsInput => ({
      points: dates.map((date, i) => ({
        date,
        equity: eq[i]!,
        weights: { SPY: 1 },
        traded: false,
      })),
      cashReturn: () => 0.0001,
      benchmarks: { b: dates.map((date, i) => ({ date, equity: 100 + i + (i % 3) })) },
      gross: dates.map((date, i) => ({ date, equity: eq[i]! * 1.0001 ** i })),
    });
    const same = (x: MetricsInput) => expect(compare(x)).toBeUndefined();

    it('a general reason wins for every metric, cost drag and benchmark entries included', () => {
      const one = base();
      one.points = one.points.slice(0, 1);
      one.gross = one.gross!.slice(0, 1);
      const r = metrics(one);
      expect(r.costDrag).toEqual({ ok: false, reason: 'tooShort' });
      expect(r.beta.b).toEqual({ ok: false, reason: 'tooShort' });
      same(one);
      const wiped = base();
      (wiped.points as MetricsPoint[])[5]!.equity = 0;
      const w = metrics(wiped);
      expect(w.costDrag).toEqual({ ok: false, reason: 'equityNotPositive' });
      expect(w.correlation.b).toEqual({ ok: false, reason: 'equityNotPositive' });
      same(wiped);
    });

    it('downside deviation never gives noDispersion', () => {
      const flat = base();
      flat.points = flat.points.map((p) => ({ ...p, equity: 10 }));
      flat.gross = undefined;
      const r = metrics(flat);
      expect(r.downsideDeviation.ok).toBe(true);
      expect(r.sharpe).toEqual({ ok: false, reason: 'noDispersion' });
      same({ ...flat, downsideTarget: 'zero' });
    });

    it('a non-positive benchmark equity on a date the strategy lacks still counts', () => {
      const x = base();
      x.benchmarks = { b: [{ date: '1970-01-02', equity: -1 }, ...x.benchmarks!.b!] };
      expect(metrics(x).beta.b).toEqual({ ok: false, reason: 'equityNotPositive' });
      same(x);
    });

    it('weights: undefined is holdingsMissing, {} is 0 exposure, an unreadable L is missing', () => {
      const none = base();
      delete (none.points as MetricsPoint[])[3]!.weights;
      expect(metrics(none).averageExposure).toEqual({ ok: false, reason: 'holdingsMissing' });
      same(none);
      const empty = base();
      empty.points = empty.points.map((p) => ({ ...p, weights: {} }));
      expect(metrics(empty).averageExposure).toEqual({ ok: true, value: 0 });
      same(empty);
      for (const ticker of ['X?L=abc', 'X?L=', 'X?L']) {
        const bad = base();
        (bad.points as MetricsPoint[])[3]!.weights = { [ticker]: 0.2 };
        expect(metrics(bad).averageExposure).toEqual({ ok: false, reason: 'holdingsMissing' });
        same(bad);
      }
    });

    it('a non-boolean traded flag is holdingsMissing', () => {
      const x = base();
      (x.points[2] as { traded?: unknown }).traded = 'yes';
      expect(metrics(x).switchesPerYear).toEqual({ ok: false, reason: 'holdingsMissing' });
      same(x);
    });

    it("bestYear.year is a 'YYYY' string; only periods holding a point are candidates", () => {
      const x = base();
      const r = metrics(x);
      expect(r.bestYear.ok && /^\d{4}$/.test(r.bestYear.value.year)).toBe(true);
      same(x);
      // 2011 has no point, so it is no candidate, and 2012 (no point in 2011) is not complete.
      const gap: MetricsInput = {
        points: [
          { date: '2010-06-01', equity: 1 },
          { date: '2012-06-01', equity: 2 },
          { date: '2013-12-31', equity: 3 },
          { date: '2014-01-02', equity: 4 },
        ],
      };
      const g = metrics(gap);
      expect(g.bestYear).toEqual({ ok: true, value: { year: '2013', return: 0.5, years: 1 } });
      same(gap);
    });

    it('optional result keys are present as undefined; another downside target means cash', () => {
      const x = base();
      const r = metrics(x);
      expect(r.rolling5y.ok && 'share' in r.rolling5y.value).toBe(true);
      same(x);
      const other = { ...base(), downsideTarget: 'other' as unknown as 'cash' };
      expect(metrics(other).downsideDeviation).toEqual(metrics(base()).downsideDeviation);
      same(other);
    });
  });
});
