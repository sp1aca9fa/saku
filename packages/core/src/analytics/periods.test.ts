// Walk-forward folds and crisis replays (docs/analytics.md "Statistics"); expected values worked
// out in the comments.
import { describe, expect, it } from 'vitest';
import { type EquitySample, metrics } from './metrics';
import { DEFAULT_CRISES, crisisReplays, walkForward } from './periods';
import type { Statistic } from './statistic';

const v = <T>(s: Statistic<T>): T => {
  if (!s.ok) throw new Error(`no value: ${s.reason}`);
  return s.value;
};
const reason = (s: { ok: boolean; reason?: string }) => (s.ok ? 'value' : s.reason);
const DAY = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** One point per calendar day from `start`, each day's return from `r(date)`. */
const daily = (start: string, end: string, r: (date: string, i: number) => number) => {
  const out: EquitySample[] = [];
  let e = 1;
  for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
    if (i > 0) e *= 1 + r(d, i);
    out.push({ date: d, equity: e });
  }
  return out;
};
const wiggle = (mean: number, s: number) => (_: string, i: number) =>
  i % 2 === 0 ? mean + s : mean - s;

describe('walk-forward folds', () => {
  it('cuts equal calendar spans of at least a year and compares Sharpe ratios', () => {
    // 2020-01-01 .. 2023-01-01: D = 1,096 days, K = min(10, floor(1096 / 365)) = 3.
    // Boundaries: +0, +floor(1096/3) = 365, +floor(2192/3) = 730, +1096 days.
    const strategyMean = (d: string) => (d >= '2020-12-31' && d < '2021-12-31' ? 0.0001 : 0.001);
    const points = daily('2020-01-01', '2023-01-01', (d, i) => wiggle(strategyMean(d), 0.01)(d, i));
    const benchmark = daily('2020-01-01', '2023-01-01', wiggle(0.0005, 0.01));
    const w = v(walkForward({ points, benchmark, cashReturn: () => 0 }));
    expect(w.folds.map((f) => f.start)).toEqual(['2020-01-01', '2020-12-31', '2021-12-31']);
    expect(w.folds.map((f) => f.end)).toEqual(['2020-12-30', '2021-12-30', '2023-01-01']);
    expect(w.folds.map((f) => f.beat)).toEqual([true, false, true]);
    expect(w).toMatchObject({ won: 2, measured: 3 });
    // Fold 1's series starts at the last point before its boundary (2020-12-30), so it holds
    // the returns ending 2020-12-31 .. 2021-12-30.
    const fold1 = points.filter((p) => p.date >= '2020-12-30' && p.date < '2021-12-31');
    const s = metrics({ points: fold1, cashReturn: () => 0 }).sharpe;
    expect(w.folds[1]!.strategy).toEqual(s);
  });

  it('at most `folds` folds; fewer than two is no value', () => {
    const long = daily('2000-01-01', '2015-01-01', wiggle(0.0003, 0.01));
    expect(
      v(walkForward({ points: long, benchmark: long, cashReturn: () => 0 })).folds,
    ).toHaveLength(10);
    expect(
      v(walkForward({ points: long, benchmark: long, cashReturn: () => 0, folds: 4 })).folds,
    ).toHaveLength(4);
    // Identical series: tied, so never beaten.
    expect(v(walkForward({ points: long, benchmark: long, cashReturn: () => 0 })).won).toBe(0);
    const short = daily('2020-01-01', '2021-12-30', wiggle(0.0003, 0.01)); // 729 days: K = 1
    expect(reason(walkForward({ points: short, benchmark: short, cashReturn: () => 0 }))).toBe(
      'tooShort',
    );
    expect(reason(walkForward({ points: [], benchmark: short }))).toBe('tooShort');
    expect(() => walkForward({ points: long, benchmark: long, folds: 1 })).toThrow('folds');
  });

  it('a fold without a value is not measured, never a win or a loss', () => {
    const points = daily('2020-01-01', '2023-01-01', wiggle(0.001, 0.01));
    // The benchmark starts in 2022: folds 0 and 1 have no benchmark Sharpe.
    const benchmark = daily('2022-01-01', '2023-01-01', wiggle(0.0001, 0.01));
    const w = v(walkForward({ points, benchmark, cashReturn: () => 0 }));
    expect(w.folds.map((f) => f.beat)).toEqual([undefined, undefined, true]);
    expect(reason(w.folds[0]!.benchmark)).toBe('tooShort');
    expect(w).toMatchObject({ won: 1, measured: 1 });
    // An unknown cash rate is no value, not 0.
    const cash = (d: string) => (d === '2021-06-01' ? undefined : 0);
    const c = v(walkForward({ points, benchmark: points, cashReturn: cash }));
    expect(reason(c.folds[1]!.strategy)).toBe('cashRateMissing');
    expect(c.measured).toBe(2);
  });
});

