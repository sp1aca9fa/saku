// Core statistics against the independent reference (requirements 13; docs/analytics.md
// "Statistics") on seeded random inputs: the random numbers and bootstrap draws are bit-exact,
// Phi and PhiInv agree within the contract's accuracy, and every statistic has the same value or
// no value, the same reason, the same throw on refused input, and values within 1e-9 relative
// (1e-12 absolute near 0). Where they disagree, find the root cause against the doc; never copy
// one into the other.
import {
  RefRandom,
  refCrisisReplays,
  refDeflatedSharpe,
  refDeflatedSharpeFromMoments,
  refEffectiveTrials,
  refEffectiveTrialsOfTrials,
  refGoalProjection,
  refNearTie,
  refNeighbors,
  refPbo,
  refPhi,
  refPhiInv,
  refSplitMix64,
  refStationaryBootstrap,
  refSweep,
  refWalkForward,
  refWilson,
} from '@saku/reference';
import type { RefProjectionInput } from '@saku/reference';
import { describe, expect, it } from 'vitest';
import crisisTemplate from '../../../../templates/crises/us-equity.json';
import type { RawBar } from '../domain';
import { Strategy } from '../strategy/schema';
import type { EquitySample } from './metrics';
import { normalCdf, normalQuantile } from './normal';
import {
  deflatedSharpeFromMoments,
  effectiveTrials,
  overfitting,
  type TrialsInput,
} from './overfitting';
import { type CrisisWindow, crisisReplays, walkForward } from './periods';
import {
  type GoalProjectionInput,
  type ProjectionPoint,
  goalProjection,
  wilson95,
} from './projection';
import { Rng, createRng, splitMix64, stationaryBootstrap } from './random';
import { nearTie } from './statistic';
import { type SweepParameter, neighbors, sweep } from './sweep';

/** A small seeded generator (mulberry32) for the inputs, so failures reproduce. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rnd = () => number;
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const gauss = (rnd: Rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const word = (rnd: Rnd) => Math.floor(rnd() * 4294967296);

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Session-like dates: mostly a day or a weekend apart, sometimes a gap of weeks. */
function sessions(rnd: Rnd, start: string, n: number, longGaps = false): string[] {
  const out: string[] = [];
  let d = start;
  for (let i = 0; i < n; i++) {
    out.push(d);
    const u = rnd();
    const step =
      u < 0.6
        ? 1
        : u < 0.95
          ? 2 + Math.floor(rnd() * 3)
          : longGaps && u > 0.997
            ? 380 + Math.floor(rnd() * 300)
            : 8 + Math.floor(rnd() * 30);
    d = addDays(d, step);
  }
  return out;
}

/** Close to a fixed tolerance: `rel` relative, `abs` absolute near 0. */
function close(a: number, b: number, rel = 1e-9, abs = 1e-12): boolean {
  if (Object.is(a, b)) return true;
  return Math.abs(a - b) <= Math.max(rel * Math.max(Math.abs(a), Math.abs(b)), abs);
}

