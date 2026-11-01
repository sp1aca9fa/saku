// Core against the independent reference implementation (requirements 04 layer E, 13) on
// synthetic random data: signals and allocations equal, indicator values and equity within 1e-9
// relative. Where they disagree, find the root cause against docs/indicators.md; never copy one
// into the other.
import {
  refBacktest,
  refDrawdown,
  refEma,
  refEvaluate,
  refGarmanKlass,
  refHigh,
  refLow,
  refOhlc,
  refParkinson,
  refPrice,
  refReturn,
  refSma,
  refTotalReturn,
  refVolatility,
  refYangZhang,
} from '@saku/reference';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { totalReturnIndex } from '../adjusted';
import type { RawBar } from '../domain';
import { backtest } from './backtest';
import type { StrategyDay } from './engine';
import { evaluate, onSeriesBasis, splitAdjusted } from './engine';
import {
  drawdown,
  ema,
  garmanKlass,
  parkinson,
  periodReturn,
  rollingHigh,
  rollingLow,
  sma,
  volatility,
  yangZhang,
} from './indicators';
import { Strategy } from './schema';

/** A small seeded generator (mulberry32), so failures reproduce. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(seed: number, n: number, vol: number): RawBar[] {
  const rnd = random(seed);
  const out: RawBar[] = [];
  let close = 100;
  const start = Date.UTC(2020, 0, 1);
  for (let i = 0; i < n; i++) {
    const split = i === Math.floor(n / 2) ? 2 : 1;
    const open = (close / split) * (1 + (rnd() - 0.5) * vol);
    close = open * (1 + (rnd() - 0.5) * vol);
    const divCash = i > 0 && i % 63 === 0 ? close * 0.004 : 0;
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      open,
      close,
      closeIsSplitAdjusted: false,
      divCash,
      splitFactor: split,
    });
  }
  return out;
}

const setup = (execution: string, members: number[]) =>
  Strategy.parse({
    name: 'Setup-like',
    account: 'taxable',
    execution,
    safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
    evaluation: { frequency: 'daily' },
    costs: { slippageBps: 5, feePct: 0.1 },
    signals: [
      {
        id: 'A',
        type: 'ensemble',
        members: members.map((length) => ({
          left: { indicator: 'price', ticker: 'X', totalReturn: true },
          op: '>',
          right: { indicator: 'sma', ticker: 'X', length, totalReturn: true },
          tolerancePct: 3,
        })),
        threshold: 0.5,
      },
      {
        id: 'B',
        type: 'compare',
        left: { indicator: 'volatility', ticker: 'X', length: 10 },
        op: '<',
        right: { threshold: 30 },
      },
      {
        id: 'C',
        type: 'compare',
        left: { indicator: 'price', ticker: 'Y' },
        op: '>',
        right: { indicator: 'sma', ticker: 'Y', length: 15 },
        tolerancePct: 1,
      },
    ],
    allocations: [
      {
        name: 'Risk on',
        when: { all: ['A', 'B'] },
        holdings: [{ ticker: 'X?L=3&E=0.9', weight: 100 }],
      },
      {
        name: 'Trend',
        when: { all: ['A'], none: ['B'] },
        holdings: [{ ticker: 'X', weight: 100 }],
      },
      {
        name: 'Mix',
        when: { any: ['C'] },
        holdings: [
          { ticker: 'X', weight: 40 },
          { ticker: 'Y', weight: 60 },
        ],
      },
      { name: 'Cash', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
  });

/** One equity point per session on both sides, matched by date, within 1e-9 relative. */
function expectSameEquity(a: ReturnType<typeof backtest>, b: ReturnType<typeof refBacktest>) {
  expect(a.points.map((p) => p.date)).toEqual(b.dates);
  const theirs = new Map(b.dates.map((d, i) => [d, b.equity[i]!]));
  for (const p of a.points) {
    expect(Math.abs(p.equity / theirs.get(p.date)! - 1), p.date).toBeLessThanOrEqual(1e-9);
  }
}

