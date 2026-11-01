// The reference's own checks for holdings identity (requirements 05, 13): a reorder of the same
// tickers and weights is no trade. Written against the reference only (no @saku/core).
import { describe, expect, it } from 'vitest';
import {
  refParseTicker,
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

// Explicit zero costs (omitted costs throw unless omittedCostsAsZero is passed).
const ZERO = { slippageBps: 0, feePct: 0 };

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
    costs: { slippageBps: 0, feePct: 0.1 },
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
    costs: { slippageBps: 0, feePct: 0.1 },
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

describe('reference: one ticker grammar', () => {
  it('reads the well-formed forms', () => {
    expect(refParseTicker('SPY')).toEqual({ base: 'SPY', L: 1, E: 0 });
    expect(refParseTicker('SPY?L=3&E=0.9')).toEqual({ base: 'SPY', L: 3, E: 0.9 });
    expect(refParseTicker('SPY?E=0.9&L=3')).toEqual({ base: 'SPY', L: 3, E: 0.9 });
    expect(refParseTicker('SPY?L=0.5')).toEqual({ base: 'SPY', L: 0.5, E: 0 });
    expect(refParseTicker('SPY?E=0')).toEqual({ base: 'SPY', L: 1, E: 0 });
    expect(refParseTicker('CASH_USD')).toEqual({ base: 'CASH_USD', L: 1, E: 0 });
  });

  it('refuses everything else', () => {
    for (const t of [
      '',
      'X?',
      'X?L=',
      'X?L',
      'X?L=1e1',
      'X?L=0x3',
      'X?L=%33',
      'X?L= 3',
      'X?L=+3',
      'X?L=3.',
      'X?L=.5',
      'X?L=2&L=3',
      'X?l=2',
      'X?K=2',
      'X?L=3&',
      'X?L=3&E=1&E=1',
      'X?L=0',
      'X?L=-1',
      'X?E=-0.1',
      `X?L=${'9'.repeat(400)}`,
      'CASH_USD?L=2',
      'CASH_USD?E=0',
      'X Y',
      'X%41',
      '?L=2',
    ]) {
      expect(refParseTicker(t), t).toBeUndefined();
    }
  });

  it('the backtest throws on a malformed ticker, never a silent 0 or NaN', () => {
    const bars: Record<string, RefBar[]> = {
      X: ['2026-06-01', '2026-06-02'].map((date) => ({
        date,
        open: 10,
        close: 10,
        divCash: 0,
        splitFactor: 1,
        closeIsSplitAdjusted: false,
      })),
    };
    for (const ticker of ['X?L=', 'X?L=1e1', 'X?L=2&L=3', 'X?L=-1', 'CASH_USD?L=2']) {
      const days: RefDay[] = ['2026-06-01', '2026-06-02'].map((date) => ({
        date,
        signals: {},
        allocation: 'a',
        holdings: [{ ticker, weight: 100 }],
      }));
      expect(() => refBacktest({ costs: ZERO }, days, bars, () => 0), ticker).toThrow(
        /malformed ticker/,
      );
    }
    const ok: RefDay[] = ['2026-06-01', '2026-06-02'].map((date) => ({
      date,
      signals: {},
      allocation: 'a',
      holdings: [{ ticker: 'X?L=2&E=0', weight: 100 }],
    }));
    expect(refBacktest({ costs: ZERO }, ok, bars, () => 0).equity).toEqual([1, 1]);
  });
});

describe('reference: whole shares (docs/indicators.md "Whole shares")', () => {
  const D = ['2026-07-01', '2026-07-02', '2026-07-06', '2026-07-07'];
  type B = Partial<RefBar> & { close: number };
  const mk = (list: B[]): RefBar[] =>
    list.map((b, i) => ({
      date: D[i]!,
      divCash: 0,
      splitFactor: 1,
      closeIsSplitAdjusted: false,
      ...b,
    }));
  const hold = (...h: [string, number][]) => h.map(([ticker, weight]) => ({ ticker, weight }));
  const decide = (list: RefDay['holdings'][]): RefDay[] =>
    list.map((holdings, i) => ({ date: D[i]!, signals: {}, allocation: `a${i}`, holdings }));
  const usd = (initialAmount: string) => ({ wholeShares: { initialAmount, currency: 'USD' } });
  const amounts = (r: { value?: { amount: number; currency: string }[] }) => {
    expect(r.value!.every((v) => v.currency === 'USD')).toBe(true);
    return r.value!.map((v) => v.amount);
  };
  const near = (xs: number[], ys: number[]) => {
    expect(xs.length).toBe(ys.length);
    xs.forEach((x, i) => expect(x).toBeCloseTo(ys[i]!, 9));
  };
  const X = hold(['X', 100]);
  const nextClose = { execution: 'next_close' as const, costs: ZERO };

  it('buys floor(x) shares and keeps the rest as USD cash (next_close, no costs)', () => {
    const bars = { X: mk([{ close: 100 }, { close: 110 }, { close: 121 }]) };
    const r = refBacktest(nextClose, decide([X, X, X]), bars, () => 0, usd('1000'));
    // Day 1 at the close 110: x = 100 x 1000 / (100 x 110) = 9.09, n = 9, residual 10.
    // Day 2: 10 + 9 x 121 = 1099.
    near(amounts(r), [1000, 1000, 1099]);
    near(r.equity, [1, 1, 1.099]);
    expect(r.weights![0]).toEqual({});
    expect(r.weights![2]!.X).toBeCloseTo(1089 / 1099, 12);
    expect(r.weights![2]!.CASH_USD).toBeCloseTo(10 / 1099, 12);
    expect(r.trades).toEqual([
      {
        date: D[1],
        time: 'close',
        V: { amount: 1000, currency: 'USD' },
        shares: { X: 9 },
        zeroShares: [],
        residual: { amount: 10, currency: 'USD' },
        costs: { amount: 0, currency: 'USD' },
      },
    ]);
    expect(r.switches).toBe(0);
    expect(r.costs).toBe(0);
  });

  it('sizing order and snap: 58% of 100 at price 2 is 29 shares and 42 cash', () => {
    expect(Math.floor((0.58 * 100) / 2)).toBe(28); // the float noise the order avoids
    const bars = { X: mk([{ close: 2 }, { close: 2 }]) };
    const T = hold(['X', 58], ['CASH_USD', 42]);
    const r = refBacktest(nextClose, decide([T, T]), bars, () => 0, usd('100'));
    expect(r.trades![0]!.shares).toEqual({ X: 29 });
    expect(r.trades![0]!.residual.amount).toBe(42);
  });

  it('the sizing snap: x = 2.9999999999999996 in float64 is 3 shares', () => {
    // 2% of 165 at 1.1: (2 x 165) / (100 x 1.1 x 1) is 3 in exact arithmetic, just below in float.
    expect((2 * 165) / (100 * 1.1 * 1)).toBeLessThan(3);
    const bars = { X: mk([{ close: 1.1 }, { close: 1.1 }]) };
    const T = hold(['X', 2], ['CASH_USD', 98]);
    const r = refBacktest(nextClose, decide([T, T]), bars, () => 0, usd('165'));
    expect(r.trades![0]!.shares).toEqual({ X: 3 });
    expect(r.trades![0]!.residual.amount).toBeCloseTo(161.7, 12);
  });

  it('the sizing snap is float noise only: a true 6.999999993 stays 6 shares', () => {
    // x = 100 x 6.999999993 / (100 x 1 x 1) = 6.999999993: 1e-9 short of 7 relative, far beyond
    // 1e-12, so the floor gives 6 and the residual is 0.999999993.
    const bars = { X: mk([{ close: 1 }, { close: 1 }]) };
    const r = refBacktest(nextClose, decide([X, X]), bars, () => 0, usd('6.999999993'));
    expect(r.trades![0]!.shares).toEqual({ X: 6 });
    expect(r.trades![0]!.residual.amount).toBeCloseTo(0.999999993, 15);
  });

  it('a switch with costs sets the sale cost aside first: cash never below 0', () => {
    // c = 25% (hand-friendly). Day 1: X at 100: B = 1250, x = 100 x 1250 / (100 x 100 x 1.25)
    // = 10, costs 0.25 x 1000 = 250, residual 0. Day 2 switch to Y at 60, X still 100:
    // V = 1000, H = 1000, B = 750, x = 750 / 75 = 10, costs 0.25 x (1000 + 600) = 400,
    // residual 1000 - 600 - 400 = 0. (Sized on V: 13 shares and a residual of -225.)
    const bars = {
      X: mk([{ close: 100 }, { close: 100 }, { close: 100 }, { close: 100 }]),
      Y: mk([{ close: 60 }, { close: 60 }, { close: 60 }, { close: 66 }]),
    };
    const Y = hold(['Y', 100]);
    const r = refBacktest(
      { execution: 'next_close', costs: { slippageBps: 0, feePct: 25 } },
      decide([X, Y, Y, Y]),
      bars,
      () => 0,
      usd('1250'),
    );
    expect(r.trades!.map((t) => [t.V.amount, t.shares, t.residual.amount, t.costs.amount])).toEqual(
      [
        [1250, { X: 10 }, 0, 250],
        [1000, { Y: 10 }, 0, 400],
      ],
    );
    near(amounts(r), [1250, 1000, 600, 660]);
    expect(r.switches).toBe(1);
    expect(r.costs).toBeCloseTo(250 / 1250 + 400 / 1000, 12);
  });

  it('a target ticker with 0 shares is listed, not an error', () => {
    const bars = { X: mk([{ close: 100 }, { close: 100 }]) };
    const r = refBacktest(nextClose, decide([X, X]), bars, () => 0, usd('50'));
    expect(r.trades![0]!.shares).toEqual({ X: 0 });
    expect(r.trades![0]!.zeroShares).toEqual(['X']);
    expect(r.trades![0]!.residual.amount).toBe(50);
    expect(r.weights![1]).toEqual({ CASH_USD: 1 });
  });

  it('within a part: interest on the starting cash, then split and fraction, then dividend on kept shares', () => {
    // Day 1 buy 9 at 100 (residual 50). Day 2: rate 25.2% a year = 0.001 a night on the 50;
    // 3-for-2 split: 13.5 -> 13 kept, 0.5 x 70 = 35 cash; dividend 2 on the 13 kept = 26.
    // Cash 50 x 1.001 + 35 + 26 = 111.05; value 111.05 + 13 x 70 = 1021.05.
    const bars = {
      X: mk([{ close: 100 }, { close: 100 }, { close: 70, splitFactor: 1.5, divCash: 2 }]),
    };
    const r = refBacktest(nextClose, decide([X, X, X]), bars, () => 25.2, usd('950'));
    near(amounts(r), [950, 950, 1021.05]);
    expect(r.weights![2]!.CASH_USD).toBeCloseTo(111.05 / 1021.05, 12);
  });

  it('the rate is read only when the cash at the start of the part is above 0', () => {
    // 10 shares at 100, residual 0. Day 2: a dividend of 1 arrives (10), no rate needed.
    // Day 3: cash 10 at the start, the rate is read: unknown fails.
    const bars = {
      X: mk([{ close: 100 }, { close: 100 }, { close: 99, divCash: 1 }, { close: 99 }]),
    };
    const three = { X: bars.X.slice(0, 3) };
    const r = refBacktest(nextClose, decide([X, X, X]), three, () => NaN, usd('1000'));
    near(amounts(r), [1000, 1000, 10 + 990]);
    expect(() =>
      refBacktest(nextClose, decide([X, X, X, X]), bars, () => NaN, usd('1000')),
    ).toThrow(/unknown cash rate/);
  });

  it('a split product within 1e-9 of a whole number is that number', () => {
    // 100 shares x 0.57 = 56.99999999999999 in float64: 57 shares, no cash in lieu.
    expect(100 * 0.57).toBeLessThan(57);
    const bars = { X: mk([{ close: 10 }, { close: 10 }, { close: 20, splitFactor: 0.57 }]) };
    const r = refBacktest(nextClose, decide([X, X, X]), bars, () => 0, usd('1000'));
    expect(r.value![2]).toEqual({ amount: 57 * 20, currency: 'USD' });
    expect(r.weights![2]).toEqual({ X: 1 });
  });

  it('a reverse split can leave 0 shares: the holding is all cash, no dividend on it', () => {
    // 3 shares; 1-for-10: 0.3 -> 0 kept, 0.3 x 1000 = 300 cash; the dividend of 5 is on 0 shares.
    const bars = {
      X: mk([
        { close: 100 },
        { close: 100 },
        { close: 1000, splitFactor: 0.1, divCash: 5 },
        { close: 900 },
      ]),
    };
    const r = refBacktest(nextClose, decide([X, X, X, X]), bars, () => 0, usd('300'));
    near(amounts(r), [300, 300, 300, 300]);
    expect(r.weights![2]).toEqual({ CASH_USD: 1 });
  });

  it('next_open: trades at the open; a split in a whole day pays the fraction at the close', () => {
    const bars = {
      X: mk([{ close: 100 }, { open: 100, close: 100 }, { open: 50, close: 52, splitFactor: 2.5 }]),
    };
    // Day-0 decision trades at day 1 open: floor(1010 / 100) = 10, residual 10. Day 2 (no trade,
    // whole day): 25 shares, no fraction: 10 + 25 x 52.
    const r = refBacktest(
      { execution: 'next_open', costs: ZERO },
      decide([X, X, X]),
      bars,
      () => 0,
      usd('1010'),
    );
    expect(r.trades![0]!.time).toBe('open');
    near(amounts(r), [1010, 1010, 10 + 25 * 52]);
    // 3 shares x 2.5 = 7.5 -> 7 kept, 0.5 x 52 at the close.
    const r2 = refBacktest(
      { execution: 'next_open', costs: ZERO },
      decide([X, X, X]),
      bars,
      () => 0,
      usd('300'),
    );
    near(amounts(r2), [300, 300, 0.5 * 52 + 7 * 52]);
  });

  it('next_open: a split in the night part pays the fraction at the open', () => {
    // Day 0 decides X, day 1 decides Y: day 2 trades at the open, so day 2 is split into night and
    // day. X held 3; night split 2.5 -> 7 kept, 0.5 x open 40 = 20 cash; then sold at 40.
    const Y = hold(['Y', 100]);
    const bars = {
      X: mk([{ close: 100 }, { open: 100, close: 100 }, { open: 40, close: 41, splitFactor: 2.5 }]),
      Y: mk([{ close: 10 }, { open: 10, close: 10 }, { open: 10, close: 10 }]),
    };
    const r = refBacktest(
      { execution: 'next_open', costs: ZERO },
      decide([X, Y, Y]),
      bars,
      () => 0,
      usd('300'),
    );
    // V at day 2 open = 20 + 7 x 40 = 300: 30 Y shares, residual 0.
    expect(r.trades![1]!.V.amount).toBeCloseTo(300, 9);
    expect(r.trades![1]!.shares).toEqual({ Y: 30 });
  });

  it('refuses malformed input, another currency, duplicates, synthetic tickers, adjusted bars, bad prices', () => {
    const bars = { X: mk([{ close: 100 }, { close: 100 }, { close: 100 }]) };
    const run = (o: unknown, b: Record<string, RefBar[]> = bars, h = X) =>
      refBacktest(nextClose, decide([h, h, h]), b, () => 0, o as never);
    for (const amount of ['0', '-5', '1e3', ' 10', '1,000', '10.', '.5', '+10', '']) {
      expect(() => run(usd(amount)), amount).toThrow(/initial amount/);
    }
    expect(() => run({ wholeShares: { initialAmount: '1000', currency: 'JPY' } })).toThrow(
      /USD only/,
    );
    expect(() => run(usd('1000'), bars, hold(['X', 50], ['X', 50]))).toThrow(/twice/);
    // Synthetic tickers: in a day's holdings, an allocation or the safe state.
    expect(() => run(usd('1000'), bars, hold(['X?L=2', 100]))).toThrow(/synthetic/);
    const withAllocation = {
      execution: 'next_close' as const,
      costs: ZERO,
      allocations: [{ name: 'lev', holdings: hold(['X?L=3', 100]) }],
    };
    expect(() =>
      refBacktest(withAllocation, decide([X, X, X]), bars, () => 0, usd('1000')),
    ).toThrow(/synthetic/);
    const withSafe = {
      execution: 'next_close' as const,
      costs: ZERO,
      safeState: { holdings: hold(['X?E=1', 100]) },
    };
    expect(() => refBacktest(withSafe, decide([X, X, X]), bars, () => 0, usd('1000'))).toThrow(
      /synthetic/,
    );
    const adjusted = { X: bars.X.map((b) => ({ ...b, closeIsSplitAdjusted: true })) };
    expect(() => run(usd('1000'), adjusted)).toThrow(/split-adjusted/);
    const zero = { X: mk([{ close: 100 }, { close: 0 }, { close: 100 }]) };
    expect(() => run(usd('1000'), zero)).toThrow(/price 0/);
    // A missing open at a next_open trade.
    const noOpen = { X: mk([{ close: 100 }, { close: 100 }, { close: 100 }]) };
    expect(() =>
      refBacktest(
        { execution: 'next_open', costs: ZERO },
        decide([X, X, X]),
        noOpen,
        () => 0,
        usd('1000'),
      ),
    ).toThrow(/no open/);
  });

  it('without the option the result is exactly the fractional one', () => {
    const bars = { X: mk([{ close: 100 }, { close: 110 }, { close: 99 }]) };
    const S = hold(['X?L=2', 100]);
    const a = refBacktest(nextClose, decide([S, S, S]), bars, () => 1);
    const b = refBacktest(nextClose, decide([S, S, S]), bars, () => 1, {});
    expect(b).toEqual(a);
    expect(Object.keys(a).sort()).toEqual(['dates', 'equity', 'switches']);
  });
});

describe('reference: bars between sessions (docs/indicators.md "Returns")', () => {
  // G may be held (an allocation) and has no bar on D[2], so D[2] is not a session; H, the held
  // ticker, has a bar there.
  const D = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];
  const mk = (list: (Partial<RefBar> & { close: number })[], skip?: number): RefBar[] =>
    list
      .map((b, i) => ({
        date: D[i]!,
        divCash: 0,
        splitFactor: 1,
        closeIsSplitAdjusted: false,
        ...b,
      }))
      .filter((_, i) => i !== skip);
  const G = mk(
    [10, 10, 10, 10].map((c) => ({ open: c, close: c })),
    2,
  );
  const hold = (t: string) => [{ ticker: t, weight: 100 }];
  const decide = (t: string, dates: string[]): RefDay[] =>
    dates.map((date) => ({ date, signals: {}, allocation: 'a', holdings: hold(t) }));
  const strategy = (t: string, execution: 'next_close' | 'next_open' = 'next_close') => ({
    execution,
    costs: ZERO,
    allocations: [
      { name: 'a', holdings: hold(t) },
      { name: 'g', holdings: hold('G') },
    ],
  });
  const sessionDates = [D[0]!, D[1]!, D[3]!];

  it('a 2:1 split on a gap day is not a 50% loss (fractional, whole day)', () => {
    // H: 200, 200, 101 (2:1 split, gap), 102. Bought at D[1]'s close (200).
    // D[3]: (101 x 2 / 200) x (102 / 101) = 1.02.
    const H = mk([{ close: 200 }, { close: 200 }, { close: 101, splitFactor: 2 }, { close: 102 }]);
    const r = refBacktest(strategy('H'), decide('H', sessionDates), { H, G }, () => 0);
    expect(r.dates).toEqual(sessionDates);
    r.equity.forEach((e, i) => expect(e).toBeCloseTo([1, 1, 1.02][i]!, 12));
  });

  it('a gap dividend is compounded; next_open puts the gap into the night part', () => {
    // H: 100, 100 (open 100), gap 98 with a dividend of 2, D[3] open 99, close 102.
    // Day-0 decision trades at D[1] open; D[1] equity 1. D[3] (no trade, whole day):
    // (98 + 2) / 100 x 102 / 98.
    const H = mk([
      { close: 100 },
      { open: 100, close: 100 },
      { close: 98, divCash: 2 },
      { open: 99, close: 102 },
    ]);
    const r = refBacktest(strategy('H', 'next_open'), decide('H', sessionDates), { H, G }, () => 0);
    r.equity.forEach((e, i) => expect(e).toBeCloseTo([1, 1, (100 / 100) * (102 / 98)][i]!, 12));
    // A trade at D[3] open: the night part holds the gap (to the open 99), the day part 102/99.
    const days = [...decide('H', [D[0]!]), ...decide('G', [D[1]!, D[3]!])];
    const r2 = refBacktest(strategy('H', 'next_open'), days, { H, G }, () => 0);
    // Night: (98 + 2) / 100 x 99 / 98 on H, then switch to G (no costs), G flat in the day.
    expect(r2.equity[2]).toBeCloseTo((100 / 100) * (99 / 98), 12);
  });

  it('a synthetic ticker resets daily over a gap, financing per covered day', () => {
    // X: 100, 100, gap 110, 121. L = 2, rate 25.2% (0.001 a day): two covered days, each
    // 1 + 2 x 0.1 - (2 - 1) x 0.001 = 1.199: 1.199^2 = 1.437601.
    const X = mk([{ close: 100 }, { close: 100 }, { close: 110 }, { close: 121 }]);
    const r = refBacktest(strategy('X?L=2'), decide('X?L=2', sessionDates), { X, G }, () => 25.2);
    expect(r.equity[2]).toBeCloseTo(1.199 ** 2, 12);
  });

  it('a cash-only strategy takes its sessions from the evaluated dates', () => {
    const S = mk([{ close: 1 }, { close: 1 }, { close: 1 }, { close: 1 }]);
    const days = decide('CASH_USD', [D[0]!, D[1]!, D[3]!]);
    // Z is loaded but not held: its dates do not make sessions.
    const r = refBacktest({ execution: 'next_close', costs: ZERO }, days, { S, Z: S }, () => 25.2);
    expect(r.dates).toEqual([D[0], D[1], D[3]]);
    // Bought at D[1]'s close; one night to D[3]: 1.001.
    expect(r.equity[2]).toBeCloseTo(1.001, 12);
  });

  describe('whole shares', () => {
    const usd = (initialAmount: string) => ({ wholeShares: { initialAmount, currency: 'USD' } });

    it('a 2:1 split on a gap day doubles the shares', () => {
      // 5 shares at 200; gap split x 2 -> 10; D[3] close 102: 1020.
      const H = mk([
        { close: 200 },
        { close: 200 },
        { close: 101, splitFactor: 2 },
        { close: 102 },
      ]);
      const r = refBacktest(
        strategy('H'),
        decide('H', sessionDates),
        { H, G },
        () => 0,
        usd('1000'),
      );
      expect(r.value!.map((v) => v.amount)).toEqual([1000, 1000, 1020]);
    });

    it('gap bars first in date order, fraction at the gap close, dividends on kept shares', () => {
      // 5 shares at 200, residual 100. Gap: split 1.5 -> 7.5: 7 kept, 0.5 x 140 = 70 cash; gap
      // dividend 1 x 7 = 7. Session bar: dividend 2 x 7 = 14, close 141.
      // Value 100 + 70 + 7 + 14 + 7 x 141 = 1178.
      const H = mk([
        { close: 200 },
        { close: 200 },
        { close: 140, splitFactor: 1.5, divCash: 1 },
        { close: 141, divCash: 2 },
      ]);
      const r = refBacktest(
        strategy('H'),
        decide('H', sessionDates),
        { H, G },
        () => 0,
        usd('1100'),
      );
      expect(r.value![2]!.amount).toBeCloseTo(1178, 9);
      expect(r.weights![2]!.CASH_USD).toBeCloseTo(191 / 1178, 12);
    });

    it('a cost rate of 100% or more is refused', () => {
      const H = mk([{ close: 200 }, { close: 200 }, { close: 200 }, { close: 200 }]);
      for (const costs of [
        { slippageBps: 0, feePct: 100 },
        { slippageBps: 5000, feePct: 50 },
        { slippageBps: 0, feePct: 150 },
      ]) {
        expect(() =>
          refBacktest(
            { ...strategy('H'), costs },
            decide('H', sessionDates),
            { H, G },
            () => 0,
            usd('1000'),
          ),
        ).toThrow(/100% or more/);
      }
      // 99.99% is allowed.
      expect(() =>
        refBacktest(
          { ...strategy('H'), costs: { slippageBps: 0, feePct: 99.99 } },
          decide('H', sessionDates),
          { H, G },
          () => 0,
          usd('1000'),
        ),
      ).not.toThrow();
    });

    it('a ticker listed twice in an allocation that is never traded is refused up front', () => {
      const H = mk([{ close: 200 }, { close: 200 }, { close: 200 }, { close: 200 }]);
      const s = {
        execution: 'next_close' as const,
        costs: ZERO,
        allocations: [
          { name: 'a', holdings: hold('H') },
          {
            name: 'dup',
            holdings: [
              { ticker: 'G', weight: 50 },
              { ticker: 'G', weight: 50 },
            ],
          },
        ],
      };
      expect(() =>
        refBacktest(s, decide('H', sessionDates), { H, G }, () => 0, usd('1000')),
      ).toThrow(/twice/);
    });
  });
});

