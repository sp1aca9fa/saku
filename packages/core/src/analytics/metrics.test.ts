// Hand-computed values per metric (docs/analytics.md "Metrics"); each expected value is worked
// out in the comment next to it, not taken from the code.
import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../strategy/backtest';
import {
  type EquitySample,
  METRIC_IDS,
  type Metric,
  type MetricsPoint,
  calendarDays,
  fiveYearsBefore,
  metrics,
} from './metrics';

const DAY = 86_400_000;
/** `count` dates one calendar day apart from `start`. */
const dates = (count: number, start = '2024-01-01') =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10),
  );
/** Equity from simple returns, starting at 1. */
const curve = (returns: number[], start = '2024-01-01'): MetricsPoint[] => {
  const ds = dates(returns.length + 1, start);
  let e = 1;
  return ds.map((date, i) => {
    if (i > 0) e *= 1 + returns[i - 1]!;
    return { date, equity: e };
  });
};
const at = (pairs: [string, number][]): MetricsPoint[] =>
  pairs.map(([date, equity]) => ({ date, equity }));
const v = <T>(m: Metric<T>): T => {
  if (!m.ok) throw new Error(`no value: ${m.reason}`);
  return m.value;
};
const reason = (m: { ok: true } | { ok: false; reason: string }) => (m.ok ? 'value' : m.reason);
const alternate = (count: number, a: number, b: number) =>
  Array.from({ length: count }, (_, i) => (i % 2 === 0 ? a : b));
const S252 = Math.sqrt(252);

describe('metrics: input', () => {
  it('a backtest point is a metrics point', () => {
    const p: EquityPoint = {
      date: '2024-01-02',
      decided: true,
      equity: 1,
      weights: {},
      traded: false,
    };
    const q: MetricsPoint = p;
    expect(q.equity).toBe(1);
  });

  it('refuses malformed input', () => {
    const ok = curve([0.01]);
    expect(() => metrics({ points: [ok[1]!, ok[0]!] })).toThrow('strictly ascending');
    expect(() => metrics({ points: [ok[0]!, ok[0]!] })).toThrow('strictly ascending');
    expect(() => metrics({ points: [{ date: '2024-02-30', equity: 1 }] })).toThrow('YYYY-MM-DD');
    expect(() => metrics({ points: [{ date: '2024-01-01', equity: NaN }] })).toThrow('finite');
    expect(() =>
      metrics({ points: [{ date: '2024-01-01', equity: 1, weights: { X: Infinity } }] }),
    ).toThrow('weight of X');
    expect(() => metrics({ points: ok, rollingTarget: NaN })).toThrow('rollingTarget');
    expect(() => metrics({ points: ok, gross: [ok[0]!] })).toThrow('gross: dates differ');
    expect(() => metrics({ points: ok, benchmarks: { B: [ok[1]!, ok[0]!] } })).toThrow(
      'B: dates are not strictly ascending',
    );
  });

  it('empty, one point and a wiped-out curve give no value at all', () => {
    for (const points of [[], curve([])]) {
      const m = metrics({ points, benchmarks: { B: curve([0.01]) } });
      for (const id of METRIC_IDS) {
        if (id === 'beta' || id === 'correlation') expect(reason(m[id].B!)).toBe('tooShort');
        else expect(reason(m[id]), id).toBe('tooShort');
      }
    }
    const wiped = curve([0.5, -1, 0.1]);
    const m = metrics({ points: wiped, benchmarks: { B: curve([0.01, 0.01, 0.01]) } });
    for (const id of METRIC_IDS) {
      if (id === 'beta' || id === 'correlation') expect(reason(m[id].B!)).toBe('equityNotPositive');
      else expect(reason(m[id]), id).toBe('equityNotPositive');
    }
  });

  it('returns every metric of the set', () => {
    const m = metrics({ points: curve([0.01]) });
    expect(Object.keys(m).sort()).toEqual([...METRIC_IDS].sort());
  });

  it('counts calendar days and steps five years back', () => {
    expect(calendarDays('2024-01-21', '2024-03-01')).toBe(40);
    expect(fiveYearsBefore('2024-02-29')).toBe('2019-02-28');
    expect(fiveYearsBefore('2020-02-29')).toBe('2015-02-28'); // 2015 has no Feb 29
    expect(fiveYearsBefore('2025-03-01')).toBe('2020-03-01');
  });
});