describe('crisis replays', () => {
  const at = (pairs: [string, number][]): EquitySample[] =>
    pairs.map(([date, equity]) => ({ date, equity }));

  it('drawdown and return inside each covered window', () => {
    const points = at([
      ['2007-10-01', 100],
      ['2007-10-09', 110],
      ['2008-06-02', 80],
      ['2009-03-09', 90],
      ['2009-12-31', 120],
    ]);
    const benchmark = at([
      ['2007-10-09', 100],
      ['2008-11-20', 50],
      ['2009-03-06', 45],
      ['2009-03-10', 47],
    ]);
    const r = crisisReplays({ points, benchmark });
    expect(r.windows.map((w) => w.id)).toEqual(DEFAULT_CRISES.map((c) => c.id));
    const gfc = r.windows[1]!;
    // Strategy: from 2007-10-09 (110) to 2009-03-09 (90); deepest 80 / 110 - 1.
    expect(v(gfc.strategy).maxDrawdown).toBeCloseTo(80 / 110 - 1, 15);
    expect(v(gfc.strategy).return).toBeCloseTo(90 / 110 - 1, 15);
    // Benchmark: from 2007-10-09 (100) to the last point on or before 2009-03-09 (45).
    expect(v(gfc.benchmark)).toEqual({ maxDrawdown: 45 / 100 - 1, return: 45 / 100 - 1 });
    expect(gfc.shallower).toBe(true);
    // The data starts after 2000 and ends before 2020.
    expect(reason(r.windows[0]!.strategy)).toBe('notCovered');
    expect(reason(r.windows[2]!.strategy)).toBe('notCovered');
    expect(r.windows[0]!.shallower).toBeUndefined();
    expect(r).toMatchObject({ covered: 1, shallower: 1 });
  });

  it('ties are not shallower; a wiped-out window is no value', () => {
    const w = [{ id: 'x', start: '2020-01-02', end: '2020-01-10', source: 'test' }];
    const a = at([
      ['2020-01-02', 100],
      ['2020-01-06', 90],
      ['2020-01-10', 95],
    ]);
    expect(crisisReplays({ points: a, benchmark: a, windows: w }).windows[0]!.shallower).toBe(
      false,
    );
    const wiped = at([
      ['2020-01-02', 100],
      ['2020-01-06', 0],
      ['2020-01-10', 1],
    ]);
    const r = crisisReplays({ points: wiped, benchmark: a, windows: w });
    expect(reason(r.windows[0]!.strategy)).toBe('equityNotPositive');
    // A series ending on the window's end date covers it; one ending a day earlier does not.
    const early = at([
      ['2020-01-02', 100],
      ['2020-01-09', 100],
    ]);
    expect(
      reason(crisisReplays({ points: early, benchmark: a, windows: w }).windows[0]!.strategy),
    ).toBe('notCovered');
  });

  it('refuses malformed windows', () => {
    const a = at([['2020-01-02', 1]]);
    const bad = (windows: { id: string; start: string; end: string; source: string }[]) => () =>
      crisisReplays({ points: a, benchmark: a, windows });
    expect(bad([{ id: 'x', start: '2020-02-30', end: '2020-03-01', source: '' }])).toThrow('YYYY');
    expect(bad([{ id: 'x', start: '2020-03-01', end: '2020-03-01', source: '' }])).toThrow(
      'before',
    );
    const ok = { id: 'x', start: '2020-01-01', end: '2020-02-01', source: '' };
    expect(bad([ok, ok])).toThrow('twice');
  });

  it('the default windows are the stated peak-to-trough dates', () => {
    expect(DEFAULT_CRISES.map((c) => [c.id, c.start, c.end])).toEqual([
      ['dotCom', '2000-03-24', '2002-10-09'],
      ['financialCrisis', '2007-10-09', '2009-03-09'],
      ['covid', '2020-02-19', '2020-03-23'],
      ['rates2022', '2022-01-03', '2022-10-12'],
    ]);
  });
});
