// The reference's own checks for holdings identity (requirements 05, 13): a reorder of the same
// tickers and weights is no trade. Written against the reference only (no @saku/core).
import { describe, expect, it } from 'vitest';
import {
  refAnnualize,
  refBacktest,
  refDrawdown,
  refEma,
  refEvaluate,
  refGarmanKlass,
  refHigh,
  refLow,
  refOhlc,
  refParkinson,
  refReturn,
  refYangZhang,
  type RefBar,
  type RefDay,
  type RefOhlc,
  type RefStrategy,
} from './index';

const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
type H = RefDay['holdings'];
const A: H = [
  { ticker: 'SPY', weight: 50 },
  { ticker: 'SSO', weight: 50 },
];
const B: H = [
  { ticker: 'SSO', weight: 50 },
  { ticker: 'SPY', weight: 50 },
];
const C: H = [
  { ticker: 'SPY', weight: 60 },
  { ticker: 'SSO', weight: 40 },
];
const series = (closes: number[]): RefBar[] =>
  closes.map((close, i) => ({
    date: dates[i]!,
    open: close * (i % 2 === 0 ? 0.98 : 1.02),
    close,
    divCash: 0,
    splitFactor: 1,
    closeIsSplitAdjusted: false,
  }));
const bars = { SPY: series([100, 102, 98, 103]), SSO: series([50, 53, 48, 54]) };
const days = (lists: H[]): RefDay[] =>
  lists.map((holdings, i) => ({ date: dates[i]!, signals: {}, allocation: `a${i}`, holdings }));
const costs = { slippageBps: 10, feePct: 0.1 };

describe('reference: holdings identity ignores order', () => {
  for (const execution of ['next_open', 'next_close', 'same_close'] as const) {
    it(`${execution}: alternating A and B gives no switch and the same equity as holding A`, () => {
      const alternating = refBacktest({ execution, costs }, days([A, B, A, B]), bars, () => 0);
      const constant = refBacktest({ execution, costs }, days([A, A, A, A]), bars, () => 0);
      expect(alternating.switches).toBe(0);
      expect(alternating.equity).toEqual(constant.equity);
    });

    it(`${execution}: a weight change still counts`, () => {
      const r = refBacktest({ execution, costs }, days([A, B, C, C]), bars, () => 0);
      expect(r.switches).toBe(1);
    });

    it(`${execution}: swapped weights between the same tickers count as a switch`, () => {
      const x: H = [
        { ticker: 'SPY', weight: 40 },
        { ticker: 'SSO', weight: 60 },
      ];
      const y: H = [
        { ticker: 'SPY', weight: 60 },
        { ticker: 'SSO', weight: 40 },
      ];
      const r = refBacktest({ execution, costs }, days([x, y, y, y]), bars, () => 0);
      expect(r.switches).toBe(1);
    });

    // Only the switch count is checked: the money for a repeated ticker is not defined yet.
    it(`${execution}: a repeated ticker is not the same as one weight for it`, () => {
      const one: H = [{ ticker: 'SPY', weight: 100 }];
      const split: H = [
        { ticker: 'SPY', weight: 50 },
        { ticker: 'SPY', weight: 50 },
      ];
      const r = refBacktest({ execution, costs }, days([one, split, split, split]), bars, () => 0);
      expect(r.switches).toBe(1);
    });
  }
});

// B1 indicators (docs/indicators.md "Indicators (B1, v1)"), hand-computed values.
const close = (xs: (number | undefined)[], ys: (number | undefined)[]) => {
  expect(xs.length).toBe(ys.length);
  xs.forEach((x, i) => {
    if (ys[i] === undefined) expect(x).toBeUndefined();
    else expect(x).toBeCloseTo(ys[i]!, 9);
  });
};
const e = Math.exp;
const LN2 = Math.log(2);

