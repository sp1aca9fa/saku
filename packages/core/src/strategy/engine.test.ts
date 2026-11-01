import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import {
  compareStep,
  evaluate,
  signalLookbacks,
  signalTickers,
  splitAdjusted,
  whyUndecided,
} from './engine';
import { sma, volatility } from './indicators';
import { Strategy } from './schema';
import { parsePlainAgainstLevel } from './testkit';

const day = (i: number) => {
  const d = new Date(Date.UTC(2026, 0, 5) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const bars = (closes: number[], extra: (i: number) => Partial<RawBar> = () => ({})): RawBar[] =>
  closes.map((close, i) => ({
    date: day(i),
    close,
    closeIsSplitAdjusted: false,
    divCash: 0,
    splitFactor: 1,
    ...extra(i),
  }));

describe('indicators', () => {
  it('SMA over its own window, undefined during warm-up', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([undefined, 1.5, 2.5, 3.5]);
  });

  it('volatility: sample standard deviation of daily returns, annualized, in percent', () => {
    // Expected values computed independently (Python statistics.stdev).
    const v = volatility([100, 101, 99, 102], 2);
    expect(v.slice(0, 2)).toEqual([undefined, undefined]);
    expect(v[2]).toBeCloseTo(33.452639804523486, 10);
    expect(v[3]).toBeCloseTo(56.242734796692, 10);
  });

  it('split-adjusts closes to the latest share basis', () => {
    expect(splitAdjusted(bars([100, 50, 51], (i) => ({ splitFactor: i === 1 ? 2 : 1 })))).toEqual([
      50, 50, 51,
    ]);
  });
});

const strategy = (s: unknown) => Strategy.parse(s);
/** A plain price against a level (refused by the schema, C18 (a)): the band math on exact closes. */
const thresholdStrategy = (tolerancePct: number) =>
  parsePlainAgainstLevel({
    name: 't',
    account: 'taxable',
    safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
    evaluation: { frequency: 'daily' },
    signals: [
      {
        id: 'A',
        type: 'compare',
        left: { indicator: 'price', ticker: 'X' },
        op: '>',
        right: { threshold: 100 },
        tolerancePct,
      },
    ],
    allocations: [
      { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'X', weight: 100 }] },
      { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
  });

describe('evaluate', () => {
  it('applies the tolerance band: changes state only past the far bound', () => {
    const days = evaluate(thresholdStrategy(3), { X: bars([101, 98, 96.9, 102, 103.5, 99]) });
    expect(days.map((d) => d.signals.A)).toEqual([true, true, false, false, true, true]);
    expect(days.map((d) => d.allocation)).toEqual(['In', 'In', 'Out', 'Out', 'In', 'In']);
  });

  it('keeps the previous state on a near-tie and logs it', () => {
    const days = evaluate(thresholdStrategy(3), {
      X: bars([96, 103 * (1 + 5e-10), 103 * (1 + 2e-9)]),
    });
    expect(days.map((d) => d.signals.A)).toEqual([false, false, true]);
    expect(days.map((d) => d.ties)).toEqual([[], ['A'], []]);
  });

  it('a first-day tie with the reference is not true', () => {
    const days = evaluate(thresholdStrategy(0), { X: bars([100, 100, 100.5, 100]) });
    expect(days.map((d) => d.signals.A)).toEqual([false, false, true, true]);
  });

  it('runs the owner-style setup: ensemble trend AND low volatility, fallbacks, warm-up', () => {
    const s = strategy({
      name: 'Setup',
      account: 'taxable',
      safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [
        {
          id: 'A',
          type: 'ensemble',
          members: [2, 3, 4].map((length) => ({
            left: { indicator: 'price', ticker: 'X', totalReturn: true },
            op: '>',
            right: { indicator: 'sma', ticker: 'X', length, totalReturn: true },
          })),
          threshold: 0.5,
        },
        {
          id: 'B',
          type: 'compare',
          left: { indicator: 'volatility', ticker: 'X', length: 2 },
          op: '<',
          right: { threshold: 25 },
        },
      ],
      allocations: [
        { name: 'Risk on', when: { all: ['A', 'B'] }, holdings: [{ ticker: 'X3', weight: 100 }] },
        { name: 'Trend only', when: { all: ['A'] }, holdings: [{ ticker: 'X', weight: 100 }] },
        { name: 'Cash', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      ],
    });
    // Steady small rises (low volatility), then a jump (high volatility), then a fall.
    const closes = [100, 100.1, 100.2, 100.3, 100.4, 103, 103.1, 95, 94];
    const days = evaluate(s, { X: bars(closes) });
    // SMA 4 needs 4 bars; volatility 2 needs 3: the first day is the 4th bar.
    expect(days[0]!.date).toBe(day(3));
    expect(days.map((d) => d.allocation)).toEqual([
      'Risk on', // 100.3: above all SMAs, quiet
      'Risk on',
      'Trend only', // 103: the jump makes volatility high
      'Trend only',
      'Cash', // 95: below every SMA
      'Cash',
    ]);
    expect(days[4]!.signals.A).toBe(0);
    expect(days[0]!.signals.A).toBe(1);
  });

  it('evaluates only dates every signal ticker has', () => {
    const s = strategy({
      name: 't',
      account: 'taxable',
      safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [
        {
          id: 'A',
          type: 'compare',
          left: { indicator: 'price', ticker: 'X' },
          op: '>',
          right: { indicator: 'price', ticker: 'Y' },
        },
      ],
      allocations: [{ name: 'All', holdings: [{ ticker: 'X', weight: 100 }] }],
    });
    const y = bars([1, 1, 1]).filter((_, i) => i !== 1);
    expect(evaluate(s, { X: bars([2, 2, 2]), Y: y }).map((d) => d.date)).toEqual([day(0), day(2)]);
  });
});

// docs/indicators.md "Signals", compare: the band is reference +- |reference| x t/100 (decisions
// log 2026-11-01), symmetric and the right way up for a negative reference.
describe('tolerance band on a negative reference', () => {
  // All-time drawdown of these closes: 0, -8, -10.5, -12, -10, -8.5, -10, -11.5.
  const closes = [100, 92, 89.5, 88, 90, 91.5, 90, 88.5];
  const withSignals = (signals: unknown[]) =>
    strategy({
      name: 't',
      account: 'taxable',
      safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals,
      allocations: [{ name: 'All', holdings: [{ ticker: 'X', weight: 100 }] }],
    });
  const drawdown = { indicator: 'drawdown', ticker: 'X' };
  const member = (op: string, tolerancePct: number) => ({
    left: drawdown,
    op,
    right: { threshold: -10 },
    tolerancePct,
  });

  it('drawdown against -10 with t = 10: true above -9, false below -11, unchanged between', () => {
    const s = withSignals([
      { id: 'up', type: 'compare', ...member('>', 10) },
      { id: 'down', type: 'compare', ...member('<', 10) },
    ]);
    const days = evaluate(s, { X: bars(closes) });
    // The inverted band (-11 as the upper bound) would flip on days 4 and 6 (-10).
    expect(days.map((d) => d.signals.up)).toEqual([
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(days.map((d) => d.signals.down)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
  });

  it('ensemble members use the same band', () => {
    const s = withSignals([
      { id: 'E', type: 'ensemble', threshold: 0.5, members: [member('>', 10), member('>', 0)] },
    ]);
    const days = evaluate(s, { X: bars(closes) });
    // Member 1 as above; member 2 (no band): -10.5 and -12 false; -9.999999999999998 (day 4,
    // 90 / 100 - 1) is a near-tie with -10 and keeps the state, as on day 6.
    expect(days.map((d) => d.signals.E)).toEqual([1, 1, 0.5, 0, 0, 1, 1, 0]);
  });

  it('a near-tie at either bound keeps the state', () => {
    const c = { op: '>' as const, tolerancePct: 10 };
    // Upper bound -9: within 1e-9 relative is a tie, beyond it the state follows.
    expect(compareStep(-9 + 9 * 5e-10, -10, c, false)).toEqual({ state: false, tie: true });
    expect(compareStep(-9 + 9 * 2e-9, -10, c, false)).toEqual({ state: true, tie: false });
    // Lower bound -11.
    expect(compareStep(-11 - 11 * 5e-10, -10, c, true)).toEqual({ state: true, tie: true });
    expect(compareStep(-11 - 11 * 2e-9, -10, c, true)).toEqual({ state: false, tie: false });
    // `<` mirrors it.
    const lt = { op: '<' as const, tolerancePct: 10 };
    expect(compareStep(-11 - 11 * 2e-9, -10, lt, false)).toEqual({ state: true, tie: false });
    expect(compareStep(-9 + 9 * 2e-9, -10, lt, true)).toEqual({ state: false, tie: false });
    expect(compareStep(-9.5, -10, lt, true)).toEqual({ state: true, tie: false });
    // A positive reference: 100 +- 10, as before.
    expect(compareStep(109, 100, c, false)).toEqual({ state: false, tie: false });
    expect(compareStep(110 * (1 + 2e-9), 100, c, false)).toEqual({ state: true, tie: false });
    expect(compareStep(91, 100, c, true)).toEqual({ state: true, tie: false });
  });

  it('the first valid day is a plain comparison, its tie the one with the reference', () => {
    const c = { op: '>' as const, tolerancePct: 10 };
    // 110 is on the upper bound (100 + 10) but clearly above the reference: true, not a tie.
    expect(compareStep(110, 100, c, undefined)).toEqual({ state: true, tie: false });
    // Exactly the reference: a tie, false.
    expect(compareStep(100, 100, c, undefined)).toEqual({ state: false, tie: true });
    expect(compareStep(100 * (1 + 5e-10), 100, c, undefined)).toEqual({ state: false, tie: true });
    // 90 is on the lower bound, below the reference: false, not a tie.
    expect(compareStep(90, 100, c, undefined)).toEqual({ state: false, tie: false });
    const lt = { op: '<' as const, tolerancePct: 10 };
    expect(compareStep(90, 100, lt, undefined)).toEqual({ state: true, tie: false });
    expect(compareStep(100, 100, lt, undefined)).toEqual({ state: false, tie: true });
  });

  it('a reference of 0 gives a band of no width (only exactly 0 is a tie)', () => {
    const c = { op: '>' as const, tolerancePct: 10 };
    expect(compareStep(1e-12, 0, c, false)).toEqual({ state: true, tie: false });
    expect(compareStep(-1e-12, 0, c, true)).toEqual({ state: false, tie: false });
    expect(compareStep(0, 0, c, true)).toEqual({ state: true, tie: true });
    expect(compareStep(0, 0, c, false)).toEqual({ state: false, tie: true });
    // Through a strategy: one-day returns +1, -0.99, 0, -1, +0.5 against 0 with t = 10.
    const s = withSignals([
      {
        id: 'R',
        type: 'compare',
        left: { indicator: 'return', ticker: 'X', length: 1 },
        op: '>',
        right: { threshold: 0 },
        tolerancePct: 10,
      },
    ]);
    const days = evaluate(s, { X: bars([100, 101, 100, 100, 99, 99.5]) });
    expect(days.map((d) => d.signals.R)).toEqual([true, false, false, false, true]);
    expect(days.map((d) => d.ties)).toEqual([[], [], ['R'], [], []]);
  });
});

describe('Strategy schema', () => {
  const base = {
    name: 't',
    account: 'taxable',
    safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
    evaluation: { frequency: 'daily' },
  };

  it('requires an unconditional last allocation, known signals and weights adding to 100', () => {
    expect(() =>
      Strategy.parse({
        ...base,
        allocations: [
          { name: 'a', when: { all: ['A'] }, holdings: [{ ticker: 'X', weight: 100 }] },
        ],
      }),
    ).toThrow(/unconditional fallback/);
    expect(() =>
      Strategy.parse({
        ...base,
        allocations: [
          { name: 'a', when: { all: ['Z'] }, holdings: [{ ticker: 'X', weight: 100 }] },
          { name: 'b', holdings: [{ ticker: 'X', weight: 100 }] },
        ],
      }),
    ).toThrow(/unknown signal/);
    expect(() =>
      Strategy.parse({
        ...base,
        allocations: [{ name: 'a', holdings: [{ ticker: 'X', weight: 60 }] }],
      }),
    ).toThrow(/add up to 100/);
    const twice = Strategy.safeParse({
      ...base,
      allocations: [
        {
          name: 'a',
          holdings: [
            { ticker: 'X', weight: 50 },
            { ticker: 'X', weight: 50 },
          ],
        },
      ],
    });
    expect(twice.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      [
        'allocations.0.holdings',
        '"X" is listed twice; list each ticker once with its total weight',
      ],
    ]);
    // The safe state too, reported at its own path.
    const safe = Strategy.safeParse({
      ...base,
      safeState: {
        holdings: [
          { ticker: 'Y', weight: 30 },
          { ticker: 'X', weight: 40 },
          { ticker: 'Y', weight: 30 },
        ],
      },
      allocations: [{ name: 'a', holdings: [{ ticker: 'X', weight: 100 }] }],
    });
    expect(safe.success).toBe(false);
    expect(safe.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['safeState.holdings', '"Y" is listed twice; list each ticker once with its total weight'],
    ]);
  });

  it('defaults to next-day execution', () => {
    const s = Strategy.parse({
      ...base,
      allocations: [{ name: 'a', holdings: [{ ticker: 'X', weight: 100 }] }],
    });
    expect(s.execution).toBe('next_open');
  });
});

// Derived and aggregate signals (requirements 05 "Signals"; docs/indicators.md "Signals"): they
// read the other signals' states on the same date, keep no state of their own, and are defined
// when every signal they read is.
describe('evaluate: not, and, or', () => {
  // `up`: X above 100 (band 3%, stateful); `fast`: X above its 2-day SMA (from day 1).
  const up = {
    id: 'up',
    type: 'compare',
    left: { indicator: 'price', ticker: 'X' },
    op: '>',
    right: { threshold: 100 },
    tolerancePct: 3,
  };
  const fast = {
    id: 'fast',
    type: 'compare',
    left: { indicator: 'price', ticker: 'X' },
    op: '>',
    right: { indicator: 'sma', ticker: 'X', length: 2 },
  };
  const derived = [
    { id: 'down', type: 'not', of: 'up' },
    { id: 'both', type: 'and', of: ['up', 'fast'] },
    { id: 'either', type: 'or', of: ['down', 'fast'] },
    { id: 'neither', type: 'not', of: 'either' },
  ];
  const make = (signals: unknown[]) =>
    parsePlainAgainstLevel({
      name: 't',
      account: 'taxable',
      safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals,
      allocations: [
        { name: 'Both', when: { all: ['both'] }, holdings: [{ ticker: 'X3', weight: 100 }] },
        { name: 'Neither', when: { all: ['neither'] }, holdings: [{ ticker: 'X', weight: 100 }] },
        { name: 'Else', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      ],
    });
  // up (band 97..103): T T F F T T; fast (above the 2-day SMA, from day 1): - F F T T F
  const closes = [101, 98, 96.9, 102, 103.5, 99];
  const input = { X: bars(closes) };

  it("reads the inputs' states on the same date (the band applied by the input)", () => {
    const days = evaluate(make([up, fast, ...derived]), input);
    // `fast` has no value on day 0, so nothing is decided that day.
    expect(days.map((d) => d.date)).toEqual([1, 2, 3, 4, 5].map(day));
    expect(days.map((d) => d.signals)).toEqual([
      { up: true, fast: false, down: false, both: false, either: false, neither: true },
      { up: false, fast: false, down: true, both: false, either: true, neither: false },
      { up: false, fast: true, down: true, both: false, either: true, neither: false },
      { up: true, fast: true, down: false, both: true, either: true, neither: false },
      { up: true, fast: false, down: false, both: false, either: false, neither: true },
    ]);
    expect(days.map((d) => d.allocation)).toEqual(['Neither', 'Else', 'Else', 'Both', 'Neither']);
    // No ties of their own (none here at all).
    expect(days.every((d) => d.ties.length === 0)).toBe(true);
  });

  it('the order in the file does not matter', () => {
    const base = evaluate(make([up, fast, ...derived]), input);
    const orders = [
      [...[...derived].reverse(), fast, up],
      [derived[3], up, derived[2], fast, derived[0], derived[1]],
      [derived[2], derived[3], derived[1], derived[0], up, fast],
    ];
    for (const signals of orders) {
      const days = evaluate(make(signals), input);
      expect(days.map((d) => [d.date, d.signals, d.allocation])).toEqual(
        base.map((d) => [d.date, d.signals, d.allocation]),
      );
    }
  });

  it("reads an ensemble's state (its share against its threshold), not its share", () => {
    const ens = {
      id: 'trend',
      type: 'ensemble',
      members: [2, 3].map((length) => ({
        left: { indicator: 'price', ticker: 'X' },
        op: '>',
        right: { indicator: 'sma', ticker: 'X', length },
      })),
      threshold: 0.5,
    };
    const days = evaluate(
      make([ens, { id: 'flat', type: 'not', of: 'trend' }, up, fast, ...derived]),
      {
        X: bars([100, 101, 102, 101.9, 90]),
      },
    );
    // Day 3: 101.9 above SMA 2 (101.95)? no; above SMA 3 (101.63)? yes: share 0.5, true.
    expect(days.map((d) => [d.signals.trend, d.signals.flat])).toEqual([
      [1, false],
      [0.5, false],
      [0, true],
    ]);
  });

  it('tickers, lookbacks and the reasons for no decision come from the inputs only', () => {
    const s = make([...derived, up, fast]);
    expect(signalTickers(s)).toEqual(['X']);
    expect(signalLookbacks(s).get('X')).toEqual({ bars: 2, totalReturn: false });
    expect(whyUndecided(s, input, day(0))).toEqual(['X:warm_up(sma)']);
  });
});
