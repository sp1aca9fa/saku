// Hand-computed checks of the reference metrics (docs/analytics.md "Metrics"). Expected values
// are closed forms worked out by hand from the contract's formulas, never read from the code.
import { describe, expect, it } from 'vitest';
import { refDays, refMetrics, type RefMetric, type RefMetricsPoint } from './metrics';

/** `count` consecutive calendar days from `start` (the metrics do not need weekdays). */
const dayList = (start: string, count: number): string[] => {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
  );
};

/** Equity from returns: e_0 = 100, e_i = e_(i-1) (1 + r_i). */
const fromReturns = (returns: number[], start = '2024-01-01'): RefMetricsPoint[] => {
  const dates = dayList(start, returns.length + 1);
  const pts: RefMetricsPoint[] = [{ date: dates[0]!, equity: 100 }];
  returns.forEach((r, i) => pts.push({ date: dates[i + 1]!, equity: pts[i]!.equity * (1 + r) }));
  return pts;
};

const value = <T>(m: RefMetric<T>): T => {
  if (!m.ok) throw new Error(`expected a value, got ${m.reason}`);
  return m.value;
};
const reason = <T>(m: RefMetric<T>) => (m.ok ? 'value' : m.reason);
const close = (a: number, b: number, rel = 1e-12) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));

// 20 returns alternating +2% and -1%; cash 0.01% a day.
const alternating = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.01));
const c = 0.0001;

describe('reference metrics: input rules', () => {
  const two: RefMetricsPoint[] = [
    { date: '2024-01-02', equity: 1 },
    { date: '2024-01-03', equity: 1 },
  ];
  it('refuses unreal dates, non-ascending dates and non-finite numbers', () => {
    for (const date of ['2023-02-29', '2024-13-01', '2024-1-01', '2024-04-31', '']) {
      expect(() => refMetrics({ points: [{ date, equity: 1 }] })).toThrow();
    }
    expect(() => refMetrics({ points: [two[0]!, { date: '2024-01-02', equity: 1 }] })).toThrow(
      /ascending/,
    );
    expect(() => refMetrics({ points: [two[1]!, two[0]!] })).toThrow(/ascending/);
    expect(() => refMetrics({ points: [{ date: '2024-01-02', equity: NaN }] })).toThrow();
    expect(() =>
      refMetrics({ points: two, benchmarks: { X: [{ date: '2024-01-02', equity: Infinity }] } }),
    ).toThrow();
    expect(() => refMetrics({ points: two, benchmarks: { X: [two[1]!, two[0]!] } })).toThrow(
      /ascending/,
    );
    expect(() =>
      refMetrics({ points: [{ date: '2024-01-02', equity: 1, weights: { A: NaN } }] }),
    ).toThrow(/weight/);
    expect(() => refMetrics({ points: two, gross: [two[0]!] })).toThrow(/gross/);
    expect(() =>
      refMetrics({ points: two, gross: [two[0]!, { date: '2024-01-04', equity: 1 }] }),
    ).toThrow(/gross/);
    expect(() => refMetrics({ points: two, rollingTarget: NaN })).toThrow(/rollingTarget/);
    // A leap day is a real date.
    expect(() => refMetrics({ points: [{ date: '2024-02-29', equity: 1 }] })).not.toThrow();
  });

  it('gives tooShort for every metric with 0 or 1 point, before a wiped-out curve', () => {
    for (const points of [[], [{ date: '2024-01-02', equity: 0 }]]) {
      const res = refMetrics({ points, benchmarks: { X: [] } });
      for (const [key, m] of Object.entries(res)) {
        if (key === 'beta' || key === 'correlation') {
          expect(m).toEqual({ X: { ok: false, reason: 'tooShort' } });
        } else expect(m).toEqual({ ok: false, reason: 'tooShort' });
      }
    }
  });

  it('gives equityNotPositive for every metric of a wiped-out curve, before per-metric reasons', () => {
    const res = refMetrics({
      points: [
        { date: '2024-01-02', equity: 1 },
        { date: '2024-01-03', equity: 0 },
      ],
      benchmarks: { X: [] },
    });
    for (const [key, m] of Object.entries(res)) {
      if (key === 'beta' || key === 'correlation') {
        expect(m).toEqual({ X: { ok: false, reason: 'equityNotPositive' } });
      } else expect(m).toEqual({ ok: false, reason: 'equityNotPositive' });
    }
  });

  it('counts calendar days between UTC midnights', () => {
    expect(refDays('2020-01-01', '2021-01-01')).toBe(366);
    expect(refDays('2015-02-27', '2020-02-29')).toBe(1828);
    expect(refDays('0050-01-01', '0051-01-01')).toBe(365);
  });
});

