// Checks of the reference statistics (docs/analytics.md "Statistics"): every "Check values" line
// of the contract, the paper's worked example, and cases worked out by hand from the contract's
// formulas (never read from the code). High-precision Phi values were computed separately with
// 420-digit decimal arithmetic (the all-positive erf series), outside this repository.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RefBar } from './index';
import { refMetrics, type RefEquitySample } from './metrics';
import {
  RefRandom,
  refDeflatedSharpe,
  refDeflatedSharpeFromMoments,
  refAlignedExcessReturns,
  refEffectiveTrials,
  refEffectiveTrialsOfTrials,
  refExpectedMaxSharpe,
  refNearTie,
  refPbo,
  refPhi,
  refPhiInv,
  refSplitMix64,
  refStationaryBootstrap,
  type RefStatistic,
} from './statistics';
import {
  REF_WILSON_Z,
  type RefCrisisWindow,
  refCrisisReplays,
  refGoalProjection,
  refNeighbors,
  refSweep,
  refSweepVariants,
  refWalkForward,
  refWilson,
} from './statistics-lab';

const value = <T>(s: RefStatistic<T>): T => {
  if (!s.ok) throw new Error(`expected a value, got ${s.reason}`);
  return s.value;
};
const reason = <T>(s: RefStatistic<T>) => (s.ok ? 'value' : s.reason);
const close = (a: number, b: number, rel = 1e-12) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(Math.abs(b), 1e-300));

/** `count` consecutive calendar days from `start`. */
const dayList = (start: string, count: number): string[] => {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
  );
};

/** Equity from returns: e_0 = 100, e_i = e_(i-1) (1 + r_i). */
const equity = (returns: number[], start = '2024-01-01'): RefEquitySample[] => {
  const dates = dayList(start, returns.length + 1);
  const out: RefEquitySample[] = [{ date: dates[0]!, equity: 100 }];
  returns.forEach((r, i) => out.push({ date: dates[i + 1]!, equity: out[i]!.equity * (1 + r) }));
  return out;
};

const zeroCash = () => 0;
/** +1, -1, +1, ... and +1, +1, -1, -1, ...: mean 0 over 20 rows, orthogonal. */
const p2 = (i: number) => (i % 2 === 0 ? 1 : -1);
const p4 = (i: number) => (i % 4 < 2 ? 1 : -1);
const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

describe('reference random numbers: the contract check values', () => {
  it('SplitMix64 from x = 0', () => {
    expect(refSplitMix64(0n, 3)).toEqual([
      0xe220a8397b1dcdafn,
      0x6e789e6aa1b965f4n,
      0x06c45d188009454fn,
    ]);
  });
  it('xoshiro128** from the state (1, 2, 3, 4)', () => {
    const r = RefRandom.fromState(1, 2, 3, 4);
    expect(series(5, () => r.next())).toEqual([11520, 0, 5927040, 70819200, 2031721883]);
  });
  it('seeded from (42, 0) and (42, 7)', () => {
    const a = new RefRandom(42);
    expect(series(4, () => a.next())).toEqual([561131802, 1455960195, 1624807067, 676739556]);
    const b = new RefRandom(42, 7);
    expect(series(4, () => b.next())).toEqual([3218433758, 3595279162, 1425948380, 2234227796]);
  });
  it('the first float and the first ten integers in [0, 10) from seed 42', () => {
    expect(new RefRandom(42).float()).toBe(0.13064867510640732);
    const r = new RefRandom(42);
    expect(series(10, () => r.int(10))).toEqual([2, 5, 7, 6, 8, 3, 5, 4, 2, 6]);
  });
  it('a float is ((a >>> 5) 2^26 + (b >>> 6)) / 2^53 of two outputs', () => {
    const a = new RefRandom(9, 3);
    const b = new RefRandom(9, 3);
    const x = b.next();
    const y = b.next();
    expect(a.float()).toBe(((x >>> 5) * 2 ** 26 + (y >>> 6)) / 2 ** 53);
  });
  it('int(n) rejects outputs at or above 2^32 - (2^32 mod n), and int(2^32) is the output', () => {
    // n = 3 * 2^30: limit = 2^32 - 2^30; outputs at or above it are drawn again.
    const n = 3 * 2 ** 30;
    const a = new RefRandom(5);
    const b = new RefRandom(5);
    let x = b.next();
    while (x >= 2 ** 32 - 2 ** 30) x = b.next();
    expect(a.int(n)).toBe(x % n);
    expect(new RefRandom(42).int(2 ** 32)).toBe(561131802);
    expect(new RefRandom(42).int(1)).toBe(0);
  });
  it('refuses a seed, stream or n out of range', () => {
    expect(() => new RefRandom(-1)).toThrow();
    expect(() => new RefRandom(2 ** 32)).toThrow();
    expect(() => new RefRandom(1.5)).toThrow();
    expect(() => new RefRandom(1, 2 ** 32)).toThrow();
    expect(() => new RefRandom(1).int(0)).toThrow();
    expect(() => new RefRandom(1).int(2 ** 32 + 1)).toThrow();
  });
});