describe('reference B1: ema, return, high, low, drawdown', () => {
  it('ema seeds with the mean of the first N values, then alpha = 2 / (N + 1)', () => {
    // N = 3, alpha = 0.5: seed (1 + 2 + 3) / 3 = 2; 0.5 x 4 + 0.5 x 2 = 3; 0.5 x 5 + 0.5 x 3 = 4.
    close(refEma([1, 2, 3, 4, 5], 3), [undefined, undefined, 2, 3, 4]);
    // N = 1, alpha = 1: the series itself.
    close(refEma([7, 3, 9], 1), [7, 3, 9]);
    // N = 2, alpha = 2/3: seed (10 + 13) / 2 = 11.5; 2/3 x 7 + 1/3 x 11.5 = 8.5.
    close(refEma([10, 13, 7], 2), [undefined, 11.5, 8.5]);
  });

  it('return is simple over N bars, in percent', () => {
    close(refReturn([100, 110, 121, 99], 1), [undefined, 10, 10, (99 / 121 - 1) * 100]);
    close(refReturn([100, 110, 121, 99], 2), [undefined, undefined, 21, -10]);
  });

  it('high and low over the last N values, today included', () => {
    close(refHigh([3, 1, 4, 1, 5], 3), [undefined, undefined, 4, 4, 5]);
    close(refLow([3, 1, 4, 1, 5], 3), [undefined, undefined, 1, 1, 1]);
    close(refHigh([3, 1], 1), [3, 1]);
  });

  it('drawdown from the N-day high and from the all-time high', () => {
    const v = [100, 120, 90, 108, 80];
    // N = 2: peaks 120, 120, 108, 108.
    close(refDrawdown(v, 2), [undefined, 0, -25, 0, (80 / 108 - 1) * 100]);
    // All-time: peaks 100, 120, 120, 120, 120.
    close(refDrawdown(v), [0, 0, -25, -10, (80 / 120 - 1) * 100]);
  });
});

const ohlc = (open: number, high: number, low: number, c: number): RefOhlc => ({
  open,
  high,
  low,
  close: c,
});

describe('reference B1: range-based volatility', () => {
  it('parkinson: sqrt(252 S / (4 ln 2 N)) x 100', () => {
    // ln(H/L) = 0.01 and 0.02: S = 0.0001 + 0.0004 = 0.0005, N = 2.
    const d = [ohlc(100, 100 * e(0.01), 100, 100), ohlc(100, 100 * e(0.02), 100, 100)];
    const want = Math.sqrt((252 * 0.0005) / (4 * LN2 * 2)) * 100; // about 15.0738
    close(refParkinson(d, 2), [undefined, want]);
    expect(want).toBeCloseTo(15.0738, 3);
  });

  it('garman-klass: one day with ln(H/L) = 0.02, ln(C/O) = 0.01', () => {
    const d = [ohlc(100, 100 * e(0.02), 100, 100 * e(0.01))];
    const term = 0.5 * 0.0004 - (2 * LN2 - 1) * 0.0001; // 0.000161371
    close(refGarmanKlass(d, 1), [Math.sqrt(252 * term) * 100]);
    expect(Math.sqrt(252 * term) * 100).toBeCloseTo(20.1657, 3);
  });

  it('yang-zhang: two days with known log moves', () => {
    // Day 1: overnight +0.01, open to close +0.02, high close+0.01, low open-0.01:
    //   RS = 0.01 x 0.03 + (-0.03) x (-0.01) = 0.0006.
    // Day 2: overnight -0.01, open to close 0, high open+0.01, low open-0.02:
    //   RS = 0.01 x 0.01 + (-0.02) x (-0.02) = 0.0005.
    // s_o = var(0.01, -0.01) = 0.0002; s_c = var(0.02, 0) = 0.0002; s_rs = 0.00055;
    // k = 0.34 / (1.34 + 3) = 0.0783410.
    const o1 = 100 * e(0.01);
    const c1 = o1 * e(0.02);
    const o2 = c1 * e(-0.01);
    const d = [
      { close: 100 }, // only its close is read (the first overnight ratio)
      ohlc(o1, c1 * e(0.01), o1 * e(-0.01), c1),
      ohlc(o2, o2 * e(0.01), o2 * e(-0.02), o2),
    ];
    const k = 0.34 / 4.34;
    const want = Math.sqrt(252 * (0.0002 + k * 0.0002 + (1 - k) * 0.00055)) * 100;
    close(refYangZhang(d, 2), [undefined, undefined, want]);
    expect(want).toBeCloseTo(42.672, 2);
  });

  it('a missing open, high or low gives no value for any window holding that day', () => {
    const good = ohlc(100, 101, 99, 100);
    const d: RefOhlc[] = [good, { ...good, high: undefined }, good, good];
    const p = refParkinson(d, 2);
    expect(p[1]).toBeUndefined();
    expect(p[2]).toBeUndefined();
    expect(p[3]).toBeDefined();
    const noOpen: RefOhlc[] = [good, { ...good, open: undefined }, good];
    expect(refParkinson(noOpen, 1)[1]).toBeUndefined();
    expect(refGarmanKlass(noOpen, 1)[1]).toBeUndefined();
    expect(refYangZhang(noOpen, 2)[2]).toBeUndefined();
  });

  it('a high below the low or a non-positive value gives no value', () => {
    const good = ohlc(100, 101, 99, 100);
    expect(refParkinson([good, ohlc(100, 99, 101, 100)], 1)).toEqual([
      expect.any(Number),
      undefined,
    ]);
    expect(refGarmanKlass([good, ohlc(100, 101, 0, 100)], 1)[1]).toBeUndefined();
    expect(refYangZhang([{ close: 0 }, good, good], 2)[2]).toBeUndefined();
  });
});

