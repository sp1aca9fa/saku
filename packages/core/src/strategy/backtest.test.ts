import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import { backtest, parseTicker, sameHoldings, summary } from './backtest';
import { type StrategyDay, evaluate } from './engine';
import { dependencies, strategyTickers } from './forward';
import { type Holding, Strategy } from './schema';

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

  // docs/indicators.md "Equity curves", "Days without a decision" (B1 review): a session that
  // is not evaluated still counts; its decision is the safe state, traded like any decision.
  it('a day without a decision: its returns count and the safe state is traded', () => {
    const closes = [100, 101, 102, 103, 104, 150, 106, 107, 108, 109];
    const dates = closes.map((_, i) =>
      new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10),
    );
    const x = closes.map((c, i) =>
      bar(dates[i]!, c, { open: c, high: c * 1.01, ...(i !== 5 && { low: c * 0.99 }) }),
    );
    const strategy = Strategy.parse({
      name: 'Gap',
      account: 'taxable',
      execution: 'next_close',
      safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [
        {
          id: 'A',
          type: 'compare',
          left: { indicator: 'volatility', method: 'parkinson', ticker: 'X', length: 1 },
          op: '<',
          right: { threshold: 1e6 },
        },
      ],
      allocations: [
        { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'X', weight: 100 }] },
        { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      ],
    });
    const days = evaluate(strategy, { X: x });
    // Day 5 (close 150) has no low: Parkinson has no value, no decision.
    expect(days.map((d) => d.date)).toEqual(dates.filter((_, i) => i !== 5));
    const r = backtest({ strategy, days, bars: { X: x }, cashRate: none });
    expect(r.points.map((p) => p.date)).toEqual(dates);
    expect(r.points.map((p) => p.decided)).toEqual(dates.map((_, i) => i !== 5));
    // X from day 1's close; day 5 decides the safe state (cash), traded at day 6's close, so
    // day 6 is still X's (150 -> 106); day 6 decides X again, traded at day 7's close.
    const want = [
      1,
      1,
      102 / 101,
      103 / 101,
      104 / 101,
      150 / 101,
      106 / 101,
      106 / 101,
      (106 / 101) * (108 / 107),
      (106 / 101) * (109 / 107),
    ];
    r.points.forEach((p, i) => expect(p.equity).toBeCloseTo(want[i]!, 12));
    expect(r.points[6]!.weights).toEqual({ CASH_USD: 1 });
    expect(r.points[7]!.weights).toEqual({ X: 1 });
    expect(r.switches).toBe(2);
    // Without a safe state to take, the gap is not guessed.
    expect(() =>
      backtest({
        strategy: { execution: 'next_close', costs: {} },
        days,
        bars: { X: x },
        cashRate: none,
      }),
    ).toThrow(/no decision/);
  });

  // A session is a date every ticker the strategy may hold has a bar; a date the signal ticker
  // lacks is then a session without a decision (docs/indicators.md "Days without a decision").
  it('a signal ticker without a bar on a session: the safe state, the held returns kept', () => {
    const closes = [100, 101, 102, 103, 104, 150, 106, 107, 108, 109];
    const dates = closes.map((_, i) =>
      new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10),
    );
    const h = closes.map((c, i) => bar(dates[i]!, c));
    const sig = dates.flatMap((d, i) => (i === 5 ? [] : [bar(d, 50 + (i % 3))]));
    const strategy = (safe: string) =>
      Strategy.parse({
        name: 'Signal elsewhere',
        account: 'taxable',
        execution: 'next_close',
        safeState: { holdings: [{ ticker: safe, weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [
          {
            id: 'A',
            type: 'compare',
            left: { indicator: 'volatility', ticker: 'S', length: 2 },
            op: '<',
            right: { threshold: 1e6 },
          },
        ],
        allocations: [
          { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'H', weight: 100 }] },
          { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        ],
      });
    const s = strategy('CASH_USD');
    const days = evaluate(s, { S: sig, H: h });
    // S's volatility of 2 needs 3 of its bars: from day 2; day 5 has no S bar.
    expect(days.map((d) => d.date)).toEqual(dates.filter((_, i) => i >= 2 && i !== 5));
    const r = backtest({ strategy: s, days, bars: { S: sig, H: h }, cashRate: none });
    expect(r.points.map((p) => p.date)).toEqual(dates.slice(2));
    expect(r.points.map((p) => p.decided)).toEqual(dates.slice(2).map((_, i) => i !== 3));
    const want = [
      1,
      1,
      104 / 103,
      150 / 103,
      106 / 103,
      106 / 103,
      (106 / 103) * (108 / 107),
      (106 / 103) * (109 / 107),
    ];
    r.points.forEach((p, i) => expect(p.equity).toBeCloseTo(want[i]!, 12));
    expect(r.switches).toBe(2);

    // A safe state holding a ticker no allocation holds (B): its bars are needed, and
    // `strategyTickers` names it for the callers to load.
    const b = dates.map((d, i) => bar(d, 20 + i));
    const withB = strategy('B');
    expect(strategyTickers(withB)).toEqual(['B', 'H', 'S']);
    expect(dependencies(withB)).toEqual(['H', 'S']);
    expect(() =>
      backtest({ strategy: withB, days, bars: { S: sig, H: h }, cashRate: none }),
    ).toThrow('No bars for B.');
    const rb = backtest({ strategy: withB, days, bars: { S: sig, H: h, B: b }, cashRate: none });
    expect(rb.points[4]!.weights).toEqual({ B: 1 }); // day 6's close: into B
    expect(rb.points[5]!.equity).toBeCloseTo((106 / 103) * (27 / 26), 12); // B on day 7
  });

  it('summarizes growth and the deepest drawdown', () => {
    const s = summary([
      { decided: true, date: '2025-01-01', equity: 1, weights: {}, traded: false },
      { decided: true, date: '2025-07-02', equity: 0.8, weights: {}, traded: false },
      { decided: true, date: '2026-01-01', equity: 1.1, weights: {}, traded: false },
    ]);
    expect(s.maxDrawdown).toBeCloseTo(-0.2, 12);
    expect(s.cagr).toBeCloseTo(1.1 ** (365.25 / 365) - 1, 12);
  });
});