describe('reference normal distribution', () => {
  it('the contract check values', () => {
    // High-precision true values 0.158655253931457051, 0.617911422188952637,
    // -2.326347874040841101, 1.959963984540054236 (as nearest doubles), met within 1e-15 relative.
    close(refPhi(-1), 0.15865525393145705, 1e-15);
    close(refPhi(0.3), 0.6179114221889527, 1e-15);
    close(refPhiInv(0.01), -2.326347874040841, 1e-15);
    close(refPhiInv(0.975), 1.9599639845400543, 1e-15);
    expect(refPhi(-Infinity)).toBe(0);
    expect(refPhi(Infinity)).toBe(1);
  });
  it('1e-13 relative for |z| <= 8 and 1e-11 to |z| = 37 (420-digit values)', () => {
    const exact: [number, number][] = [
      [-1.9999, 0.022755531584767185],
      [-2.0001, 0.022744733391410546],
      [-3, 0.0013498980316300946],
      [-6, 9.86587645037698e-10],
      [-8, 6.220960574271784e-16],
      [1.5, 0.9331927987311419],
      [2, 0.9772498680518208],
      [5, 0.9999997133484281],
    ];
    for (const [z, p] of exact) close(refPhi(z), p, 1e-13);
    const far: [number, number][] = [
      [-12, 1.776482112077679e-33],
      [-20, 2.7536241186062337e-89],
      [-30, 4.906713927148187e-198],
      [-37, 5.725571222524577e-300],
    ];
    for (const [z, p] of far) close(refPhi(z), p, 1e-11);
  });
  it('PhiInv inverts Phi in both tails, the upper from q = 1 - p', () => {
    // The upper tail only near the center: Phi(8) rounds to within an ulp of 1, so 8 is lost.
    for (const z of [-37, -20, -8, -3, -1.2, -0.4, 0.4, 1.2, 2]) {
      close(refPhiInv(refPhi(z)), z, 1e-11);
    }
    expect(refPhiInv(0.5)).toBe(0);
    expect(refPhiInv(0.975)).toBe(-refPhiInv(1 - 0.975)); // q = 1 - 0.975, not 0.025
    close(refPhi(refPhiInv(1e-300)), 1e-300, 1e-11);
    expect(refPhiInv(0)).toBe(-Infinity);
    expect(refPhiInv(1)).toBe(Infinity);
    expect(() => refPhiInv(1.5)).toThrow();
    expect(() => refPhiInv(Number.NaN)).toThrow();
  });
});

describe('reference stationary block bootstrap', () => {
  it('draws one integer on day 0, then a float and (on a new block) an integer', () => {
    const got = refStationaryBootstrap(new RefRandom(11), 7, 30, 3);
    const r = new RefRandom(11);
    let i = r.int(7);
    const want = [i];
    for (let d = 1; d < 30; d++) {
      i = r.float() < 1 / 3 ? r.int(7) : (i + 1) % 7;
      want.push(i);
    }
    expect(got).toEqual(want);
  });
  it('meanBlock 1 draws single days; a long block wraps after the last day', () => {
    const one = refStationaryBootstrap(new RefRandom(3), 5, 6, 1);
    const r = new RefRandom(3);
    const want = [r.int(5)];
    for (let d = 1; d < 6; d++) {
      r.float();
      want.push(r.int(5));
    }
    expect(one).toEqual(want);
    // meanBlock 2^60: 1 / meanBlock is below every float but 0, so blocks continue (circular).
    const long = refStationaryBootstrap(new RefRandom(42), 10, 6, 2 ** 60);
    expect(long).toEqual([2, 3, 4, 5, 6, 7]); // int(10) from seed 42 is 2
    const wrap = refStationaryBootstrap(new RefRandom(42), 3, 5, 2 ** 60);
    expect(wrap).toEqual([0, 1, 2, 0, 1]); // int(3) from seed 42: 561131802 mod 3 = 0
  });
  it('L = 0 draws nothing; refuses a bad n, L or meanBlock', () => {
    expect(refStationaryBootstrap(new RefRandom(1), 4, 0)).toEqual([]);
    expect(() => refStationaryBootstrap(new RefRandom(1), 0, 3)).toThrow();
    expect(() => refStationaryBootstrap(new RefRandom(1), 3, 3, 0.5)).toThrow();
  });
});

// Trials: x = 0.001 + 0.01 x pattern, cash 0.
const trial = (f: (i: number) => number, n = 20) => equity(series(n, (i) => 0.001 + 0.01 * f(i)));

describe('reference trials: no-value reasons in order', () => {
  const good = trial(p2);
  it('no trial, a wiped-out trial, too few returns, an unknown cash return, no swings', () => {
    expect(reason(refEffectiveTrialsOfTrials({ trials: [], cashReturn: zeroCash }))).toBe(
      'tooFewTrials',
    );
    const wiped = good.map((p, i) => (i === 3 ? { ...p, equity: 0 } : p));
    expect(
      reason(refEffectiveTrialsOfTrials({ trials: [good, wiped], cashReturn: zeroCash })),
    ).toBe('equityNotPositive');
    expect(
      reason(refEffectiveTrialsOfTrials({ trials: [good, trial(p2, 19)], cashReturn: zeroCash })),
    ).toBe('tooShort');
    expect(reason(refEffectiveTrialsOfTrials({ trials: [good] }))).toBe('cashRateMissing');
    // Unknown only on a_0 is not needed.
    const notFirst = (d: string) => (d === good[0]!.date ? undefined : 0);
    expect(reason(refEffectiveTrialsOfTrials({ trials: [good], cashReturn: notFirst }))).toBe(
      'value',
    );
    const flat = equity(series(20, () => 0.001));
    expect(reason(refEffectiveTrialsOfTrials({ trials: [good, flat], cashReturn: zeroCash }))).toBe(
      'noDispersion',
    );
    // Order: tooShort before cashRateMissing.
    expect(reason(refEffectiveTrialsOfTrials({ trials: [trial(p2, 19)] }))).toBe('tooShort');
  });
  it('datesDiffer: a date strictly between consecutive common dates; checked after equity', () => {
    const gap = good.filter((_, i) => i !== 5); // the other trial has a date in its gap
    expect(reason(refEffectiveTrialsOfTrials({ trials: [good, gap], cashReturn: zeroCash }))).toBe(
      'datesDiffer',
    );
    const wiped = gap.map((p, i) => (i === 2 ? { ...p, equity: -1 } : p));
    expect(
      reason(refEffectiveTrialsOfTrials({ trials: [good, wiped], cashReturn: zeroCash })),
    ).toBe('equityNotPositive');
    // datesDiffer before tooShort and cashRateMissing.
    expect(
      reason(refEffectiveTrialsOfTrials({ trials: [good.slice(0, 10), gap.slice(0, 9)] })),
    ).toBe('datesDiffer');
    // Dates before the first or after the last common date are only cut.
    const longer = trial(p2, 40);
    const middle = longer.slice(5, 30);
    const rows = value(refAlignedExcessReturns({ trials: [longer, middle], cashReturn: zeroCash }));
    expect([rows.T, rows.dates[0], rows.dates[24]]).toEqual([
      24,
      middle[0]!.date,
      middle[24]!.date,
    ]);
  });
  it('uses only the dates every trial has', () => {
    const longer = trial(p2, 40); // 2024-01-01 .. 2024-02-10
    const later = longer.slice(15); // 26 dates, 25 returns in common
    const n = value(refEffectiveTrialsOfTrials({ trials: [longer, later], cashReturn: zeroCash }));
    expect(n.returns).toBe(25);
  });
  it('refuses unreal or unordered dates and non-finite equity', () => {
    const bad = [{ date: '2024-02-30', equity: 1 }];
    expect(() => refEffectiveTrialsOfTrials({ trials: [bad] })).toThrow();
    const order = [good[1]!, good[0]!];
    expect(() => refEffectiveTrialsOfTrials({ trials: [order] })).toThrow();
    expect(() =>
      refEffectiveTrialsOfTrials({ trials: [[{ date: '2024-01-01', equity: NaN }]] }),
    ).toThrow();
  });
});