describe('reference metrics: drawdowns', () => {
  // d: 0, 0, -0.1, -0.2, 0, 0, -1/11, 0
  const dates = [
    '2024-01-02',
    '2024-01-03',
    '2024-01-04',
    '2024-01-05',
    '2024-01-08',
    '2024-01-09',
    '2024-01-10',
    '2024-01-11',
  ];
  const eq = [100, 110, 99, 88, 110, 121, 110, 121];
  const points = dates.map((date, i) => ({ date, equity: eq[i]! }));
  const res = refMetrics({ points });

  it('measures depth, episodes, the longest one and the Ulcer index', () => {
    close(value(res.cumulativeReturn), 0.21);
    close(value(res.maxDrawdown), -0.2);
    close(value(res.averageDrawdown), (-0.2 - 1 / 11) / 2);
    const longest = value(res.longestDrawdown)!;
    expect({ ...longest, depth: 0 }).toEqual({
      days: 5,
      peak: '2024-01-03',
      trough: '2024-01-05',
      recovery: '2024-01-08',
      recoveryDays: 3,
      depth: 0,
    });
    close(longest.depth, -0.2);
    close(value(res.ulcerIndex), Math.sqrt((0.01 + 0.04 + 1 / 121) / 8));
  });

  it('leaves annual and distribution metrics without value on a short series', () => {
    expect(reason(res.cagr)).toBe('tooShort');
    expect(reason(res.calmar)).toBe('tooShort');
    expect(reason(res.volatility)).toBe('tooShort');
    expect(reason(res.sharpe)).toBe('tooShort');
    expect(reason(res.var95)).toBe('tooShort');
    expect(reason(res.bestYear)).toBe('tooShort');
    expect(reason(res.rolling5y)).toBe('tooShort');
  });

  it('reports an unrecovered episode so far, and the earliest of equally long ones', () => {
    const r = refMetrics({
      points: [
        { date: '2024-01-02', equity: 100 },
        { date: '2024-01-03', equity: 90 },
        { date: '2024-01-04', equity: 80 },
        { date: '2024-01-05', equity: 95 },
      ],
    });
    const l = value(r.longestDrawdown)!;
    expect(l.peak).toBe('2024-01-02');
    expect(l.trough).toBe('2024-01-04');
    expect(l.recovery).toBeUndefined();
    expect(l.recoveryDays).toBeUndefined();
    expect(l.days).toBe(3);
    close(l.depth, -0.2);
    // Two 1-day episodes: the first is reported; the trough is the first on a tie.
    const t = refMetrics({
      points: [
        { date: '2024-01-02', equity: 100 },
        { date: '2024-01-03', equity: 90 },
        { date: '2024-01-04', equity: 100 },
        { date: '2024-01-05', equity: 90 },
        { date: '2024-01-06', equity: 100 },
      ],
    });
    expect(value(t.longestDrawdown)!.peak).toBe('2024-01-02');
    const flat = refMetrics({
      points: [
        { date: '2024-01-02', equity: 100 },
        { date: '2024-01-03', equity: 90 },
        { date: '2024-01-04', equity: 90 },
        { date: '2024-01-05', equity: 100 },
      ],
    });
    expect(value(flat.longestDrawdown)!.trough).toBe('2024-01-03');
  });

  it('treats a dip within TIE of the peak as no episode, but maxDrawdown stays exact', () => {
    const r = refMetrics({
      points: [
        { date: '2024-01-02', equity: 100 },
        { date: '2024-01-03', equity: 100 * (1 - 1e-10) },
        { date: '2024-01-04', equity: 100 },
      ],
    });
    expect(value(r.longestDrawdown)).toBeNull();
    expect(value(r.averageDrawdown)).toBe(0);
    expect(value(r.maxDrawdown)).toBeLessThan(0);
    close(value(r.maxDrawdown), -1e-10, 1e-5);
  });
});

