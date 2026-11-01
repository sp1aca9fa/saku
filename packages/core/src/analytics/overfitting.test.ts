// Overfitting statistics (docs/analytics.md "Statistics"). The deflated Sharpe ratio is checked
// against the worked example of Bailey and Lopez de Prado (2014); the other values are worked out
// by hand in the comments.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EquitySample } from './metrics';
import {
  alignTrials,
  backtestOverfitting,
  dailySharpe,
  deflatedSharpe,
  deflatedSharpeFromMoments,
  effectiveTrials,
  expectedMaxSharpe,
  moments,
  overfitting,
} from './overfitting';
import { createRng } from './random';
import type { Statistic } from './statistic';

const v = <T>(s: Statistic<T>): T => {
  if (!s.ok) throw new Error(`no value: ${s.reason}`);
  return s.value;
};
const reason = (s: { ok: boolean; reason?: string }) => (s.ok ? 'value' : s.reason);

const DAY = 86_400_000;
const dates = (count: number, start = '2024-01-01') =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10),
  );
const curve = (returns: readonly number[], start = '2024-01-01'): EquitySample[] => {
  let e = 1;
  return dates(returns.length + 1, start).map((date, i) => {
    if (i > 0) e *= 1 + returns[i - 1]!;
    return { date, equity: e };
  });
};
/** `rows` returns alternating mean + s, mean - s. */
const block = (mean: number, rows: number, s = 0.01) =>
  Array.from({ length: rows }, (_, i) => (i % 2 === 0 ? mean + s : mean - s));
/** Normal draws (Box-Muller) from the seeded generator. */
const normals = (seed: number, count: number, mean: number, sd: number) => {
  const r = createRng(seed);
  return Array.from({ length: count }, () => {
    const u = 1 - r.float();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r.float());
  });
};

describe('trials', () => {
  it('aligns on the common dates and subtracts the cash return', () => {
    const a = curve(Array.from({ length: 25 }, (_, i) => 0.01 * ((i % 3) - 1)));
    const b = curve(
      Array.from({ length: 22 }, (_, i) => 0.02 * ((i % 2) - 0.5)),
      '2024-01-04',
    );
    const t = v(alignTrials({ trials: [a, b], cashReturn: () => 0.001 }));
    // Common dates: 2024-01-04 .. 2024-01-26 (23 dates), so 22 returns ending 2024-01-05 .. 26.
    expect(t.dates).toHaveLength(22);
    expect(t.dates[0]).toBe('2024-01-05');
    // a's return on 2024-01-05 is its 4th: 0.01 x ((3 % 3) - 1) = -0.01; less cash 0.001.
    expect(t.excess[0]![0]).toBeCloseTo(-0.011, 15);
    expect(t.excess[1]![0]).toBeCloseTo(-0.01 - 0.001, 15);
  });

  it('no value when a trial has a date between two common dates', () => {
    const a = curve(block(0.001, 30));
    // b lacks 2024-01-10, so a's 2024-01-10 falls between the common dates 01-09 and 01-11.
    const b = a.filter((p) => p.date !== '2024-01-10');
    expect(reason(alignTrials({ trials: [a, b], cashReturn: () => 0 }))).toBe('datesDiffer');
    // Dates before the first or after the last common date are only cut.
    const later = a.slice(3);
    expect(reason(alignTrials({ trials: [a, later], cashReturn: () => 0 }))).toBe('value');
    // Before the length check: a wiped-out trial is still reported first.
    const wiped = curve([...block(0.001, 29), -1]);
    expect(reason(alignTrials({ trials: [wiped, b], cashReturn: () => 0 }))).toBe(
      'equityNotPositive',
    );
  });

  it('gives no value with a reason, in the stated order', () => {
    const ok = curve(block(0.001, 30));
    const cash = () => 0;
    expect(reason(alignTrials({ trials: [], cashReturn: cash }))).toBe('tooFewTrials');
    const wiped = curve([...block(0.001, 29), -1]);
    expect(reason(alignTrials({ trials: [ok, wiped], cashReturn: cash }))).toBe(
      'equityNotPositive',
    );
    expect(reason(alignTrials({ trials: [curve(block(0.001, 19))], cashReturn: cash }))).toBe(
      'tooShort',
    );
    expect(reason(alignTrials({ trials: [ok], cashReturn: () => undefined }))).toBe(
      'cashRateMissing',
    );
    expect(reason(alignTrials({ trials: [ok], cashReturn: () => NaN }))).toBe('cashRateMissing');
    const flat = curve(Array.from({ length: 30 }, () => 0));
    expect(reason(alignTrials({ trials: [ok, flat], cashReturn: cash }))).toBe('noDispersion');
    expect(() => alignTrials({ trials: [[ok[1]!, ok[0]!]], cashReturn: cash })).toThrow(
      'ascending',
    );
  });
});