describe('reference effective number of trials', () => {
  it('a returns matrix: tooFewTrials, noDispersion (flat or under 2 returns), throws on bad rows', () => {
    expect(reason(refEffectiveTrials([]))).toBe('tooFewTrials');
    expect(
      reason(
        refEffectiveTrials([
          [0.01, -0.01, 0.02],
          [0.001, 0.001, 0.001],
        ]),
      ),
    ).toBe('noDispersion');
    expect(reason(refEffectiveTrials([[0.01]]))).toBe('noDispersion');
    expect(() => refEffectiveTrials([[0.01, 0.02], [0.01]])).toThrow();
    expect(() => refEffectiveTrials([[0.01, NaN]])).toThrow();
    // p and -p: correlation -1, clamped to 0: N = 2; returns = the row length.
    const n = value(
      refEffectiveTrials([
        [1, -1, 1, -1],
        [-1, 1, -1, 1],
      ]),
    );
    expect(n).toEqual({ effective: 2, trials: 2, averageCorrelation: 0, returns: 4 });
  });
  it('one trial: N = 1, rho undefined', () => {
    const n = value(refEffectiveTrialsOfTrials({ trials: [trial(p2)], cashReturn: zeroCash }));
    expect(n).toEqual({ effective: 1, trials: 1, averageCorrelation: undefined, returns: 20 });
  });
  it('copies: rho = 1, N = 1; orthogonal: rho = 0, N = M; negative clamps to 0', () => {
    const copies = value(
      refEffectiveTrialsOfTrials({
        trials: [trial(p2), trial(p2), trial(p2)],
        cashReturn: zeroCash,
      }),
    );
    close(copies.averageCorrelation!, 1, 1e-12);
    close(copies.effective, 1, 1e-12);
    const orth = value(
      refEffectiveTrialsOfTrials({ trials: [trial(p2), trial(p4)], cashReturn: zeroCash }),
    );
    expect(Math.abs(orth.averageCorrelation!)).toBeLessThan(1e-12);
    close(orth.effective, 2, 1e-12);
    // Pairs: +1, -1, -1: mean -1/3, clamped to 0, so N = M = 3.
    const neg = value(
      refEffectiveTrialsOfTrials({
        trials: [trial(p2), trial(p2), trial((i) => -p2(i))],
        cashReturn: zeroCash,
      }),
    );
    expect(neg.averageCorrelation).toBe(0);
    expect(neg.effective).toBe(3);
  });
  it('corr(p, p + q) = 1 / sqrt(2) for orthogonal p, q of equal spread: N = rho + (1 - rho) 2', () => {
    const n = value(
      refEffectiveTrialsOfTrials({
        trials: [trial(p2), trial((i) => p2(i) + p4(i))],
        cashReturn: zeroCash,
      }),
    );
    const rho = Math.SQRT1_2;
    // Equity rounding moves the returns by ~1e-16; the correlation by about as much.
    close(n.averageCorrelation!, rho, 1e-12);
    close(n.effective, rho + (1 - rho) * 2, 1e-12);
  });
});