describe('reference: omitted costs (docs/indicators.md "Costs")', () => {
  const D = ['2026-09-01', '2026-09-02', '2026-09-03'];
  const bars = {
    X: [100, 110, 121].map((close, i) => ({
      date: D[i]!,
      open: close,
      close,
      divCash: 0,
      splitFactor: 1,
      closeIsSplitAdjusted: false,
    })),
  };
  const days: RefDay[] = D.map((date) => ({
    date,
    signals: {},
    allocation: 'a',
    holdings: [{ ticker: 'X', weight: 100 }],
  }));
  const run = (costs: { slippageBps?: number; feePct?: number } | undefined, o?: object) =>
    refBacktest({ execution: 'next_close', costs }, days, bars, () => 0, o);

  it('throws when slippageBps or feePct is undefined', () => {
    expect(() => run(undefined)).toThrow(/slippageBps/);
    expect(() => run({ feePct: 0.1 })).toThrow(/slippageBps/);
    expect(() => run({ slippageBps: 10 })).toThrow(/feePct/);
    expect(() =>
      run(undefined, { wholeShares: { initialAmount: '1000', currency: 'USD' } }),
    ).toThrow(/slippageBps/);
  });

  it('omittedCostsAsZero: true reads them as 0 (the pre-C2 reading)', () => {
    const zero = run({ slippageBps: 0, feePct: 0 });
    expect(run(undefined, { omittedCostsAsZero: true })).toEqual(zero);
    // Only the omitted one is 0: fee 1% with slippage omitted, bought at 110: 0.99, then x 1.1.
    const r = run({ feePct: 1 }, { omittedCostsAsZero: true });
    expect(r.equity[2]).toBeCloseTo(0.99 * 1.1, 12);
    // false is the same as leaving it out.
    expect(() => run(undefined, { omittedCostsAsZero: false })).toThrow(/slippageBps/);
  });
});