describe('reference metrics: CAGR and Calmar', () => {
  it('annualizes over 365.25-day years from one year on', () => {
    const r = refMetrics({
      points: [
        { date: '2020-01-01', equity: 100 },
        { date: '2020-06-01', equity: 80 },
        { date: '2021-01-01', equity: 110 },
      ],
    });
    const cagr = 1.1 ** (365.25 / 366) - 1;
    close(value(r.cagr), cagr);
    close(value(r.calmar), cagr / 0.2);
    const short = refMetrics({
      points: [
        { date: '2020-01-01', equity: 100 },
        { date: '2020-12-30', equity: 110 },
      ],
    });
    expect(reason(short.cagr)).toBe('tooShort'); // 364 days
  });

  it('gives noDrawdown without a drawdown, after cagr reasons', () => {
    const r = refMetrics({
      points: [
        { date: '2020-01-01', equity: 100 },
        { date: '2021-01-01', equity: 110 },
      ],
    });
    expect(reason(r.calmar)).toBe('noDrawdown');
  });
});

describe('reference metrics: return statistics', () => {
  const points = fromReturns(alternating);
  const sdAlt = Math.sqrt((20 * 0.015 ** 2) / 19); // deviations from the mean 0.005 are +-0.015

  it('volatility, Sharpe, Sortino and downside deviation by hand', () => {
    const res = refMetrics({ points, cashReturn: () => c });
    close(value(res.volatility), sdAlt * Math.sqrt(252), 1e-10);
    // x alternates 0.0199 and -0.0101: mean 0.0049, same spread.
    close(value(res.sharpe), (0.0049 / sdAlt) * Math.sqrt(252), 1e-10);
    // Only the ten -0.0101 days count, divided by all 20: 0.0101 / sqrt(2).
    const dd = 0.0101 / Math.SQRT2;
    close(value(res.sortino), (0.0049 / dd) * Math.sqrt(252), 1e-10);
    close(value(res.downsideDeviation), dd * Math.sqrt(252), 1e-10);
    const zero = refMetrics({ points, downsideTarget: 'zero' });
    close(value(zero.downsideDeviation), (0.01 / Math.SQRT2) * Math.sqrt(252), 1e-10);
  });

  it('needs MIN_RETURNS returns first, then every cash return', () => {
    const short = refMetrics({ points: points.slice(0, 20) }); // 19 returns, no cash
    for (const m of [short.volatility, short.sharpe, short.sortino, short.downsideDeviation]) {
      expect(reason(m)).toBe('tooShort');
    }
    const noCash = refMetrics({ points });
    expect(reason(noCash.sharpe)).toBe('cashRateMissing');
    expect(reason(noCash.sortino)).toBe('cashRateMissing');
    expect(reason(noCash.downsideDeviation)).toBe('cashRateMissing');
    expect(reason(noCash.volatility)).toBe('value');
    const gap = points[7]!.date;
    for (const bad of [undefined, NaN, Infinity]) {
      const r = refMetrics({ points, cashReturn: (d) => (d === gap ? bad : c) });
      expect(reason(r.sharpe)).toBe('cashRateMissing');
      expect(reason(r.downsideDeviation)).toBe('cashRateMissing');
      expect(reason(refMetrics({ points, downsideTarget: 'zero' }).downsideDeviation)).toBe(
        'value',
      );
    }
    // The first point's date is never asked for (r_1 is on t_1).
    const r = refMetrics({ points, cashReturn: (d) => (d === points[0]!.date ? undefined : c) });
    expect(reason(r.sharpe)).toBe('value');
  });

  it('gives noDispersion for a cash-only curve', () => {
    const cashOnly = fromReturns(Array.from({ length: 30 }, () => c));
    const r = refMetrics({ points: cashOnly, cashReturn: () => c });
    expect(reason(r.sharpe)).toBe('noDispersion');
    expect(reason(r.sortino)).toBe('noDispersion');
    expect(reason(r.volatility)).toBe('value');
  });

  it('VaR and CVaR from the ceil(m / 20)-th worst day', () => {
    const r20 = refMetrics({ points });
    close(value(r20.var95), -0.01, 1e-10); // k = 1
    close(value(r20.cvar95), -0.01, 1e-10);
    // 21 returns: k = 2; worst two are -0.05 and -0.03.
    const returns = [-0.05, -0.03, ...Array.from({ length: 19 }, (_, i) => 0.001 * (i + 1))];
    const r21 = refMetrics({ points: fromReturns(returns) });
    close(value(r21.var95), -0.03, 1e-10);
    close(value(r21.cvar95), -0.04, 1e-10);
    // 40 returns: k = 2 (exact multiple of 20).
    const r40 = refMetrics({ points: fromReturns([...returns, ...returns.slice(2, 21)]) });
    close(value(r40.var95), -0.03, 1e-10);
  });
});