describe('reference deflated Sharpe ratio', () => {
  it("the paper's worked example: SR0 = 0.1132, DSR = 0.9004", () => {
    const d = value(
      refDeflatedSharpeFromMoments({
        sharpe: 2.5 / Math.sqrt(250),
        returns: 1250,
        effectiveTrials: 100,
        sharpeVariance: 0.5 / 250,
        skewness: -3,
        kurtosis: 10,
      }),
    );
    expect(d.expectedMaxSharpe).toBeCloseTo(0.1132, 4);
    expect(d.probability).toBeCloseTo(0.9004, 4);
  });
  it('one trial: SR0 = 0, the probabilistic Sharpe ratio; two-point returns have g3 = 0, g4 = 1', () => {
    // x alternates 0.02, -0.01 (10 each): mean 0.005, sample sd 0.015 sqrt(20/19);
    // SR = sqrt(19/20) / 3; denominator sqrt(1 - 0 + 0) = 1; DSR = Phi(SR sqrt(19)).
    const x = series(20, (i) => (i % 2 === 0 ? 0.02 : -0.01));
    const d = value(refDeflatedSharpe({ trials: [equity(x)], cashReturn: zeroCash, selected: 0 }));
    const SR = Math.sqrt(19 / 20) / 3;
    close(d.sharpe, SR, 1e-12);
    expect(d.expectedMaxSharpe).toBe(0);
    expect(Math.abs(d.skewness)).toBeLessThan(1e-12);
    close(d.kurtosis, 1, 1e-12);
    close(d.probability, refPhi(SR * Math.sqrt(19)), 1e-12);
    expect(d.returns).toBe(20);
    expect(d.effectiveTrials).toBe(1);
  });
  it('two orthogonal trials: N = 2, V the sample variance of the two daily Sharpes', () => {
    const a = trial(p2);
    const b = equity(series(20, (i) => 0.003 + 0.01 * p4(i))); // another mean, so V > 0
    const sr = (t: RefEquitySample[]) => {
      const r = t.slice(1).map((p, i) => p.equity / t[i]!.equity - 1);
      const m = r.reduce((s, v) => s + v, 0) / r.length;
      return m / Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1));
    };
    const s = [sr(a), sr(b)];
    const V = (s[0]! - s[1]!) ** 2 / 2; // (n - 1) = 1
    const d = value(refDeflatedSharpe({ trials: [a, b], cashReturn: zeroCash, selected: 0 }));
    close(d.effectiveTrials, 2, 1e-12);
    const gamma = 0.5772156649015329;
    const z = (1 - gamma) * refPhiInv(0.5) + gamma * refPhiInv(1 - 1 / (2 * 2.718281828459045));
    close(d.expectedMaxSharpe, Math.max(0, Math.sqrt(V) * z), 1e-9);
  });
  it('SR0 is 0 for N = 1 and floored at 0 just above 1', () => {
    expect(refExpectedMaxSharpe(1, undefined)).toBe(0);
    expect(refExpectedMaxSharpe(1.1, 0.01)).toBe(0); // the formula is negative there
    expect(refExpectedMaxSharpe(5, 0)).toBe(0);
    expect(refExpectedMaxSharpe(100, 0.002)).toBeCloseTo(0.1132, 4);
  });
  it('the denominator square at or below 1e-12 is noDispersion', () => {
    // 1 - g3 SR + (g4 - 1)/4 SR^2 with g4 = 1: 1 - g3 SR; g3 SR = 1 gives 0.
    const d = refDeflatedSharpeFromMoments({
      sharpe: 0.5,
      returns: 100,
      effectiveTrials: 1,
      sharpeVariance: undefined,
      skewness: 2,
      kurtosis: 1,
    });
    expect(reason(d)).toBe('noDispersion');
  });
  it('refuses a selected index that is not a trial, before any data state', () => {
    expect(() => refDeflatedSharpe({ trials: [], cashReturn: zeroCash, selected: 0 })).toThrow();
    expect(() =>
      refDeflatedSharpe({ trials: [trial(p2, 5)], cashReturn: zeroCash, selected: 0.5 }),
    ).toThrow();
    expect(() =>
      refDeflatedSharpe({ trials: [trial(p2)], cashReturn: zeroCash, selected: 1 }),
    ).toThrow();
  });
});

describe('reference PBO (CSCV)', () => {
  // Block-wise patterns over 40 rows (two blocks of 20): good then bad, or bad then good.
  const up = (i: number) => (i % 2 === 0 ? 0.02 : -0.01); // mean +0.005
  const down = (i: number) => (i % 2 === 0 ? 0.01 : -0.02); // mean -0.005
  const make = (f: (i: number) => number, n = 40) => equity(series(n, f));

  it('in-sample best always worst out of sample: PBO = 1', () => {
    const a = make((i) => (i < 20 ? up(i) : down(i)));
    const b = make((i) => (i < 20 ? down(i) : up(i)));
    const p = value(refPbo({ trials: [a, b], cashReturn: zeroCash, partitions: 2 }));
    expect(p).toEqual({
      pbo: 1,
      combinations: 2,
      trials: 2,
      partitions: 2,
      rowsUsed: 40,
      rowsDropped: 0,
    });
  });
  it('one trial best in every block: rank 2 of 2, w = 2/3, PBO = 0', () => {
    const p = value(
      refPbo({ trials: [make(up), make(down)], cashReturn: zeroCash, partitions: 2 }),
    );
    expect(p.pbo).toBe(0);
  });
  it('tied trials: mid-rank 1.5 of 2, w = 1/2, logit 0 counts as overfit', () => {
    const p = value(refPbo({ trials: [make(up), make(up)], cashReturn: zeroCash, partitions: 2 }));
    expect(p.pbo).toBe(1);
  });
  it('blocks: the oldest leftover rows dropped; C(S, S/2) combinations', () => {
    // T = 83, S = 4: b = 20, 3 rows dropped, 6 combinations.
    const p = value(
      refPbo({ trials: [make(up, 83), make(down, 83)], cashReturn: zeroCash, partitions: 4 }),
    );
    expect(p).toMatchObject({ combinations: 6, rowsUsed: 80, rowsDropped: 3, pbo: 0 });
    // The dropped rows are the oldest: a wild start changes nothing.
    const wild = (f: (i: number) => number) =>
      make((i) => (i < 3 ? (i === 1 ? 0.5 : -0.3) : f(i)), 83);
    const q = value(
      refPbo({ trials: [wild(up), wild(down)], cashReturn: zeroCash, partitions: 4 }),
    );
    expect(q.pbo).toBe(0);
    const s16 = value(refPbo({ trials: [make(up, 400), make(down, 400)], cashReturn: zeroCash }));
    expect(s16).toMatchObject({ combinations: 12870, partitions: 16, rowsUsed: 400, pbo: 0 });
  });
  it('tooFewTrials, tooShort (S/2 x b < 20), noDispersion in a set', () => {
    expect(reason(refPbo({ trials: [make(up)], cashReturn: zeroCash, partitions: 2 }))).toBe(
      'tooFewTrials',
    );
    // T = 39, S = 2: b = 19, 19 < 20.
    expect(
      reason(
        refPbo({ trials: [make(up, 39), make(down, 39)], cashReturn: zeroCash, partitions: 2 }),
      ),
    ).toBe('tooShort');
    // A trial flat (x = 0 exactly) in block 1: its out-of-sample variance is 0.
    const flatLater = make((i) => (i < 20 ? up(i) : 0));
    expect(
      reason(refPbo({ trials: [make(up), flatLater], cashReturn: zeroCash, partitions: 2 })),
    ).toBe('noDispersion');
    // A constant non-zero return in block 1: (S2 - S1^2/m)/(m - 1) leaves only rounding, below
    // the scale-aware floor 1e-14 x S2 / m (a fixed 1e-24 would read it as a spread).
    const constLater = make((i) => (i < 20 ? up(i) : 0.0037));
    expect(
      reason(refPbo({ trials: [make(up), constLater], cashReturn: zeroCash, partitions: 2 })),
    ).toBe('noDispersion');
    expect(() =>
      refPbo({ trials: [make(up), make(down)], cashReturn: zeroCash, partitions: 3 }),
    ).toThrow();
    expect(() =>
      refPbo({ trials: [make(up), make(down)], cashReturn: zeroCash, partitions: 0 }),
    ).toThrow();
  });
});