describe('core vs reference', () => {
  for (const seed of [1, 2, 3]) {
    for (const execution of ['next_open', 'next_close', 'same_close']) {
      it(`agrees on seed ${seed}, ${execution}`, () => {
        const bars = { X: walk(seed, 700, 0.04), Y: walk(seed + 100, 700, 0.02) };
        const strategy = setup(execution, [20, 40, 60]);
        const cashRate = (date: string) => 1 + (Date.parse(date) % 7) / 10;

        const core = evaluate(strategy, bars);
        const ref = refEvaluate(strategy, bars);
        expect(core.map((d) => d.date)).toEqual(ref.map((d) => d.date));
        expect(core.map((d) => d.allocation)).toEqual(ref.map((d) => d.allocation));
        expect(core.map((d) => d.signals)).toEqual(ref.map((d) => d.signals));
        expect(new Set(core.map((d) => d.allocation)).size).toBeGreaterThan(2);

        const a = backtest({ strategy, days: core, bars, cashRate });
        const b = refBacktest(strategy, ref, bars, cashRate);
        expect(a.switches).toBe(b.switches);
        expectSameEquity(a, b);
      });
    }
  }
});

// docs/indicators.md "Signals", compare: the band is reference +- |reference| x t/100, so a
// negative reference (a drawdown, a negative return) has its upper bound above the lower one.
describe('core vs reference: tolerance bands on negative references', () => {
  for (const seed of [11, 12, 13]) {
    it(`agrees on seed ${seed}`, () => {
      const bars = { X: walk(seed, 500, 0.05) };
      const members: Record<string, unknown>[] = [
        { indicator: 'drawdown', ticker: 'X', totalReturn: true },
        { indicator: 'drawdown', ticker: 'X', length: 60, totalReturn: true },
        { indicator: 'return', ticker: 'X', length: 20, totalReturn: true },
      ].flatMap((left) =>
        [-4, -8, -15].flatMap((level) =>
          (['>', '<'] as const).map((op) => ({
            left,
            op,
            right: { threshold: level },
            tolerancePct: 25,
          })),
        ),
      );
      // A reference that changes sign (a 60-day return): the band flips with it.
      const changing = { indicator: 'return', ticker: 'X', length: 60, totalReturn: true };
      const sixty = periodReturn(totalReturnIndex(bars.X), 60).filter(
        (v): v is number => v !== undefined,
      );
      expect(sixty.some((v) => v > 0) && sixty.some((v) => v < 0)).toBe(true);
      members.push({
        left: { indicator: 'return', ticker: 'X', length: 20, totalReturn: true },
        op: '>',
        right: changing,
        tolerancePct: 25,
      });
      const strategy = Strategy.parse({
        name: 'Negative references',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: members.map((m, i) => ({ id: `s${i}`, type: 'compare', ...m })),
        allocations: [{ name: 'All', holdings: [{ ticker: 'X', weight: 100 }] }],
      });
      const core = evaluate(strategy, bars);
      const ref = refEvaluate(strategy, bars);
      expect(core.map((d) => d.date)).toEqual(ref.map((d) => d.date));
      expect(core.map((d) => d.signals)).toEqual(ref.map((d) => d.signals));
    });
  }
});

describe('core vs reference: a reorder of the same holdings', () => {
  const mix = [
    { ticker: 'X', weight: 40 },
    { ticker: 'Y', weight: 60 },
  ];
  const reordered = [mix[1]!, mix[0]!];
  const other = [
    { ticker: 'X', weight: 70 },
    { ticker: 'Y', weight: 30 },
  ];
  const cash = [{ ticker: 'CASH_USD', weight: 100 }];
  for (const execution of ['next_open', 'next_close', 'same_close'] as const) {
    it(`agrees on switches and equity, ${execution}`, () => {
      const bars = { X: walk(7, 60, 0.04), Y: walk(107, 60, 0.02) };
      const cycle = [mix, reordered, reordered, mix, other, other, reordered, cash, mix, reordered];
      const days: StrategyDay[] = bars.X.map((b, i) => ({
        date: b.date,
        signals: {},
        allocation: `a${i % cycle.length}`,
        holdings: cycle[i % cycle.length]!,
        ties: [],
      }));
      const strategy = { execution, costs: { slippageBps: 5, feePct: 0.1 } };
      const cashRate = (date: string) => 1 + (Date.parse(date) % 7) / 10;
      const a = backtest({ strategy, days, bars, cashRate });
      const b = refBacktest(strategy, days, bars, cashRate);
      // Per 10-day cycle: mix -> other -> reordered mix -> cash -> mix, 4 switches (reorders: none).
      expect(a.switches).toBe(b.switches);
      expect(a.switches).toBe(4 * 6);
      expectSameEquity(a, b);
    });
  }
});

