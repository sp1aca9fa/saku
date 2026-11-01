// The B1 v1 indicators (requirements 06; the contract in docs/indicators.md, "Indicators (B1,
// v1)"): hand-computed values for each, warm-up, missing and inconsistent data (no value, never a
// guess), the open/high/low on the series' basis, the schema (strict, refused where the doc
// says) and incremental against full recomputation (<= 1e-9 relative, requirements 13).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { totalReturnIndex } from '../adjusted';
import type { RawBar } from '../domain';
import { evaluate, onSeriesBasis, operandBars, signalLookbacks, splitAdjusted } from './engine';
import {
  type SeriesBar,
  drawdown,
  ema,
  garmanKlass,
  parkinson,
  periodReturn,
  rollingHigh,
  rollingLow,
  volatility,
  yangZhang,
} from './indicators';
import { Strategy } from './schema';
import { parsePlainAgainstLevel } from './testkit';

const relClose = (a: number | undefined, b: number) =>
  a !== undefined && Math.abs(a - b) <= 1e-9 * Math.abs(b);
const expectValues = (got: (number | undefined)[], want: (number | undefined)[]) => {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => {
    const w = want[i];
    if (w === undefined) expect(g, `bar ${i}`).toBeUndefined();
    else expect(relClose(g, w) || (w === 0 && g === 0), `bar ${i}: ${g} vs ${w}`).toBe(true);
  });
};

// Six days with consistent ranges (low <= open, close <= high). Expected values below were
// computed by hand and independently in Python from the formulas in docs/indicators.md.
const C = [10, 11, 10.5, 12, 11.5, 13];
const O = [9.8, 10.2, 11.1, 10.6, 12.1, 11.4];
const H = [10.3, 11.2, 11.3, 12.2, 12.3, 13.1];
const L = [9.7, 10.1, 10.4, 10.5, 11.4, 11.3];
const ohlc = (): SeriesBar[] => C.map((close, i) => ({ open: O[i], high: H[i], low: L[i], close }));
const u = undefined;

describe('B1 indicators: hand-computed values', () => {
  it('EMA: seeded with the mean of the first N values, then alpha = 2 / (N + 1)', () => {
    // alpha = 0.5; seed (10 + 11 + 10.5) / 3 = 10.5; 0.5 x 12 + 0.5 x 10.5 = 11.25; ...
    expectValues(ema(C, 3), [u, u, 10.5, 11.25, 11.375, 12.1875]);
    expectValues(ema(C, 1), C);
    expectValues(ema([1, 2], 3), [u, u]);
    expectValues(ema([], 3), []);
  });

  it('return over N days: simple, in percent, warm-up N bars', () => {
    expectValues(periodReturn(C, 2), [
      u,
      u,
      5.000000000000004,
      9.090909090909083,
      9.523809523809534,
      8.333333333333325,
    ]);
    expectValues(periodReturn([10, 11, 9.9], 1), [u, 10.000000000000009, -9.999999999999998]);
    // A non-positive value at either end is a data error: no value.
    expectValues(periodReturn([10, 0, 11, 12], 1), [u, u, u, (12 / 11 - 1) * 100]);
  });

  it('drawdown from the N-day high (today included) and from the all-time high', () => {
    expectValues(drawdown(C, 3), [u, u, -4.545454545454541, 0, -4.1666666666666625, 0]);
    expectValues(drawdown(C), [0, 0, -4.545454545454541, 0, -4.1666666666666625, 0]);
    // The all-time high is not forgotten after N days.
    expectValues(drawdown([20, 10, 11, 12]), [0, -50, -45, -40]);
    expectValues(drawdown([20, 10, 11, 12], 2), [u, -50, 0, 0]);
    // A non-positive value: no value for windows holding it (the all-time one from then on).
    expectValues(drawdown([10, -1, 11, 12], 2), [u, u, u, 0]);
    expectValues(drawdown([10, -1, 11, 12]), [0, u, u, u]);
  });

  it('N-day high and low of the series values, today included', () => {
    expectValues(rollingHigh(C, 3), [u, u, 11, 12, 12, 13]);
    expectValues(rollingLow(C, 3), [u, u, 10, 10.5, 10.5, 11.5]);
    expectValues(rollingHigh(C, 1), C);
  });

  it('Parkinson, Garman-Klass and Yang-Zhang volatility (N = 3)', () => {
    expectValues(parkinson(ohlc(), 3), [
      u,
      u,
      80.10076515712501,
      110.21366508229215,
      103.24006834850432,
      123.25026674286366,
    ]);
    expectValues(garmanKlass(ohlc(), 3), [
      u,
      u,
      76.8775725475147,
      94.83558312046264,
      89.11200616618339,
      98.1258815442456,
    ]);
    // Warm-up N bars: the first overnight return needs the close before the window.
    expectValues(yangZhang(ohlc(), 3), [
      u,
      u,
      u,
      91.55319944717,
      89.89805344557247,
      93.05503314242128,
    ]);
  });

  it('Parkinson of one day: ln(H/L) x sqrt(252 / (4 ln 2)) x 100', () => {
    const one = parkinson([{ open: 10, high: 11, low: 10, close: 10.5 }], 1);
    expectValues(one, [Math.log(1.1) * Math.sqrt(252 / (4 * Math.LN2)) * 100]);
  });
});