/** The first difference between a core and a reference value, or undefined (keys compared too). */
function diff(a: unknown, b: unknown, path: string): string | undefined {
  if (typeof a === 'number' && typeof b === 'number') {
    return close(a, b) ? undefined : `${path}: core ${a}, reference ${b}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array on one side only`;
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

type Outcome = { threw: true; error: string } | { threw: false; value: unknown };
const attempt = (f: () => unknown): Outcome => {
  try {
    return { threw: false, value: f() };
  } catch (e) {
    return { threw: true, error: String(e) };
  }
};

/** Same throw-or-result; on results, the first value that differs. */
function compare(core: () => unknown, ref: () => unknown, label: string): string | undefined {
  const c = attempt(core);
  const r = attempt(ref);
  if (c.threw || r.threw) {
    if (c.threw && r.threw) return undefined;
    return `${label}: throws: core ${c.threw ? c.error : 'no'}, reference ${r.threw ? r.error : 'no'}`;
  }
  return diff(c.value, r.value, label);
}
const agree = (core: () => unknown, ref: () => unknown, label: string) =>
  expect(compare(core, ref, label)).toBeUndefined();
const bothThrow = (core: () => unknown, ref: () => unknown, label: string) => {
  expect(core, `${label} (core)`).toThrow();
  expect(ref, `${label} (reference)`).toThrow();
};

// ---- Random numbers ----

describe('random numbers: core vs reference, bit-exact', () => {
  it('SplitMix64 from random 64-bit starts', () => {
    const rnd = random(101);
    for (let c = 0; c < 200; c++) {
      const x = (BigInt(word(rnd)) << 32n) | BigInt(word(rnd));
      const ref = refSplitMix64(x, 4);
      let state = x;
      for (let k = 0; k < 4; k++) {
        const s = splitMix64(state);
        expect(s.output, `x = ${x}, output ${k}`).toBe(ref[k]);
        state = s.next;
      }
    }
  });

  it('seeded generators draw the same outputs, floats and integers in any interleaving', () => {
    const rnd = random(102);
    const seeds: [number, number][] = [
      [0, 0],
      [42, 0],
      [42, 7],
      [4294967295, 4294967295],
      [0, 4294967295],
    ];
    for (let c = 0; c < 200; c++) seeds.push([word(rnd), rnd() < 0.3 ? 0 : word(rnd)]);
    const ns = [1, 2, 3, 10, 252, 2 ** 31, 2 ** 31 + 1, 3 * 2 ** 30, 4294967295, 4294967296];
    for (const [seed, stream] of seeds) {
      const core = createRng(seed, stream);
      const ref = new RefRandom(seed, stream);
      for (let k = 0; k < 300; k++) {
        const u = rnd();
        const at = `seed ${seed}, stream ${stream}, draw ${k}`;
        if (u < 0.3) expect(core.next(), at).toBe(ref.next());
        else if (u < 0.6) expect(core.float(), at).toBe(ref.float());
        else {
          const n = rnd() < 0.5 ? pick(rnd, ns) : 1 + Math.floor(rnd() * 4294967296);
          expect(core.int(n), `${at}, int(${n})`).toBe(ref.int(n));
        }
      }
    }
  });

  it('a generator from an explicit state', () => {
    const rnd = random(103);
    const states: [number, number, number, number][] = [[1, 2, 3, 4]];
    for (let c = 0; c < 100; c++) states.push([word(rnd), word(rnd), word(rnd), word(rnd)]);
    for (const s of states) {
      const core = new Rng(s);
      const ref = RefRandom.fromState(...s);
      for (let k = 0; k < 100; k++) expect(core.next(), `state ${s}`).toBe(ref.next());
    }
  });

  it('refuses the same seeds, streams and ranges', () => {
    for (const bad of [-1, 4294967296, 1.5, Number.NaN, Infinity]) {
      bothThrow(
        () => createRng(bad),
        () => new RefRandom(bad),
        `seed ${bad}`,
      );
      bothThrow(
        () => createRng(1, bad),
        () => new RefRandom(1, bad),
        `stream ${bad}`,
      );
    }
    for (const n of [0, -1, 1.5, 4294967297, Number.NaN, Infinity]) {
      bothThrow(
        () => createRng(1).int(n),
        () => new RefRandom(1).int(n),
        `int(${n})`,
      );
    }
  });
});

describe('stationary bootstrap: core vs reference, bit-exact', () => {
  it('the same day indexes and the generator left in the same state', () => {
    const rnd = random(104);
    for (let c = 0; c < 400; c++) {
      const seed = word(rnd);
      const stream = Math.floor(rnd() * 50);
      const n = pick(rnd, [1, 2, 3, 7, 252, 253, 1000, 5003]);
      const L = pick(rnd, [0, 1, 2, 30, 252, 600]);
      const meanBlock = pick(rnd, [1, 1.0000001, 1.5, 5, 20, 63.7, 1e6]);
      const core = createRng(seed, stream);
      const ref = new RefRandom(seed, stream);
      const at = `seed ${seed}, n ${n}, L ${L}, meanBlock ${meanBlock}`;
      expect(stationaryBootstrap(core, n, L, meanBlock), at).toEqual(
        refStationaryBootstrap(ref, n, L, meanBlock),
      );
      expect(core.next(), at).toBe(ref.next());
    }
  });

  it('refuses the same sample sizes, lengths and block lengths', () => {
    const cases: [number, number, number][] = [
      [0, 5, 20],
      [1.5, 5, 20],
      [-1, 5, 20],
      [10, -1, 20],
      [10, 1.5, 20],
      [10, 5, 0.5],
      [10, 5, 0],
      [10, 5, Number.NaN],
      [10, 5, Infinity],
    ];
    for (const [n, L, mb] of cases) {
      bothThrow(
        () => stationaryBootstrap(createRng(3), n, L, mb),
        () => refStationaryBootstrap(new RefRandom(3), n, L, mb),
        `n ${n}, L ${L}, meanBlock ${mb}`,
      );
    }
  });
});

// ---- Normal distribution ----

describe('normal distribution: core vs reference', () => {
  // The contract's accuracy: 1e-13 relative for |z| <= 8, 1e-11 for |z| <= 37.
  const tolerance = (z: number) => (Math.abs(z) <= 8 ? 1e-13 : 1e-11);

  it('Phi within the contract accuracy', () => {
    const rnd = random(105);
    const zs = [0, -0, 1, -1, 0.3, -0.3, 0.999999, 1.000001, -1.000001, 8, -8, 20, -20, 37, -37];
    for (let c = 0; c < 3000; c++) zs.push((rnd() * 2 - 1) * pick(rnd, [1, 2, 8, 37]));
    for (const z of zs) {
      expect(close(normalCdf(z), refPhi(z), tolerance(z), 0), `Phi(${z})`).toBe(true);
    }
    expect(normalCdf(-Infinity)).toBe(refPhi(-Infinity));
    expect(normalCdf(Infinity)).toBe(refPhi(Infinity));
  });

  it('PhiInv within the contract accuracy, on p in [1e-300, 1 - 1e-16]', () => {
    const rnd = random(106);
    const ps = [1e-300, 1e-100, 1e-16, 0.01, 0.025, 0.1, 0.3, 0.5, 0.7, 0.975, 0.99, 1 - 1e-16];
    for (let c = 0; c < 1500; c++) {
      const u = rnd();
      ps.push(u < 0.4 ? rnd() : u < 0.7 ? 10 ** (-300 * rnd()) : 1 - 10 ** (-16 * rnd()));
    }
    for (const p of ps) {
      const a = normalQuantile(p);
      const b = refPhiInv(p);
      // Near p = 0.5 the quantile is near 0, where a relative bound would ask for more than the
      // input carries: an absolute 1e-15 there (the spacing of p around 0.5 is 1.1e-16).
      expect(close(a, b, tolerance(a), 1e-15), `PhiInv(${p}): core ${a}, reference ${b}`).toBe(
        true,
      );
    }
    expect(normalQuantile(0)).toBe(refPhiInv(0));
    expect(normalQuantile(1)).toBe(refPhiInv(1));
    expect(normalQuantile(0.5)).toBe(refPhiInv(0.5));
  });

  it('PhiInv refuses p outside [0, 1] and NaN', () => {
    for (const p of [-1e-300, -0.5, 1 + 1e-15, 2, Number.NaN]) {
      bothThrow(
        () => normalQuantile(p),
        () => refPhiInv(p),
        `PhiInv(${p})`,
      );
    }
  });
});

// ---- Trials: effective number, DSR, PBO ----

type TrialMode = 'walk' | 'correlated' | 'copy' | 'scaled' | 'negative' | 'flat' | 'cashOnly';
type TrialFault =
  'none' | 'wiped' | 'extraInside' | 'extraOutside' | 'missingDate' | 'cashGap' | 'cashNaN';

interface TrialsCase {
  input: TrialsInput;
  selected: number;
  partitions: number;
}

/** M trials on shared session dates, some near copies, some without swings, with rare faults. */
function buildTrials(seed: number): TrialsCase {
  const rnd = random(seed);
  const M = pick(rnd, [0, 1, 2, 2, 3, 3, 4, 5, 7]);
  const n = 1 + pick(rnd, [0, 1, 5, 19, 20, 21, 40, 63, 100, 160, 330, 700]);
  const dates = sessions(rnd, addDays('2015-01-02', Math.floor(rnd() * 500)), n);
  const cashBy = new Map<string, number>(dates.map((d) => [d, 0.00008 + 0.00006 * rnd()]));
  const fault = pick<TrialFault>(rnd, [
    'none',
    'none',
    'none',
    'none',
    'none',
    'none',
    'wiped',
    'extraInside',
    'extraOutside',
    'missingDate',
    'cashGap',
    'cashNaN',
  ]);
  const common = dates.map(() => 0.0003 + 0.01 * gauss(rnd));
  const walk = (returns: number[], start: number) => {
    let v = start;
    return dates.map((date, i) => {
      if (i > 0) v *= 1 + returns[i]! + cashBy.get(date)!;
      return { date, equity: v };
    });
  };
  const trials: EquitySample[][] = [];
  for (let j = 0; j < M; j++) {
    const mode = pick<TrialMode>(rnd, [
      'walk',
      'walk',
      'correlated',
      'correlated',
      'correlated',
      'copy',
      'scaled',
      'negative',
      ...(rnd() < 0.3 ? (['flat', 'cashOnly'] as const) : []),
    ]);
    const start = 1 + rnd() * 999;
    const rho = rnd();
    if (mode === 'walk') {
      trials.push(
        walk(
          dates.map(() => 0.0002 + 0.012 * gauss(rnd)),
          start,
        ),
      );
    } else if (mode === 'correlated') {
      const r = common.map((c) => rho * c + Math.sqrt(1 - rho * rho) * 0.01 * gauss(rnd));
      trials.push(walk(r, start));
    } else if (mode === 'copy' && j > 0) {
      trials.push(trials[0]!.map((p) => ({ ...p })));
    } else if (mode === 'scaled' && j > 0) {
      trials.push(trials[0]!.map((p) => ({ date: p.date, equity: p.equity * 3 })));
    } else if (mode === 'negative') {
      trials.push(
        walk(
          common.map((c) => -0.5 * c),
          start,
        ),
      );
    } else if (mode === 'flat') {
      trials.push(dates.map((date) => ({ date, equity: start })));
    } else if (mode === 'cashOnly') {
      trials.push(
        walk(
          dates.map(() => 0),
          start,
        ),
      );
    } else {
      trials.push(walk(common, start));
    }
  }
  if (M > 0 && fault !== 'none') {
    const j = Math.floor(rnd() * M);
    const t = trials[j]!;
    const i = Math.floor(rnd() * t.length);
    if (fault === 'wiped') t[i]!.equity = rnd() < 0.5 ? 0 : -1;
    else if (fault === 'missingDate' && t.length > 2)
      t.splice(1 + Math.floor(rnd() * (t.length - 2)), 1);
    else if (fault === 'extraInside' && t.length > 2) {
      // A date between two sessions that only this trial has (inside the common range).
      const k = 1 + Math.floor(rnd() * (t.length - 2));
      const gap = addDays(t[k - 1]!.date, 1);
      if (gap < t[k]!.date) t.splice(k, 0, { date: gap, equity: t[k - 1]!.equity * 1.001 });
    } else if (fault === 'extraOutside' && t.length > 0) {
      t.unshift({ date: addDays(t[0]!.date, -3), equity: t[0]!.equity * 0.99 });
      t.push({ date: addDays(t.at(-1)!.date, 2), equity: t.at(-1)!.equity * 1.01 });
    } else if (fault === 'cashGap') cashBy.delete(dates[1 + Math.floor(rnd() * (n - 1))] ?? '');
    else if (fault === 'cashNaN') cashBy.set(dates.at(-1)!, Number.NaN);
  }
  return {
    input: { trials, cashReturn: (d) => cashBy.get(d) },
    selected: M === 0 ? 0 : Math.floor(rnd() * M),
    partitions: pick(rnd, [2, 4, 4, 6, 8, 8, 10, 16]),
  };
}

/** The overfitting statistics of one case, core and reference, compared one by one. */
function compareTrials(c: TrialsCase, label: string): string | undefined {
  const core = () => overfitting({ ...c.input, selected: c.selected, partitions: c.partitions });
  const dsr = compare(
    () => core().deflatedSharpe,
    () => refDeflatedSharpe({ ...c.input, selected: c.selected }),
    `${label} deflatedSharpe`,
  );
  // No trial: both throw on `selected` (compared above). The reference's effective trials and
  // PBO of trials take no `selected`, so they have nothing to compare there.
  if (c.input.trials.length === 0) return dsr;
  return (
    dsr ??
    compare(
      () => core().effectiveTrials,
      () => refEffectiveTrialsOfTrials(c.input),
      `${label} effectiveTrials`,
    ) ??
    compare(
      () => core().overfittingProbability,
      () => refPbo({ ...c.input, partitions: c.partitions }),
      `${label} overfittingProbability`,
    )
  );
}

describe('overfitting statistics: core vs reference', () => {
  it('agree on random trials (value or no value, reason, values within 1e-9)', () => {
    const reasons = new Map<string, number>();
    for (let seed = 1; seed <= 400; seed++) {
      const c = buildTrials(seed);
      const d = compareTrials(c, `seed ${seed}`);
      if (d) throw new Error(d);
      // No trial: both throw (compared above), so no reasons to count.
      if (c.input.trials.length === 0) continue;
      const r = overfitting({ ...c.input, selected: c.selected, partitions: c.partitions });
      for (const s of Object.values(r)) {
        const key = s.ok ? 'ok' : s.reason;
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
    }
    // The random inputs reach every outcome the trials can have.
    for (const k of [
      'ok',
      'tooFewTrials',
      'equityNotPositive',
      'datesDiffer',
      'tooShort',
      'cashRateMissing',
      'noDispersion',
    ]) {
      expect(reasons.get(k) ?? 0, k).toBeGreaterThan(0);
    }
  }, 120_000);

  it('tied trials: copies and scaled copies (rho 1, N 1, tied Sharpes)', () => {
    const rnd = random(201);
    const dates = sessions(rnd, '2018-01-02', 400);
    let v = 100;
    const a = dates.map((date, i) => {
      if (i > 0) v *= 1 + 0.0004 + 0.01 * gauss(rnd);
      return { date, equity: v };
    });
    const cash = () => 0.0001;
    for (const trials of [
      [a, a],
      [a, a, a, a],
      [a, a.map((p) => ({ date: p.date, equity: p.equity * 7 }))],
    ]) {
      for (const partitions of [2, 8, 16]) {
        const c: TrialsCase = { input: { trials, cashReturn: cash }, selected: 1, partitions };
        expect(compareTrials(c, `${trials.length} copies, S ${partitions}`)).toBeUndefined();
      }
    }
    const r = overfitting({ trials: [a, a], cashReturn: cash, selected: 0 });
    expect(r.effectiveTrials.ok && r.effectiveTrials.value.effective).toBe(1);
    // Every split ranks the tied copies at the median: lambda = 0 counts as overfit.
    expect(r.overfittingProbability.ok && r.overfittingProbability.value.pbo).toBe(1);
  });

  it('flat trials and trials growing at the cash rate have no dispersion', () => {
    const dates = sessions(random(202), '2018-01-02', 120);
    const cash = () => 0.0001;
    const flat = dates.map((date) => ({ date, equity: 50 }));
    let v = 10;
    const atCash = dates.map((date, i) => {
      if (i > 0) v *= 1.0001;
      return { date, equity: v };
    });
    let w = 10;
    const rnd = random(203);
    const walk = dates.map((date, i) => {
      if (i > 0) w *= 1 + 0.01 * gauss(rnd);
      return { date, equity: w };
    });
    for (const trials of [[flat], [atCash], [walk, flat], [walk, atCash], [flat, walk]]) {
      const c: TrialsCase = { input: { trials, cashReturn: cash }, selected: 0, partitions: 4 };
      expect(compareTrials(c, 'no dispersion')).toBeUndefined();
      expect(overfitting({ ...c.input, selected: 0 }).deflatedSharpe).toEqual({
        ok: false,
        reason: 'noDispersion',
      });
    }
  });

  it('date gaps: a date inside the common range on one trial only is datesDiffer; outside it is cut', () => {
    const rnd = random(204);
    const dates = sessions(rnd, '2019-01-02', 200).filter((_, i) => i % 2 === 0);
    const mk = (ds: string[]) => {
      let v = 10;
      return ds.map((date, i) => {
        if (i > 0) v *= 1 + 0.01 * gauss(rnd);
        return { date, equity: v };
      });
    };
    const a = mk(dates);
    const inside = mk([...dates, addDays(dates[50]!, 1)].sort());
    const before = mk([addDays(dates[0]!, -1), ...dates]);
    const after = mk([...dates, addDays(dates.at(-1)!, 1)]);
    const cash = () => 0.0001;
    for (const trials of [
      [a, inside],
      [inside, a],
      [a, before],
      [after, a],
      [a, before, after],
    ]) {
      expect(
        compareTrials({ input: { trials, cashReturn: cash }, selected: 0, partitions: 4 }, 'gaps'),
      ).toBeUndefined();
    }
    expect(
      overfitting({ trials: [a, inside], cashReturn: cash, selected: 0 }).deflatedSharpe,
    ).toEqual({ ok: false, reason: 'datesDiffer' });
    expect(
      overfitting({ trials: [a, before, after], cashReturn: cash, selected: 0 }).deflatedSharpe.ok,
    ).toBe(true);
  });

  it('the PBO dispersion floor: clearly above and clearly below 1e-9 x S2 / m', () => {
    // x = c + eps x noise: within a set var / (S2 / m) is about (eps / c)^2 x var(noise), so
    // eps / c = 1e-4 (ratio about 1e-8, ten times above the floor) and 1e-5.5 (about 1e-11,
    // a hundred times below) leave no doubt; the trials' own sd stays far above 1e-12.
    for (const [ratio, expected] of [
      [1e-4, true],
      [10 ** -5.5, false],
    ] as const) {
      for (let seed = 0; seed < 6; seed++) {
        const rnd = random(300 + seed);
        const dates = sessions(rnd, '2016-01-04', 1 + 16 * 40);
        const cash = () => 0.00005;
        const trials = [0, 1, 2].map(() => {
          const c = 0.001 * (1 + rnd());
          let v = 100;
          return dates.map((date, i) => {
            if (i > 0) v *= 1 + c + c * ratio * gauss(rnd) + 0.00005;
            return { date, equity: v };
          });
        });
        // A walk beside them, so only the constant-like trials sit near the floor.
        let w = 100;
        trials.push(
          dates.map((date, i) => {
            if (i > 0) w *= 1 + 0.01 * gauss(rnd);
            return { date, equity: w };
          }),
        );
        const c: TrialsCase = { input: { trials, cashReturn: cash }, selected: 0, partitions: 16 };
        expect(compareTrials(c, `floor ratio ${ratio}, seed ${seed}`)).toBeUndefined();
        expect(overfitting({ ...c.input, selected: 0 }).overfittingProbability.ok).toBe(expected);
      }
    }
  });

  it('effective trials from a returns matrix (empty, one return, unequal rows, non-finite)', () => {
    const rnd = random(205);
    for (let c = 0; c < 300; c++) {
      const M = pick(rnd, [0, 1, 2, 3, 6]);
      const T = pick(rnd, [0, 1, 2, 3, 20, 200]);
      const base = Array.from({ length: T }, () => gauss(rnd) * 0.01);
      const rows = Array.from({ length: M }, () => {
        const u = rnd();
        if (u < 0.1) return base.map(() => 0.0004);
        if (u < 0.3) return [...base];
        if (u < 0.4) return base.map((x) => -x);
        return base.map((x) => (rnd() < 0.5 ? x : 0) + 0.01 * gauss(rnd));
      });
      if (M > 0 && rnd() < 0.05) rows[0] = rows[0]!.slice(1);
      if (M > 0 && T > 0 && rnd() < 0.05) rows[0]![0] = pick(rnd, [Number.NaN, Infinity]);
      agree(
        () => effectiveTrials(rows),
        () => refEffectiveTrials(rows),
        `matrix case ${c}`,
      );
    }
  });

  it('the deflated Sharpe ratio from its moments, the paper example included', () => {
    const rnd = random(206);
    const cases = [
      {
        sharpe: 2.5 / Math.sqrt(250),
        returns: 1250,
        skewness: -3,
        kurtosis: 10,
        variance: 0.5 / 250,
        N: 100,
      },
    ];
    for (let c = 0; c < 500; c++) {
      const skewness = (rnd() * 2 - 1) * 2;
      cases.push({
        sharpe: (rnd() * 2 - 1) * 0.3,
        returns: pick(rnd, [20, 21, 250, 1250, 5000]),
        skewness,
        kurtosis: skewness * skewness + 1 + rnd() * 20,
        variance: pick(rnd, [0, 1e-6, 0.002, 0.03]),
        N: pick(rnd, [1, 1 + 1e-9, 1.1, 1.3, 1.5, 2, 7.3, 100, 1000]),
      });
    }
    for (const m of cases) {
      const core = deflatedSharpeFromMoments({
        sharpe: m.sharpe,
        returns: m.returns,
        skewness: m.skewness,
        kurtosis: m.kurtosis,
        trialSharpeVariance: m.variance,
        effectiveTrials: m.N,
      });
      const ref = refDeflatedSharpeFromMoments({
        sharpe: m.sharpe,
        returns: m.returns,
        skewness: m.skewness,
        kurtosis: m.kurtosis,
        sharpeVariance: m.variance,
        effectiveTrials: m.N,
      });
      expect(core.ok, JSON.stringify(m)).toBe(ref.ok);
      if (core.ok && ref.ok) {
        const at = JSON.stringify(m);
        expect(close(core.value.probability, ref.value.probability), at).toBe(true);
        expect(close(core.value.expectedMaxSharpe, ref.value.expectedMaxSharpe), at).toBe(true);
      } else if (!core.ok && !ref.ok) expect(core.reason).toBe(ref.reason);
    }
    const paper = deflatedSharpeFromMoments({
      sharpe: 2.5 / Math.sqrt(250),
      returns: 1250,
      skewness: -3,
      kurtosis: 10,
      trialSharpeVariance: 0.5 / 250,
      effectiveTrials: 100,
    });
    expect(paper.ok && paper.value.probability).toBeCloseTo(0.9004, 4);
  });

  it('refuses the same selected trials and partitions', () => {
    const rnd = random(207);
    const dates = sessions(rnd, '2018-01-02', 60);
    const walk = () => {
      let v = 10;
      return dates.map((date, i) => {
        if (i > 0) v *= 1 + 0.01 * gauss(rnd);
        return { date, equity: v };
      });
    };
    const trials: TrialsInput = { trials: [walk(), walk(), walk()], cashReturn: () => 0.0001 };
    const M = trials.trials.length;
    for (const selected of [-1, M, 0.5, Number.NaN]) {
      bothThrow(
        () => overfitting({ ...trials, selected }),
        () => refDeflatedSharpe({ ...trials, selected }),
        `selected ${selected}`,
      );
    }
    for (const partitions of [0, 1, 3, -2, 2.5, Number.NaN]) {
      bothThrow(
        () => overfitting({ ...trials, selected: 0, partitions }),
        () => refPbo({ ...trials, partitions }),
        `partitions ${partitions}`,
      );
    }
    // A malformed equity series is refused before any no-value reason.
    for (const bad of [
      [{ date: '2021-02-29', equity: 1 }],
      [{ date: '2021-01-04', equity: Number.NaN }],
      [
        { date: '2021-01-05', equity: 1 },
        { date: '2021-01-04', equity: 1 },
      ],
    ]) {
      const input = { trials: [...trials.trials, bad], cashReturn: trials.cashReturn };
      bothThrow(
        () => overfitting({ ...input, selected: 0 }),
        () => refDeflatedSharpe({ ...input, selected: 0 }),
        `bad series ${JSON.stringify(bad)}`,
      );
      bothThrow(
        () => overfitting({ ...input, selected: 0 }),
        () => refPbo(input),
        `bad series ${JSON.stringify(bad)} (PBO)`,
      );
    }
  });
});

// ---- Walk-forward folds ----

/** A strategy series, a benchmark on partly other dates (some before and after), and the cash. */
function buildPeriods(seed: number) {
  const rnd = random(seed);
  const n = pick(rnd, [0, 1, 2, 30, 300, 600, 900, 1500, 2600]);
  const dates = sessions(rnd, addDays('1999-06-01', Math.floor(rnd() * 4000)), n, rnd() < 0.3);
  const mode = pick(rnd, ['walk', 'walk', 'walk', 'flat', 'wiped', 'same']);
  let v = 1 + rnd() * 99;
  const points = dates.map((date, i) => {
    if (i > 0 && mode !== 'flat') v *= Math.max(0.5, 1 + 0.0003 + 0.012 * gauss(rnd));
    return { date, equity: v };
  });
  if (mode === 'wiped' && n > 0) points[Math.floor(rnd() * n)]!.equity = rnd() < 0.5 ? 0 : -2;
  const keep = pick(rnd, [1, 0.97, 0.6]);
  const set = new Set<string>();
  const extendBefore = rnd() < 0.3 && n > 0;
  const extendAfter = rnd() < 0.3 && n > 0;
  if (extendBefore) for (let k = 1; k <= 40; k++) set.add(addDays(dates[0]!, -2 * k));
  for (const d of dates) {
    if (rnd() < keep) set.add(d);
    if (rnd() < 0.05) set.add(addDays(d, 1));
  }
  if (extendAfter) for (let k = 1; k <= 400; k++) set.add(addDays(dates.at(-1)!, 2 * k));
  const benchDates = [...set].sort();
  let b = 50 + rnd() * 50;
  const at = new Map(points.map((p) => [p.date, p.equity]));
  const benchmark = benchDates.map((date) => {
    if (mode === 'same' && at.has(date)) b = at.get(date)!;
    else b *= Math.max(0.5, 1 + 0.0002 + 0.01 * gauss(rnd));
    return { date, equity: b };
  });
  const cashMode = pick(rnd, ['full', 'full', 'full', 'gap', 'none']);
  const gapDate = dates[Math.floor(rnd() * Math.max(1, n))];
  const cashReturn = (d: string) =>
    cashMode === 'none' || (cashMode === 'gap' && d === gapDate) ? undefined : 0.0001;
  return {
    rnd,
    points,
    benchmark,
    cashReturn,
    extendAfter,
    folds: pick(rnd, [2, 3, 5, 10, 10, 12]),
  };
}

describe('walk-forward folds: core vs reference', () => {
  it("a benchmark point after the strategy's last date is in no fold (same period for both)", () => {
    const rnd = random(1300);
    const dates = sessions(rnd, '2012-01-03', 1200);
    let v = 10;
    const points = dates.map((date, i) => {
      if (i > 0) v *= 1 + 0.0003 + 0.01 * gauss(rnd);
      return { date, equity: v };
    });
    let b = 10;
    const benchmark = [...dates, ...sessions(rnd, addDays(dates.at(-1)!, 1), 200)].map(
      (date, i) => {
        if (i > 0) b *= 1 + 0.0002 + 0.01 * gauss(rnd);
        return { date, equity: b };
      },
    );
    const cut = benchmark.filter((p) => p.date <= dates.at(-1)!);
    const input = { points, benchmark, cashReturn: () => 0.0001, folds: 4 };
    agree(
      () => walkForward(input),
      () => refWalkForward(input),
      'benchmark past the end',
    );
    expect(walkForward(input)).toEqual(walkForward({ ...input, benchmark: cut }));
  });

  it('agree on random series (folds, reasons, Sharpe ratios within 1e-9)', () => {
    let measured = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const c = buildPeriods(1000 + seed);
      const input = {
        points: c.points,
        benchmark: c.benchmark,
        cashReturn: c.cashReturn,
        folds: c.folds,
      };
      const d = compare(
        () => walkForward(input),
        () => refWalkForward(input),
        `seed ${1000 + seed}`,
      );
      if (d) throw new Error(d);
      const r = walkForward(input);
      if (r.ok) measured++;
    }
    expect(measured).toBeGreaterThan(30);
  });

  it('refuses the same malformed series and fold counts', () => {
    const c = buildPeriods(1200);
    const ok = { points: c.points, benchmark: c.benchmark, cashReturn: c.cashReturn };
    for (const folds of [0, 1.5, -2, Number.NaN]) {
      bothThrow(
        () => walkForward({ ...ok, folds }),
        () => refWalkForward({ ...ok, folds }),
        `folds ${folds}`,
      );
    }
    const bad = [{ date: '2020-13-01', equity: 1 }];
    bothThrow(
      () => walkForward({ ...ok, benchmark: bad }),
      () => refWalkForward({ ...ok, benchmark: bad }),
      'bad benchmark',
    );
  });
});

// ---- Crisis replays ----

const TEMPLATE = crisisTemplate as CrisisWindow[];

describe('crisis replays: core vs reference', () => {
  it('agree on the template windows and random windows', () => {
    let covered = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const c = buildPeriods(2000 + seed);
      const all = [...c.points, ...c.benchmark].map((p) => p.date).sort();
      const windows: CrisisWindow[] = TEMPLATE.filter(() => c.rnd() < 0.7);
      const extra = Math.floor(c.rnd() * 5);
      for (let k = 0; k < extra && all.length > 0; k++) {
        const start = c.rnd() < 0.8 ? pick(c.rnd, all) : addDays(all[0]!, -10);
        const end =
          c.rnd() < 0.8 ? addDays(start, 1 + Math.floor(c.rnd() * 300)) : pick(c.rnd, all);
        if (start < end) windows.push({ id: `w${k}`, start, end, source: 'made up' });
      }
      const input = { points: c.points, benchmark: c.benchmark, windows };
      const d = compare(
        () => crisisReplays(input),
        () => refCrisisReplays({ strategy: c.points, benchmark: c.benchmark, windows }),
        `seed ${2000 + seed}`,
      );
      if (d) throw new Error(d);
      const r = crisisReplays(input);
      if (r.ok) covered += r.value.covered;
    }
    expect(covered).toBeGreaterThan(50);
  });

  it('flat series tie (never shallower); an empty list is notCovered', () => {
    const dates = sessions(random(2400), '2007-01-03', 900);
    const flat = dates.map((date) => ({ date, equity: 10 }));
    const flat2 = dates.map((date) => ({ date, equity: 99 }));
    for (const windows of [TEMPLATE, []]) {
      agree(
        () => crisisReplays({ points: flat, benchmark: flat2, windows }),
        () => refCrisisReplays({ strategy: flat, benchmark: flat2, windows }),
        `flat, ${windows.length} windows`,
      );
    }
  });

  it('refuses the same malformed windows', () => {
    const c = buildPeriods(2500);
    const w = TEMPLATE[0]!;
    for (const windows of [
      [w, w],
      [{ ...w, start: w.end, end: w.start }],
      [{ ...w, end: w.start }],
      [{ ...w, start: '2001-02-29' }],
      [{ ...w, id: '' }],
      [{ ...w, source: undefined as unknown as string }],
      undefined as unknown as CrisisWindow[],
    ]) {
      bothThrow(
        () => crisisReplays({ points: c.points, benchmark: c.benchmark, windows }),
        () => refCrisisReplays({ strategy: c.points, benchmark: c.benchmark, windows }),
        JSON.stringify(windows),
      );
    }
  });
});

// ---- Parameter sweep ----

const SWEEP_BASE = Strategy.parse({
  name: 'Trend',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'up',
      type: 'compare',
      left: { indicator: 'price', ticker: 'X', totalReturn: true },
      op: '>',
      right: { indicator: 'sma', ticker: 'X', length: 200, totalReturn: true },
      tolerancePct: 1,
    },
    {
      id: 'calm',
      type: 'compare',
      left: { indicator: 'volatility', ticker: 'X', length: 20 },
      op: '<',
      right: { threshold: 30 },
    },
  ],
  allocations: [
    { name: 'In', when: { all: ['up', 'calm'] }, holdings: [{ ticker: 'X', weight: 100 }] },
    { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  ],
});