describe('reference B1: OHLC on the series basis', () => {
  const day = (date: string, b: Partial<RefBar>): RefBar => ({
    date,
    close: 100,
    divCash: 0,
    splitFactor: 1,
    closeIsSplitAdjusted: false,
    ...b,
  });

  it('price basis: a 2-for-1 split scales earlier days by 1/2, within-day ratios unchanged', () => {
    const bars = [
      day('2026-01-05', { open: 198, high: 204, low: 196, close: 200 }),
      day('2026-01-06', { open: 101, high: 103, low: 99, close: 100, splitFactor: 2 }),
    ];
    const d = refOhlc(bars, false);
    expect(d[0]).toEqual({ open: 99, high: 102, low: 98, close: 100 });
    expect(d[1]).toEqual({ open: 101, high: 103, low: 99, close: 100 });
    // Overnight ratio across the split: 101 / 100.
    expect(d[1]!.open! / d[0]!.close).toBeCloseTo(1.01, 12);
  });

  it('total-return basis: the overnight ratio includes the dividend', () => {
    // TR: 1, then (99 + 1) / 100 = 1. Day 2 factor 1 / 99: open 99.5 -> 99.5 / 99.
    const bars = [
      day('2026-01-05', { open: 100, high: 100, low: 100, close: 100 }),
      day('2026-01-06', { open: 99.5, high: 99.5, low: 99, close: 99, divCash: 1 }),
    ];
    const d = refOhlc(bars, true);
    expect(d[0]!.close).toBe(1);
    expect(d[1]!.close).toBeCloseTo(1, 12);
    expect(d[1]!.open!).toBeCloseTo(99.5 / 99, 12);
    expect(d[1]!.low!).toBeCloseTo(1, 12);
  });

  it('a missing open stays missing on the basis', () => {
    const d = refOhlc([day('2026-01-05', { high: 101, low: 99 })], false);
    expect(d[0]!.open).toBeUndefined();
  });
});