describe('B1 indicators: missing and inconsistent data give no value', () => {
  const cases: [string, Partial<SeriesBar>][] = [
    ['no open', { open: undefined }],
    ['no high', { high: undefined }],
    ['no low', { low: undefined }],
    ['a high below the low', { high: 10, low: 10.6 }],
    ['an open above the high', { open: 12.3 }],
    ['an open below the low', { open: 10.4 }],
    ['a close above the high (on the series basis)', { close: 12.25 }],
    ['a close below the low', { close: 10.45 }],
    ['a non-positive low', { low: 0 }],
    ['a non-finite open', { open: NaN }],
  ];
  it.each(cases)('%s on day 3: every window holding it has no value', (_, change) => {
    const bars = ohlc();
    bars[3] = { ...bars[3]!, ...change };
    // N = 2: windows ending on days 3 and 4 hold day 3.
    for (const f of [parkinson, garmanKlass]) {
      const v = f(bars, 2);
      expect(v[2]).toBeDefined();
      expect(v[3]).toBeUndefined();
      expect(v[4]).toBeUndefined();
      expect(v[5]).toBeDefined();
    }
    const yz = yangZhang(bars, 2);
    expect([yz[2], yz[5]].every((x) => x !== undefined)).toBe(true);
    expect([yz[3], yz[4]]).toEqual([u, u]);
  });

  it('Yang-Zhang reads only the close of the day before its window (its range may be missing)', () => {
    const bars = ohlc();
    bars[2] = { close: bars[2]!.close };
    const yz = yangZhang(bars, 2);
    expect(yz[2]).toBeUndefined();
    expect(yz[3]).toBeUndefined();
    expect(yz[4]).toBeDefined();
  });

  it('a close outside its range gives no value, where the variance would also be negative', () => {
    // H = L, so the range term is 0 and the open-to-close term would make the mean negative.
    const bad = [{ open: 9, high: 10, low: 10, close: 11 }];
    expect(garmanKlass(bad, 1)).toEqual([u]);
    expect(parkinson(bad, 1)).toEqual([u]);
  });

  it('checks the range on the series basis, which keeps the raw order (a split day)', () => {
    const raw = (p: Partial<RawBar>): RawBar => ({
      date: '2026-01-05',
      close: 100,
      closeIsSplitAdjusted: false,
      divCash: 0,
      splitFactor: 1,
      ...p,
    });
    const list = [
      raw({ open: 99, high: 101, low: 98, close: 100 }),
      // A raw close above the raw high, before a later 3-for-1 split.
      raw({ date: '2026-01-06', open: 99, high: 100, low: 98, close: 100.5 }),
      raw({ date: '2026-01-07', open: 33, high: 34, low: 32.9, close: 33.5, splitFactor: 3 }),
    ];
    const s = onSeriesBasis(list, splitAdjusted(list));
    expect(s[1]!.close > s[1]!.high!).toBe(true);
    expect(parkinson(s, 1).map((v) => v !== undefined)).toEqual([true, false, true]);
    expect(yangZhang(s, 2)).toEqual([u, u, u]);
  });
});

