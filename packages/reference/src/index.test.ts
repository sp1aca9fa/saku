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