describe('reference metrics: beta and correlation', () => {
  const b = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? 0.01 : -0.004 * (i % 5)));
  const bench = fromReturns(b);

  it('beta 2 and correlation 1 for twice the benchmark; -1 for the inverse', () => {
    const r = refMetrics({
      points: fromReturns(b.map((x) => 2 * x)),
      benchmarks: { A: bench, B: bench },
    });
    close(value(r.beta.A!), 2, 1e-10);
    close(value(r.correlation.B!), 1, 1e-10);
    expect(value(r.correlation.A!)).toBeLessThanOrEqual(1);
    const inv = refMetrics({ points: fromReturns(b.map((x) => -x)), benchmarks: { A: bench } });
    close(value(inv.beta.A!), -1, 1e-10);
    close(value(inv.correlation.A!), -1, 1e-10);
  });

  it('aligns by the dates both series have', () => {
    // Strategy: 41 points; at even indexes twice the benchmark's returns, odd ones junk.
    // Benchmark: only the even dates, plus dates the strategy does not have.
    const dates = dayList('2024-01-01', 41);
    const pts: RefMetricsPoint[] = [];
    const bp: { date: string; equity: number }[] = [];
    let s = 100;
    let be = 100;
    for (let i = 0; i < 41; i++) {
      if (i % 2 === 0) {
        if (i > 0) {
          s *= 1 + 2 * b[i / 2 - 1]!;
          be *= 1 + b[i / 2 - 1]!;
        }
        pts.push({ date: dates[i]!, equity: s });
        bp.push({ date: dates[i]!, equity: be });
      } else {
        pts.push({ date: dates[i]!, equity: 1e6 * (i % 4 === 1 ? 1 : 3) });
      }
    }
    bp.push({ date: '2024-03-01', equity: 1 }, { date: '2024-03-02', equity: 1e9 });
    const r = refMetrics({ points: pts, benchmarks: { A: bp } });
    close(value(r.beta.A!), 2, 1e-10);
    // One aligned date less: 19 aligned returns.
    const r19 = refMetrics({ points: pts, benchmarks: { A: bp.slice(1) } });
    expect(reason(r19.beta.A!)).toBe('tooShort');
  });

  it('reasons: a wiped-out benchmark only for itself, then length, then spreads', () => {
    const wiped = bench.map((p, i) => (i === 3 ? { ...p, equity: 0 } : p));
    const flat = bench.map((p) => ({ ...p, equity: 5 }));
    const r = refMetrics({
      points: fromReturns(b),
      benchmarks: { W: wiped, F: flat, S: bench.slice(0, 20), OK: bench },
    });
    expect(reason(r.beta.W!)).toBe('equityNotPositive');
    expect(reason(r.correlation.W!)).toBe('equityNotPositive');
    expect(reason(r.beta.F!)).toBe('noDispersion');
    expect(reason(r.correlation.F!)).toBe('noDispersion');
    expect(reason(r.beta.S!)).toBe('tooShort');
    close(value(r.beta.OK!), 1, 1e-10);
    // A flat strategy: beta 0 (no co-movement), correlation has no spread to divide by.
    const still = refMetrics({
      points: bench.map((p) => ({ ...p, equity: 7 })),
      benchmarks: { A: bench },
    });
    expect(value(still.beta.A!)).toBe(0);
    expect(reason(still.correlation.A!)).toBe('noDispersion');
  });
});