describe('open, high and low on the series basis', () => {
  const bar = (p: Partial<RawBar>): RawBar => ({
    date: '2026-01-05',
    close: 100,
    closeIsSplitAdjusted: false,
    divCash: 0,
    splitFactor: 1,
    ...p,
  });

  it('price: scaled by the split adjustment, so ratios within the day are the raw ones', () => {
    const bars = [
      bar({ open: 98, high: 101, low: 97, close: 100 }),
      bar({ date: '2026-01-06', open: 50, high: 52, low: 49.5, close: 51, splitFactor: 2 }),
    ];
    const s = onSeriesBasis(bars, splitAdjusted(bars));
    expect(s).toEqual([
      { open: 49, high: 50.5, low: 48.5, close: 50 },
      { open: 50, high: 52, low: 49.5, close: 51 },
    ]);
  });

  it('total return: scaled by index / raw close; the overnight ratio holds the dividend', () => {
    const bars = [
      bar({ open: 99, high: 101, low: 98, close: 100 }),
      bar({ date: '2026-01-06', open: 99.5, high: 100, low: 98, close: 99, divCash: 1 }),
    ];
    const tr = totalReturnIndex(bars);
    expect(tr).toEqual([1, 1]);
    const s = onSeriesBasis(bars, tr);
    expect(s[1]!.close).toBe(1);
    expect(relClose(s[1]!.open, 99.5 / 99)).toBe(true);
    // Overnight O_1 / C_0 on this basis: 99.5 x (100 / 99) / 100, against a raw 0.995.
    expect(relClose(s[1]!.open! / s[0]!.close, 99.5 / 99)).toBe(true);
    expect(relClose(s[1]!.high! / s[1]!.low!, 100 / 98)).toBe(true);
  });

  it('a field the source did not give stays missing', () => {
    expect(onSeriesBasis([bar({ high: 101 })], [50])).toEqual([
      { open: undefined, high: 50.5, low: undefined, close: 50 },
    ]);
  });
});