describe('effective number of trials', () => {
  it('copies count once, uncorrelated trials each, negative correlation never more than M', () => {
    const x = [1, -1, 1, -1];
    const y = [1, 1, -1, -1]; // centered dot product with x: 1 - 1 - 1 + 1 = 0
    expect(v(effectiveTrials([x, x, x])).effective).toBeCloseTo(1, 15);
    expect(v(effectiveTrials([x, y])).effective).toBeCloseTo(2, 15);
    expect(v(effectiveTrials([x, x.map((a) => -a)]))).toMatchObject({
      effective: 2,
      averageCorrelation: 0,
    });
    // Pairs (x, x) = 1, (x, y) = 0, (x, y) = 0: rho = 1/3; N = 1/3 + 2/3 x 3 = 7/3.
    expect(v(effectiveTrials([x, x, y])).effective).toBeCloseTo(7 / 3, 14);
    expect(v(effectiveTrials([x]))).toEqual({
      effective: 1,
      trials: 1,
      averageCorrelation: undefined,
      returns: 4,
    });
    expect(reason(effectiveTrials([]))).toBe('tooFewTrials');
    // A trial without swings has no correlation: no value, not a guess.
    expect(reason(effectiveTrials([x, [0.01, 0.01, 0.01, 0.01]]))).toBe('noDispersion');
    expect(reason(effectiveTrials([[0.01], [0.02]]))).toBe('noDispersion');
    expect(() => effectiveTrials([x, [1, 2]])).toThrow('same number');
  });

  it('stays within [1, M]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 1000 }), (M, seed) => {
        const trials = Array.from({ length: M }, (_, j) => normals(seed * 10 + j, 30, 0, 0.01));
        const n = v(effectiveTrials(trials)).effective;
        return n >= 1 - 1e-12 && n <= M + 1e-12;
      }),
    );
  });
});

