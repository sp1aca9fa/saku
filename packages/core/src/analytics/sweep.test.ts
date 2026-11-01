// Parameter sweep driver (docs/analytics.md "Statistics", "Parameter sweep").
import { describe, expect, it } from 'vitest';
import { Strategy } from '../strategy/schema';
import { neighbors, sweep, sweepVariants } from './sweep';

const base = Strategy.parse({
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
const LENGTH = ['signals', 0, 'right', 'length'] as const;
const BAND = ['signals', 0, 'tolerancePct'] as const;

describe('parameter sweep', () => {
  it('builds the Cartesian product, first parameter outermost', () => {
    const grid = [
      { paths: [LENGTH], values: [100, 150, 200] },
      { paths: [BAND], values: [0, 2] },
    ];
    const vs = sweepVariants(base, grid);
    expect(vs.map((x) => x.index)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ]);
    expect(vs[3]!.values).toEqual([150, 2]);
    const s = vs[3]!.strategy!;
    const up = s.signals[0]!;
    expect(up.type === 'compare' && up.right).toMatchObject({ length: 150 });
    expect(up.type === 'compare' && up.tolerancePct).toBe(2);
    // The base strategy is not changed.
    const b = base.signals[0]!;
    expect(b.type === 'compare' && b.right).toMatchObject({ length: 200 });
    // No grid: the strategy itself.
    expect(sweepVariants(base, [])).toEqual([{ index: [], values: [], strategy: base }]);
  });

  it('sets several paths to one value', () => {
    const grid = [{ paths: [LENGTH, ['signals', 1, 'left', 'length']], values: [30, 60] }];
    const s = sweepVariants(base, grid)[1]!.strategy!;
    const [up, calm] = s.signals;
    expect(up!.type === 'compare' && up!.right).toMatchObject({ length: 60 });
    expect(calm!.type === 'compare' && calm!.left).toMatchObject({ length: 60 });
  });

  it('keeps an invalid variant with its error, never drops it', () => {
    // A close-to-close volatility needs a length of at least 2.
    const grid = [{ paths: [['signals', 1, 'left', 'length']], values: [1, 20] }];
    const vs = sweepVariants(base, grid);
    expect(vs).toHaveLength(2);
    expect(vs[0]!.strategy).toBeUndefined();
    expect(vs[0]!.error).toContain('at least 2');
    expect(vs[1]!.strategy).toBeDefined();
    const results = sweep(base, grid, (s, index) => `${s.name} ${index.join(',')}`);
    expect(results.map((r) => r.result)).toEqual([undefined, 'Trend 1']);
  });

  it('refuses a path that does not exist, a repeated value and empty parameters', () => {
    expect(() => sweepVariants(base, [{ paths: [['signals', 0, 'lenght']], values: [1] }])).toThrow(
      'no signals.0.lenght',
    );
    expect(() => sweepVariants(base, [{ paths: [['signals', 5, 'id']], values: ['a'] }])).toThrow(
      'no signals.5.id',
    );
    expect(() => sweepVariants(base, [{ paths: [['signals', '0', 'id']], values: ['a'] }])).toThrow(
      'no signals.0.id',
    );
    expect(() => sweepVariants(base, [{ paths: [LENGTH], values: [50, 50] }])).toThrow('twice');
    expect(() => sweepVariants(base, [{ paths: [LENGTH], values: [] }])).toThrow('one value');
    expect(() => sweepVariants(base, [{ paths: [], values: [1] }])).toThrow('one path');
    expect(() => sweepVariants(base, [{ paths: [[]], values: [1] }])).toThrow('not empty');
    // Two parameters setting the same place: equal paths, or one inside the other.
    expect(() =>
      sweepVariants(base, [
        { paths: [LENGTH], values: [50] },
        { paths: [BAND, LENGTH], values: [1] },
      ]),
    ).toThrow('same place');
    expect(() =>
      sweepVariants(base, [
        { paths: [['signals', 0, 'right']], values: [{ threshold: 1 }] },
        { paths: [LENGTH], values: [50] },
      ]),
    ).toThrow('same place');
    // Sibling paths are fine, and one parameter may list a path once per place.
    expect(
      sweepVariants(base, [
        { paths: [LENGTH], values: [50] },
        { paths: [['signals', 0, 'right', 'ticker']], values: ['X'] },
      ]),
    ).toHaveLength(1);
  });

  it('neighbors: one step in one parameter, previous before next', () => {
    const grid = [
      { paths: [LENGTH], values: [100, 150, 200] },
      { paths: [BAND], values: [0, 1, 2] },
    ];
    expect(neighbors([1, 1], grid)).toEqual([
      [0, 1],
      [2, 1],
      [1, 0],
      [1, 2],
    ]);
    expect(neighbors([0, 2], grid)).toEqual([
      [1, 2],
      [0, 1],
    ]);
    expect(neighbors([], [])).toEqual([]);
    expect(() => neighbors([3, 0], grid)).toThrow('not a point');
    expect(() => neighbors([0], grid)).toThrow('not a point');
  });
});