describe('B1 operands in a strategy', () => {
  const day = (i: number) =>
    new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);
  const bars = (): RawBar[] =>
    C.map((close, i) => ({
      date: day(i),
      open: O[i],
      high: H[i],
      low: L[i],
      close,
      closeIsSplitAdjusted: false,
      divCash: 0,
      splitFactor: 1,
    }));
  const base = {
    name: 't',
    account: 'taxable',
    safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
    evaluation: { frequency: 'daily' },
  };
  const oneSignal = (left: object, op: '>' | '<', right: object) => ({
    ...base,
    signals: [{ id: 'A', type: 'compare', left, op, right }],
    allocations: [
      { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'X', weight: 100 }] },
      { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
  });
  const states = (s: Strategy, list = bars()) =>
    evaluate(s, { X: list }).map((d) => [d.date, d.signals.A]);

  it('evaluates each operand from its first defined day, with the hand-computed values', () => {
    const x = (o: object) => ({ ticker: 'X', ...o });
    // EMA(3) = 10.5, 11.25, 11.375, 12.1875 against the price 10.5, 12, 11.5, 13.
    expect(
      states(
        Strategy.parse(
          oneSignal(x({ indicator: 'price' }), '>', x({ indicator: 'ema', length: 3 })),
        ),
      ),
    ).toEqual([
      [day(2), false],
      [day(3), true],
      [day(4), true],
      [day(5), true],
    ]);
    // Parkinson(3) = 80.1, 110.2, 103.2, 123.3 against 100.
    expect(
      states(
        Strategy.parse(
          oneSignal(x({ indicator: 'volatility', method: 'parkinson', length: 3 }), '<', {
            threshold: 100,
          }),
        ),
      ),
    ).toEqual([
      [day(2), true],
      [day(3), false],
      [day(4), false],
      [day(5), false],
    ]);
    // Return(2) = 5, 9.09, 9.52, 8.33 against 9.
    expect(
      states(
        Strategy.parse(oneSignal(x({ indicator: 'return', length: 2 }), '>', { threshold: 9 })),
      ),
    ).toEqual([
      [day(2), false],
      [day(3), true],
      [day(4), true],
      [day(5), false],
    ]);
    // All-time drawdown 0, 0, -4.5, 0, -4.2, 0 against -3: no warm-up.
    expect(
      states(Strategy.parse(oneSignal(x({ indicator: 'drawdown' }), '<', { threshold: -3 }))).map(
        (s) => s[1],
      ),
    ).toEqual([false, false, true, false, true, false]);
    // The 3-day low 10, 10.5, 10.5, 11.5 against 10.4 (on exact closes without splits).
    expect(
      states(
        parsePlainAgainstLevel(
          oneSignal(x({ indicator: 'low', length: 3 }), '>', { threshold: 10.4 }),
        ),
      ).map((s) => s[1]),
    ).toEqual([false, true, true, true]);
  });

  it('a day without a high is not evaluated by a range-based volatility (never estimated)', () => {
    const list = bars();
    delete list[4]!.high;
    const s = Strategy.parse(
      oneSignal({ indicator: 'volatility', method: 'garman_klass', ticker: 'X', length: 2 }, '<', {
        threshold: 100,
      }),
    );
    // Windows ending on days 4 and 5 hold day 4.
    expect(states(s, list).map((d) => d[0])).toEqual([day(1), day(2), day(3)]);
    // A close-based operand reading the same ticker is not affected.
    const close = Strategy.parse(
      oneSignal({ indicator: 'volatility', ticker: 'X', length: 2 }, '<', { threshold: 100 }),
    );
    expect(states(close, list).map((d) => d[0])).toEqual([day(2), day(3), day(4), day(5)]);
  });

  it('operandBars and lookbacks: EMA and the all-time drawdown read the whole history', () => {
    const o = (p: object) => ({ ticker: 'X', ...p }) as Parameters<typeof operandBars>[0];
    expect(operandBars(o({ indicator: 'ema', length: 3 }))).toBe(Infinity);
    expect(operandBars(o({ indicator: 'drawdown' }))).toBe(Infinity);
    expect(operandBars(o({ indicator: 'drawdown', length: 5 }))).toBe(5);
    expect(operandBars(o({ indicator: 'return', length: 5 }))).toBe(6);
    expect(operandBars(o({ indicator: 'high', length: 5 }))).toBe(5);
    expect(operandBars(o({ indicator: 'low', length: 5 }))).toBe(5);
    expect(operandBars(o({ indicator: 'volatility', length: 5 }))).toBe(6);
    expect(operandBars(o({ indicator: 'volatility', method: 'close', length: 5 }))).toBe(6);
    expect(operandBars(o({ indicator: 'volatility', method: 'parkinson', length: 5 }))).toBe(5);
    expect(operandBars(o({ indicator: 'volatility', method: 'garman_klass', length: 5 }))).toBe(5);
    expect(operandBars(o({ indicator: 'volatility', method: 'yang_zhang', length: 5 }))).toBe(6);
    const s = Strategy.parse(
      oneSignal({ indicator: 'price', ticker: 'X' }, '>', {
        indicator: 'ema',
        ticker: 'X',
        length: 3,
      }),
    );
    expect(signalLookbacks(s).get('X')).toEqual({ bars: Infinity, totalReturn: false });
  });
});