// ---- B1 indicators (docs/indicators.md "Indicators (B1, v1)"): core vs reference on random
// OHLC data with splits, dividends, flat days and days with missing or inconsistent open, high or
// low, on both series bases, per indicator and through whole strategies. ----

const RUNS = { seed: 20261101, numRuns: 300 };

/** What a generated day is: a normal one, a flat one, or one of layer A's O/H/L data errors. */
const DAY_KINDS = [
  'flat',
  'noOpen',
  'noHigh',
  'noLow',
  'highBelowLow',
  'openAboveHigh',
  'closeBelowLow',
  'zeroLow',
  'negativeOpen',
  'nanHigh',
  'infiniteLow',
] as const;
type DayKind = 'normal' | (typeof DAY_KINDS)[number];

/**
 * A random OHLC walk on one ticker. `adjusted`: the source gives prices already on today's share
 * basis (closeIsSplitAdjusted, no jump on the split day). Closes stay positive and finite (a
 * close is the series itself; layer A refuses a bad one); only open, high and low carry faults.
 */
const ohlcWalk = fc
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
        kind: fc.oneof(
          { weight: 60, arbitrary: fc.constant<DayKind>('normal') },
          { weight: 6, arbitrary: fc.constant<DayKind>('flat') },
          { weight: 4, arbitrary: fc.constantFrom<DayKind>(...DAY_KINDS.slice(1)) },
        ),
      }),
      { minLength: 2, maxLength: 90, size: 'max' },
    ),
    start: fc.double({ min: 20, max: 500, noNaN: true }),
    adjusted: fc.boolean(),
  })
  .map(({ steps, start, adjusted }): RawBar[] => {
    let close = start;
    return steps.map((s, i) => {
      const base = adjusted ? close : close / s.split;
      let open: number | undefined;
      let high: number | undefined;
      let low: number | undefined;
      if (s.kind === 'flat') {
        open = high = low = close = base;
      } else {
        open = base * (1 + s.gap);
        close = open * (1 + s.move);
        high = Math.max(open, close) * (1 + s.up);
        low = Math.min(open, close) * (1 - s.down);
      }
      switch (s.kind) {
        case 'noOpen':
          open = undefined;
          break;
        case 'noHigh':
          high = undefined;
          break;
        case 'noLow':
          low = undefined;
          break;
        case 'highBelowLow':
          high = low * 0.999;
          break;
        case 'openAboveHigh':
          open = high * 1.001;
          break;
        case 'closeBelowLow':
          low = close * 1.001;
          break;
        case 'zeroLow':
          low = 0;
          break;
        case 'negativeOpen':
          open = -open;
          break;
        case 'nanHigh':
          high = NaN;
          break;
        case 'infiniteLow':
          low = Infinity;
          break;
      }
      return {
        date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
        ...(open === undefined ? {} : { open }),
        ...(high === undefined ? {} : { high }),
        ...(low === undefined ? {} : { low }),
        close,
        divCash: i > 0 ? close * s.dividend : 0,
        splitFactor: s.split,
        closeIsSplitAdjusted: adjusted,
      };
    });
  });

/**
 * Agreement of one value: within 1e-9 relative (requirements 13). For percentages (return,
 * drawdown, volatility) the bound is 1e-9 x max(|value|, 1) percentage points, as in core's own
 * incremental property test: a relative bound has no width at 0, and a percentage that is exactly
 * 0 on one implementation's series (a flat window across a split) is +-1e-14 on the other's,
 * whose split-adjusted series is rounded differently (both are exact to the last bits of the
 * underlying ratio). Levels (price, averages, highs and lows) are compared purely relative.
 */
function agrees(
  a: (number | undefined)[],
  b: (number | undefined)[],
  kind: 'level' | 'percent',
): string | undefined {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) {
      if (x !== y) return `bar ${i}: core ${x} vs reference ${y}`;
      continue;
    }
    const scale = kind === 'level' ? Math.abs(y) : Math.max(Math.abs(y), 1);
    if (!(Math.abs(x - y) <= 1e-9 * scale)) return `bar ${i}: core ${x} vs reference ${y}`;
  }
  return undefined;
}

