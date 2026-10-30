import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import { backtest, parseTicker, sameHoldings, summary } from './backtest';
import type { StrategyDay } from './engine';
import type { Holding } from './schema';

const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
const decide = (tickers: string[]): StrategyDay[] =>
  tickers.map((t, i) => ({
    date: D[i]!,
    signals: {},
    allocation: t,
    holdings: [{ ticker: t, weight: 100 }],
    ties: [],
  }));
const none = () => 0;

describe('backtest', () => {
  it('an unknown cash rate fails only where cash or financing is needed', () => {
    const unknown = () => undefined;
    const x = { X: [bar(D[0]!, 100), bar(D[1]!, 110), bar(D[2]!, 99)] };
    const held = backtest({
      strategy: { execution: 'same_close', costs: {} },
      days: decide(['X', 'X', 'X']),
      bars: x,
      cashRate: unknown,
    });
    expect(held.points.at(-1)!.equity).toBeCloseTo(0.99, 12);
    expect(() =>
      backtest({
        strategy: { execution: 'same_close', costs: {} },
        days: decide(['X', 'CASH_USD', 'CASH_USD']),
        bars: x,
        cashRate: unknown,
      }),
    ).toThrow(/No cash rate/);
    expect(() =>
      backtest({
        strategy: { execution: 'same_close', costs: {} },
        days: decide(['X?L=3', 'X?L=3', 'X?L=3']),
        bars: x,
        cashRate: unknown,
      }),
    ).toThrow(/No cash rate/);
  });

  it('same close: holds from the deciding close (testfol timing)', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs: {} },
      days: decide(['X', 'X', 'X']),
      bars: { X: [bar(D[0]!, 100), bar(D[1]!, 110), bar(D[2]!, 99)] },
      cashRate: none,
    });
    const e = r.points.map((p) => p.equity);
    expect(e[1]).toBeCloseTo(1.1, 12);
    expect(e[2]).toBeCloseTo(0.99, 12);
    expect(r.switches).toBe(0);
  });

  it('next open: trades at the next open; cash earns from the following night', () => {
    const r = backtest({
      strategy: { execution: 'next_open', costs: {} },
      days: decide(['X', 'CASH_USD', 'CASH_USD', 'CASH_USD']),
      bars: {
        X: [
          bar(D[0]!, 100),
          bar(D[1]!, 104, { open: 102 }),
          bar(D[2]!, 101, { open: 103 }),
          bar(D[3]!, 90, { open: 95 }),
        ],
      },
      cashRate: () => 2.52,
    });
    const e = r.points.map((p) => p.equity);
    expect(e[0]).toBe(1);
    expect(e[1]).toBeCloseTo(104 / 102, 12);
    expect(e[2]).toBeCloseTo(103 / 102, 12);
    expect(e[3]).toBeCloseTo((103 / 102) * 1.0001, 12);
    expect(r.switches).toBe(1);
    expect(r.points[2]!.weights).toEqual({ CASH_USD: 1 });
  });

  it('next close: the deciding day and the next one under the old holdings', () => {
    const r = backtest({
      strategy: { execution: 'next_close', costs: {} },
      days: decide(['X', 'Y', 'Y']),
      bars: {
        X: [bar(D[0]!, 100), bar(D[1]!, 110), bar(D[2]!, 121)],
        Y: [bar(D[0]!, 50), bar(D[1]!, 50), bar(D[2]!, 55)],
      },
      cashRate: none,
    });
    // Enters X at D1's close; D2 is X's day (+10%), then switches to Y at D2's close.
    expect(r.points.map((p) => p.equity)).toEqual([1, 1, 1.1]);
    expect(r.points[2]!.weights).toEqual({ Y: 1 });
  });

  it('charges slippage and fees on the turnover of each trade', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs: { slippageBps: 10, feePct: 0.1 } },
      days: decide(['X', 'Y']),
      bars: { X: [bar(D[0]!, 1), bar(D[1]!, 1)], Y: [bar(D[0]!, 1), bar(D[1]!, 1)] },
      cashRate: none,
    });
    // Entry: turnover 1; switch: sell X and buy Y, turnover 2. Cost rate 0.2%.
    expect(r.points[1]!.equity).toBeCloseTo(0.998 * (1 - 0.004), 12);
    expect(r.costs).toBeCloseTo(0.002 + 0.004, 12);
  });

  it('synthetic leverage: L x return minus financing and expense, per day', () => {
    expect(parseTicker('SPY?L=3&E=0.9')).toEqual({ base: 'SPY', leverage: 3, expensePct: 0.9 });
    const r = backtest({
      strategy: { execution: 'same_close', costs: {} },
      days: decide(['SPY?L=3&E=0.9', 'SPY?L=3&E=0.9']),
      bars: { SPY: [bar(D[0]!, 100), bar(D[1]!, 101)] },
      cashRate: () => 2.52,
    });
    expect(r.points[1]!.equity).toBeCloseTo(1 + 0.03 - 2 * 0.0001 - 0.009 / 252, 12);
  });

  it('gives the ex-date dividend to the overnight holder', () => {
    const r = backtest({
      strategy: { execution: 'next_open', costs: {} },
      days: decide(['X', 'CASH_USD']).concat(decide(['CASH_USD', 'CASH_USD', 'CASH_USD']).slice(2)),
      bars: {
        X: [
          bar(D[0]!, 100),
          bar(D[1]!, 100, { open: 100 }),
          bar(D[2]!, 100, { open: 99, divCash: 1 }),
        ],
      },
      cashRate: none,
    });
    expect(r.points[2]!.equity).toBeCloseTo(1, 12);
  });

  it('summarizes growth and the deepest drawdown', () => {
    const s = summary([
      { date: '2025-01-01', equity: 1, weights: {}, traded: false },
      { date: '2025-07-02', equity: 0.8, weights: {}, traded: false },
      { date: '2026-01-01', equity: 1.1, weights: {}, traded: false },
    ]);
    expect(s.maxDrawdown).toBeCloseTo(-0.2, 12);
    expect(s.cagr).toBeCloseTo(1.1 ** (365.25 / 365) - 1, 12);
  });
});