describe('deflated Sharpe ratio', () => {
  it("reproduces the paper's worked example", () => {
    // Bailey and Lopez de Prado (2014): yearly SR 2.5, T 1,250, N 100, yearly V 0.5, skew -3,
    // kurtosis 10, 250 days a year: SR0 = 0.1132 and DSR = 0.9004 (the values below are the
    // same formula in Python with statistics.NormalDist, unrounded).
    const d = v(
      deflatedSharpeFromMoments({
        sharpe: 2.5 / Math.sqrt(250),
        returns: 1250,
        skewness: -3,
        kurtosis: 10,
        trialSharpeVariance: 0.5 / 250,
        effectiveTrials: 100,
      }),
    );
    expect(d.expectedMaxSharpe).toBeCloseTo(0.1132, 4);
    expect(d.probability).toBeCloseTo(0.9004, 4);
    expect(d.expectedMaxSharpe).toBeCloseTo(0.11317200186513214, 13);
    expect(d.probability).toBeCloseTo(0.9003968344493904, 12);
  });

  it('expected maximum Sharpe: 0 for one trial, floored at 0 just above one', () => {
    expect(expectedMaxSharpe(1, 1)).toBe(0);
    // N = 1.1: 0.4228 x PhiInv(1 - 1/1.1) + 0.5772 x PhiInv(1 - 1/(1.1 e)) = 0.4228 x -1.335 +
    // 0.5772 x 0.348 < 0, so the floor applies.
    expect(expectedMaxSharpe(1, 1.1)).toBe(0);
    // N = 2: 0.5772 x PhiInv(1 - 1/(2e)) = 0.51976 (the true E[max of 2] is 1/sqrt(pi) = 0.564).
    expect(expectedMaxSharpe(1, 2)).toBeCloseTo(0.5197553442805939, 13);
    expect(expectedMaxSharpe(4, 2)).toBeCloseTo(2 * 0.5197553442805939, 13);
    expect(() => expectedMaxSharpe(1, 0.5)).toThrow('>= 1');
    expect(() => expectedMaxSharpe(-1, 2)).toThrow('>= 0');
  });

  it('one trial is the probabilistic Sharpe ratio against 0', () => {
    const d = v(
      deflatedSharpeFromMoments({
        sharpe: 0.1,
        returns: 101,
        skewness: 0,
        kurtosis: 3,
        trialSharpeVariance: 0,
        effectiveTrials: 1,
      }),
    );
    // z = 0.1 x sqrt(100) / sqrt(1 + 2/4 x 0.01) = 1 / sqrt(1.005) = 0.99751; Phi(z) = 0.84074.
    expect(d.probability).toBeCloseTo(0.84074, 5);
  });

  it('no value when the denominator vanishes or the sample is too short', () => {
    // SR 2, skew 1, kurtosis 2 (= skew^2 + 1): 1 - 2 + 1/4 x 4 = 0.
    const base = {
      sharpe: 2,
      returns: 100,
      skewness: 1,
      kurtosis: 2,
      trialSharpeVariance: 0,
      effectiveTrials: 1,
    };
    expect(reason(deflatedSharpeFromMoments(base))).toBe('noDispersion');
    expect(reason(deflatedSharpeFromMoments({ ...base, returns: 1, kurtosis: 3 }))).toBe(
      'tooShort',
    );
    expect(() => deflatedSharpeFromMoments({ ...base, sharpe: NaN })).toThrow('sharpe');
  });

  it('falls as the effective number of trials rises', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e4, noNaN: true }),
        fc.double({ min: 1, max: 1e4, noNaN: true }),
        fc.double({ min: -0.2, max: 0.3, noNaN: true }),
        (a, b, sharpe) => {
          const at = (n: number) =>
            v(
              deflatedSharpeFromMoments({
                sharpe,
                returns: 1000,
                skewness: -0.5,
                kurtosis: 6,
                trialSharpeVariance: 0.001,
                effectiveTrials: n,
              }),
            ).probability;
          const [lo, hi] = a < b ? [a, b] : [b, a];
          return at(lo) >= at(hi);
        },
      ),
    );
  });

  it('moments are population moments', () => {
    // mean 2.5; deviations -1.5, -0.5, 0.5, 1.5; m2 = 5/4, m3 = 0, m4 = 10.25/4 = 2.5625;
    // kurtosis = 2.5625 / 1.5625 = 1.64.
    const m = moments([1, 2, 3, 4]);
    expect(m.skewness).toBeCloseTo(0, 15);
    expect(m.kurtosis).toBeCloseTo(1.64, 14);
    // [0, 0, 0, 4]: mean 1, deviations -1, -1, -1, 3: m2 = 3, m3 = 24/4 = 6, m4 = 84/4 = 21.
    const s = moments([0, 0, 0, 4]);
    expect(s.skewness).toBeCloseTo(6 / 3 ** 1.5, 14);
    expect(s.kurtosis).toBeCloseTo(21 / 9, 14);
  });

  it("of a selected trial: its moments, the trials' Sharpe variance and their effective number", () => {
    const trials = [0, 1, 2].map((j) => normals(100 + j, 300, 0.0005 * j, 0.01));
    const d = v(deflatedSharpe(trials, 2));
    const sharpes = trials.map(dailySharpe);
    const mean = sharpes.reduce((s, x) => s + x, 0) / 3;
    const V = sharpes.reduce((s, x) => s + (x - mean) ** 2, 0) / 2;
    const want = v(
      deflatedSharpeFromMoments({
        sharpe: sharpes[2]!,
        returns: 300,
        ...moments(trials[2]!),
        trialSharpeVariance: V,
        effectiveTrials: v(effectiveTrials(trials)).effective,
      }),
    );
    expect(d).toEqual(want);
    expect(reason(deflatedSharpe([trials[0]!.slice(0, 19)], 0))).toBe('tooShort');
    expect(() => deflatedSharpe(trials, 3)).toThrow('no trial 3');
  });
});