const SWEEP_PARAMETERS: SweepParameter[] = [
  { paths: [['signals', 0, 'right', 'length']], values: [50, 100, 150, 200, -5] },
  { paths: [['signals', 0, 'tolerancePct']], values: [0, 1, 2] },
  {
    paths: [
      ['signals', 1, 'left', 'length'],
      ['signals', 1, 'right', 'threshold'],
    ],
    values: [10, 20, 'x'],
  },
  { paths: [['allocations', 0, 'holdings', 0, 'ticker']], values: ['X', 'Y'] },
  { paths: [['name']], values: ['A', ''] },
];

describe('parameter sweep: core vs reference', () => {
  const validate = (s: unknown) => {
    const r = Strategy.safeParse(s);
    return r.success
      ? { ok: true as const, strategy: r.data }
      : { ok: false as const, error: 'invalid' };
  };
  /** A cheap evaluation that depends on the whole variant. */
  const evaluate = (s: Strategy) => JSON.stringify(s).length;
  const shape = (
    rows: {
      index: number[];
      values: unknown[];
      strategy?: unknown;
      error?: unknown;
      result?: unknown;
    }[],
  ) =>
    rows.map((r) => ({
      index: r.index,
      values: r.values,
      strategy: r.strategy,
      invalid: r.error !== undefined,
      result: r.result,
    }));

  it('the same variants in the same order, invalid ones kept, the same neighbors', () => {
    const rnd = random(3000);
    for (let c = 0; c < 60; c++) {
      const grid = SWEEP_PARAMETERS.filter(() => rnd() < 0.5).map((p) => ({
        paths: p.paths,
        values: p.values.filter(() => rnd() < 0.8),
      }));
      if (grid.some((p) => p.values.length === 0)) continue;
      const core = sweep(SWEEP_BASE, grid, evaluate);
      const ref = refSweep(SWEEP_BASE, grid, validate, evaluate);
      expect(shape(core), `grid ${JSON.stringify(grid)}`).toEqual(shape(ref));
      const sizes = grid.map((p) => p.values.length);
      for (const v of core) {
        expect(neighbors(v.index, grid)).toEqual(refNeighbors(sizes, v.index));
      }
    }
  });

  it('refuses the same grids: missing paths, overlaps, repeats, empty lists', () => {
    const L = ['signals', 0, 'right', 'length'];
    for (const grid of [
      [{ paths: [['signals', 0, 'right', 'lenght']], values: [1] }],
      [{ paths: [['signals', 5, 'right']], values: [1] }],
      [{ paths: [['signals', '0', 'right']], values: [1] }],
      [{ paths: [[]], values: [1] }],
      [{ paths: [], values: [1] }],
      [{ paths: [L], values: [] }],
      [{ paths: [L], values: [1, 2, 1] }],
      [
        { paths: [L], values: [1] },
        { paths: [L], values: [2] },
      ],
      [
        { paths: [['signals', 0, 'right']], values: [{}] },
        { paths: [L], values: [2] },
      ],
      [
        { paths: [L], values: [2] },
        { paths: [['signals', 0]], values: [{}] },
      ],
    ] as SweepParameter[][]) {
      bothThrow(
        () => sweep(SWEEP_BASE, grid, evaluate),
        () => refSweep(SWEEP_BASE, grid, validate, evaluate),
        JSON.stringify(grid),
      );
    }
  });
});