describe('B1 operands: schema', () => {
  const base = {
    name: 't',
    account: 'taxable',
    safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
    evaluation: { frequency: 'daily' },
    allocations: [
      { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'X', weight: 100 }] },
      { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
  };
  const withLeft = (left: object, right: object = { threshold: 0 }) => ({
    ...base,
    signals: [{ id: 'A', type: 'compare', left, op: '>', right }],
  });
  const x = (o: object) => ({ ticker: 'X', ...o });
  const ok = (left: object, right?: object) => Strategy.safeParse(withLeft(left, right)).success;

  it.each([
    ['ema', x({ indicator: 'ema', length: 20 }), x({ indicator: 'price' })],
    ['return', x({ indicator: 'return', length: 1 })],
    ['volatility, no method', x({ indicator: 'volatility', length: 2 })],
    ['volatility close', x({ indicator: 'volatility', method: 'close', length: 2 })],
    ['parkinson of 1', x({ indicator: 'volatility', method: 'parkinson', length: 1 })],
    ['garman_klass of 1', x({ indicator: 'volatility', method: 'garman_klass', length: 1 })],
    ['yang_zhang of 2', x({ indicator: 'volatility', method: 'yang_zhang', length: 2 })],
    ['drawdown all-time', x({ indicator: 'drawdown' })],
    ['drawdown of 1', x({ indicator: 'drawdown', length: 1 })],
    ['high', x({ indicator: 'high', length: 1 }), x({ indicator: 'price' })],
    ['low', x({ indicator: 'low', length: 5, totalReturn: true })],
  ])('%s parses', (_, left, right?: object) => {
    expect(ok(left, right)).toBe(true);
  });

  it.each([
    ['ema of 0', x({ indicator: 'ema', length: 0 })],
    ['ema without length', x({ indicator: 'ema' })],
    ['return of 1.5', x({ indicator: 'return', length: 1.5 })],
    ['close volatility of 1', x({ indicator: 'volatility', length: 1 })],
    ['close volatility of 1, named', x({ indicator: 'volatility', method: 'close', length: 1 })],
    ['yang_zhang of 1', x({ indicator: 'volatility', method: 'yang_zhang', length: 1 })],
    ['an unknown method', x({ indicator: 'volatility', method: 'rogers_satchell', length: 5 })],
    ['drawdown of 0', x({ indicator: 'drawdown', length: 0 })],
    ['a method on another indicator', x({ indicator: 'ema', length: 5, method: 'close' })],
    ['an unknown key', x({ indicator: 'high', length: 5, lenght: 5 })],
  ])('%s is refused', (_, left) => {
    expect(ok(left)).toBe(false);
  });

  it('the method is not added when left out (stored versions re-parse to themselves)', () => {
    const once = Strategy.parse(withLeft(x({ indicator: 'volatility', length: 20 })));
    const left = (once.signals[0] as { left: object }).left;
    expect(left).toEqual({ indicator: 'volatility', ticker: 'X', length: 20, totalReturn: false });
    expect(Strategy.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  // docs/indicators.md B1 "Fixed levels" (decisions log 2026-11-01, C18 (a)).
  it.each(['ema', 'high', 'low'])('a plain %s against a fixed level is refused', (indicator) => {
    const plain = x({ indicator, length: 5 });
    for (const [l, r] of [
      [plain, { threshold: 10 }],
      [{ threshold: 10 }, plain],
    ] as const) {
      const res = Strategy.safeParse(withLeft(l, r));
      expect(res.success).toBe(false);
      expect(res.error!.issues.some((i) => i.message.includes('fixed level'))).toBe(true);
    }
    // On total return it is not refused by C18 (a) (open decision C26).
    expect(ok(x({ indicator, length: 5, totalReturn: true }))).toBe(true);
  });

  it.each([
    ['return', x({ indicator: 'return', length: 5 })],
    ['volatility (yang_zhang)', x({ indicator: 'volatility', method: 'yang_zhang', length: 5 })],
    ['drawdown', x({ indicator: 'drawdown' })],
  ])('a plain %s against a fixed level is allowed (a percentage)', (_, left) => {
    expect(ok(left)).toBe(true);
  });
});

describe('B1 indicators: incremental equals full (<= 1e-9 relative)', () => {
  const RUNS = { seed: 20261101, numRuns: 200 };
  /** An OHLC random walk with splits, dividends and now and then a day without a high. */
  const walk = fc
    .record({
      steps: fc.array(
        fc.record({
          gap: fc.double({ min: -0.02, max: 0.02, noNaN: true }),
          move: fc.double({ min: -0.04, max: 0.04, noNaN: true }),
          up: fc.double({ min: 0, max: 0.02, noNaN: true }),
          down: fc.double({ min: 0, max: 0.02, noNaN: true }),
          split: fc.oneof(
            { weight: 30, arbitrary: fc.constant(1) },
            { weight: 1, arbitrary: fc.constantFrom(2, 3, 0.5) },
          ),
          dividend: fc.oneof(
            { weight: 20, arbitrary: fc.constant(0) },
            { weight: 1, arbitrary: fc.double({ min: 0.001, max: 0.01, noNaN: true }) },
          ),
          noHigh: fc.oneof({ weight: 40, arbitrary: fc.constant(false) }, fc.constant(true)),
        }),
        { minLength: 2, maxLength: 120, size: 'max' },
      ),
      start: fc.double({ min: 20, max: 500, noNaN: true }),
    })
    .map(({ steps, start }): RawBar[] => {
      let close = start;
      return steps.map((s, i) => {
        const open = (close / s.split) * (1 + s.gap);
        close = open * (1 + s.move);
        return {
          date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
          open,
          ...(s.noHigh ? {} : { high: Math.max(open, close) * (1 + s.up) }),
          low: Math.min(open, close) * (1 - s.down),
          close,
          divCash: i > 0 ? close * s.dividend : 0,
          splitFactor: s.split,
          closeIsSplitAdjusted: false,
        };
      });
    });
  const lengths = fc.record({ n: fc.integer({ min: 2, max: 30 }), cut: fc.nat() });

  /**
   * Total return: exactly equal (the index is forward-accumulated, so a later bar changes no
   * earlier input, and each value repeats the same operations). Split-adjusted prices: a later
   * split rescales every earlier value by one factor, which cancels in the percentages and is
   * undone for the levels, up to rounding: within 1e-9 relative, and 1e-9 absolute (percent
   * points) for values near 0, where a relative bound is undefined (a flat window across a split
   * gives 0 on one basis and +-1e-14 on the other).
   */
  const agree = (
    basis: 'tr' | 'price',
    part: (number | undefined)[],
    full: (number | undefined)[],
  ) => {
    if (basis === 'tr') return expect(part).toEqual(full);
    part.forEach((p, i) => {
      const f = full[i];
      if (p === undefined || f === undefined) expect(p).toBe(f);
      else expect(Math.abs(p - f) <= 1e-9 * Math.max(Math.abs(f), 1), `${p} vs ${f}`).toBe(true);
    });
  };

  it('each indicator on the bars up to a cut equals the full history on those bars', () => {
    fc.assert(
      fc.property(walk, lengths, (list, { n, cut }) => {
        const k = 1 + (cut % list.length);
        const head = list.slice(0, k);
        for (const [basis, of] of [
          ['tr', (b: RawBar[]) => totalReturnIndex(b)],
          ['price', splitAdjusted],
        ] as const) {
          const sFull = of(list);
          const sPart = of(head);
          const bFull = onSeriesBasis(list, sFull);
          const bPart = onSeriesBasis(head, sPart);
          // Price levels on the split-adjusted basis: compare after rescaling to the full basis.
          const scale = basis === 'price' ? sFull[k - 1]! / sPart[k - 1]! : 1;
          const levels = (v: (number | undefined)[]) =>
            v.map((x) => (x === undefined ? x : x * scale));
          agree(basis, levels(ema(sPart, n)), ema(sFull, n).slice(0, k));
          agree(basis, levels(rollingHigh(sPart, n)), rollingHigh(sFull, n).slice(0, k));
          agree(basis, levels(rollingLow(sPart, n)), rollingLow(sFull, n).slice(0, k));
          agree(basis, periodReturn(sPart, n), periodReturn(sFull, n).slice(0, k));
          agree(basis, drawdown(sPart, n), drawdown(sFull, n).slice(0, k));
          agree(basis, drawdown(sPart), drawdown(sFull).slice(0, k));
          agree(basis, volatility(sPart, n), volatility(sFull, n).slice(0, k));
          for (const f of [parkinson, garmanKlass, yangZhang]) {
            agree(basis, f(bPart, n), f(bFull, n).slice(0, k));
          }
        }
      }),
      RUNS,
    );
  });

  it('the engine on the bars up to a cut decides as on the full history', () => {
    const params = fc.record({
      n: fc.integer({ min: 2, max: 20 }),
      cut: fc.nat(),
      totalReturn: fc.boolean(),
      levels: fc.array(
        fc.oneof(
          { weight: 1, arbitrary: fc.constant(0) },
          { weight: 9, arbitrary: fc.double({ min: -20, max: 60, noNaN: true }) },
        ),
        { minLength: 6, maxLength: 6 },
      ),
    });
    fc.assert(
      fc.property(walk, params, (list, p) => {
        // On plain prices, levels away from 0 only: a percentage that is exactly 0 on one basis
        // (a flat window) can be +-1e-14 on the other after a split's rescaling, and the
        // near-tie rule (requirements 06, 1e-9 relative to the level) has no width at a level
        // of 0, so that one comparison can differ. Reported to the owner (spec 2026-11-01
        // b1-indicators). On total return nothing is rescaled: levels of 0 included.
        fc.pre(p.totalReturn || p.levels.every((l) => Math.abs(l) > 1e-6));
        // An operand on the ticker; `length: undefined` leaves the key out (strict schema).
        const x = (o: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries({ ticker: 'X', totalReturn: p.totalReturn, length: p.n, ...o }).filter(
              ([, v]) => v !== undefined,
            ),
          );
        const vs = (left: object, i: number) => ({
          left,
          op: '>',
          right: { threshold: p.levels[i] },
        });
        const s = Strategy.parse({
          name: 'Incremental',
          account: 'taxable',
          safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
          evaluation: { frequency: 'daily' },
          signals: [
            {
              id: 'trend',
              type: 'compare',
              left: x({ indicator: 'price', length: undefined }),
              op: '>',
              right: x({ indicator: 'ema' }),
              tolerancePct: 1,
            },
            {
              id: 'range',
              type: 'compare',
              left: x({ indicator: 'price', length: undefined }),
              op: '<',
              right: x({ indicator: 'high' }),
              tolerancePct: 2,
            },
            {
              id: 'floor',
              type: 'compare',
              left: x({ indicator: 'price', length: undefined }),
              op: '>',
              right: x({ indicator: 'low' }),
            },
            {
              id: 'pct',
              type: 'ensemble',
              threshold: 0.5,
              members: [
                vs(x({ indicator: 'return' }), 0),
                vs(x({ indicator: 'drawdown', length: undefined }), 1),
                vs(x({ indicator: 'drawdown' }), 2),
                vs(x({ indicator: 'volatility', method: 'parkinson' }), 3),
                vs(x({ indicator: 'volatility', method: 'garman_klass' }), 4),
                vs(x({ indicator: 'volatility', method: 'yang_zhang' }), 5),
              ],
            },
          ],
          allocations: [
            {
              name: 'On',
              when: { all: ['trend', 'pct'], none: ['range'] },
              holdings: [{ ticker: 'X', weight: 100 }],
            },
            { name: 'Off', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
          ],
        });
        const k = 1 + (p.cut % list.length);
        const full = evaluate(s, { X: list });
        const part = evaluate(s, { X: list.slice(0, k) });
        expect(part).toEqual(full.filter((d) => d.date <= list[k - 1]!.date));
      }),
      RUNS,
    );
  });
});