describe('reference metrics: calendar periods', () => {
  it('best and worst complete years', () => {
    const r = refMetrics({
      points: [
        { date: '2019-12-31', equity: 100 },
        { date: '2020-06-30', equity: 110 },
        { date: '2020-12-31', equity: 121 },
        { date: '2021-12-31', equity: 108.9 },
        { date: '2022-01-03', equity: 120 },
      ],
    });
    const best = value(r.bestYear);
    expect(best.year).toBe('2020');
    expect(best.years).toBe(2);
    close(best.return, 0.21);
    const worst = value(r.worstYear);
    expect(worst.year).toBe('2021');
    close(worst.return, -0.1);
  });

  it('a year after a year without points is not complete; ties take the earliest', () => {
    const gap = refMetrics({
      points: [
        { date: '2019-12-31', equity: 100 },
        { date: '2021-12-31', equity: 110 },
        { date: '2022-01-03', equity: 120 },
      ],
    });
    expect(reason(gap.bestYear)).toBe('tooShort');
    const tie = refMetrics({
      points: [
        { date: '2019-12-31', equity: 100 },
        { date: '2020-12-31', equity: 100 },
        { date: '2021-12-31', equity: 100 },
        { date: '2022-01-03', equity: 100 },
      ],
    });
    expect(value(tie.bestYear).year).toBe('2020');
    expect(value(tie.worstYear).year).toBe('2020');
  });

  it('positive months: complete months only, 0 is not positive, December to January', () => {
    const r = refMetrics({
      points: [
        { date: '2023-12-29', equity: 100 },
        { date: '2024-01-31', equity: 100 },
        { date: '2024-02-15', equity: 105 },
        { date: '2024-02-29', equity: 100 },
        { date: '2024-03-29', equity: 100 },
        { date: '2024-04-30', equity: 110 },
        { date: '2024-05-01', equity: 99 },
      ],
    });
    // Jan 0, Feb 0, Mar 0, Apr +10%; Dec and May are partial.
    expect(value(r.positiveMonths)).toEqual({ share: 1 / 4, positive: 1, months: 4 });
    const one = refMetrics({
      points: [
        { date: '2024-01-31', equity: 100 },
        { date: '2024-02-01', equity: 100 },
      ],
    });
    expect(reason(one.positiveMonths)).toBe('tooShort');
  });
});

describe('reference metrics: rolling 5-year windows', () => {
  const points: RefMetricsPoint[] = [
    { date: '2015-02-27', equity: 100 },
    { date: '2015-03-02', equity: 999 },
    { date: '2020-02-27', equity: 1 },
    { date: '2020-02-28', equity: 150 },
    { date: '2020-02-29', equity: 160 },
    { date: '2020-03-02', equity: 1498.5 },
  ];
  // 2020-02-27 -> D 2015-02-27 (s = 2015-02-27, 1826 days); 2020-02-28 -> s = 2015-02-27 (1827);
  // 2020-02-29 -> D 2015-02-28 -> s = 2015-02-27 (1828); 2020-03-02 -> s = 2015-03-02 (1827).
  const w = [
    0.01 ** (365.25 / 1826) - 1,
    1.5 ** (365.25 / 1827) - 1,
    1.6 ** (365.25 / 1828) - 1,
    1.5 ** (365.25 / 1827) - 1,
  ];

  it('one window per point with a point five calendar years before', () => {
    const r = value(refMetrics({ points, rollingTarget: w[2]! }).rolling5y);
    expect(r.windows).toBe(4);
    close(r.min, w[0]!);
    close(r.max, w[2]!);
    close(r.median, w[1]!); // mean of the two middle values, both 1.5^(365.25/1827) - 1
    expect(r.meeting).toBe(1); // >= the target, met exactly
    expect(r.share).toBe(0.25);
    const none = value(refMetrics({ points }).rolling5y);
    expect(none.meeting).toBeUndefined();
    expect(none.share).toBeUndefined();
    expect(reason(refMetrics({ points: points.slice(0, 2) }).rolling5y)).toBe('tooShort');
  });
});