// ---- Monte Carlo goal projection ----

/** Raw bars of a few series ending on one date, with gaps, splits, dividends, missing fields. */
function buildHistory(rnd: Rnd, count: number, sessionsCount: number) {
  const names = ['B', 'A', 'C'].slice(0, count);
  const dates = sessions(rnd, '2021-01-04', sessionsCount);
  const history: Record<string, RawBar[]> = {};
  for (const name of names) {
    const adjusted = rnd() < 0.5;
    let close = 20 + rnd() * 200;
    const bars: RawBar[] = [];
    dates.forEach((date, i) => {
      // A series missing a session (not the last): that day and the next are no sample day.
      if (i > 0 && i < dates.length - 1 && rnd() < 0.01) return;
      const split = !adjusted && i > 0 && rnd() < 0.004 ? pick(rnd, [2, 3, 0.5]) : 1;
      close = (close * Math.max(0.6, 1 + 0.0003 + 0.015 * gauss(rnd))) / split;
      const bar: RawBar = {
        date,
        close,
        closeIsSplitAdjusted: adjusted,
        divCash: rnd() < 0.02 ? close * 0.01 : 0,
        splitFactor: split,
      };
      if (rnd() < 0.95) {
        bar.open = close * (1 + 0.003 * gauss(rnd));
        bar.high = Math.max(close, bar.open) * (1 + 0.004 * rnd());
        bar.low = Math.min(close, bar.open) * (1 - 0.004 * rnd());
      }
      bars.push(bar);
    });
    history[name] = bars;
  }
  return { history, dates };
}