describe('core vs reference: B1 indicators per indicator (random OHLC)', () => {
  it('agree within 1e-9 and give no value on the same bars, on both series bases', () => {
    // Counts across all runs, so the test proves it exercised values and missing values of each.
    const defined: Record<string, number> = {};
    const missing: Record<string, number> = {};
    fc.assert(
      fc.property(ohlcWalk, fc.integer({ min: 1, max: 30 }), (bars, n) => {
        const n2 = Math.max(2, n); // close-to-close and Yang-Zhang need length >= 2
        for (const tr of [false, true]) {
          const cs = tr ? totalReturnIndex(bars) : splitAdjusted(bars);
          const rs = tr ? refTotalReturn(bars) : refPrice(bars);
          const cb = onSeriesBasis(bars, cs);
          const rb = refOhlc(bars, tr);
          const pairs: [
            string,
            'level' | 'percent',
            (number | undefined)[],
            (number | undefined)[],
          ][] = [
            ['series', 'level', cs, rs],
            ['sma', 'level', sma(cs, n), refSma(rs, n)],
            ['ema', 'level', ema(cs, n), refEma(rs, n)],
            ['high', 'level', rollingHigh(cs, n), refHigh(rs, n)],
            ['low', 'level', rollingLow(cs, n), refLow(rs, n)],
            ['return', 'percent', periodReturn(cs, n), refReturn(rs, n)],
            ['drawdown N', 'percent', drawdown(cs, n), refDrawdown(rs, n)],
            ['drawdown all-time', 'percent', drawdown(cs), refDrawdown(rs)],
            ['volatility close', 'percent', volatility(cs, n2), refVolatility(rs, n2)],
            ['parkinson', 'percent', parkinson(cb, n), refParkinson(rb, n)],
            ['garman_klass', 'percent', garmanKlass(cb, n), refGarmanKlass(rb, n)],
            ['yang_zhang', 'percent', yangZhang(cb, n2), refYangZhang(rb, n2)],
          ];
          // The day's O, H, L and C on the series basis themselves (where both have them).
          for (const f of ['open', 'high', 'low', 'close'] as const) {
            const finite = (v: number | undefined) =>
              v !== undefined && Number.isFinite(v) ? v : undefined;
            pairs.push([
              `series ${f}`,
              'level',
              cb.map((d) => finite(d[f])),
              rb.map((d) => finite(d[f])),
            ]);
          }
          for (const [name, kind, c, r] of pairs) {
            const why = agrees(c, r, kind);
            if (why) throw new Error(`${name} (${tr ? 'total return' : 'price'}, n ${n}): ${why}`);
            defined[name] = (defined[name] ?? 0) + c.filter((v) => v !== undefined).length;
            missing[name] = (missing[name] ?? 0) + c.filter((v) => v === undefined).length;
          }
        }
      }),
      RUNS,
    );
    for (const name of Object.keys(defined)) expect(defined[name], name).toBeGreaterThan(0);
    // Warm-ups and O/H/L faults leave bars without a value; the all-time drawdown and the series
    // itself have neither (closes stay valid).
    for (const name of ['sma', 'ema', 'return', 'parkinson', 'garman_klass', 'yang_zhang']) {
      expect(missing[name], name).toBeGreaterThan(0);
    }
  });

  it('a fault on one day removes the range volatilities of exactly the windows holding it', () => {
    // Deterministic companion to the random test: one day without a low in a clean walk.
    const bars: RawBar[] = walk(11, 40, 0.03).map((b, i) => ({
      ...b,
      high: Math.max(b.open!, b.close) * 1.01,
      ...(i === 20 ? {} : { low: Math.min(b.open!, b.close) * 0.99 }),
    }));
    const n = 5;
    for (const tr of [false, true]) {
      const cb = onSeriesBasis(bars, tr ? totalReturnIndex(bars) : splitAdjusted(bars));
      const rb = refOhlc(bars, tr);
      for (const [c, r] of [
        [parkinson(cb, n), refParkinson(rb, n)],
        [garmanKlass(cb, n), refGarmanKlass(rb, n)],
        [yangZhang(cb, n), refYangZhang(rb, n)],
      ] as const) {
        expect(agrees(c, r, 'percent')).toBeUndefined();
        // Windows ending on bars 20..24 hold bar 20; 25 does not.
        for (let i = 20; i < 25; i++) expect(c[i]).toBeUndefined();
        expect(c[19]).toBeDefined();
        expect(c[25]).toBeDefined();
      }
    }
  });
});

