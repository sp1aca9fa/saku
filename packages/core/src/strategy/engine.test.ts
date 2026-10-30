import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import { evaluate, splitAdjusted } from './engine';
import { sma, volatility } from './indicators';
import { Strategy } from './schema';

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
const thresholdStrategy = (tolerancePct: number) =>
  strategy({
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