describe('metrics: growth', () => {
  it('CAGR over 365.25-day years, none under a year', () => {
    // 2020-01-01 to 2021-01-01 is 366 days (2020 is a leap year).
    const m = metrics({
      points: at([
        ['2020-01-01', 1],
        ['2021-01-01', 1.1],
      ]),
    });
    expect(v(m.cagr)).toBeCloseTo(1.1 ** (365.25 / 366) - 1, 14);
    expect(v(m.cumulativeReturn)).toBeCloseTo(0.1, 14);
    // 364 days: not annualized.
    const short = metrics({
      points: at([
        ['2020-01-01', 1],
        ['2020-12-30', 1.1],
      ]),
    });
    expect(reason(short.cagr)).toBe('tooShort');
    expect(v(short.cumulativeReturn)).toBeCloseTo(0.1, 14);
    // 365 days: the minimum.
    expect(
      v(
        metrics({
          points: at([
            ['2021-01-01', 1],
            ['2022-01-01', 1.1],
          ]),
        }).cagr,
      ),
    ).toBeCloseTo(1.1 ** (365.25 / 365) - 1, 14);
  });

  it('cost drag: growth lost to costs, from a zero-cost run on the same dates', () => {
    const points = at([
      ['2020-01-01', 1],
      ['2021-01-01', 1.1],
    ]);
    const gross = at([
      ['2020-01-01', 1],
      ['2021-01-01', 1.2],
    ]);
    expect(v(metrics({ points, gross }).costDrag)).toBeCloseTo(
      1.2 ** (365.25 / 366) - 1.1 ** (365.25 / 366),
      14,
    );
    expect(reason(metrics({ points }).costDrag)).toBe('grossMissing');
    const shortP = at([
      ['2020-01-01', 1],
      ['2020-06-01', 1.1],
    ]);
    const shortG = at([
      ['2020-01-01', 1],
      ['2020-06-01', 1.2],
    ]);
    expect(reason(metrics({ points: shortP, gross: shortG }).costDrag)).toBe('tooShort');
    const zero = at([
      ['2020-01-01', 1],
      ['2021-01-01', 0],
    ]);
    expect(reason(metrics({ points, gross: zero }).costDrag)).toBe('equityNotPositive');
  });
});