describe('core vs reference: whole strategies with every B1 operand (random OHLC)', () => {
  const params = fc.record({
    n: fc.integer({ min: 1, max: 20 }),
    m: fc.integer({ min: 2, max: 20 }),
    totalReturn: fc.boolean(),
    execution: fc.constantFrom('next_open', 'next_close', 'same_close'),
    tolerances: fc.array(fc.constantFrom(0, 0, 0.5, 1, 3), { minLength: 5, maxLength: 5 }),
    ops: fc.array(fc.constantFrom('>', '<'), { minLength: 7, maxLength: 7 }),
    // Levels per percent operand (return, drawdown all-time and N-day, four volatilities), with
    // 0 now and then.
    levels: fc.tuple(
      fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 9, arbitrary: fc.double({ min: -15, max: 15, noNaN: true }) },
      ),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 9, arbitrary: fc.double({ min: -20, max: 0, noNaN: true }) },
      ),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 9, arbitrary: fc.double({ min: -20, max: 0, noNaN: true }) },
      ),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 9, arbitrary: fc.double({ min: 0, max: 80, noNaN: true }) },
      ),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 9, arbitrary: fc.double({ min: 0, max: 80, noNaN: true }) },
      ),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 9, arbitrary: fc.double({ min: 0, max: 80, noNaN: true }) },
      ),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 9, arbitrary: fc.double({ min: 0, max: 80, noNaN: true }) },
      ),
    ),
    shareThreshold: fc.constantFrom(0.25, 0.5, 0.75, 1),
    // Derived signals (not, and, or), each reading the signals above or earlier derived ones,
    // nested; the whole list then shuffled (the order in the file does not matter).
    derived: fc.array(
      fc.record({
        type: fc.constantFrom('not', 'and', 'or'),
        picks: fc.array(fc.nat(), { minLength: 2, maxLength: 3 }),
      }),
      { maxLength: 4 },
    ),
    order: fc.nat(),
  });

  /** `base` with the derived signals added (inputs chosen by `picks`), in a shuffled order. */
  const withDerived = <T extends { id: string }>(
    base: T[],
    derived: { type: string; picks: number[] }[],
    order: number,
  ) => {
    const pool = base.map((b) => b.id);
    const out: object[] = [...base];
    derived.forEach(({ type, picks }, i) => {
      const id = `d${i}`;
      const pick = (k: number) => pool[k % pool.length]!;
      if (type === 'not') out.push({ id, type, of: pick(picks[0]!) });
      else {
        const of = [...new Set(picks.map(pick))];
        if (of.length < 2) of.push(pick(picks[0]! + 1));
        out.push({ id, type, of });
      }
      pool.push(id);
    });
    const rnd = random(order);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  it('signals, allocations and equity agree on both series bases', () => {
    let evaluated = 0;
    /** Sessions without a decision (the safe state), valued by both. */
    let undecided = 0;
    const allocations = new Set<string>();
    /** Evaluated days of strategies with at least 2 derived signals (often one reading another). */
    let derivedDays = 0;
    fc.assert(
      fc.property(ohlcWalk, params, (bars, p) => {
        // On plain prices, levels away from 0 only (owner question C27, open): a percentage
        // that is exactly 0 on one implementation's split-adjusted series (a flat window across
        // a split) can be +-1e-14 on the other's, and the near-tie rule (requirements 06, 1e-9
        // relative to the level) has no width at a level of 0, so that one comparison may
        // legitimately differ. Core's own incremental property test does the same. On total
        // return both build the index with the same products: levels of 0 included.
        fc.pre(p.totalReturn || p.levels.every((l) => Math.abs(l) > 1e-6));
        const x = (o: Record<string, unknown>) => ({
          ticker: 'X',
          totalReturn: p.totalReturn,
          ...o,
        });
        const price = x({ indicator: 'price' });
        const vs = (left: object, i: number) => ({
          left,
          op: p.ops[i],
          right: { threshold: p.levels[i] },
          tolerancePct: p.tolerances[i % p.tolerances.length],
        });
        const strategy = Strategy.parse({
          name: 'B1 operands',
          account: 'taxable',
          execution: p.execution,
          safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
          evaluation: { frequency: 'daily' },
          costs: { slippageBps: 5, feePct: 0.1 },
          signals: withDerived(
            [
              {
                id: 'trend',
                type: 'compare',
                left: price,
                op: '>',
                right: x({ indicator: 'ema', length: p.n }),
                tolerancePct: p.tolerances[0],
              },
              {
                id: 'cross',
                type: 'compare',
                left: x({ indicator: 'ema', length: p.n }),
                op: '>',
                right: x({ indicator: 'sma', length: p.m }),
                tolerancePct: p.tolerances[1],
              },
              // The price equals its N-day high (or low) on every new high (low): exact ties.
              {
                id: 'breakout',
                type: 'compare',
                left: price,
                op: '<',
                right: x({ indicator: 'high', length: p.n }),
                tolerancePct: p.tolerances[2],
              },
              {
                id: 'floor',
                type: 'compare',
                left: price,
                op: '>',
                right: x({ indicator: 'low', length: p.m }),
                tolerancePct: p.tolerances[3],
              },
              {
                id: 'pct',
                type: 'ensemble',
                threshold: p.shareThreshold,
                members: [
                  vs(x({ indicator: 'return', length: p.n }), 0),
                  vs(x({ indicator: 'drawdown' }), 1),
                  vs(x({ indicator: 'drawdown', length: p.m }), 2),
                  vs(x({ indicator: 'volatility', length: p.m }), 3),
                  vs(x({ indicator: 'volatility', method: 'parkinson', length: p.n }), 4),
                  vs(x({ indicator: 'volatility', method: 'garman_klass', length: p.n }), 5),
                  vs(x({ indicator: 'volatility', method: 'yang_zhang', length: p.m }), 6),
                ],
              },
            ],
            p.derived,
            p.order,
          ),
          allocations: [
            {
              name: 'Lever',
              // The last derived signal, when there is one, also decides, and with 2 or more the
              // first one in `none` (Lever only, so Hold and Cash stay reachable as before).
              when: {
                all: ['trend', 'pct', ...(p.derived.length ? [`d${p.derived.length - 1}`] : [])],
                none: ['breakout', ...(p.derived.length > 1 ? ['d0'] : [])],
              },
              holdings: [{ ticker: 'X?L=2&E=0.5', weight: 100 }],
            },
            {
              name: 'Hold',
              when: { any: ['cross', 'floor'] },
              holdings: [{ ticker: 'X', weight: 100 }],
            },
            { name: 'Cash', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
          ],
        });

        const core = evaluate(strategy, { X: bars });
        const ref = refEvaluate(strategy, { X: bars });
        expect(core.map((d) => d.date)).toEqual(ref.map((d) => d.date));
        expect(core.map((d) => d.signals)).toEqual(ref.map((d) => d.signals));
        expect(core.map((d) => d.allocation)).toEqual(ref.map((d) => d.allocation));
        evaluated += core.length;
        if (p.derived.length > 1) derivedDays += core.length;
        for (const d of core) allocations.add(d.allocation);

        // Equity on every session from the first evaluated day (days without a decision
        // included), when every open the trades may read is a usable price.
        const first = core[0]?.date;
        const usable = (o: number | undefined) => o !== undefined && o > 0 && Number.isFinite(o);
        if (first === undefined || !bars.every((b) => b.date < first || usable(b.open))) return;
        const cashRate = (date: string) => 1 + (Date.parse(date) % 7) / 10;
        const sub = { X: bars };
        const a = backtest({ strategy, days: core, bars: sub, cashRate });
        const b = refBacktest(strategy, ref, sub, cashRate);
        expect(a.switches).toBe(b.switches);
        expectSameEquity(a, b);
        undecided += a.points.filter((pt) => !pt.decided).length;
      }),
      RUNS,
    );
    expect(evaluated).toBeGreaterThan(0);
    expect(undecided).toBeGreaterThan(0);
    expect(derivedDays).toBeGreaterThan(0);
    expect(allocations.size).toBe(3);
  });
});