describe('reference: covered days (docs/indicators.md "Returns", "Cash", "Synthetic leverage")', () => {
  // Sessions need every holdable ticker; G has no bar on D[2..4], so those are covered days of
  // the step from D[1] to D[5] whenever another holdable ticker has a bar there.
  const D = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
  const mk = (closes: (number | undefined)[], extra: Partial<RefBar>[] = []): RefBar[] =>
    closes.flatMap((close, i) =>
      close === undefined
        ? []
        : [
            {
              date: D[i]!,
              open: close,
              close,
              divCash: 0,
              splitFactor: 1,
              closeIsSplitAdjusted: false,
              ...extra[i],
            },
          ],
    );
  const G = mk([10, 10, undefined, undefined, undefined, 10]);
  const hold = (t: string) => [{ ticker: t, weight: 100 }];
  const strategy = (t: string, execution: 'next_close' | 'same_close' = 'next_close') => ({
    execution,
    costs: ZERO,
    allocations: [
      { name: 'a', holdings: hold(t) },
      { name: 'g', holdings: hold('G') },
    ],
  });
  const decide = (t: string, dates: string[]): RefDay[] =>
    dates.map((date) => ({ date, signals: {}, allocation: 'a', holdings: hold(t) }));
  const sessions = [D[0]!, D[1]!, D[5]!];

  it('X?L=3 falling 15% a day over a 3-day gap stays positive and equals the daily reset', () => {
    const X = mk([100, 100, 85, 72.25, 61.4125, 52.200625]);
    const r = refBacktest(strategy('X?L=3'), decide('X?L=3', sessions), { X, G }, () => 0);
    expect(r.dates).toEqual(sessions);
    // Four covered days (D[2..4], D[5]), each 1 - 3 x 0.15 = 0.55.
    expect(r.equity[2]).toBeCloseTo(0.55 ** 4, 12);
    expect(r.equity[2]).toBeGreaterThan(0);
    // With a rate of 25.2% (0.001 a day): each day 1 - 0.45 - 2 x 0.001 = 0.548.
    const f = refBacktest(strategy('X?L=3'), decide('X?L=3', sessions), { X, G }, () => 25.2);
    expect(f.equity[2]).toBeCloseTo(0.548 ** 4, 12);
  });

  it('a day whose growth is not above 0 fails', () => {
    // X falls 40% on a covered day: 1 - 3 x 0.4 = -0.2.
    const X = mk([100, 100, 60, 60, 60, 60]);
    expect(() =>
      refBacktest(strategy('X?L=3'), decide('X?L=3', sessions), { X, G }, () => 0),
    ).toThrow(/growth/);
  });

  it('cash earns each covered day at that day rate', () => {
    // H (holdable, not held) has bars on D[2..4]; cash is held from D[1]'s close.
    const H = mk([10, 10, 10, 10, 10, 10]);
    const rates: Record<string, number> = {
      [D[2]!]: 25.2,
      [D[3]!]: 50.4,
      [D[4]!]: 0,
      [D[5]!]: 25.2,
    };
    const s = {
      execution: 'next_close' as const,
      costs: ZERO,
      allocations: [
        { name: 'c', holdings: hold('CASH_USD') },
        { name: 'h', holdings: hold('H') },
        { name: 'g', holdings: hold('G') },
      ],
    };
    const r = refBacktest(s, decide('CASH_USD', sessions), { H, G }, (d) => rates[d] ?? 0);
    expect(r.equity[2]).toBeCloseTo(1.001 * 1.002 * 1 * 1.001, 12);
  });

  it('a held ticker without a bar on a covered day has return 0 there; its move counts on its next bar', () => {
    // H has no bar on D[3]; H2 (holdable) makes D[2..4] covered days.
    const H = mk([100, 100, 110, undefined, 121, 133.1]);
    const H2 = mk([1, 1, 1, 1, 1, 1]);
    const s = {
      execution: 'next_close' as const,
      costs: ZERO,
      allocations: [
        { name: 'a', holdings: hold('H') },
        { name: 'b', holdings: hold('H2') },
        { name: 'g', holdings: hold('G') },
      ],
    };
    const r = refBacktest(s, decide('H', sessions), { H, H2, G }, () => 0);
    expect(r.equity[2]).toBeCloseTo(1.331, 12);
  });

  it('the pre-entry probe: held over a night without a bar on the previous session fails', () => {
    // H has no bar on D[0], an evaluated date; same_close buys H at D[0] (fractional), so the
    // step to D[1] holds H from a session where H has no bar: its move before entry is unknown.
    const H = mk([undefined, 100, 100, 100, 100, 100]);
    const S = mk([1, 1, 1, 1, 1, 1]);
    const s = { execution: 'same_close' as const, costs: ZERO };
    const days = decide('H', [D[0]!, D[1]!]);
    expect(() => refBacktest(s, days, { H, S }, () => 0)).toThrow(/without a bar that day/);
  });

  describe('whole shares', () => {
    const usd = (initialAmount: string) => ({ wholeShares: { initialAmount, currency: 'USD' } });

    it('residual interest per covered day, then split and dividend that day', () => {
      // 9 shares at 100, residual 50 (initial 950). Rate 25.2% = 0.001 a day on D[2..5].
      // D[2]: 50 x 1.001 = 50.05; split 1.5 -> 13.5: 13 kept, 0.5 x 70 = 35: 85.05.
      // D[3]: 85.05 x 1.001 = 85.13505; dividend 1 x 13 = 13: 98.13505.
      // D[4]: x 1.001 = 98.23318505.  D[5]: x 1.001 = 98.33141823505.
      const X = mk([100, 100, 70, 70, 70, 71], [{}, {}, { splitFactor: 1.5 }, { divCash: 1 }]);
      const r = refBacktest(strategy('X'), decide('X', sessions), { X, G }, () => 25.2, usd('950'));
      const cash = ((50 * 1.001 + 35) * 1.001 + 13) * 1.001 * 1.001;
      expect(r.value![2]!.amount).toBeCloseTo(cash + 13 * 71, 9);
    });

    it('the rate is read only when the cash at the start of a covered day is above 0', () => {
      // 10 shares at 100, residual 0. A dividend on the last covered day: no rate read.
      const late = mk([100, 100, 100, 100, 100, 100], [{}, {}, {}, {}, {}, { divCash: 1 }]);
      const ok = refBacktest(
        strategy('X'),
        decide('X', sessions),
        { X: late, G },
        () => NaN,
        usd('1000'),
      );
      expect(ok.value![2]!.amount).toBeCloseTo(1010, 9);
      // A dividend on D[2]: the cash is above 0 at the start of D[3], the unknown rate fails.
      const early = mk([100, 100, 100, 100, 100, 100], [{}, {}, { divCash: 1 }]);
      expect(() =>
        refBacktest(strategy('X'), decide('X', sessions), { X: early, G }, () => NaN, usd('1000')),
      ).toThrow(/unknown cash rate/);
    });
  });
});