// docs/indicators.md "Equity curves", "Returns": a held ticker's bars dated between two sessions
// (another ticker it may hold has no bar there) are compounded into the next session, never dropped.
describe('bars between sessions', () => {
  const at = (date: string, holdings: Holding[]): StrategyDay => ({
    date,
    signals: {},
    allocation: holdings.map((h) => h.ticker).join(),
    holdings,
    ties: [],
  });
  const x100 = [{ ticker: 'X', weight: 100 }];
  const yAllocation = {
    allocations: [{ name: 'Y', holdings: [{ ticker: 'Y', weight: 100 }] }],
  } as unknown as Partial<Pick<Strategy, 'allocations'>>;

  it('a 2:1 split on a date that is no session counts (Y has no bar there)', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs: {}, ...yAllocation },
      days: [at('2026-01-05', x100), at('2026-01-07', x100)],
      bars: {
        X: [
          bar('2026-01-05', 100),
          bar('2026-01-06', 55, { splitFactor: 2 }),
          bar('2026-01-07', 51),
        ],
        Y: [bar('2026-01-05', 10), bar('2026-01-07', 10)],
      },
      cashRate: none,
    });
    expect(r.points.map((p) => p.date)).toEqual(['2026-01-05', '2026-01-07']);
    // 100 -> 55 x 2 -> 51 x 2: +2%, not 51 / 55 - 1 (the gap's day and split dropped).
    expect(r.points[1]!.equity).toBeCloseTo(1.02, 12);
  });

  it('next open: the gap bars (split, dividend) go into the night part, before the trade', () => {
    const r = backtest({
      strategy: { execution: 'next_open', costs: {}, ...yAllocation },
      days: [
        at('2026-01-05', x100),
        at('2026-01-06', [{ ticker: 'Y', weight: 100 }]),
        at('2026-01-08', [{ ticker: 'Y', weight: 100 }]),
      ],
      bars: {
        X: [
          bar('2026-01-05', 100),
          bar('2026-01-06', 100, { open: 100 }),
          bar('2026-01-07', 51, { open: 50, splitFactor: 2, divCash: 1 }),
          bar('2026-01-08', 53, { open: 52 }),
        ],
        Y: [
          bar('2026-01-05', 10),
          bar('2026-01-06', 10, { open: 10 }),
          bar('2026-01-08', 11, { open: 10 }),
        ],
      },
      cashRate: none,
    });
    // X bought at 01-06's open; 01-08's night: (51 + 1) x 2 / 100, then 52 / 51; Y's day 11 / 10.
    expect(r.points[1]!.equity).toBe(1);
    expect(r.points[2]!.equity).toBeCloseTo(((52 * 2) / 100) * (52 / 51) * 1.1, 12);
    expect(r.points[2]!.weights).toEqual({ Y: 1 });
  });

  it('without a gap the return is the same as before, to the bit', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs: {} },
      days: [at('2026-01-05', x100), at('2026-01-06', x100)],
      bars: { X: [bar('2026-01-05', 3), bar('2026-01-06', 7, { divCash: 0.1, splitFactor: 3 })] },
      cashRate: none,
    });
    expect(r.points[1]!.equity).toBe(1 + (((7 + 0.1) * 3) / 3 - 1));
  });

  it('a strategy that may hold only cash: the sessions are the evaluated dates', () => {
    const cash = [{ ticker: 'CASH_USD', weight: 100 }];
    const r = backtest({
      strategy: { execution: 'same_close', costs: {} },
      days: [at('2026-01-05', cash), at('2026-01-07', cash)],
      bars: { X: [bar('2026-01-05', 1), bar('2026-01-06', 1), bar('2026-01-07', 1)] },
      cashRate: () => 2.52,
    });
    expect(r.points.map((p) => p.date)).toEqual(['2026-01-05', '2026-01-07']);
    expect(r.points[1]!.equity).toBeCloseTo(1.0001, 15);
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
    // Swapped weights between the same tickers are a change.
    expect(
      sameHoldings(
        [
          { ticker: 'SPY', weight: 40 },
          { ticker: 'SSO', weight: 60 },
        ],
        [
          { ticker: 'SPY', weight: 60 },
          { ticker: 'SSO', weight: 40 },
        ],
      ),
    ).toBe(false);
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