// docs/indicators.md "Equity curves", "Returns" (covered days): a held ticker's bars on dates
// that are no session (another ticker it may hold, and the signal ticker, have no bar there) are
// compounded day by day: cash, synthetic leverage, financing and expense per covered day. Runs of
// up to 4 such dates in a row; both price bases; all three execution modes.
// Review of 16f0131 (gap bars, per-day rules): `.fails` until the reference follows the
// contract; remove it then.
describe('core vs reference: bars between sessions (covered days)', () => {
  /** On today's split basis: prices and dividends divided by the later splits. */
  const toAdjusted = (bars: RawBar[]): RawBar[] => {
    let after = 1;
    const out = new Array<RawBar>(bars.length);
    for (let i = bars.length - 1; i >= 0; i--) {
      const b = bars[i]!;
      const f = (v: number | undefined) => (v === undefined ? undefined : v / after);
      out[i] = {
        ...b,
        open: f(b.open),
        close: b.close / after,
        divCash: b.divCash / after,
        closeIsSplitAdjusted: true,
      };
      after *= b.splitFactor;
    }
    return out;
  };
  const gapped = (seed: number) => {
    const n = 300;
    const rnd = random(seed * 7 + 1);
    const x = walk(seed, n, 0.04);
    const y = walk(seed + 50, n, 0.02);
    const s = walk(seed + 90, n, 0.03);
    const dropX = new Set<string>();
    const dropY = new Set<string>();
    for (let i = 40; i < n - 1;) {
      if (rnd() < 0.1) {
        const which = rnd() < 0.6 ? dropY : dropX;
        const len = 1 + Math.floor(rnd() * 4);
        // Keep the split bars (a dropped split would be a fake crash, not a gap).
        for (let k = 0; k < len && i < n - 1; k++, i++) {
          if (i !== Math.floor(n / 2)) which.add(x[i]!.date);
        }
      } else i++;
    }
    const keep = (drop: Set<string>) => (b: RawBar) => !drop.has(b.date);
    const both = new Set([...dropX, ...dropY]);
    return {
      X: x.filter(keep(dropX)),
      Y: y.filter(keep(dropY)),
      S: s.filter(keep(both)),
      dropped: both.size,
    };
  };
  const strategyFor = (execution: string) =>
    Strategy.parse({
      name: 'Gaps',
      account: 'taxable',
      execution,
      safeState: { holdings: [{ ticker: 'Y', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      costs: { slippageBps: 5, feePct: 0.1 },
      signals: [
        {
          id: 'A',
          type: 'compare',
          left: { indicator: 'price', ticker: 'S', totalReturn: true },
          op: '>',
          right: { indicator: 'sma', ticker: 'S', length: 10, totalReturn: true },
          tolerancePct: 0.5,
        },
        {
          id: 'B',
          type: 'compare',
          left: { indicator: 'price', ticker: 'S', totalReturn: true },
          op: '>',
          right: { indicator: 'sma', ticker: 'S', length: 30, totalReturn: true },
        },
      ],
      allocations: [
        {
          name: 'Lever',
          when: { all: ['A', 'B'] },
          holdings: [{ ticker: 'X?L=3&E=0.9', weight: 100 }],
        },
        {
          name: 'Mix',
          when: { all: ['A'] },
          holdings: [
            { ticker: 'X', weight: 40 },
            { ticker: 'CASH_USD', weight: 20 },
            { ticker: 'Y', weight: 40 },
          ],
        },
        { name: 'Cash', when: { all: ['B'] }, holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        { name: 'Y', holdings: [{ ticker: 'Y', weight: 100 }] },
      ],
    });

  for (const seed of [11, 12, 13]) {
    for (const execution of ['next_open', 'next_close', 'same_close']) {
      for (const adjusted of [false, true]) {
        it(`agrees on seed ${seed}, ${execution}, ${adjusted ? 'split-adjusted' : 'raw'} bars`, () => {
          const g = gapped(seed);
          const bars = adjusted
            ? { X: toAdjusted(g.X), Y: toAdjusted(g.Y), S: toAdjusted(g.S) }
            : { X: g.X, Y: g.Y, S: g.S };
          const strategy = strategyFor(execution);
          const cashRate = (date: string) => 1 + (Date.parse(date) % 7) / 10;
          const core = evaluate(strategy, bars);
          const ref = refEvaluate(strategy, bars);
          expect(core.map((d) => d.allocation)).toEqual(ref.map((d) => d.allocation));
          expect(new Set(core.map((d) => d.allocation)).size).toBeGreaterThan(2);
          const a = backtest({ strategy, days: core, bars, cashRate });
          // Gaps inside the run: sessions fewer than X's and Y's dates together.
          expect(g.dropped).toBeGreaterThan(10);
          expect(a.points.length).toBeLessThan(new Set([...g.X, ...g.Y].map((b) => b.date)).size);
          const b = refBacktest(strategy, ref, bars, cashRate);
          expect(a.switches).toBe(b.switches);
          expectSameEquity(a, b);
        });
      }
    }
  }
});