/**
 * A cheap deterministic strategy run: each series' daily total return, an equal-weight position
 * in the series whose close is above its 5-bar mean (decided at a close, held from the next day,
 * with `leverage`), equity from the first series' date `from` on. Series in sorted order, so the
 * run does not depend on the record's key order.
 */
function trendRun(leverage: number, from: string, peek: 'none' | 'equity' | 'decision' = 'none') {
  return (bars: Record<string, readonly RawBar[]>): ProjectionPoint[] => {
    const names = Object.keys(bars).sort();
    const first = bars[names[0]!]!;
    const byDate = names.map((n) => new Map(bars[n]!.map((b, i) => [b.date, i])));
    const out: ProjectionPoint[] = [];
    let equity = 1;
    let held: Record<string, number> = {};
    for (let t = 0; t < first.length; t++) {
      const date = first[t]!.date;
      if (date < from) continue;
      if (out.length > 0) {
        let r = 0;
        names.forEach((n, s) => {
          const i = byDate[s]!.get(date);
          const w = held[n] ?? 0;
          if (i === undefined || i === 0 || w === 0) return;
          const b = bars[n]![i]!;
          const k = b.closeIsSplitAdjusted ? 1 : b.splitFactor;
          r += w * (((b.close + b.divCash) * k) / bars[n]![i - 1]!.close - 1);
        });
        equity *= 1 + leverage * r;
      }
      const decision: Record<string, number> = {};
      names.forEach((n, s) => {
        let i = byDate[s]!.get(date);
        if (i === undefined) return;
        // A run that reads tomorrow's bar (the look-ahead the guard is there to catch).
        if (peek === 'decision' && i + 1 < bars[n]!.length) i++;
        const list = bars[n]!;
        const from = Math.max(0, i - 4);
        let sum = 0;
        for (let j = from; j <= i; j++) sum += list[j]!.close;
        if (list[i]!.close > sum / (i - from + 1)) decision[n] = 1 / names.length;
      });
      const peeked =
        peek === 'equity' && t + 2 < first.length ? first[t + 2]!.close / first[t]!.close : 1;
      out.push({ date, equity: equity * peeked, weights: { ...held }, decision });
      held = decision;
    }
    return out;
  };
}

