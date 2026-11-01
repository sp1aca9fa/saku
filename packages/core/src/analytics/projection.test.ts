// Monte Carlo goal projection (docs/analytics.md "Statistics", "Monte Carlo goal projection").
// Wilson intervals: the formula in Python, and 0 of 10 against the known 0.2775.
import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import type { EquitySample } from './metrics';
import { type GoalProjectionInput, goalProjection, wilson95 } from './projection';
import { createRng, stationaryBootstrap } from './random';
import type { Statistic } from './statistic';

const v = <T>(s: Statistic<T>): T => {
  if (!s.ok) throw new Error(`no value: ${s.reason}`);
  return s.value;
};
const reason = (s: { ok: boolean; reason?: string }) => (s.ok ? 'value' : s.reason);
const DAY = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const days = (start: string, count: number) =>
  Array.from({ length: count }, (_, i) => addDays(start, i));
const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  close,
  open: close,
  high: close,
  low: close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
/** Bars ending on `end`, closes from day ratios. */
const series = (end: string, ratios: readonly number[], start = 100): RawBar[] => {
  const ds = days(addDays(end, -ratios.length), ratios.length + 1);
  let c = start;
  return ds.map((d, i) => {
    if (i > 0) c *= ratios[i - 1]!;
    return bar(d, c);
  });
};
/** Buy and hold of `ticker`: total return (dividends, splits) from its first bar. */
const hold =
  (ticker: string) =>
  (bars: Record<string, RawBar[]>): EquitySample[] => {
    const b = bars[ticker]!;
    let e = 1;
    return b.map((x, i) => {
      if (i > 0) {
        const k = x.closeIsSplitAdjusted ? 1 : x.splitFactor;
        e *= ((x.close + x.divCash) * k) / b[i - 1]!.close;
      }
      return { date: x.date, equity: e };
    });
  };
const varied = (count: number) =>
  Array.from({ length: count }, (_, i) => 1 + 0.001 * (((i * 7) % 11) - 5));

const base = (over: Partial<GoalProjectionInput> = {}): GoalProjectionInput => ({
  history: {
    X: series(
      '2024-01-31',
      Array.from({ length: 300 }, () => 1.001),
    ),
  },
  future: days('2024-02-01', 30),
  run: hold('X'),
  initial: 1000,
  monthly: 0,
  goal: 1000,
  currency: 'XYZ',
  seed: 1,
  paths: 50,
  ...over,
});

describe('Wilson interval', () => {
  it('matches the formula', () => {
    expect(wilson95(2, 4).low).toBeCloseTo(0.15003898915214953, 14);
    expect(wilson95(2, 4).high).toBeCloseTo(0.8499610108478505, 14);
    expect(wilson95(0, 10).low).toBeCloseTo(0, 14);
    expect(wilson95(0, 10).high).toBeCloseTo(0.2775327998628892, 14);
    expect(wilson95(50, 50)).toEqual({ low: expect.closeTo(0.9286524008666414, 14), high: 1 });
    expect(() => wilson95(5, 4)).toThrow();
    expect(() => wilson95(0, 0)).toThrow();
  });
});