describe('metrics: return statistics', () => {
  // 20 returns alternating +2% and -1%: mean 0.005, deviations +-0.015, so the sample variance is
  // 20 x 0.015^2 / 19 = 0.0045 / 19.
  const r = alternate(20, 0.02, -0.01);
  const points = curve(r);
  const c = 0.0001;
  const cashReturn = () => c;

  it('volatility: sample spread x sqrt(252), at least 20 returns', () => {
    expect(v(metrics({ points }).volatility)).toBeCloseTo(Math.sqrt(0.0045 / 19) * S252, 12);
    expect(reason(metrics({ points: curve(r.slice(0, 19)) }).volatility)).toBe('tooShort');
  });

  it('Sharpe: mean excess over sample spread of excess x sqrt(252)', () => {
    // Excess: +0.0199 and -0.0101, mean 0.0049, the same spread as the returns.
    const m = metrics({ points, cashReturn });
    expect(v(m.sharpe)).toBeCloseTo((0.0049 / Math.sqrt(0.0045 / 19)) * S252, 9);
  });

  it('Sortino and downside deviation: shortfalls below target over all returns', () => {
    // Below the cash target: ten days of -0.0101; 10 x 0.0101^2 / 20 = 0.000051005.
    const m = metrics({ points, cashReturn });
    expect(v(m.sortino)).toBeCloseTo((0.0049 / Math.sqrt(0.000051005)) * S252, 9);
    expect(v(m.downsideDeviation)).toBeCloseTo(Math.sqrt(0.000051005) * S252, 12);
    // Target 0: ten days of -0.01; 10 x 0.0001 / 20 = 0.00005. No cash rate needed.
    const zero = metrics({ points, downsideTarget: 'zero' });
    expect(v(zero.downsideDeviation)).toBeCloseTo(Math.sqrt(0.00005) * S252, 12);
  });

  it('an unknown cash rate on any date is no value, never 0', () => {
    for (const cash of [
      undefined,
      (d: string) => (d === '2024-01-10' ? undefined : c),
      (d: string) => (d === '2024-01-10' ? NaN : c),
    ]) {
      const m = metrics({ points, cashReturn: cash });
      expect(reason(m.sharpe)).toBe('cashRateMissing');
      expect(reason(m.sortino)).toBe('cashRateMissing');
      expect(reason(m.downsideDeviation)).toBe('cashRateMissing');
      expect(v(m.volatility)).toBeGreaterThan(0);
    }
    // The cash rate of the first point (no return ends there) is not read.
    const m = metrics({ points, cashReturn: (d) => (d === '2024-01-01' ? undefined : c) });
    expect(m.sharpe.ok).toBe(true);
  });

  it('a cash-only curve has no Sharpe or Sortino (no spread), not a rounding artifact', () => {
    const cash = curve(Array(30).fill(c));
    const m = metrics({ points: cash, cashReturn });
    expect(reason(m.sharpe)).toBe('noDispersion');
    expect(reason(m.sortino)).toBe('noDispersion');
    // No day below the target: no downside.
    expect(reason(metrics({ points: curve(Array(30).fill(0.01)), cashReturn }).sortino)).toBe(
      'noDispersion',
    );
  });

  it('VaR and CVaR 95%: the ceil(m / 20)-th worst day and the mean of the worst', () => {
    // 20 returns: k = 1, the worst day.
    const m20 = metrics({ points });
    expect(v(m20.var95)).toBeCloseTo(-0.01, 12);
    expect(v(m20.cvar95)).toBeCloseTo(-0.01, 12);
    // 21 returns: k = 2. Worst -3%, second -2%.
    const r21 = [...Array(19).fill(0.001), -0.03, -0.02];
    const m21 = metrics({ points: curve(r21) });
    expect(v(m21.var95)).toBeCloseTo(-0.02, 12);
    expect(v(m21.cvar95)).toBeCloseTo(-0.025, 12);
    // 40 returns: k = 2; 41: k = 3.
    const r40 = [...Array(37).fill(0.001), -0.03, -0.02, -0.01];
    expect(v(metrics({ points: curve(r40) }).var95)).toBeCloseTo(-0.02, 12);
    expect(v(metrics({ points: curve([...r40, 0.001]) }).var95)).toBeCloseTo(-0.01, 12);
    expect(v(metrics({ points: curve([...r40, 0.001]) }).cvar95)).toBeCloseTo(-0.02, 12);
    expect(reason(metrics({ points: curve(r.slice(0, 19)) }).var95)).toBe('tooShort');
  });
});