describe('goal projection: core vs reference', () => {
  const asRef = (x: GoalProjectionInput) => x as unknown as RefProjectionInput;

  function buildProjection(seed: number): GoalProjectionInput {
    const rnd = random(seed);
    const { history, dates } = buildHistory(
      rnd,
      pick(rnd, [1, 2, 3]),
      pick(rnd, [200, 260, 300, 420]),
    );
    const h = dates.at(-1)!;
    const future = sessions(rnd, addDays(h, 1 + Math.floor(rnd() * 3)), pick(rnd, [1, 2, 25, 70]));
    const input: GoalProjectionInput = {
      history,
      future,
      run: trendRun(pick(rnd, [1, 1, 2, 40]), dates.at(-pick(rnd, [1, 5, 30]))!),
      initial: pick(rnd, [0, 1000, 25000.5]),
      monthly: pick(rnd, [0, 0, 100, 750.25]),
      goal: pick(rnd, [1, 1000, 1100, 30000, 1e9]),
      currency: 'XYZ',
      seed: rnd() < 0.2 ? pick(rnd, [0, 4294967295]) : word(rnd),
      paths: pick(rnd, [1, 2, 7, 20, 40]),
      meanBlock: pick(rnd, [1, 1.5, 5, 20, 300]),
    };
    if (rnd() < 0.3) input.sampleFrom = dates[Math.floor(rnd() * 120)]!;
    return input;
  }

  it('agree on random histories, futures and runs (draws, money, interval, percentiles)', () => {
    let measured = 0;
    let reached = 0;
    let missed = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const input = buildProjection(4000 + seed);
      const d = compare(
        () => goalProjection(input),
        () => refGoalProjection(asRef(input)),
        `seed ${4000 + seed}`,
      );
      if (d) throw new Error(d);
      const r = goalProjection(input);
      if (r.ok) {
        measured++;
        reached += r.value.reached;
        missed += r.value.paths - r.value.reached;
      }
    }
    expect(measured).toBeGreaterThan(40);
    expect(reached).toBeGreaterThan(0);
    expect(missed).toBeGreaterThan(0);
  }, 60_000);

  it('the same no-value reasons: a short sample, an equity at the start <= 0', () => {
    const rnd = random(4500);
    const { history, dates } = buildHistory(rnd, 2, 300);
    const base: GoalProjectionInput = {
      history,
      future: sessions(rnd, addDays(dates.at(-1)!, 1), 30),
      run: trendRun(1, dates.at(-10)!),
      initial: 1000,
      monthly: 10,
      goal: 1000,
      currency: 'XYZ',
      seed: 9,
      paths: 5,
    };
    const cases: GoalProjectionInput[] = [
      { ...base, sampleFrom: dates[100]! },
      { ...base, history: { A: history.A!.slice(-200) } },
      {
        ...base,
        run: (b) => trendRun(1, dates.at(-10)!)(b).map((p) => ({ ...p, equity: p.equity - 1 })),
      },
      {
        ...base,
        run: (b) => trendRun(1, dates.at(-10)!)(b).map((p) => ({ ...p, equity: -p.equity })),
      },
    ];
    for (const [k, input] of cases.entries()) {
      const r = goalProjection(input);
      expect(r.ok, `case ${k}`).toBe(false);
      agree(
        () => goalProjection(input),
        () => refGoalProjection(asRef(input)),
        `case ${k}`,
      );
    }
  });

  it('a wiped-out path is lost, on both', () => {
    const rnd = random(4600);
    const { history, dates } = buildHistory(rnd, 1, 300);
    const input: GoalProjectionInput = {
      history,
      future: sessions(rnd, addDays(dates.at(-1)!, 1), 120),
      run: trendRun(80, dates.at(-3)!),
      initial: 1000,
      monthly: 500,
      goal: 1,
      currency: 'XYZ',
      seed: 12,
      paths: 30,
      meanBlock: 3,
    };
    const r = goalProjection(input);
    expect(r.ok && r.value.reached < r.value.paths && r.value.endValues.p5).toBe(0);
    agree(
      () => goalProjection(input),
      () => refGoalProjection(asRef(input)),
      'wiped out',
    );
  });

  it('the look-ahead guard refuses the same runs (equity two days ahead, decision one day ahead)', () => {
    const rnd = random(4700);
    const { history, dates } = buildHistory(rnd, 2, 300);
    const base: GoalProjectionInput = {
      history,
      future: sessions(rnd, addDays(dates.at(-1)!, 1), 20),
      run: trendRun(1, dates.at(-10)!),
      initial: 1000,
      monthly: 0,
      goal: 1000,
      currency: 'XYZ',
      seed: 3,
      paths: 6,
    };
    for (const peek of ['equity', 'decision'] as const) {
      const input = { ...base, run: trendRun(1, dates.at(-10)!, peek) };
      bothThrow(
        () => goalProjection(input),
        () => refGoalProjection(asRef(input)),
        `peek ${peek}`,
      );
    }
  });

  it('refuses the same malformed inputs', () => {
    const rnd = random(4800);
    const { history, dates } = buildHistory(rnd, 2, 300);
    const h = dates.at(-1)!;
    const base = (): GoalProjectionInput => ({
      history: structuredClone(history),
      future: sessions(random(4801), addDays(h, 1), 20),
      run: trendRun(1, dates.at(-10)!),
      initial: 1000,
      monthly: 0,
      goal: 1000,
      currency: 'XYZ',
      seed: 3,
      paths: 4,
    });
    const bar = (x: GoalProjectionInput, i: number) => x.history.A![i] as RawBar;
    const faults: ((x: GoalProjectionInput) => void)[] = [
      (x) => (x.history = {}),
      (x) => (x.history.A = []),
      (x) => (bar(x, 5).date = '2021-02-30'),
      (x) => (bar(x, 5).date = bar(x, 4).date),
      (x) => (bar(x, 5).close = 0),
      (x) => (bar(x, 5).close = Number.NaN),
      (x) => (bar(x, 5).splitFactor = 0),
      (x) => (bar(x, 5).divCash = Number.NaN),
      (x) => (bar(x, 5).open = Infinity),
      (x) => (bar(x, 5).low = Number.NaN),
      (x) => (x.history.A = x.history.A!.slice(0, -1)),
      (x) => (x.future = []),
      (x) => (x.future = [h, ...x.future]),
      (x) => (x.future = [x.future[1]!, x.future[0]!, ...x.future.slice(2)]),
      (x) => (x.future = [...x.future, '2099-02-29']),
      (x) => (x.initial = -1),
      (x) => (x.monthly = Number.NaN),
      (x) => (x.goal = 0),
      (x) => (x.goal = Infinity),
      (x) => (x.currency = ''),
      (x) => (x.seed = -1),
      (x) => (x.seed = 4294967296),
      (x) => (x.seed = 1.5),
      (x) => (x.paths = 0),
      (x) => (x.paths = 2.5),
      (x) => (x.meanBlock = 0.5),
      (x) => (x.meanBlock = Number.NaN),
      (x) => (x.sampleFrom = '2021-13-01'),
      (x) => (x.run = (b) => trendRun(1, dates.at(-10)!)(b).slice(0, -1)),
      (x) =>
        (x.run = (b) =>
          trendRun(
            1,
            dates.at(-10)!,
          )(b).map((p, i) => (i === 12 ? { ...p, equity: Number.NaN } : p))),
    ];
    for (const [k, fault] of faults.entries()) {
      const input = base();
      fault(input);
      bothThrow(
        () => goalProjection(input),
        () => refGoalProjection(asRef(input)),
        `fault ${k}`,
      );
    }
  });
});