describe('goal projection', () => {
  it('a constant growth reaches the same value on every path', () => {
    const want = 1000 * 1.001 ** 30;
    const p = v(goalProjection(base({ goal: want * (1 - 1e-9) })));
    expect(p).toMatchObject({ reached: 50, paths: 50, probability: 1, high: 1, currency: 'XYZ' });
    expect(p.low).toBeCloseTo(1 / (1 + 1.959963984540054 ** 2 / 50), 14);
    expect(p.endValues.p5).toBeCloseTo(want, 9);
    expect(p.endValues.p95).toBeCloseTo(want, 9);
    expect(p).toMatchObject({ sampleDays: 300, meanBlock: 20, seed: 1 });
    expect(p.sampleStart).toBe(addDays('2024-01-31', -299));
    expect(p.sampleEnd).toBe('2024-01-31');
    // Just above the end value: no path reaches it.
    expect(v(goalProjection(base({ goal: want * (1 + 1e-9) }))).reached).toBe(0);
  });

  it('adds the contribution on the first session of each new month', () => {
    // h = 2024-01-31; sessions Feb 1 (new month: + 100), Feb 2, Mar 1 (new month: + 100).
    const p = v(
      goalProjection(
        base({ future: ['2024-02-01', '2024-02-02', '2024-03-01'], monthly: 100, paths: 3 }),
      ),
    );
    const w1 = 1000 * 1.001 + 100;
    const w3 = w1 * 1.001 * 1.001 + 100;
    expect(p.endValues.p50).toBeCloseTo(w3, 9);
  });

  it('resamples the same days for every series, in the specified draw order', () => {
    const r = varied(400);
    const history = {
      X: series('2024-01-31', r),
      Y: series('2024-01-31', r, 200),
    };
    const seen: Record<string, RawBar[]>[] = [];
    const run = (bars: Record<string, RawBar[]>) => {
      seen.push(bars);
      return hold('X')(bars);
    };
    goalProjection(base({ history, run, paths: 3, seed: 77, meanBlock: 5 }));
    expect(seen).toHaveLength(3);
    seen.forEach((bars, p) => {
      const draw = stationaryBootstrap(createRng(77, p), 400, 30, 5);
      const x = bars.X!.slice(401);
      const y = bars.Y!.slice(401);
      expect(x.map((b) => b.date)).toEqual(days('2024-02-01', 30));
      x.forEach((b, t) => {
        const prev = t === 0 ? bars.X![400]!.close : x[t - 1]!.close;
        // Sample day i is history day i + 1, its ratio r[i].
        expect(b.close / prev).toBeCloseTo(r[draw[t]!]!, 12);
        expect(y[t]!.close).toBeCloseTo(2 * b.close, 9);
        expect(b).toMatchObject({ splitFactor: 1, closeIsSplitAdjusted: false, divCash: 0 });
      });
    });
  });

  it('keeps dividends and splits in the sampled total return, and missing fields missing', () => {
    // Day 1: a 2-for-1 split (close halves, no loss); day 2: a dividend of 1; day 3: no open.
    const ds = days('2023-06-01', 300);
    const history: RawBar[] = ds.map((d, i) => {
      if (i === 1) return bar(d, 50, { splitFactor: 2 });
      if (i === 2) return bar(d, 49.5, { divCash: 1 });
      const b = bar(d, i === 0 ? 100 : 49.5);
      if (i === 3) delete b.open;
      return b;
    });
    const seen: Record<string, RawBar[]>[] = [];
    const run = (bars: Record<string, RawBar[]>) => {
      seen.push(bars);
      return hold('X')(bars);
    };
    goalProjection(
      base({ history: { X: history }, future: days(addDays(ds.at(-1)!, 1), 400), run, paths: 2 }),
    );
    for (const bars of seen) {
      const synthetic = bars.X!.slice(300);
      let prev = history.at(-1)!.close;
      for (const b of synthetic) {
        const total = (b.close + b.divCash) / prev;
        // Every sampled day is 1 (split day: 50 x 2 / 100; dividend day: (49.5 + 1) / 50 =
        // 1.01; no-open day and others: 1).
        expect([1, 1.01].some((want) => Math.abs(total - want) < 1e-12)).toBe(true);
        if (b.divCash > 0) expect(total).toBeCloseTo(1.01, 12);
        prev = b.close;
      }
      expect(synthetic.some((b) => b.open === undefined)).toBe(true);
    }
  });

  it('a day after a bar one series lacks is not a sample day', () => {
    const x = series('2024-01-31', varied(300));
    const y = series('2024-01-31', varied(300)).filter((_, i) => i !== 100);
    // Common dates: 300 (x's 301 less day 100); day 101's previous x bar is day 100, not the
    // previous common date, so it is left out: 299 - 1 = 298 sample days.
    const p = v(goalProjection(base({ history: { X: x, Y: y } })));
    expect(p.sampleDays).toBe(298);
  });

  it('needs a year of sample days', () => {
    const short = (n: number) => base({ history: { X: series('2024-01-31', varied(n)) } });
    expect(reason(goalProjection(short(251)))).toBe('tooShort');
    expect(reason(goalProjection(short(252)))).toBe('value');
    expect(reason(goalProjection({ ...short(400), sampleFrom: addDays('2024-01-31', -250) }))).toBe(
      'tooShort',
    );
  });

  it('a wiped-out path is lost; a start at or below zero is no value', () => {
    const second = addDays('2024-02-01', 1);
    const wipe = (bars: Record<string, RawBar[]>) =>
      hold('X')(bars).map((e) => (e.date >= second ? { ...e, equity: -0.5 } : e));
    const p = v(goalProjection(base({ run: wipe, monthly: 100, goal: 1 })));
    expect(p.reached).toBe(0);
    expect(p.endValues.p95).toBe(0);
    const dead = (bars: Record<string, RawBar[]>) =>
      hold('X')(bars).map((e) => ({ ...e, equity: 0 }));
    expect(reason(goalProjection(base({ run: dead })))).toBe('equityNotPositive');
  });

  it('nearest-rank percentiles and the share reaching the goal', () => {
    let path = 0;
    // Path p's strategy multiplies the money by p + 1 over the period.
    const run = (bars: Record<string, RawBar[]>) => {
      const k = ++path;
      return bars.X!.map((b) => ({ date: b.date, equity: b.date > '2024-01-31' ? k : 1 }));
    };
    const p = v(goalProjection(base({ run, paths: 4, goal: 2500 })));
    // Ends 1000, 2000, 3000, 4000: ranks ceil(q x 4 / 100) = 1, 1, 2, 3, 4.
    expect(p.endValues).toEqual({ p5: 1000, p25: 1000, p50: 2000, p75: 3000, p95: 4000 });
    expect(p).toMatchObject({ reached: 2, probability: 0.5 });
    expect(p.low).toBeCloseTo(0.15003898915214953, 14);
  });

  it('the same seed gives the same result; another seed other paths', () => {
    const history = { X: series('2024-01-31', varied(400)) };
    const a = v(goalProjection(base({ history, seed: 3, goal: 1010 })));
    const b = v(goalProjection(base({ history, seed: 3, goal: 1010 })));
    const c = v(goalProjection(base({ history, seed: 4, goal: 1010 })));
    expect(a).toEqual(b);
    expect(c.endValues).not.toEqual(a.endValues);
  });

  it('refuses malformed input', () => {
    const throws = (over: Partial<GoalProjectionInput>, message: string) =>
      expect(() => goalProjection(base(over))).toThrow(message);
    throws({ history: {} }, 'no series');
    throws(
      { history: { X: series('2024-01-31', varied(300)), Y: series('2024-01-30', varied(300)) } },
      'same date',
    );
    throws({ future: [] }, 'no future');
    throws({ future: ['2024-01-31'] }, 'strictly ascending');
    throws({ future: ['2024-02-02', '2024-02-01'] }, 'strictly ascending');
    throws({ initial: -1 }, 'initial');
    throws({ monthly: NaN }, 'monthly');
    throws({ goal: 0 }, 'goal');
    throws({ currency: '' }, 'currency');
    throws({ seed: -1 }, 'seed');
    throws({ paths: 0 }, 'paths');
    throws({ meanBlock: 0.5 }, 'meanBlock');
    throws({ sampleFrom: '2024-13-01' }, 'sampleFrom');
    const bad = series('2024-01-31', varied(300));
    bad[5] = { ...bad[5]!, close: 0 };
    throws({ history: { X: bad } }, 'not positive');
    throws({ run: (bars) => hold('X')(bars).slice(0, -1) }, 'no finite equity');
  });
});