describe('reference B1: refEvaluate with the new operands', () => {
  const ds = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
  const closes = [100, 120, 90, 108, 80];
  const bars: Record<string, RefBar[]> = {
    AAA: closes.map((c, i) => ({
      date: ds[i]!,
      open: c,
      high: c * 1.01,
      low: c * 0.99,
      close: c,
      divCash: 0,
      splitFactor: 1,
      closeIsSplitAdjusted: false,
    })),
  };
  const holdings = (t: string) => [{ ticker: t, weight: 100 }];

  it('drawdown, return, ema, high and range volatility drive allocations', () => {
    const s: RefStrategy = {
      signals: [
        {
          id: 'dd',
          type: 'compare',
          left: { indicator: 'drawdown', ticker: 'AAA' },
          op: '<',
          right: { threshold: -20 },
        },
        {
          id: 'up',
          type: 'compare',
          left: { indicator: 'return', ticker: 'AAA', length: 1 },
          op: '>',
          right: { threshold: 0 },
        },
        {
          id: 'trend',
          type: 'compare',
          left: { indicator: 'price', ticker: 'AAA' },
          op: '>',
          right: { indicator: 'ema', ticker: 'AAA', length: 2 },
        },
        {
          id: 'atHigh',
          type: 'compare',
          left: { indicator: 'price', ticker: 'AAA' },
          op: '<',
          right: { indicator: 'high', ticker: 'AAA', length: 2 },
        },
        {
          id: 'calm',
          type: 'compare',
          left: { indicator: 'volatility', ticker: 'AAA', length: 2, method: 'parkinson' },
          op: '<',
          right: { threshold: 100 },
        },
      ],
      allocations: [
        { name: 'cash', when: { any: ['dd'] }, holdings: holdings('CASH_USD') },
        { name: 'risk', holdings: holdings('AAA') },
      ],
    };
    const out = refEvaluate(s, bars);
    // Every signal defined from day 1 (return N = 1, ema/high/parkinson N = 2).
    expect(out.map((d) => d.date)).toEqual(ds.slice(1));
    // Drawdowns: 0, -25, -10, -33.3; returns: +20, -25, +20, -25.9.
    expect(out.map((d) => d.signals.dd)).toEqual([false, true, false, true]);
    expect(out.map((d) => d.signals.up)).toEqual([true, false, true, false]);
    // EMA N = 2: seed 110; 2/3 x 90 + 1/3 x 110 = 96.67; 2/3 x 108 + 1/3 x 96.67 = 104.22;
    // 2/3 x 80 + 1/3 x 104.22 = 88.07.
    expect(out.map((d) => d.signals.trend)).toEqual([true, false, true, false]);
    // 2-day highs: 120, 120, 108, 108. Day 1 (120 vs 120) is a first-day tie: false. Day 3
    // (108 vs 108) is a tie: the previous state (true) is kept.
    expect(out.map((d) => d.signals.atHigh)).toEqual([false, true, true, true]);
    expect(out.map((d) => d.signals.calm)).toEqual([true, true, true, true]);
    expect(out.map((d) => d.allocation)).toEqual(['risk', 'cash', 'risk', 'cash']);
  });
});