describe('probability of backtest overfitting', () => {
  // S = 2: blocks of 20 rows (T = 40); IS = one block, OOS = the other.
  it('the in-sample best is the out-of-sample worst in every split: PBO 1', () => {
    const a = [...block(0.002, 20), ...block(-0.001, 20)];
    const b = [...block(-0.001, 20), ...block(0.002, 20)];
    // Split {0}: a is best in block 0, worst in block 1 (rank 1 of 2, w = 1/3, logit < 0).
    // Split {1}: b likewise.
    expect(v(backtestOverfitting([a, b], 2))).toEqual({
      pbo: 1,
      combinations: 2,
      trials: 2,
      partitions: 2,
      rowsUsed: 40,
      rowsDropped: 0,
    });
  });

  it('the best stays best: PBO 0', () => {
    const a = [...block(0.002, 20), ...block(0.002, 20)];
    const b = [...block(0.001, 20), ...block(0.001, 20)];
    expect(v(backtestOverfitting([a, b], 2)).pbo).toBe(0);
  });

  it('a logit of exactly 0 (the median) counts as overfit', () => {
    // Split {0}: a best (0.003); OOS block 1: a 0.002, b 0.003, c 0.001: rank 2 of 3, w = 0.5.
    // Split {1}: b best (0.003); OOS block 0: b 0.001 is the worst.
    const a = [...block(0.003, 20), ...block(0.002, 20)];
    const b = [...block(0.001, 20), ...block(0.003, 20)];
    const c = [...block(0.002, 20), ...block(0.001, 20)];
    expect(v(backtestOverfitting([a, b, c], 2)).pbo).toBe(1);
  });

  it('ties take the first trial and the mid-rank', () => {
    // a and its near copy b tie in and out of sample, c is lower: the first (a) is chosen; OOS
    // less = 1, tied = 2, r = 1 + 3/2 = 2.5, w = 2.5 / 4 > 0.5, so not overfit in either split.
    const a = [...block(0.002, 20), ...block(0.002, 20, 0.02)];
    const b = a.map((x) => x * (1 + 1e-13));
    const c = [...block(0.0005, 20), ...block(0.0005, 20)];
    expect(v(backtestOverfitting([a, b, c], 2)).pbo).toBe(0);
    // With rank = less + 1 instead of the mid-rank, w would be 2 / 4 and both splits overfit.
  });

  it('drops the oldest leftover rows', () => {
    // T = 43, S = 2: b = 21, the first row dropped; with it the best would differ in block 0.
    const a = [-0.5, ...block(0.002, 21), ...block(0.002, 21)];
    const b = [0.5, ...block(0.001, 21), ...block(0.001, 21)];
    expect(v(backtestOverfitting([a, b], 2))).toMatchObject({
      pbo: 0,
      rowsUsed: 42,
      rowsDropped: 1,
    });
  });

  it('no value without enough trials, rows or dispersion; refuses bad partitions', () => {
    const a = block(0.002, 40);
    expect(reason(backtestOverfitting([a], 2))).toBe('tooFewTrials');
    expect(reason(backtestOverfitting([a.slice(0, 39), a.slice(0, 39)], 2))).toBe('tooShort');
    // 16 partitions need 8 x b >= 20, b >= 3, T >= 48.
    expect(reason(backtestOverfitting([a, a], 16))).toBe('tooShort');
    const flatHalf = [...block(0.002, 20), ...Array.from({ length: 20 }, () => 0.001)];
    expect(reason(backtestOverfitting([a, flatHalf], 2))).toBe('noDispersion');
    expect(() => backtestOverfitting([a, a], 3)).toThrow('even');
    expect(() => backtestOverfitting([a, a], 0)).toThrow('even');
  });

  it('the dispersion floor scales with the returns: a constant return has no Sharpe', () => {
    // Constant c over a set of m rows: the variance is 0 up to rounding of the order of
    // 1e-16 x S2; the floor max(1e-24, 1e-14 x S2 / m) = max(1e-24, 1e-14 x c^2) catches it.
    const noise = (n: number) => normals(31, n, 0, 0.01);
    // S = 2: m = 400 rows per set (T = 800), c = 0.001.
    const c3 = Array.from({ length: 800 }, () => 0.001);
    expect(reason(backtestOverfitting([c3, noise(800)], 2))).toBe('noDispersion');
    // m = 24 rows per set (T = 48), c = 1e-4.
    const c4 = Array.from({ length: 48 }, () => 1e-4);
    expect(reason(backtestOverfitting([c4, noise(48)], 2))).toBe('noDispersion');
    // A small but real spread around the same level is kept: var 1e-12 >> 1e-14 x 1e-6.
    const small = c3.map((x, i) => x + (i % 2 === 0 ? 1e-6 : -1e-6));
    expect(reason(backtestOverfitting([small, noise(800)], 2))).toBe('value');
  });

  it('noise trials overfit about half the time; a real edge does not', () => {
    const noise = Array.from({ length: 20 }, (_, j) => normals(500 + j, 800, 0, 0.01));
    const pure = v(backtestOverfitting(noise));
    expect(pure.combinations).toBe(12_870);
    expect(pure.pbo).toBeGreaterThan(0.2);
    expect(pure.pbo).toBeLessThan(0.8);
    const edge = [normals(499, 800, 0.003, 0.01), ...noise];
    expect(v(backtestOverfitting(edge)).pbo).toBeLessThan(0.05);
  });

  it('is a share in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 40, max: 70 }),
        fc.constantFrom(2, 4),
        fc.integer({ min: 0, max: 10_000 }),
        (M, T, S, seed) => {
          const trials = Array.from({ length: M }, (_, j) => normals(seed * 7 + j, T, 0, 0.01));
          const r = backtestOverfitting(trials, S);
          return !r.ok || (r.value.pbo >= 0 && r.value.pbo <= 1);
        },
      ),
    );
  });
});

describe('overfitting', () => {
  it('gives the three statistics of a selected trial from equity curves', () => {
    const returns = [0, 1, 2].map((j) => normals(700 + j, 60, 0.0005 * j, 0.01));
    const trials = returns.map((r) => curve(r));
    const o = overfitting({ trials, cashReturn: () => 0, selected: 2, partitions: 2 });
    const excess = v(alignTrials({ trials, cashReturn: () => 0 })).excess;
    expect(o.effectiveTrials).toEqual(effectiveTrials(excess));
    expect(o.deflatedSharpe).toEqual(deflatedSharpe(excess, 2));
    expect(o.overfittingProbability).toEqual(backtestOverfitting(excess, 2));
    const none = overfitting({ trials: [], cashReturn: () => 0, selected: 0 });
    expect(reason(none.deflatedSharpe)).toBe('tooFewTrials');
    const short = overfitting({ trials: [curve([0.01, 0.02])], cashReturn: () => 0, selected: 0 });
    expect(reason(short.overfittingProbability)).toBe('tooShort');
    expect(() => overfitting({ trials, cashReturn: () => 0, selected: 5 })).toThrow('no trial 5');
  });
});