describe('metrics: drawdowns', () => {
  // Drawdowns: 0, 0, -0.25, -0.1, 0, 0, -0.2, -0.1.
  const points = at([
    ['2024-01-01', 1],
    ['2024-01-02', 1.2],
    ['2024-01-05', 0.9],
    ['2024-01-10', 1.08],
    ['2024-01-20', 1.2],
    ['2024-01-21', 1.3],
    ['2024-01-25', 1.04],
    ['2024-03-01', 1.17],
  ]);
  const m = metrics({ points });

  it('maximum and average drawdown (mean of the episodes deepest points)', () => {
    expect(v(m.maxDrawdown)).toBeCloseTo(-0.25, 14);
    expect(v(m.averageDrawdown)).toBeCloseTo((-0.25 - 0.2) / 2, 14);
  });

  it('Ulcer index: root mean square drawdown over every point', () => {
    // 0.25^2 + 0.1^2 + 0.2^2 + 0.1^2 = 0.1225, over 8 points.
    expect(v(m.ulcerIndex)).toBeCloseTo(Math.sqrt(0.1225 / 8), 14);
  });

  it('longest drawdown: an unrecovered one counts its days so far', () => {
    // First: 01-02 to 01-20, 18 days. Second: 01-21 to 03-01 (unrecovered), 40 days.
    expect(v(m.longestDrawdown)).toEqual({
      days: 40,
      peak: '2024-01-21',
      trough: '2024-01-25',
      recovery: undefined,
      recoveryDays: undefined,
      depth: expect.closeTo(-0.2, 14),
    });
    // Recovered: peak 01-02, trough 01-05, recovery 01-20.
    const recovered = metrics({ points: points.slice(0, 6) });
    expect(v(recovered.longestDrawdown)).toEqual({
      days: 18,
      peak: '2024-01-02',
      trough: '2024-01-05',
      recovery: '2024-01-20',
      recoveryDays: 15,
      depth: expect.closeTo(-0.25, 14),
    });
  });

  it('the earliest of equally long drawdowns', () => {
    const two = at([
      ['2024-01-01', 1],
      ['2024-01-02', 0.9],
      ['2024-01-03', 1],
      ['2024-01-04', 0.5],
      ['2024-01-05', 1.1],
    ]);
    expect(v(metrics({ points: two }).longestDrawdown)).toMatchObject({
      days: 2,
      peak: '2024-01-01',
    });
  });

  it('no drawdown: average 0, longest none, Calmar none', () => {
    const up = at([
      ['2020-01-01', 1],
      ['2020-06-01', 1.05],
      ['2021-01-01', 1.1],
    ]);
    const u = metrics({ points: up });
    expect(v(u.maxDrawdown)).toBe(0);
    expect(v(u.averageDrawdown)).toBe(0);
    expect(v(u.longestDrawdown)).toBeNull();
    expect(v(u.ulcerIndex)).toBe(0);
    expect(reason(u.calmar)).toBe('noDrawdown');
  });

  it('a dip within 1e-9 of the peak is at the peak (near-tie rule), but max drawdown is exact', () => {
    const flat = at([
      ['2024-01-01', 1],
      ['2024-01-02', 1 - 1e-12],
      ['2024-01-03', 1],
    ]);
    const f = metrics({ points: flat });
    expect(v(f.maxDrawdown)).toBe(1 - 1e-12 - 1); // exact, about -1e-12
    expect(v(f.maxDrawdown)).toBeLessThan(0);
    expect(v(f.averageDrawdown)).toBe(0);
    expect(v(f.longestDrawdown)).toBeNull();
  });

  it('Calmar: CAGR over the absolute maximum drawdown, none under a year', () => {
    const c = at([
      ['2020-01-01', 1],
      ['2020-06-01', 0.8],
      ['2021-01-01', 1.1],
    ]);
    expect(v(metrics({ points: c }).calmar)).toBeCloseTo((1.1 ** (365.25 / 366) - 1) / 0.2, 12);
    expect(reason(metrics({ points: points }).calmar)).toBe('tooShort');
  });
});