describe('reference metrics: holdings', () => {
  it('switches per year: the first trade is the entry', () => {
    const pts: RefMetricsPoint[] = [
      { date: '2020-01-01', equity: 1, traded: true },
      { date: '2021-01-01', equity: 1, traded: true },
      { date: '2021-06-01', equity: 1, traded: false },
      { date: '2022-01-01', equity: 1, traded: true },
    ];
    close(value(refMetrics({ points: pts }).switchesPerYear), 2 / (731 / 365.25));
    const none = pts.map((p) => ({ ...p, traded: false }));
    expect(value(refMetrics({ points: none }).switchesPerYear)).toBe(0);
    const missing = pts.map((p, i) => (i === 2 ? { date: p.date, equity: 1 } : p));
    expect(reason(refMetrics({ points: missing }).switchesPerYear)).toBe('holdingsMissing');
    // holdingsMissing comes before the span.
    expect(reason(refMetrics({ points: missing.slice(1, 3) }).switchesPerYear)).toBe(
      'holdingsMissing',
    );
    expect(reason(refMetrics({ points: pts.slice(1, 3) }).switchesPerYear)).toBe('tooShort');
  });

  it('average exposure: net weight x L over points 0 .. n-2', () => {
    const r = refMetrics({
      points: [
        { date: '2024-01-02', equity: 1, weights: { SPY: 0.5, 'SPY?L=3&E=0.9': 0.5 } },
        { date: '2024-01-03', equity: 1, weights: { CASH_USD: 1 } },
        { date: '2024-01-04', equity: 1, weights: { 'SH?E=0.9&L=-1': 1 } },
        { date: '2024-01-05', equity: 1, weights: {} },
        { date: '2024-01-08', equity: 1 }, // the last point's weights are not needed
      ],
    });
    close(value(r.averageExposure), (2 + 0 - 1 + 0) / 4);
    const missing = refMetrics({
      points: [
        { date: '2024-01-02', equity: 1 },
        { date: '2024-01-03', equity: 1, weights: {} },
      ],
    });
    expect(reason(missing.averageExposure)).toBe('holdingsMissing');
    for (const ticker of ['X?L=abc', 'X?L=', 'X?L=2&L=3']) {
      const bad = refMetrics({
        points: [
          { date: '2024-01-02', equity: 1, weights: { [ticker]: 1 } },
          { date: '2024-01-03', equity: 1 },
        ],
      });
      expect(reason(bad.averageExposure)).toBe('holdingsMissing');
    }
  });
});

describe('reference metrics: cost drag', () => {
  const points = [
    { date: '2020-01-01', equity: 100 },
    { date: '2021-01-01', equity: 110 },
  ];
  it('the gross CAGR minus the net CAGR', () => {
    const gross = [
      { date: '2020-01-01', equity: 100 },
      { date: '2021-01-01', equity: 112 },
    ];
    close(
      value(refMetrics({ points, gross }).costDrag),
      1.12 ** (365.25 / 366) - 1.1 ** (365.25 / 366),
    );
  });
  it('reasons: grossMissing, then the gross run, then the span', () => {
    expect(reason(refMetrics({ points }).costDrag)).toBe('grossMissing');
    const wiped = [points[0]!, { ...points[1]!, equity: 0 }];
    expect(reason(refMetrics({ points, gross: wiped }).costDrag)).toBe('equityNotPositive');
    const short = [
      { date: '2020-01-01', equity: 100 },
      { date: '2020-06-01', equity: 110 },
    ];
    expect(reason(refMetrics({ points: short, gross: short }).costDrag)).toBe('tooShort');
  });
});