describe('reference B1: data-error rules (contract clarification)', () => {
  it('return gives no value when a value it reads is not positive or not finite', () => {
    close(refReturn([100, 0, 110, 121], 1), [undefined, undefined, undefined, 10]);
    close(refReturn([100, -5, 110, NaN, 121, Infinity], 2), [
      undefined,
      undefined,
      10,
      undefined,
      10,
      undefined,
    ]);
  });

  it('N-day drawdown gives no value for a window holding a bad value', () => {
    close(refDrawdown([100, 0, 90, 80], 2), [undefined, undefined, undefined, (80 / 90 - 1) * 100]);
    close(refDrawdown([100, NaN, 90], 1), [0, undefined, 0]);
  });

  it('all-time drawdown gives no value from a bad value on', () => {
    close(refDrawdown([100, 90, -1, 120, 60]), [0, -10, undefined, undefined, undefined]);
    close(refDrawdown([100, Infinity, 50]), [0, undefined, undefined]);
  });

  it('high and low give no value when a value they read is not finite', () => {
    close(refHigh([3, NaN, 4, 1, 5], 2), [undefined, undefined, undefined, 4, 5]);
    close(refLow([3, Infinity, 4, 1], 2), [undefined, undefined, undefined, 1]);
    close(refHigh([3, -Infinity], 1), [3, undefined]);
    // Zero and negative values are finite and still read (the contract only requires finite).
    close(refLow([2, 0, -1], 2), [undefined, 0, -1]);
  });

  it('a non-finite ema gives no value', () => {
    close(refEma([1, 2, Infinity, 4], 2), [undefined, 1.5, undefined, undefined]);
    close(refEma([NaN, 2, 3], 2), [undefined, undefined, undefined]);
  });

  it('an open or close outside [low, high] gives no value for every range method', () => {
    const good = ohlc(100, 101, 99, 100);
    const openAbove = ohlc(102, 101, 99, 100);
    const closeBelow = ohlc(100, 101, 99, 98);
    for (const bad of [openAbove, closeBelow]) {
      expect(refParkinson([good, bad], 1)[1]).toBeUndefined();
      expect(refGarmanKlass([good, bad], 1)[1]).toBeUndefined();
      expect(refYangZhang([good, bad, good], 2)[2]).toBeUndefined();
      expect(refYangZhang([good, good, bad], 2)[2]).toBeUndefined();
    }
    // Boundaries are inside: open at the low, close at the high.
    expect(refGarmanKlass([ohlc(99, 101, 99, 101)], 1)[0]).toBeDefined();
  });

  it('a non-finite open, high, low or close gives no value', () => {
    const good = ohlc(100, 101, 99, 100);
    expect(refParkinson([ohlc(100, Infinity, 99, 100)], 1)[0]).toBeUndefined();
    expect(refGarmanKlass([ohlc(NaN, 101, 99, 100)], 1)[0]).toBeUndefined();
    expect(refParkinson([ohlc(100, 101, 99, NaN)], 1)[0]).toBeUndefined();
    // Yang-Zhang: the day before the window supplies only its close, which must be usable.
    expect(refYangZhang([{ close: NaN }, good, good], 2)[2]).toBeUndefined();
    expect(refYangZhang([{ close: 100 }, good, good], 2)[2]).toBeDefined();
  });

  it('a negative or non-finite variance gives no value', () => {
    expect(refAnnualize(-1e-12)).toBeUndefined();
    expect(refAnnualize(NaN)).toBeUndefined();
    expect(refAnnualize(Infinity)).toBeUndefined();
    expect(refAnnualize(0)).toBe(0);
    expect(refAnnualize(0.0001)).toBeCloseTo(Math.sqrt(0.0252) * 100, 12);
  });

  it('the close is scaled like the other three, so a flat day gives exactly 0', () => {
    // Total-return basis with a dividend: day 2 factor = TR / raw close, not 1.
    const bars: RefBar[] = [
      { date: '2026-01-05', open: 37.1, high: 37.1, low: 37.1, close: 37.1 },
      { date: '2026-01-06', open: 36.3, high: 36.3, low: 36.3, close: 36.3, divCash: 0.7 },
    ].map((b) => ({ divCash: 0, splitFactor: 1, closeIsSplitAdjusted: false, ...b }));
    const d = refOhlc(bars, true);
    // Raw close x factor, with factor = (series value / raw close).
    const factor = (36.3 + 0.7) / 37.1 / 36.3;
    expect(d[1]!.close).toBe(36.3 * factor);
    expect(d[1]!.open).toBe(d[1]!.close);
    expect(d[1]!.high).toBe(d[1]!.low);
    expect(refParkinson(d, 2)).toEqual([undefined, 0]);
    expect(refGarmanKlass(d, 2)).toEqual([undefined, 0]);
    // Price basis with a split: the flat day stays exactly flat too.
    const split: RefBar[] = [
      { date: '2026-01-05', open: 30.3, high: 30.3, low: 30.3, close: 30.3 },
      { date: '2026-01-06', open: 10.1, high: 10.1, low: 10.1, close: 10.1, splitFactor: 3 },
    ].map((b) => ({ divCash: 0, splitFactor: 1, closeIsSplitAdjusted: false, ...b }));
    expect(refGarmanKlass(refOhlc(split, false), 1)).toEqual([0, 0]);
  });
});