describe('metrics: against a benchmark', () => {
  // Benchmark: +1%, -1% alternating. Strategy: +2%, 0, 0, 0 repeated (mean 0.005).
  // Per 4 returns: covariance sum 0.015x0.01 + 0.005x0.01 - 0.005x0.01 + 0.005x0.01 = 0.0002,
  // so 0.001 over 20; benchmark squares 0.002; strategy squares 0.0003 x 5 = 0.0015.
  // beta = 0.001 / 0.002 = 0.5; correlation = 0.001 / sqrt(0.0015 x 0.002) = 1 / sqrt(3).
  const b = curve(alternate(20, 0.01, -0.01));
  const s = curve(Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? 0.02 : 0)));

  it('beta and correlation from aligned daily returns', () => {
    const m = metrics({ points: s, benchmarks: { B: b } });
    expect(v(m.beta.B!)).toBeCloseTo(0.5, 12);
    expect(v(m.correlation.B!)).toBeCloseTo(1 / Math.sqrt(3), 12);
  });

  it('aligns by date: the strategy dates the benchmark lacks are left out', () => {
    // The strategy is 3 x the benchmark's level on the shared dates (same returns), with wild
    // values on dates the benchmark lacks.
    const long = curve(alternate(30, 0.01, -0.02));
    const bench = long.filter((_, i) => i % 3 !== 1);
    const strat = long.map((p, i) => ({ date: p.date, equity: i % 3 === 1 ? 50 : 3 * p.equity }));
    const m = metrics({
      points: strat,
      benchmarks: { B: bench, N: bench.map((p) => ({ ...p, equity: 1 / p.equity })) },
    });
    expect(v(m.beta.B!)).toBeCloseTo(1, 12);
    expect(v(m.correlation.B!)).toBeCloseTo(1, 12);
    expect(v(m.correlation.N!)).toBeLessThan(-0.99);
    expect(v(m.correlation.N!)).toBeGreaterThanOrEqual(-1);
  });

  it('too few shared dates, a flat or wiped-out benchmark: no value for that benchmark only', () => {
    const flat: EquitySample[] = b.map((p) => ({ date: p.date, equity: 1 }));
    const zero: EquitySample[] = b.map((p, i) => ({ date: p.date, equity: i === 3 ? 0 : 1 }));
    const m = metrics({
      points: s,
      benchmarks: { B: b, short: b.slice(0, 20), flat, zero },
    });
    expect(m.beta.B!.ok).toBe(true);
    expect(reason(m.beta.short!)).toBe('tooShort'); // 19 shared returns
    expect(reason(m.beta.flat!)).toBe('noDispersion');
    expect(reason(m.correlation.flat!)).toBe('noDispersion');
    expect(reason(m.beta.zero!)).toBe('equityNotPositive');
    // A flat strategy: beta 0, no correlation.
    const still = metrics({ points: s.map((p) => ({ ...p, equity: 1 })), benchmarks: { B: b } });
    expect(v(still.beta.B!)).toBeCloseTo(0, 14);
    expect(reason(still.correlation.B!)).toBe('noDispersion');
    expect(metrics({ points: s }).beta).toEqual({});
  });
});

describe('metrics: calendar periods', () => {
  it('best and worst complete calendar year', () => {
    const m = metrics({
      points: at([
        ['2019-12-31', 1],
        ['2020-06-30', 1.05],
        ['2020-12-31', 1.1],
        ['2021-06-30', 1.0],
        ['2021-12-31', 0.99],
        ['2022-03-01', 1.2],
      ]),
    });
    // 2019 and 2022 are partial; 2020: 1.1 / 1 - 1; 2021: 0.99 / 1.1 - 1.
    expect(v(m.bestYear)).toEqual({ year: '2020', return: expect.closeTo(0.1, 14), years: 2 });
    expect(v(m.worstYear)).toEqual({ year: '2021', return: expect.closeTo(-0.1, 14), years: 2 });
    expect(reason(m.positiveMonths)).toBe('tooShort'); // no month has both neighbors
  });

  it('a year without the next one in the series is not complete', () => {
    const m = metrics({
      points: at([
        ['2019-12-31', 1],
        ['2020-12-31', 1.1],
      ]),
    });
    expect(reason(m.bestYear)).toBe('tooShort');
  });

  it('share of positive complete months (a flat month is not positive)', () => {
    const m = metrics({
      points: at([
        ['2024-01-31', 1],
        ['2024-02-15', 1.02],
        ['2024-02-29', 1.05],
        ['2024-03-29', 1.05],
        ['2024-04-30', 1.1],
        ['2024-05-01', 1.0],
      ]),
    });
    // Feb: 1.05 / 1 (up); Mar: 1.05 / 1.05 (flat); Apr: 1.1 / 1.05 (up). Jan and May partial.
    expect(v(m.positiveMonths)).toEqual({ share: 2 / 3, positive: 2, months: 3 });
    // January's previous month is December of the year before.
    const turn = metrics({
      points: at([
        ['2023-12-29', 1],
        ['2024-01-31', 1.1],
        ['2024-02-01', 1.2],
      ]),
    });
    expect(v(turn.positiveMonths)).toEqual({ share: 1, positive: 1, months: 1 });
  });

  it('rolling 5-year windows: yearly growth, median, range and share meeting a target', () => {
    const points = at([
      ['2015-01-02', 1],
      ['2017-06-01', 1.3],
      ['2020-01-02', 1.5],
      ['2020-01-03', 1.4],
      ['2021-01-04', 2],
    ]);
    // Windows end 2020-01-02 (1826 days), 2020-01-03 (1827) and 2021-01-04 (2194), all from
    // 2015-01-02 (the last point on or before each start).
    const g = [1.5 ** (365.25 / 1826) - 1, 1.4 ** (365.25 / 1827) - 1, 2 ** (365.25 / 2194) - 1];
    const m = metrics({ points, rollingTarget: 0.08 });
    expect(v(m.rolling5y)).toEqual({
      median: expect.closeTo(g[0]!, 14),
      min: expect.closeTo(g[1]!, 14),
      max: expect.closeTo(g[2]!, 14),
      windows: 3,
      meeting: 2, // 8.4% and 12.2% meet 8%; 7.0% does not
      share: 2 / 3,
    });
    expect(v(metrics({ points }).rolling5y)).toMatchObject({
      share: undefined,
      meeting: undefined,
    });
    // Even count: the mean of the two middle values.
    const even = metrics({ points: points.slice(0, 4) });
    expect(v(even.rolling5y).median).toBeCloseTo((g[0]! + g[1]!) / 2, 14);
    expect(reason(metrics({ points: points.slice(0, 2) }).rolling5y)).toBe('tooShort');
  });
});