describe('holdings compare order-insensitively (a reorder is no trade)', () => {
  const A: Holding[] = [
    { ticker: 'SPY', weight: 50 },
    { ticker: 'SSO', weight: 50 },
  ];
  const B: Holding[] = [
    { ticker: 'SSO', weight: 50 },
    { ticker: 'SPY', weight: 50 },
  ];
  const C: Holding[] = [
    { ticker: 'SPY', weight: 60 },
    { ticker: 'SSO', weight: 40 },
  ];
  const days = (lists: Holding[][]): StrategyDay[] =>
    lists.map((holdings, i) => ({
      date: D[i]!,
      signals: {},
      allocation: `alloc${i}`,
      holdings,
      ties: [],
    }));
  const flat = (closes: number[]) =>
    closes.map((c, i) => bar(D[i]!, c, { open: c * (i % 2 === 0 ? 0.99 : 1.01) }));
  const bars = { SPY: flat([100, 101, 99, 102]), SSO: flat([50, 52, 49, 53]) };
  const costs = { slippageBps: 10, feePct: 0.1 };

  it('compares tickers and weights as a multiset, exactly', () => {
    expect(sameHoldings(A, B)).toBe(true);
    expect(sameHoldings(A, C)).toBe(false);
    expect(sameHoldings(A, [{ ticker: 'SPY', weight: 100 }])).toBe(false);
    // A repeated ticker never matches a list without the repeat; weights are not merged.
    expect(
      sameHoldings(
        [{ ticker: 'SPY', weight: 100 }],
        [
          { ticker: 'SPY', weight: 50 },
          { ticker: 'SPY', weight: 50 },
        ],
      ),
    ).toBe(false);
    expect(
      sameHoldings(
        [
          { ticker: 'SPY', weight: 50 },
          { ticker: 'SPY', weight: 25 },
          { ticker: 'SSO', weight: 25 },
        ],
        [
          { ticker: 'SPY', weight: 50 },
          { ticker: 'SSO', weight: 25 },
          { ticker: 'SSO', weight: 25 },
        ],
      ),
    ).toBe(false);
    expect(
      sameHoldings(
        [
          { ticker: 'SPY', weight: 25 },
          { ticker: 'SSO', weight: 50 },
          { ticker: 'SPY', weight: 25 },
        ],
        [
          { ticker: 'SPY', weight: 25 },
          { ticker: 'SPY', weight: 25 },
          { ticker: 'SSO', weight: 50 },
        ],
      ),
    ).toBe(true);
    // Exact weights: no tolerance (out of scope).
    expect(
      sameHoldings(
        [
          { ticker: 'SPY', weight: 50 },
          { ticker: 'SSO', weight: 50 },
        ],
        [
          { ticker: 'SPY', weight: 50 + 1e-12 },
          { ticker: 'SSO', weight: 50 - 1e-12 },
        ],
      ),
    ).toBe(false);
    // The inputs are not reordered in place.
    expect(B[0]!.ticker).toBe('SSO');
  });

  for (const execution of ['next_open', 'next_close', 'same_close'] as const) {
    it(`${execution}: alternating A and B gives no switch and no cost after entry`, () => {
      const run = (lists: Holding[][]) =>
        backtest({ strategy: { execution, costs }, days: days(lists), bars, cashRate: none });
      const alternating = run([A, B, A, B]);
      const constant = run([A, A, A, A]);
      expect(alternating.switches).toBe(0);
      expect(alternating.costs).toBe(constant.costs);
      expect(alternating.costs).toBeCloseTo(0.002, 12); // entry only: turnover 1 at 0.2%
      expect(alternating.points.map((p) => p.equity)).toEqual(constant.points.map((p) => p.equity));
      expect(alternating.points.map((p) => p.traded)).toEqual(constant.points.map((p) => p.traded));
    });

    it(`${execution}: a real weight change still counts`, () => {
      const r = backtest({
        strategy: { execution, costs },
        days: days([A, B, C, C]),
        bars,
        cashRate: none,
      });
      expect(r.switches).toBe(1);
      expect(r.costs).toBeGreaterThan(0.002);
    });
  }
});