describe('reference walk-forward folds', () => {
  // 1096 calendar days 2020-01-01 .. 2022-12-31: D = 1095, K = min(10, 3) = 3,
  // B = 2020-01-01, 2020-12-31, 2021-12-31, 2022-12-31.
  const returns = series(1095, (i) => 0.0004 + 0.01 * Math.sin(i * 0.7) + 0.003 * p4(i));
  const pts = equity(returns, '2020-01-01');
  const cash = (d: string) => (d < '2021-06-01' ? 0.0001 : 0.00005);

  it('cuts equal calendar spans, each fold starting from the last point before it', () => {
    const w = value(refWalkForward({ points: pts, benchmark: pts, cashReturn: cash }));
    expect(w.folds.map((f) => [f.start, f.end])).toEqual([
      ['2020-01-01', '2020-12-30'],
      ['2020-12-31', '2021-12-30'],
      ['2021-12-31', '2022-12-31'],
    ]);
    const cut = (from: number, to: number) => pts.slice(from, to);
    const sharpe = (s: RefEquitySample[]) => refMetrics({ points: s, cashReturn: cash }).sharpe;
    // Fold 0: indexes 0 .. 364; fold 1: 364 .. 729; fold 2: 729 .. 1095.
    expect(w.folds[0]!.strategy).toEqual(sharpe(cut(0, 365)));
    expect(w.folds[1]!.strategy).toEqual(sharpe(cut(364, 730)));
    expect(w.folds[2]!.strategy).toEqual(sharpe(cut(729, 1096)));
    // The same series as the benchmark: every fold tied, so never beaten.
    expect(w.folds.every((f) => f.beat === false)).toBe(true);
    expect([w.won, w.measured]).toEqual([0, 3]);
  });
  it('a weaker benchmark (half the return less 5 bp a day) is beaten in every fold', () => {
    const bench = equity(
      returns.map((r) => 0.5 * r - 0.0005),
      '2020-01-01',
    );
    const w = value(refWalkForward({ points: pts, benchmark: bench, cashReturn: zeroCash }));
    expect([w.won, w.measured]).toEqual([3, 3]);
  });
  it('a benchmark without data in a fold: no value there, beat undefined', () => {
    const bench = pts.filter((p) => p.date < '2020-12-31' || p.date >= '2022-01-01');
    const w = value(refWalkForward({ points: pts, benchmark: bench, cashReturn: cash }));
    expect(reason(w.folds[1]!.benchmark)).toBe('tooShort');
    expect(w.folds[1]!.beat).toBeUndefined();
    expect(w.measured).toBe(2);
  });
  it('folds caps K; fewer than 2 folds of a year is tooShort', () => {
    expect(
      value(refWalkForward({ points: pts, benchmark: pts, cashReturn: cash, folds: 2 })).folds,
    ).toHaveLength(2);
    expect(
      reason(refWalkForward({ points: pts.slice(0, 730), benchmark: pts, cashReturn: cash })),
    ).toBe('tooShort');
    expect(reason(refWalkForward({ points: [], benchmark: pts, cashReturn: cash }))).toBe(
      'tooShort',
    );
    expect(() =>
      refWalkForward({ points: pts, benchmark: pts, cashReturn: cash, folds: 0 }),
    ).toThrow();
    // cashReturn is required.
    expect(() =>
      refWalkForward({ points: pts, benchmark: pts } as unknown as Parameters<
        typeof refWalkForward
      >[0]),
    ).toThrow();
  });
  it('nothing measured: no value with the first fold reason (strategy, else benchmark)', () => {
    const noCash = () => undefined;
    expect(reason(refWalkForward({ points: pts, benchmark: pts, cashReturn: noCash }))).toBe(
      'cashRateMissing',
    );
    // A benchmark with no point at all: the strategy has values, the benchmark is tooShort.
    expect(reason(refWalkForward({ points: pts, benchmark: [], cashReturn: cash }))).toBe(
      'tooShort',
    );
  });
});

