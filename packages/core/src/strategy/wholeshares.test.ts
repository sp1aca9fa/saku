// docs/indicators.md "Equity curves", "Whole shares" (requirements 05 "Execution model": small
// amounts): hand-worked cases, refusals, and the residual cash never below 0.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import { type BacktestInput, backtest } from './backtest';
import type { StrategyDay } from './engine';
import type { Holding } from './schema';

const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
/** One decision per date: a ticker held at 100, or a holdings list. */
const decide = (list: (string | Holding[])[]): StrategyDay[] =>
  list.map((h, i) => ({
    date: D[i]!,
    signals: {},
    allocation: String(i),
    holdings: typeof h === 'string' ? [{ ticker: h, weight: 100 }] : h,
    ties: [],
  }));
const none = () => 0;
const usd = (amount: number) => ({ amount, currency: 'USD' });
type Execution = BacktestInput['strategy']['execution'];
const run = (
  execution: Execution,
  list: (string | Holding[])[],
  bars: Record<string, RawBar[]>,
  initialAmount: string,
  extra: Partial<BacktestInput> & { costs?: BacktestInput['strategy']['costs'] } = {},
) =>
  backtest({
    strategy: { execution, costs: extra.costs ?? {} },
    days: decide(list),
    bars,
    cashRate: extra.cashRate ?? none,
    wholeShares: { initialAmount, currency: 'USD' },
  });