describe('reference: days without a decision (docs/indicators.md, equity curves)', () => {
  // X closes 100..104, 150, 106..109; the 150 day has no low, so a Parkinson length-1 signal has
  // no value that day only (every other day it is positive). The day is not evaluated and the
  // backtest holds the safe state (cash at 0%) from it, traded like any decision.
  const xs = [100, 101, 102, 103, 104, 150, 106, 107, 108, 109];
  const ds = xs.map((_, i) => `2026-02-${String(2 + i).padStart(2, '0')}`);
  const bars: Record<string, RefBar[]> = {
    X: xs.map((c, i) => ({
      date: ds[i]!,
      open: c,
      high: c * 1.01,
      low: i === 5 ? undefined : c * 0.99,
      close: c,
      divCash: 0,
      splitFactor: 1,
      closeIsSplitAdjusted: false,
    })),
  };
  const s: RefStrategy = {
    execution: 'next_close',
    costs: { feePct: 0.1 },
    signals: [
      {
        id: 'on',
        type: 'compare',
        left: { indicator: 'volatility', ticker: 'X', length: 1, method: 'parkinson' },
        op: '>',
        right: { threshold: 0 },
      },
    ],
    allocations: [
      { name: 'in', when: { all: ['on'] }, holdings: [{ ticker: 'X', weight: 100 }] },
      { name: 'out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
    safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  };

  it('the 150 day is not evaluated, its return is compounded, the safe state is traded', () => {
    const days = refEvaluate(s, bars);
    expect(days.map((d) => d.date)).toEqual(ds.filter((_, i) => i !== 5));
    expect(days.every((d) => d.allocation === 'in')).toBe(true);
    const r = refBacktest(s, days, bars, () => 0);
    expect(r.dates).toEqual(ds);
    // Hand computation, next_close, cost 0.1% x turnover:
    //   day 0: decide X; equity 1 (nothing held).
    //   day 1: buy X at the close, turnover 1: 0.999.
    //   days 2-4: X 102/101, 103/101, 104/101 of it.
    //   day 5 (150, not evaluated): X moves to 150/101; the decision is the safe state (cash).
    //   day 6: X moves to 106/101, then the switch to cash, turnover 2: x 0.998. Decide X again.
    //   day 7: cash earns 0; switch back to X: x 0.998.
    //   days 8-9: X 108/107, 109/107.
    const w = 0.999 * (106 / 101) * 0.998;
    const want = [
      1,
      0.999,
      (0.999 * 102) / 101,
      (0.999 * 103) / 101,
      (0.999 * 104) / 101,
      (0.999 * 150) / 101,
      w,
      w * 0.998,
      (w * 0.998 * 108) / 107,
      (w * 0.998 * 109) / 107,
    ];
    expect(r.equity.length).toBe(want.length);
    r.equity.forEach((e, i) => expect(e).toBeCloseTo(want[i]!, 12));
    expect(r.switches).toBe(2);
  });

  it('a date that is not evaluated without a safe state is an error, not a guess', () => {
    const days = refEvaluate(s, bars);
    const { safeState: _, ...noSafe } = s;
    expect(() => refBacktest(noSafe, days, bars, () => 0)).toThrow(/safe state/);
  });
});

describe('reference: a signal ticker without a bar is a session without a decision', () => {
  // H is held; the signal reads S (close volatility, length 2, positive whenever defined). S has
  // no bar on H's 150 day, so that date is not evaluated, but H has a bar: it is a session, H's
  // return is compounded and the safe state (cash at 0%) is the decision.
  const hs = [100, 101, 102, 103, 104, 150, 106, 107, 108, 109];
  const ss = [50, 51, 50, 52, 51, undefined, 53, 52, 54, 53];
  const ds = hs.map((_, i) => `2026-03-${String(2 + i).padStart(2, '0')}`);
  const bar = (date: string, close: number): RefBar => ({
    date,
    open: close,
    close,
    divCash: 0,
    splitFactor: 1,
    closeIsSplitAdjusted: false,
  });
  const bars: Record<string, RefBar[]> = {
    H: hs.map((c, i) => bar(ds[i]!, c)),
    S: ss.flatMap((c, i) => (c === undefined ? [] : [bar(ds[i]!, c)])),
  };
  const s: RefStrategy = {
    execution: 'next_close',
    costs: { feePct: 0.1 },
    signals: [
      {
        id: 'on',
        type: 'compare',
        left: { indicator: 'volatility', ticker: 'S', length: 2 },
        op: '>',
        right: { threshold: 0 },
      },
    ],
    allocations: [
      { name: 'in', when: { all: ['on'] }, holdings: [{ ticker: 'H', weight: 100 }] },
      { name: 'out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
    safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  };

  it('compounds the held ticker over the gap and trades the safe state', () => {
    const days = refEvaluate(s, bars);
    // S's volatility (2 returns) is defined from its third bar; the 150 day has no S bar.
    expect(days.map((d) => d.date)).toEqual([2, 3, 4, 6, 7, 8, 9].map((i) => ds[i]!));
    expect(days.every((d) => d.allocation === 'in')).toBe(true);
    const r = refBacktest(s, days, bars, () => 0);
    expect(r.dates).toEqual(ds.slice(2));
    // Hand computation, next_close, cost 0.1% x turnover:
    //   day 2: decide H; equity 1.   day 3: buy H at the close: 0.999.   day 4: x 104/103.
    //   day 5 (150, no S bar): H moves to 150/103; decision: safe state (cash).
    //   day 6: H moves to 106/103, switch to cash (turnover 2): x 0.998; decide H.
    //   day 7: cash earns 0, switch back to H: x 0.998.   days 8-9: x 108/107, 109/107.
    const w = ((0.999 * 106) / 103) * 0.998;
    const want = [
      1,
      0.999,
      (0.999 * 104) / 103,
      (0.999 * 150) / 103,
      w,
      w * 0.998,
      (w * 0.998 * 108) / 107,
      (w * 0.998 * 109) / 107,
    ];
    expect(r.equity.length).toBe(want.length);
    r.equity.forEach((e, i) => expect(e).toBeCloseTo(want[i]!, 12));
    expect(r.switches).toBe(2);
  });

  it('missing bars for a ticker the strategy may hold is an error', () => {
    const days = refEvaluate(s, bars);
    const withSafeH = { ...s, safeState: { holdings: [{ ticker: 'G?L=2', weight: 100 }] } };
    expect(() => refBacktest(withSafeH, days, bars, () => 0)).toThrow(/no bars loaded for G/);
  });
});

describe('reference: derived signals not / and / or', () => {
  const ds = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-06'];
  // Closes 10, 20, 30, 12 (no near-ties). Comparisons on the plain price (the reference has no parser):
  //   a: price > 15  -> F, T, T, F
  //   b: price < 25  -> T, T, F, T
  const bars: Record<string, RefBar[]> = {
    Q: [10, 20, 30, 12].map((close, i) => ({
      date: ds[i]!,
      close,
      divCash: 0,
      splitFactor: 1,
      closeIsSplitAdjusted: false,
    })),
  };
  const s: RefStrategy = {
    signals: [
      // Declared before the signals it reads.
      { id: 'neither', type: 'not', of: 'either' },
      { id: 'both', type: 'and', of: ['a', 'b'] },
      { id: 'either', type: 'or', of: ['notA', 'notB'] },
      {
        id: 'a',
        type: 'compare',
        left: { indicator: 'price', ticker: 'Q' },
        op: '>',
        right: { threshold: 15 },
      },
      {
        id: 'b',
        type: 'compare',
        left: { indicator: 'price', ticker: 'Q' },
        op: '<',
        right: { threshold: 25 },
      },
      { id: 'notA', type: 'not', of: 'a' },
      { id: 'notB', type: 'not', of: 'b' },
    ],
    allocations: [
      { name: 'both', when: { all: ['both'] }, holdings: [{ ticker: 'Q', weight: 100 }] },
      { name: 'rest', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
  };

  it('evaluates derived signals in any order, without state of their own', () => {
    const out = refEvaluate(s, bars);
    const col = (id: string) => out.map((d) => d.signals[id]);
    expect(col('a')).toEqual([false, true, true, false]);
    expect(col('b')).toEqual([true, true, false, true]);
    expect(col('notA')).toEqual([true, false, false, true]);
    expect(col('notB')).toEqual([false, false, true, false]);
    // either = notA or notB; neither = not either = a and b.
    expect(col('either')).toEqual([true, false, true, true]);
    expect(col('neither')).toEqual([false, true, false, false]);
    expect(col('both')).toEqual([false, true, false, false]);
    expect(out.map((d) => d.allocation)).toEqual(['rest', 'both', 'rest', 'rest']);
  });

  it('a derived signal is defined only when its inputs are (warm-up)', () => {
    const warm: RefStrategy = {
      signals: [
        { id: 'n', type: 'not', of: 'up' },
        {
          id: 'up',
          type: 'compare',
          left: { indicator: 'return', ticker: 'Q', length: 1 },
          op: '>',
          right: { threshold: 0 },
        },
      ],
      allocations: [
        { name: 'x', when: { any: ['n'] }, holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        { name: 'y', holdings: [{ ticker: 'Q', weight: 100 }] },
      ],
    };
    const out = refEvaluate(warm, bars);
    // Returns: +100%, +50%, -60% from the second day.
    expect(out.map((d) => d.date)).toEqual(ds.slice(1));
    expect(out.map((d) => d.signals.n)).toEqual([false, false, true]);
    expect(out.map((d) => d.allocation)).toEqual(['y', 'y', 'x']);
  });

  it('an unknown id or a cycle throws (no parser in the reference)', () => {
    const base = s.signals.filter((x) => x.id === 'a');
    const unknown = { ...s, signals: [...base, { id: 'z', type: 'not' as const, of: 'nope' }] };
    expect(() => refEvaluate(unknown, bars)).toThrow(/unknown signal nope/);
    const cycle = {
      ...s,
      signals: [
        ...base,
        { id: 'p', type: 'and' as const, of: ['a', 'q'] },
        { id: 'q', type: 'not' as const, of: 'p' },
      ],
    };
    expect(() => refEvaluate(cycle, bars)).toThrow(/cycle/);
  });
});

describe('reference: tolerance band right +- |right| x t/100', () => {
  const series = (closes: number[]): Record<string, RefBar[]> => ({
    Q: closes.map((close, i) => ({
      date: `2026-05-${String(1 + i).padStart(2, '0')}`,
      close,
      divCash: 0,
      splitFactor: 1,
      closeIsSplitAdjusted: false,
    })),
  });
  const dd = { indicator: 'drawdown' as const, ticker: 'Q' };
  const one = (sig: RefStrategy['signals'][number]): RefStrategy => ({
    signals: [sig],
    allocations: [{ name: 'x', holdings: [{ ticker: 'CASH_USD', weight: 100 }] }],
  });
  const run = (s: RefStrategy, closes: number[], id = 'k') =>
    refEvaluate(s, series(closes)).map((d) => d.signals[id]);

  it('negative reference: drawdown > -10 with t = 10 is true above -9, false below -11', () => {
    const s = one({
      id: 'k',
      type: 'compare',
      left: dd,
      op: '>',
      right: { threshold: -10 },
      tolerancePct: 10,
    });
    // All-time drawdowns (peak 100): 0, -8.5, -10, -11.5, -10, -9.5, -8.5.
    // First day plain: 0 > -10 true; -8.5 > -9 true; -10 in the band: kept; -11.5 < -11 false;
    // -10 kept; -9.5 kept; -8.5 true.
    expect(run(s, [100, 91.5, 90, 88.5, 90, 90.5, 91.5])).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      true,
    ]);
    // The old band right x (1 +- t/100) would be inverted here (-11 above, -9 below).
  });

  it("'<' mirrors it with a negative reference", () => {
    const s = one({
      id: 'k',
      type: 'compare',
      left: dd,
      op: '<',
      right: { threshold: -10 },
      tolerancePct: 10,
    });
    // 0 < -10 false; -11.5 below -11 true; -10 kept; -8.5 above -9 false.
    expect(run(s, [100, 88.5, 90, 91.5])).toEqual([false, true, true, false]);
  });

  it('near-ties at each bound keep the state', () => {
    const s = one({
      id: 'k',
      type: 'compare',
      left: dd,
      op: '>',
      right: { threshold: -10 },
      tolerancePct: 10,
    });
    // Drawdowns 0 (true), -11 (tie with the lower bound: kept true), -12 (false),
    // -9 (tie with the upper bound: kept false), -8 (true). 89/100 - 1 and 91/100 - 1 carry
    // float noise of about 1e-15, well within 1e-9 relative.
    expect(run(s, [100, 89, 88, 91, 92])).toEqual([true, true, false, false, true]);
  });

  it('reference 0: the band has zero width, an exact 0 is a tie', () => {
    const s = one({
      id: 'k',
      type: 'compare',
      left: { indicator: 'return', ticker: 'Q', length: 1 },
      op: '>',
      right: { threshold: 0 },
      tolerancePct: 10,
    });
    // Returns from day 2: +1% (true), 0 (tie: kept true), -0.99% (false), +0.1% (true).
    expect(run(s, [100, 101, 101, 100, 100.1])).toEqual([true, true, false, true]);
  });

  it('ensemble members use the same band', () => {
    const s = one({
      id: 'e',
      type: 'ensemble',
      threshold: 0.5,
      members: [
        { left: dd, op: '>', right: { threshold: -10 }, tolerancePct: 10 }, // band [-11, -9]
        { left: dd, op: '>', right: { threshold: -20 }, tolerancePct: 10 }, // band [-22, -18]
      ],
    });
    // Drawdowns 0, -10, -19, -21, -23, -10:
    //   m1: true, kept true, false, false, false, kept false
    //   m2: true, true, kept true, kept true, false, true
    expect(run(s, [100, 90, 81, 79, 77, 90], 'e')).toEqual([1, 1, 0.5, 0.5, 0, 0.5]);
  });
});