describe('reference parameter sweep', () => {
  const strategy = {
    signals: [{ left: { length: 50 } }, { left: { length: 50 } }],
    allocations: [{ weight: 60 }],
  };
  const grid = [
    {
      paths: [
        ['signals', 0, 'left', 'length'],
        ['signals', 1, 'left', 'length'],
      ],
      values: [20, 50, 100],
    },
    { paths: [['allocations', 0, 'weight']], values: [40, 60] },
  ];

  it('the Cartesian product, first parameter outermost, paths sharing one value', () => {
    const v = refSweepVariants(strategy, grid);
    expect(v.map((x) => x.index)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ]);
    expect(v[3]!.values).toEqual([50, 60]);
    expect(v[4]!.strategy).toEqual({
      signals: [{ left: { length: 100 } }, { left: { length: 100 } }],
      allocations: [{ weight: 40 }],
    });
    expect(strategy.signals[0]!.left.length).toBe(50); // the original is untouched
  });
  it('keeps an invalid variant with its error and runs only the valid ones', () => {
    const out = refSweep(
      strategy,
      grid,
      (s) => {
        const w = (s as typeof strategy).allocations[0]!.weight;
        return w < 50
          ? { ok: false, error: 'weight below 50' }
          : { ok: true, strategy: s as typeof strategy };
      },
      (s) => s.signals[0]!.left.length * 2,
    );
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({ index: [0, 0], values: [20, 40], error: 'weight below 50' });
    expect(out[5]!.result).toBe(200);
  });
  it('refuses a path not in the strategy, an empty value list and repeats', () => {
    expect(() =>
      refSweepVariants(strategy, [{ paths: [['signals', 2, 'left']], values: [1] }]),
    ).toThrow();
    expect(() =>
      refSweepVariants(strategy, [{ paths: [['signals', '0', 'left']], values: [1] }]),
    ).toThrow();
    expect(() =>
      refSweepVariants(strategy, [{ paths: [['allocations', 0, 'wieght']], values: [1] }]),
    ).toThrow();
    expect(() =>
      refSweepVariants(strategy, [{ paths: [['allocations', 0, 'weight']], values: [] }]),
    ).toThrow();
    expect(() =>
      refSweepVariants(strategy, [{ paths: [['allocations', 0, 'weight']], values: [1, 2, 1] }]),
    ).toThrow();
  });
  it('neighbors: one step in one parameter, by parameter, previous before next', () => {
    expect(refNeighbors([3, 2], [1, 0])).toEqual([
      [0, 0],
      [2, 0],
      [1, 1],
    ]);
    expect(refNeighbors([3, 3, 1], [2, 1, 0])).toEqual([
      [1, 1, 0],
      [2, 0, 0],
      [2, 2, 0],
    ]);
  });
});

describe('reference crisis replays', () => {
  const strategy: RefEquitySample[] = [
    { date: '2020-02-18', equity: 100 },
    { date: '2020-02-20', equity: 110 },
    { date: '2020-03-01', equity: 88 },
    { date: '2020-03-10', equity: 99 },
    { date: '2020-03-24', equity: 120 },
  ];
  const benchmark: RefEquitySample[] = [
    { date: '2020-02-19', equity: 50 },
    { date: '2020-03-01', equity: 30 },
    { date: '2020-03-23', equity: 40 },
  ];
  const windows = JSON.parse(
    readFileSync(new URL('../../../templates/crises/us-equity.json', import.meta.url), 'utf8'),
  ) as RefCrisisWindow[];
  const covidOnly = windows.filter((w) => w.id === 'covid');

  it('from the last point <= start to the last <= end; covered needs points on both sides', () => {
    const r = value(refCrisisReplays({ strategy, benchmark, windows }));
    expect(r.windows.map((w) => w.id)).toEqual(['dotCom', 'financialCrisis', 'covid', 'rates2022']);
    expect(r.windows[2]!.source).toBe(windows[2]!.source);
    const covid = r.windows[2]!;
    // Strategy: 100, 110, 88, 99: 88/110 - 1 = -0.2; 99/100 - 1 = -0.01.
    close(value(covid.strategy).maxDrawdown, -0.2);
    close(value(covid.strategy).return, -0.01);
    // Benchmark: 50, 30, 40: -0.4 and -0.2.
    close(value(covid.benchmark).maxDrawdown, -0.4);
    close(value(covid.benchmark).return, -0.2);
    expect(covid.shallower).toBe(true);
    expect(reason(r.windows[0]!.strategy)).toBe('notCovered');
    expect(r.windows[0]!.shallower).toBeUndefined();
    expect([r.covered, r.shallower]).toEqual([1, 1]);
  });
  it('a tie is not shallower; an equity <= 0 in the window is equityNotPositive', () => {
    const same = value(refCrisisReplays({ strategy, benchmark: strategy, windows }));
    expect(same.windows[2]!.shallower).toBe(false);
    // A series ending on the trough date is covered (a point dated >= end).
    const short = value(refCrisisReplays({ strategy: benchmark, benchmark, windows }));
    expect(short.windows[2]!.strategy.ok).toBe(true);
    // Nothing covered: the first window's reason, the strategy's before the benchmark's.
    const wiped = benchmark.map((p, i) => (i === 1 ? { ...p, equity: 0 } : p));
    const r = refCrisisReplays({ strategy, benchmark: wiped, windows: covidOnly });
    expect(reason(r)).toBe('equityNotPositive');
    expect(reason(refCrisisReplays({ strategy, benchmark: wiped, windows }))).toBe('notCovered');
    expect(reason(refCrisisReplays({ strategy, benchmark, windows: [] }))).toBe('notCovered');
  });
  it('windows are required input: real dates, start before end, unique ids, a source', () => {
    const w = covidOnly[0]!;
    const bad: unknown[] = [
      undefined,
      [w, w],
      [{ ...w, end: w.start }],
      [{ ...w, start: '2020-02-30' }],
      [{ ...w, source: undefined }],
    ];
    for (const b of bad) {
      expect(() =>
        refCrisisReplays({ strategy, benchmark, windows: b as RefCrisisWindow[] }),
      ).toThrow();
    }
  });
});