describe('metrics: trading', () => {
  const day = (date: string, traded: boolean, weights: Record<string, number>) => ({
    date,
    equity: 1,
    traded,
    weights,
  });

  it('switches per year: trades after the entry over the calendar years', () => {
    // 2024-01-01 to 2025-01-01: 366 days. Three trades: the entry and two switches.
    const points = [
      day('2024-01-01', false, {}),
      day('2024-01-02', true, { A: 1 }),
      day('2024-05-01', false, { A: 1 }),
      day('2024-06-03', true, { B: 1 }),
      day('2024-09-03', true, { A: 1 }),
      day('2025-01-01', false, { A: 1 }),
    ];
    expect(v(metrics({ points }).switchesPerYear)).toBeCloseTo(2 / (366 / 365.25), 14);
    const missing = points.map((p, i) => (i === 2 ? { date: p.date, equity: 1 } : p));
    expect(reason(metrics({ points: missing }).switchesPerYear)).toBe('holdingsMissing');
    expect(reason(metrics({ points: points.slice(0, 5) }).switchesPerYear)).toBe('tooShort');
  });

  it('average exposure: weight x leverage of the weights each return period starts from', () => {
    const points = [
      day('2024-01-01', false, {}), // 0 (nothing held yet)
      day('2024-01-02', true, { 'SPY?L=3&E=0.9': 1 }), // 3
      day('2024-01-03', true, { SPY: 0.5, CASH_USD: 0.5 }), // 0.5
      day('2024-01-04', true, { 'SPY?L=2': 1 }), // the last point earns nothing: left out
    ];
    expect(v(metrics({ points }).averageExposure)).toBeCloseTo(3.5 / 3, 14);
    const noWeights = points.map((p, i) => (i === 1 ? { date: p.date, equity: 1 } : p));
    expect(reason(metrics({ points: noWeights }).averageExposure)).toBe('holdingsMissing');
    const lastBare = points.map((p, i) => (i === 3 ? { date: p.date, equity: 1 } : p));
    expect(metrics({ points: lastBare }).averageExposure.ok).toBe(true);
    const unreadable = points.map((p, i) => (i === 2 ? { ...p, weights: { 'SPY?L=x': 1 } } : p));
    expect(reason(metrics({ points: unreadable }).averageExposure)).toBe('holdingsMissing');
  });
});