describe('whole shares', () => {
  it('hand-worked: 1,000 USD at 300 buys 3 shares and keeps 100 as cash earning the rate', () => {
    const r = run('same_close', ['X', 'X'], { X: [bar(D[0]!, 300), bar(D[1]!, 330)] }, '1000', {
      cashRate: () => 2.52,
    });
    expect(r.wholeShares).toEqual({
      initialAmount: { amount: '1000', currency: 'USD' },
      trades: [
        {
          date: D[0],
          at: 'close',
          value: usd(1000),
          shares: { X: 3 },
          zeroShares: [],
          residualCash: usd(100),
          costs: usd(0),
        },
      ],
    });
    expect(r.points[0]).toMatchObject({ equity: 1, value: usd(1000), traded: true });
    expect(r.points[0]!.weights).toEqual({ X: 0.9, CASH_USD: 0.1 });
    // D1: 3 x 330 + 100 x (1 + 2.52% / 252).
    expect(r.points[1]!.value!.amount).toBeCloseTo(990 + 100.01, 9);
    expect(r.points[1]!.value!.currency).toBe('USD');
    expect(r.points[1]!.equity).toBeCloseTo(1.09001, 12);
    expect(r.switches).toBe(0);
    expect(r.costs).toBe(0);
  });

  it('the residual needs the cash rate: unknown with cash above 0 fails, at 0 it is not read', () => {
    const unknown = () => undefined;
    expect(() =>
      run('same_close', ['X', 'X'], { X: [bar(D[0]!, 300), bar(D[1]!, 330)] }, '1000', {
        cashRate: unknown,
      }),
    ).toThrow(/No cash rate known for 2026-01-06/);
    const exact = run('same_close', ['X', 'X'], { X: [bar(D[0]!, 100), bar(D[1]!, 110)] }, '1000', {
      cashRate: unknown,
    });
    expect(exact.points[1]!.value).toEqual(usd(1100));
    expect(exact.points[1]!.weights).toEqual({ X: 1 });
  });

  it('a target that buys 0 shares is reported, not an error; its money stays cash', () => {
    const r = run(
      'same_close',
      [
        [
          { ticker: 'X', weight: 50 },
          { ticker: 'Y', weight: 50 },
        ],
      ],
      { X: [bar(D[0]!, 300)], Y: [bar(D[0]!, 600)] },
      '1000',
    );
    const t = r.wholeShares!.trades[0]!;
    expect(t.shares).toEqual({ X: 1, Y: 0 });
    expect(t.zeroShares).toEqual(['Y']);
    expect(t.residualCash).toEqual(usd(700));
    expect(r.points[0]!.weights).toEqual({ X: 0.3, CASH_USD: 0.7 });
  });

  it("the target's own CASH_USD weight joins the residual", () => {
    const r = run(
      'same_close',
      [
        [
          { ticker: 'X', weight: 50 },
          { ticker: 'CASH_USD', weight: 50 },
        ],
      ],
      { X: [bar(D[0]!, 300)] },
      '1000',
    );
    expect(r.wholeShares!.trades[0]!.shares).toEqual({ X: 1 });
    expect(r.wholeShares!.trades[0]!.residualCash).toEqual(usd(700));
  });

  it('sizing: a quotient within float noise of a whole number is that number', () => {
    // 58 x 100 / (100 x 2) = 29 (0.58 x 100 / 2 would be 28.999...: 28 shares).
    const at = (weight: number, amount: string, p: number, costs = {}) =>
      run(
        'same_close',
        [
          [
            { ticker: 'X', weight },
            { ticker: 'CASH_USD', weight: 100 - weight },
          ],
        ],
        { X: [bar(D[0]!, p)] },
        amount,
        { costs },
      ).wholeShares!.trades[0]!;
    expect(at(58, '100', 2).shares).toEqual({ X: 29 });
    expect(at(58, '100', 2).residualCash).toEqual(usd(42));
    expect(at(29, '100', 1).shares).toEqual({ X: 29 });
    // With c = 0.002, 30 x 10.02 / (100 x 1 x 1.002) is 3 exactly, 2.9999999999999996 in
    // float64: the snap keeps 3 shares; costs 0.002 x 3, residual 10.02 - 3 - 0.006.
    const t = at(30, '10.02', 1, { slippageBps: 10, feePct: 0.1 });
    expect(t.shares).toEqual({ X: 3 });
    expect(t.residualCash.amount).toBeCloseTo(7.014, 12);
    expect(t.residualCash.amount).toBeGreaterThanOrEqual(0);
  });

  it('costs on the shares traded; sizing leaves room for them', () => {
    // c = 10 bps + 0.1% = 0.002: floor(1000 / (100 x 1.002)) = 9 shares, costs 0.002 x 900.
    const r = run('same_close', ['X'], { X: [bar(D[0]!, 100)] }, '1000', {
      costs: { slippageBps: 10, feePct: 0.1 },
    });
    const t = r.wholeShares!.trades[0]!;
    expect(t.shares).toEqual({ X: 9 });
    expect(t.costs.amount).toBeCloseTo(1.8, 12);
    expect(t.residualCash.amount).toBeCloseTo(98.2, 12);
    expect(r.costs).toBeCloseTo(1.8 / 1000, 15);
  });

  it('a switch sets the sale cost aside first, so the residual never goes below 0', () => {
    // c = 25% for round numbers. Entry: floor(1250 / 125) = 10 shares, costs 250, residual 0.
    // Switch at V = 1000: sized on V it would buy floor(1000 / 125) = 8 Y and pay
    // 0.25 x (1000 + 800) = 450, leaving -250. Budget B = 1000 - 0.25 x 1000 = 750: 6 Y,
    // costs 0.25 x (1000 + 600) = 400, residual 0. The rate is never read (cash stays 0).
    const flat = [bar(D[0]!, 100), bar(D[1]!, 100)];
    const r = run('same_close', ['X', 'Y'], { X: flat, Y: flat }, '1250', {
      costs: { slippageBps: 2500 },
      cashRate: () => undefined,
    });
    const [entry, sw] = r.wholeShares!.trades;
    expect(entry).toMatchObject({ shares: { X: 10 }, costs: usd(250), residualCash: usd(0) });
    expect(sw).toMatchObject({
      value: usd(1000),
      shares: { Y: 6 },
      costs: usd(400),
      residualCash: usd(0),
    });
    expect(r.points.map((p) => p.equity)).toEqual([0.8, 0.48]);
    expect(r.costs).toBeCloseTo(0.2 + 0.4, 15);
    expect(r.switches).toBe(1);
  });

  it('next open: the night (split, dividend) goes to the old shares, the trade at the open', () => {
    const r = run(
      'next_open',
      ['X', 'Y', 'Y', 'Y'],
      {
        X: [
          bar(D[0]!, 300),
          bar(D[1]!, 310, { open: 300 }),
          bar(D[2]!, 170, { open: 160, splitFactor: 2, divCash: 1 }),
          bar(D[3]!, 175, { open: 170 }),
        ],
        Y: [
          bar(D[0]!, 100),
          bar(D[1]!, 100, { open: 100 }),
          bar(D[2]!, 105, { open: 100 }),
          bar(D[3]!, 110, { open: 105 }),
        ],
      },
      '1000',
    );
    const [entry, sw] = r.wholeShares!.trades;
    expect(entry).toMatchObject({
      date: D[1],
      at: 'open',
      shares: { X: 3 },
      residualCash: usd(100),
    });
    // D2's night: 3 X split into 6, dividend 6 x 1 to cash; at the open V = 106 + 6 x 160.
    expect(sw).toMatchObject({
      date: D[2],
      at: 'open',
      value: usd(1066),
      shares: { Y: 10 },
      residualCash: usd(66),
    });
    expect(r.points.map((p) => p.value!.amount)).toEqual([1000, 1030, 1116, 1166]);
    expect(r.points[0]!.weights).toEqual({});
  });

  it('a split that leaves a fraction pays it as cash at the close; float noise is no fraction', () => {
    // 3 shares x 1.5 = 4.5: 4 kept, 0.5 x 210 paid as cash.
    const r = run(
      'same_close',
      ['X', 'X'],
      {
        X: [bar(D[0]!, 300), bar(D[1]!, 210, { splitFactor: 1.5 })],
      },
      '1000',
    );
    expect(r.points[1]!.value).toEqual(usd(4 * 210 + 100 + 105));
    expect(r.points[1]!.weights.X).toBeCloseTo(840 / 1045, 15);
    // 90 x 0.7 is 62.99999999999999 in float64: 63 shares, no cash in lieu.
    const rev = run(
      'same_close',
      ['X', 'X'],
      {
        X: [bar(D[0]!, 100), bar(D[1]!, 140, { splitFactor: 0.7 })],
      },
      '9000',
    );
    expect(rev.points[1]!.value).toEqual(usd(63 * 140));
    expect(rev.points[1]!.weights).toEqual({ X: 1 });
  });

  it('a reverse split can leave 0 shares: the fraction is cash, no dividend on it', () => {
    // 1 share x 0.1 = 0.1: 0 kept, 0.1 x 1000 paid as cash; the dividend of 5 is on 0 shares.
    const r = run(
      'same_close',
      ['X', 'X', 'X'],
      {
        X: [bar(D[0]!, 100), bar(D[1]!, 1000, { splitFactor: 0.1, divCash: 5 }), bar(D[2]!, 1010)],
      },
      '150',
    );
    expect(r.points[1]!.value).toEqual(usd(150));
    expect(r.points[1]!.weights).toEqual({ CASH_USD: 1 });
    expect(r.points[2]!.value).toEqual(usd(150));
    expect(r.wholeShares!.trades).toHaveLength(1);
  });

  it('next open: a split fraction is paid at the open, before the trade', () => {
    // D2's night: 3 X x 1.5 = 4.5: 4 kept, 0.5 x 200 (the open) paid as cash, so
    // V = 100 + 100 + 4 x 200 = 1000 (at the close, 220, it would be 1010): 10 Y, residual 0.
    const r = run(
      'next_open',
      ['X', 'Y', 'Y'],
      {
        X: [
          bar(D[0]!, 300),
          bar(D[1]!, 300, { open: 300 }),
          bar(D[2]!, 220, { open: 200, splitFactor: 1.5 }),
        ],
        Y: [bar(D[0]!, 100), bar(D[1]!, 100, { open: 100 }), bar(D[2]!, 100, { open: 100 })],
      },
      '1000',
    );
    expect(r.wholeShares!.trades[1]).toMatchObject({
      date: D[2],
      at: 'open',
      value: usd(1000),
      shares: { Y: 10 },
      residualCash: usd(0),
    });
  });

  it('next close: a trade on an ex-date sells the split shares, the dividend in cash', () => {
    // Bought at D1's close: 3 X at 300, residual 100. D2 (ex-date): 3 x 2 = 6 shares, dividend
    // 6 x 1; at the close V = 106 + 6 x 160 = 1066: 10 Y at 100, residual 66.
    const r = run(
      'next_close',
      ['X', 'Y', 'Y'],
      {
        X: [bar(D[0]!, 300), bar(D[1]!, 300), bar(D[2]!, 160, { splitFactor: 2, divCash: 1 })],
        Y: [bar(D[0]!, 100), bar(D[1]!, 100), bar(D[2]!, 100)],
      },
      '1000',
    );
    expect(r.wholeShares!.trades.map((t) => [t.date, t.at, t.shares, t.residualCash])).toEqual([
      [D[1], 'close', { X: 3 }, usd(100)],
      [D[2], 'close', { Y: 10 }, usd(66)],
    ]);
    expect(r.wholeShares!.trades[1]!.value).toEqual(usd(1066));
    expect(r.points[2]!.value).toEqual(usd(1066));
  });

  it('a missing open at a next_open trade fails, never a guessed price', () => {
    expect(() =>
      run('next_open', ['X', 'X'], { X: [bar(D[0]!, 300), bar(D[1]!, 310)] }, '1000'),
    ).toThrow(/X has no open on 2026-01-06/);
  });

  it('refuses a strategy that may hold a synthetic ticker', () => {
    const x = { X: [bar(D[0]!, 100), bar(D[1]!, 110)] };
    expect(() => run('same_close', ['X?L=2', 'X?L=2'], x, '1000')).toThrow(
      /synthetic ticker \(X\?L=2\)/,
    );
    // Also when only an allocation or the safe state lists it.
    const days = decide(['X', 'X']);
    for (const strategy of [
      {
        allocations: [
          { name: 'A', holdings: [{ ticker: 'X', weight: 100 }] },
          { name: 'B', holdings: [{ ticker: 'X?E=0.5', weight: 100 }] },
        ],
      },
      { safeState: { holdings: [{ ticker: 'X?L=1', weight: 100 }] } },
    ]) {
      expect(() =>
        backtest({
          strategy: {
            execution: 'same_close',
            costs: {},
            ...strategy,
          } as BacktestInput['strategy'],
          days,
          bars: x,
          cashRate: none,
          wholeShares: { initialAmount: '1000', currency: 'USD' },
        }),
      ).toThrow(/synthetic ticker/);
    }
    // The fractional run holds it as before.
    expect(() =>
      backtest({
        strategy: { execution: 'same_close', costs: {} },
        days: decide(['X?L=2', 'X?L=2']),
        bars: x,
        cashRate: none,
      }),
    ).not.toThrow();
  });

  it('refuses what it cannot model', () => {
    const x = { X: [bar(D[0]!, 100), bar(D[1]!, 60)] };
    const days = decide(['X', 'X']);
    const with_ = (ws: { initialAmount: string; currency: string }) => () =>
      backtest({
        strategy: { execution: 'same_close', costs: {} },
        days,
        bars: x,
        cashRate: none,
        wholeShares: ws,
      });
    expect(with_({ initialAmount: '1000', currency: 'JPY' })).toThrow(/only USD/);
    for (const bad of ['0', '0.00', '-5', '1e3', ' 100', '1,000', '1000.', '.5', '', '+1']) {
      expect(with_({ initialAmount: bad, currency: 'USD' })).toThrow(/initial amount/);
    }
    expect(with_({ initialAmount: '2500.50', currency: 'USD' })).not.toThrow();
    // Split-adjusted bars: not a share count anyone held.
    expect(() =>
      run('same_close', ['X'], { X: [bar(D[0]!, 100, { closeIsSplitAdjusted: true })] }, '1000'),
    ).toThrow(/split-adjusted/);
    // A cost rate of 100% or more.
    expect(() =>
      run('same_close', ['X'], { X: [bar(D[0]!, 100)] }, '1000', { costs: { feePct: 100 } }),
    ).toThrow(/cost rate/);
    // A price at or below 0 at a trade.
    expect(() =>
      run('same_close', ['CASH_USD', 'X'], { X: [bar(D[0]!, 100), bar(D[1]!, 0)] }, '1000'),
    ).toThrow(/priced 0/);
    // A ticker listed twice.
    expect(() =>
      run(
        'same_close',
        [
          [
            { ticker: 'X', weight: 50 },
            { ticker: 'X', weight: 50 },
          ],
        ],
        { X: [bar(D[0]!, 100)] },
        '1000',
      ),
    ).toThrow(/listed twice/);
  });

  it('without the option: no amounts in the result', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs: {} },
      days: decide(['X', 'X']),
      bars: { X: [bar(D[0]!, 300), bar(D[1]!, 330)] },
      cashRate: none,
    });
    expect('wholeShares' in r).toBe(false);
    expect(r.points.every((p) => !('value' in p))).toBe(true);
    expect(r.points.map((p) => p.equity)).toEqual([1, 1.1]);
  });

  it('a large amount without costs or dividends follows the fractional curve', () => {
    const closes = { X: [100, 103, 99, 104, 101], Y: [50, 49, 52, 51, 55] };
    const bars = Object.fromEntries(
      Object.entries(closes).map(([t, cs]) => [
        t,
        cs.map((c, i) => bar(D[i]!, c, { open: c * (i % 2 ? 1.01 : 0.99) })),
      ]),
    );
    const list: (string | Holding[])[] = [
      [
        { ticker: 'X', weight: 60 },
        { ticker: 'Y', weight: 40 },
      ],
      'Y',
      [
        { ticker: 'X', weight: 70 },
        { ticker: 'CASH_USD', weight: 30 },
      ],
      'X',
      'X',
    ];
    for (const execution of ['next_open', 'next_close', 'same_close'] as const) {
      const fractional = backtest({
        strategy: { execution, costs: {} },
        days: decide(list),
        bars,
        cashRate: () => 2.52,
      });
      const whole = run(execution, list, bars, '1000000000000', { cashRate: () => 2.52 });
      whole.points.forEach((p, i) => {
        expect(p.equity).toBeCloseTo(fractional.points[i]!.equity, 9);
        expect(p.traded).toBe(fractional.points[i]!.traded);
      });
      expect(whole.switches).toBe(fractional.switches);
    }
  });

  it('property: residual = V - bought - costs, never below 0; counts whole and maximal', () => {
    const targets: Holding[][] = [
      [{ ticker: 'X', weight: 100 }],
      [
        { ticker: 'X', weight: 50 },
        { ticker: 'Y', weight: 50 },
      ],
      [
        { ticker: 'Y', weight: 30 },
        { ticker: 'CASH_USD', weight: 70 },
      ],
      [{ ticker: 'CASH_USD', weight: 100 }],
    ];
    // The target of a trade from its non-cash tickers (unique in this list).
    const weightOf = (tickers: string[], k: string) =>
      targets
        .find(
          (h) =>
            h
              .filter((x) => x.ticker !== 'CASH_USD')
              .map((x) => x.ticker)
              .join() === tickers.join(),
        )!
        .find((x) => x.ticker === k)!.weight;
    const price = fc.double({ min: 1, max: 2000, noNaN: true });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(price, price, price, price, fc.nat(targets.length - 1)), {
          minLength: 5,
          maxLength: 5,
        }),
        fc.constantFrom<Execution>('next_open', 'next_close', 'same_close'),
        fc.integer({ min: 0, max: 500 }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.integer({ min: 1, max: 100_000 }),
        (rows, execution, slippageBps, feePct, amount) => {
          const bars = {
            X: rows.map(([o, c], i) => bar(D[i]!, c, { open: o })),
            Y: rows.map(([, , o, c], i) => bar(D[i]!, c, { open: o })),
          };
          const days = rows.map((row) => targets[row[4]]!);
          const r = run(execution, days, bars, String(amount), {
            costs: { slippageBps, feePct },
            cashRate: () => 2,
          });
          const c = slippageBps / 10_000 + feePct / 100;
          const at = (t: string, date: string, open: boolean) => {
            const b = bars[t as 'X' | 'Y'].find((x) => x.date === date)!;
            return open ? b.open! : b.close;
          };
          // No splits here: the shares before a trade are the previous trade's.
          let before: Record<string, number> = {};
          for (const t of r.wholeShares!.trades) {
            const price = (k: string) => at(k, t.date, t.at === 'open');
            const V = t.value.amount;
            let held = 0;
            for (const [k, n] of Object.entries(before)) held += n * price(k);
            const B = V - c * held;
            let bought = 0;
            for (const [k, n] of Object.entries(t.shares)) {
              expect(Number.isInteger(n) && n >= 0).toBe(true);
              bought += n * price(k);
              // Never over the ticker's share of the budget, and one more share would be.
              const share = (weightOf(Object.keys(t.shares), k) / 100) * B;
              expect(n * price(k) * (1 + c)).toBeLessThanOrEqual(share * (1 + 1e-9));
              expect((n + 1) * price(k) * (1 + c)).toBeGreaterThan(share * (1 - 1e-9));
            }
            expect(t.residualCash.amount).toBeGreaterThanOrEqual(0);
            expect(t.costs.amount).toBeGreaterThanOrEqual(0);
            expect(
              Math.abs(t.residualCash.amount - (V - bought - t.costs.amount)),
            ).toBeLessThanOrEqual(1e-9 * V);
            before = t.shares;
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