describe('reference goal projection', () => {
  /** Bars whose close grows 0.1% a day; one 2-for-1 split day (raw close halves). */
  const growing = (count: number, start = '2024-01-01', splitAt = 100): RefBar[] => {
    const dates = dayList(start, count);
    const bars: RefBar[] = [];
    let close = 50;
    dates.forEach((date, i) => {
      let splitFactor = 1;
      if (i > 0) close *= 1.001;
      if (i === splitAt) {
        close /= 2;
        splitFactor = 2;
      }
      bars.push({ date, close, divCash: 0, splitFactor, closeIsSplitAdjusted: false });
    });
    return bars;
  };
  const history = { A: growing(300) }; // ends 2024-10-26; 299 sample days
  const h = history.A[299]!.date;
  const future = dayList('2024-10-27', 40); // .. 2024-12-05; month changes on 11-01 and 12-01
  const runA = (bars: Record<string, RefBar[]>) => {
    // Buy and hold A's total return, 1 at h.
    const list = bars.A!;
    const at = list.findIndex((b) => b.date === future[0]) - 1; // h, the last real bar
    const out: RefEquitySample[] = [{ date: list[at]!.date, equity: 1 }];
    for (let i = at + 1; i < list.length; i++) {
      const b = list[i]!;
      const p = list[i - 1]!;
      const k = b.closeIsSplitAdjusted ? 1 : b.splitFactor;
      out.push({
        date: b.date,
        equity: (out[out.length - 1]!.equity * (b.close + b.divCash) * k) / p.close,
      });
    }
    return out;
  };
  // Every sample day is +0.1% (the split day too), so every path is the same.
  let W = 1000;
  for (let i = 0; i < future.length; i++) {
    const before = i === 0 ? h : future[i - 1]!;
    W = W * 1.001 + (future[i]!.slice(0, 7) !== before.slice(0, 7) ? 100 : 0);
  }

  it('money: contributions on each new month, every path the same', () => {
    const r = value(
      refGoalProjection({
        history,
        future,
        run: runA,
        initial: 1000,
        monthly: 100,
        goal: 1200,
        currency: 'XYZ',
        paths: 20,
        seed: 7,
      }),
    );
    expect(W).toBeGreaterThan(1200);
    for (const q of Object.values(r.endValues)) close(q, W, 1e-12);
    expect([r.reached, r.probability]).toEqual([20, 1]);
    // p = 1: the Wilson interval is [1 / (1 + z^2 / P), 1].
    close(r.low, 1 / (1 + REF_WILSON_Z ** 2 / 20), 1e-14);
    expect(r.high).toBe(1);
    expect(r).toMatchObject({
      paths: 20,
      sampleDays: 299,
      sampleStart: '2024-01-02',
      sampleEnd: h,
      meanBlock: 20,
      seed: 7,
      currency: 'XYZ',
    });
    const miss = value(
      refGoalProjection({
        history,
        future,
        run: runA,
        initial: 1000,
        monthly: 100,
        goal: W * 1.0001,
        currency: 'XYZ',
        paths: 20,
        seed: 7,
      }),
    );
    expect([miss.reached, miss.low]).toEqual([0, 0]);
  });
  it('synthesized bars: relative to the previous close, split factor 1, no open without one', () => {
    let seen: RefBar[] = [];
    refGoalProjection({
      history,
      future,
      run: (bars) => {
        seen = bars.A!;
        return runA(bars);
      },
      initial: 1,
      monthly: 0,
      goal: 1,
      currency: 'XYZ',
      paths: 1,
      seed: 1,
    });
    expect(seen).toHaveLength(340);
    for (let i = 300; i < 340; i++) {
      close(seen[i]!.close / seen[i - 1]!.close, 1.001, 1e-13);
      expect(seen[i]).toMatchObject({
        date: future[i - 300],
        splitFactor: 1,
        divCash: 0,
        closeIsSplitAdjusted: false,
      });
      expect(seen[i]!.open).toBeUndefined();
    }
  });
  it('path p draws from stream p: the sampled days follow the bootstrap', () => {
    // Close returns alternate +2% / -1% on the history; a 5-day future.
    const dates = dayList('2023-01-01', 400);
    let c = 10;
    const bars: RefBar[] = dates.map((date, i) => {
      if (i > 0) c *= i % 2 === 1 ? 1.02 : 0.99;
      return {
        date,
        close: c,
        open: c * 0.995,
        divCash: 0,
        splitFactor: 1,
        closeIsSplitAdjusted: true,
      };
    });
    const h2 = dates[399]!;
    const fut = dayList(dayList(h2, 2)[1]!, 5);
    const runB = (b: Record<string, RefBar[]>) => {
      const list = b.B!;
      return [h2, ...fut].map((date) => ({
        date,
        equity: list.find((x) => x.date === date)!.close,
      }));
    };
    const r = value(
      refGoalProjection({
        history: { B: bars },
        future: fut,
        run: runB,
        initial: 100,
        monthly: 0,
        goal: 101,
        currency: 'XYZ',
        paths: 3,
        seed: 99,
        meanBlock: 2,
      }),
    );
    const ends = [0, 1, 2].map((p) => {
      const idx = refStationaryBootstrap(new RefRandom(99, p), 399, 5, 2);
      let w = 100;
      for (const k of idx) w *= bars[k + 1]!.close / bars[k]!.close; // sample day k is date k + 1
      return w;
    });
    const reached = ends.filter((w) => w >= 101).length;
    expect(r.reached).toBe(reached);
    close(r.endValues.p50, [...ends].sort((a, b) => a - b)[1]!, 1e-12);
    expect(Object.keys(r)).toEqual([
      'reached',
      'paths',
      'probability',
      'low',
      'high',
      'endValues',
      'sampleDays',
      'sampleStart',
      'sampleEnd',
      'meanBlock',
      'seed',
      'currency',
    ]);
    // Look-ahead guard: a run whose output up to h changes with the simulated future throws.
    const peeking = (b: Record<string, RefBar[]>) => {
      const out = runB(b);
      return [{ date: dates[398]!, equity: b.B![b.B!.length - 1]!.close }, ...out];
    };
    const base = {
      history: { B: bars },
      future: fut,
      initial: 100,
      monthly: 0,
      goal: 101,
      currency: 'XYZ',
      paths: 3,
      seed: 99,
      meanBlock: 2,
    };
    expect(() => refGoalProjection({ ...base, run: peeking })).toThrow(/look-ahead/);
    // The same past on every path passes.
    const steady = (b: Record<string, RefBar[]>) => [{ date: dates[398]!, equity: 1 }, ...runB(b)];
    expect(refGoalProjection({ ...base, run: steady }).ok).toBe(true);
  });
  it('sample days need the previous common date as every series previous bar', () => {
    const b = growing(300).filter((x) => x.date !== '2024-03-01');
    const r = value(
      refGoalProjection({
        history: { A: history.A, B: b },
        future,
        run: runA,
        initial: 1,
        monthly: 0,
        goal: 1,
        currency: 'XYZ',
        paths: 1,
        seed: 1,
      }),
    );
    expect(r.sampleDays).toBe(297); // 2024-03-01 and 2024-03-02 drop out
    const from = value(
      refGoalProjection({
        history,
        future,
        run: runA,
        initial: 1,
        monthly: 0,
        goal: 1,
        currency: 'XYZ',
        paths: 1,
        seed: 1,
        sampleFrom: '2024-01-10',
      }),
    );
    expect([from.sampleDays, from.sampleStart]).toEqual([291, '2024-01-10']);
  });
  it('tooShort under 252 sample days; equityNotPositive at h; a wiped-out path is lost', () => {
    const base = { future, initial: 1, monthly: 0, goal: 0.5, currency: 'XYZ', paths: 2, seed: 1 };
    expect(reason(refGoalProjection({ ...base, history: { A: growing(252) }, run: runA }))).toBe(
      'tooShort',
    );
    expect(
      value(refGoalProjection({ ...base, history: { A: growing(253) }, run: runA })).sampleDays,
    ).toBe(252);
    const zeroAtH = (bars: Record<string, RefBar[]>) =>
      runA(bars).map((p, i) => (i === 0 ? { ...p, equity: 0 } : p));
    expect(reason(refGoalProjection({ ...base, history, run: zeroAtH }))).toBe('equityNotPositive');
    // Equity 0 on the 3rd future day, back up later: lost, W = 0, the goal 0.5 not reached.
    const wiped = (bars: Record<string, RefBar[]>) =>
      runA(bars).map((p, i) => (i === 3 ? { ...p, equity: 0 } : p));
    const r = value(refGoalProjection({ ...base, history, run: wiped }));
    expect([r.reached, r.endValues.p95]).toEqual([0, 0]);
  });
  it('a run dropping a past date on a later path is look-ahead too', () => {
    let calls = 0;
    const flaky = (bars: Record<string, RefBar[]>) => {
      calls++;
      const out = runA(bars);
      return calls === 1 ? [{ date: '2024-10-01', equity: 1 }, ...out] : out;
    };
    expect(() =>
      refGoalProjection({
        history,
        future,
        run: flaky,
        initial: 1,
        monthly: 0,
        goal: 1,
        currency: 'XYZ',
        paths: 2,
        seed: 1,
      }),
    ).toThrow(/look-ahead/);
  });
  it('refuses malformed input', () => {
    const base = {
      history,
      future,
      run: runA,
      initial: 1,
      monthly: 0,
      goal: 1,
      currency: 'XYZ',
      paths: 1,
      seed: 1,
    };
    const bad: Partial<Parameters<typeof refGoalProjection>[0]>[] = [
      { history: { A: history.A, B: growing(299) } }, // ends on another date
      { history: { A: history.A.map((x, i) => (i === 5 ? { ...x, close: 0 } : x)) } },
      { history: { A: history.A.map((x, i) => (i === 5 ? { ...x, splitFactor: 0 } : x)) } },
      { history: { A: history.A.map((x, i) => (i === 5 ? { ...x, open: NaN } : x)) } },
      { future: [] },
      { future: [h] },
      { future: ['2024-11-02', '2024-11-01'] },
      { initial: -1 },
      { monthly: NaN },
      { goal: 0 },
      { seed: 2 ** 32 },
      { seed: -1 },
      { meanBlock: 0.5 },
      { paths: 0 },
      { sampleFrom: '2024-02-30' },
      { run: (bars) => runA(bars).slice(0, -1) },
      { run: (bars) => runA(bars).map((p, i) => (i === 2 ? { ...p, equity: Infinity } : p)) },
    ];
    for (const b of bad) expect(() => refGoalProjection({ ...base, ...b })).toThrow();
  });
  it('Wilson: p = 0 gives [0, z^2/P / (1 + z^2/P)]; a middle value by hand', () => {
    const z2 = REF_WILSON_Z ** 2;
    const zero = refWilson(0, 100);
    expect(zero.low).toBe(0); // exact at the end, not left to rounding
    close(zero.high, z2 / 100 / (1 + z2 / 100), 1e-14);
    // 50 of 100: center 0.5; half = z / (1 + z^2/100) sqrt(0.0025 + z^2 / 40000).
    const mid = refWilson(50, 100);
    const half = (REF_WILSON_Z / (1 + z2 / 100)) * Math.sqrt(0.0025 + z2 / 40000);
    close(mid.low, 0.5 - half, 1e-14);
    close(mid.high, 0.5 + half, 1e-14);
  });
});

describe('reference near tie', () => {
  it('relative 1e-9; two zeros are tied', () => {
    expect(refNearTie(0, 0)).toBe(true);
    expect(refNearTie(1, 1 + 1e-10)).toBe(true);
    expect(refNearTie(1, 1 + 2e-9)).toBe(false);
    expect(refNearTie(0, 1e-300)).toBe(false);
  });
});
