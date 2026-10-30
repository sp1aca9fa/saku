// Core against the independent reference implementation (requirements 04 layer E, 13) on
// synthetic random data: signals and allocations equal, equity within 1e-9 relative.
import { refBacktest, refEvaluate } from '@saku/reference';
import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import { backtest } from './backtest';
import type { StrategyDay } from './engine';
import { evaluate } from './engine';
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
        a.points.forEach((p, i) => {
          expect(Math.abs(p.equity / b.equity[i]! - 1)).toBeLessThanOrEqual(1e-9);
        });
      });
    }
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
      a.points.forEach((p, i) => {
        expect(Math.abs(p.equity / b.equity[i]! - 1)).toBeLessThanOrEqual(1e-9);
      });
    });
  }
});