// ---- Wilson interval and the near-tie rule ----

describe('Wilson interval and near ties: core vs reference', () => {
  it('Wilson at 95% for every k of small n and random k of large n', () => {
    const rnd = random(5000);
    const cases: [number, number][] = [];
    for (let n = 1; n <= 120; n++) for (let k = 0; k <= n; k++) cases.push([k, n]);
    for (const n of [999, 1000, 10_000, 1_000_000]) {
      for (const k of [0, 1, 2, n - 1, n, Math.floor(n / 2)]) cases.push([k, n]);
      for (let c = 0; c < 50; c++) cases.push([Math.floor(rnd() * (n + 1)), n]);
    }
    for (const [k, n] of cases) {
      agree(
        () => wilson95(k, n),
        () => refWilson(k, n),
        `wilson(${k}, ${n})`,
      );
    }
  });

  it('the near-tie rule on pairs clearly inside and clearly outside the band, zeros included', () => {
    const rnd = random(5001);
    const pairs: [number, number][] = [
      [0, 0],
      [0, -0],
      [0, 1e-300],
      [1, 1],
    ];
    for (let c = 0; c < 2000; c++) {
      const a = (rnd() * 2 - 1) * 10 ** (Math.floor(rnd() * 20) - 10);
      const step = pick(rnd, [0, 1e-12, 1e-10, 1e-8, 1e-6, 1]);
      pairs.push([a, a * (1 + (rnd() < 0.5 ? step : -step))]);
    }
    for (const [a, b] of pairs) expect(nearTie(a, b), `${a}, ${b}`).toBe(refNearTie(a, b));
  });
});

// ---- Caller errors and the order of reasons (docs/analytics.md, settled 2026-11-02) ----
//
// The eight readings the first comparison found open, now asserted. A caller error throws before
// any no-value reason; for PBO fewer than 2 trials comes first; an empty walk-forward fold has no
// `end`; each crisis result repeats its window's source.

describe('caller errors and the order of reasons: core vs reference', () => {
  const rnd = random(6000);
  const dates = sessions(rnd, '2018-01-02', 80);
  const walk = () => {
    let v = 10;
    return dates.map((date, i) => {
      if (i > 0) v *= 1 + 0.01 * gauss(rnd);
      return { date, equity: v };
    });
  };
  const cash = () => 0.0001;

  it('1. PBO of one trial is tooFewTrials before any per-trial reason', () => {
    const wiped = walk();
    wiped[5]!.equity = 0;
    const flat = dates.map((date) => ({ date, equity: 7 }));
    for (const trial of [wiped, flat, walk().slice(0, 10), walk()]) {
      const input = { trials: [trial], cashReturn: cash };
      expect(overfitting({ ...input, selected: 0 }).overfittingProbability).toEqual({
        ok: false,
        reason: 'tooFewTrials',
      });
      agree(
        () => overfitting({ ...input, selected: 0 }).overfittingProbability,
        () => refPbo(input),
        'one trial',
      );
    }
  });

  it('2. the DSR of no trial throws (no index is in range)', () => {
    bothThrow(
      () => overfitting({ trials: [], cashReturn: cash, selected: 0 }),
      () => refDeflatedSharpe({ trials: [], cashReturn: cash, selected: 0 }),
      'no trial',
    );
  });

  it('3. walk-forward with folds = 1 throws', () => {
    const points = walk();
    bothThrow(
      () => walkForward({ points, benchmark: points, cashReturn: cash, folds: 1 }),
      () => refWalkForward({ points, benchmark: points, cashReturn: cash, folds: 1 }),
      'folds 1',
    );
  });

  it('4. a walk-forward fold without an own point has no end and no value', () => {
    // Points 2 days apart, then a gap of 900 days: with 4 folds the second holds no point.
    const ds = Array.from({ length: 800 }, (_, i) => addDays('2010-01-04', 2 * i));
    const points = ds.map((d, i) => ({
      date: i < 300 ? d : addDays(d, 900),
      equity: 1 + 0.01 * Math.sin(i) + i * 0.001,
    }));
    const input = { points, benchmark: points, cashReturn: cash, folds: 4 };
    const r = walkForward(input);
    const empty = r.ok ? r.value.folds.filter((f) => f.end === undefined) : [];
    expect(empty.length).toBeGreaterThan(0);
    for (const f of empty) expect(f.strategy.ok).toBe(false);
    agree(
      () => walkForward(input),
      () => refWalkForward(input),
      'empty fold',
    );
  });

  it('5. Phi of NaN throws', () => {
    bothThrow(
      () => normalCdf(Number.NaN),
      () => refPhi(Number.NaN),
      'Phi(NaN)',
    );
  });

  describe('6. projection refusals come before its no-value reasons', () => {
    const { history, dates: hd } = buildHistory(random(6002), 1, 300);
    const base: GoalProjectionInput = {
      history,
      future: sessions(random(6003), addDays(hd.at(-1)!, 1), 20),
      run: trendRun(1, hd.at(-10)!),
      initial: 1000,
      monthly: 0,
      goal: 1000,
      currency: 'XYZ',
      seed: 5,
      paths: 3,
    };
    const asRef = (x: GoalProjectionInput) => x as unknown as RefProjectionInput;
    const withBar = (change: (b: RawBar) => void): GoalProjectionInput => {
      const h = structuredClone(history);
      change(h.B![100]!);
      return { ...base, history: h };
    };

    it('a negative divCash throws', () => {
      const input = withBar((b) => (b.divCash = -0.1));
      bothThrow(
        () => goalProjection(input),
        () => refGoalProjection(asRef(input)),
        'negative divCash',
      );
    });

    it('a closeIsSplitAdjusted that is not a boolean throws', () => {
      for (const flag of [undefined, 0, 'true']) {
        const input = withBar((b) => {
          (b as { closeIsSplitAdjusted: unknown }).closeIsSplitAdjusted = flag;
        });
        bothThrow(
          () => goalProjection(input),
          () => refGoalProjection(asRef(input)),
          `closeIsSplitAdjusted ${String(flag)}`,
        );
      }
    });

    it('fewer than 252 sample days is tooShort before any path runs', () => {
      const short = { ...base, history: { B: history.B!.slice(-252) } };
      let runs = 0;
      const counted = {
        ...short,
        run: (b: Record<string, RawBar[]>) => {
          runs++;
          return base.run(b);
        },
      };
      expect(goalProjection(counted)).toEqual({ ok: false, reason: 'tooShort' });
      expect(runs).toBe(0);
      agree(
        () => goalProjection(counted),
        () => refGoalProjection(asRef(counted)),
        '251 sample days',
      );
      expect(runs).toBe(0);
      // A run that would throw is never reached either.
      const broken = {
        ...short,
        run: (): ProjectionPoint[] => {
          throw new Error('run called');
        },
      };
      agree(
        () => goalProjection(broken),
        () => refGoalProjection(asRef(broken)),
        'tooShort, run never called',
      );
    });

    it('a session missing from the run throws before an equity at h <= 0 is no value', () => {
      const dead = (b: Record<string, readonly RawBar[]>) =>
        base.run(b as Record<string, RawBar[]>).map((p) => ({ ...p, equity: -1 }));
      const missing = { ...base, run: (b: Record<string, RawBar[]>) => dead(b).slice(0, -1) };
      bothThrow(
        () => goalProjection(missing),
        () => refGoalProjection(asRef(missing)),
        'missing session, dead at h',
      );
      const nan = {
        ...base,
        run: (b: Record<string, RawBar[]>) =>
          dead(b).map((p, i, all) => (i === all.length - 1 ? { ...p, equity: Number.NaN } : p)),
      };
      bothThrow(
        () => goalProjection(nan),
        () => refGoalProjection(asRef(nan)),
        'NaN equity, dead at h',
      );
      const deadOnly = { ...base, run: dead };
      expect(goalProjection(deadOnly)).toEqual({ ok: false, reason: 'equityNotPositive' });
      agree(
        () => goalProjection(deadOnly),
        () => refGoalProjection(asRef(deadOnly)),
        'dead at h',
      );
    });
  });

  it('7. invalid partitions throw even when the trials have a no-value reason', () => {
    const wiped = walk();
    wiped[3]!.equity = -1;
    for (const trials of [[wiped, walk()], [walk()], [walk(), walk().slice(0, 5)]]) {
      for (const partitions of [3, 0, 2.5]) {
        bothThrow(
          () => overfitting({ trials, cashReturn: cash, selected: 0, partitions }),
          () => refPbo({ trials, cashReturn: cash, partitions }),
          `partitions ${partitions}`,
        );
      }
    }
  });

  it("8. each crisis result repeats its window's source", () => {
    const points = walk();
    const windows = [{ id: 'w', start: dates[10]!, end: dates[30]!, source: 'made up' }];
    const r = crisisReplays({ points, benchmark: points, windows });
    expect(r.ok && r.value.windows[0]!.source).toBe('made up');
    agree(
      () => crisisReplays({ points, benchmark: points, windows }),
      () => refCrisisReplays({ strategy: points, benchmark: points, windows }),
      'source',
    );
  });
});
