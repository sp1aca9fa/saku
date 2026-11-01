// Base currency, CASH_BASE and the FX spread (docs/indicators.md "Base currency", "Base-currency
// cash", "FX spread"; spec 2026-11-02 base-currency). Hand-worked values.
import { describe, expect, it } from 'vitest';
import type { RawBar, TradingDate } from '../domain';
import { type BacktestInput, backtest, heldTickers, summary } from './backtest';
import type { StrategyDay } from './engine';
import { strategyTickers } from './forward';
import { Strategy } from './schema';

const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
const decide = (tickers: string[], dates = D): StrategyDay[] =>
  tickers.map((t, i) => ({
    date: dates[i]!,
    signals: {},
    allocation: t,
    holdings: [{ ticker: t, weight: 100 }],
    ties: [],
  }));
const at =
  (values: Record<string, number | undefined>) =>
  (date: TradingDate): number | undefined =>
    values[date];
const none = () => 0;
/** 2.52% a year: 0.0001 a day (/ 252). */
const deposit = () => 2.52;
const costs = { slippageBps: 0, feePct: 0, fxSpreadPct: 0 };

describe('base-currency series', () => {
  it('whole shares: USD 1000 is JPY 150,000 at 150; each point is value x its own FX', () => {
    const r = backtest({
      strategy: { execution: 'next_open', costs },
      days: decide(['X', 'X', 'X']),
      bars: {
        X: [bar(D[0]!, 100), bar(D[1]!, 110, { open: 100 }), bar(D[2]!, 120, { open: 115 })],
      },
      cashRate: none,
      wholeShares: { initialAmount: '1000', currency: 'USD' },
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150, [D[1]!]: 151, [D[2]!]: 149 }),
    });
    // Before the first trade: USD 1000 at 150. Then 10 shares at the D1 open (100): 1100 at the
    // D1 close at 151, 1200 at the D2 close at 149.
    expect(r.base!.points.map((p) => p.value)).toEqual([
      { amount: 150_000, currency: 'JPY' },
      { amount: 166_100, currency: 'JPY' },
      { amount: 178_800, currency: 'JPY' },
    ]);
    expect(r.base!.points.map((p) => p.equity)).toEqual([150, 1.1 * 151, 1.2 * 149]);
    expect(r.base!.currency).toBe('JPY');
    expect(r.conversions).toBeUndefined();
  });

  it('an unknown FX on a session gives no base value there, listed; the USD curve is unchanged', () => {
    const input: BacktestInput = {
      strategy: { execution: 'same_close', costs },
      days: decide(['X', 'X', 'X']),
      bars: { X: [bar(D[0]!, 100), bar(D[1]!, 110), bar(D[2]!, 99)] },
      cashRate: none,
    };
    const usd = backtest(input);
    const r = backtest({
      ...input,
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150, [D[2]!]: 152 }),
    });
    expect(r.points).toEqual(usd.points);
    expect(r.base!.points.map((p) => p.equity)).toEqual([150, null, usd.points[2]!.equity! * 152]);
    expect(r.base!.unknownFx).toEqual([D[1]]);
    expect(r.base!.invalidFx).toEqual([]);
    // A value that is not finite or not above 0 is never a rate: no base value, listed apart.
    const bad = backtest({
      ...input,
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 0, [D[1]!]: Number.NaN, [D[2]!]: -1 }),
    });
    expect(bad.points).toEqual(usd.points);
    expect(bad.base!.points.map((p) => p.equity)).toEqual([null, null, null]);
    expect(bad.base!.invalidFx).toEqual([D[0], D[1], D[2]]);
    // With whole shares the value is null too.
    const whole = backtest({
      ...input,
      wholeShares: { initialAmount: '1000', currency: 'USD' },
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150 }),
    });
    expect(whole.base!.points[1]).toEqual({ date: D[1], equity: null, value: null });
  });

  it('without base inputs the result is bit-identical; base USD equals the USD series', () => {
    const input: BacktestInput = {
      strategy: { execution: 'next_open', costs: { slippageBps: 7, feePct: 0.03 } },
      days: decide(['X', 'CASH_USD', 'X', 'X']),
      bars: {
        X: [
          bar(D[0]!, 100),
          bar(D[1]!, 104, { open: 102 }),
          bar(D[2]!, 101, { open: 103 }),
          bar(D[3]!, 90, { open: 95 }),
        ],
      },
      cashRate: () => 4.2,
    };
    const plain = backtest(input);
    expect(Object.keys(plain).sort()).toEqual(['costs', 'points', 'switches']);
    const jpy = backtest({ ...input, baseCurrency: 'JPY', fxRate: () => 150 });
    expect(jpy.points).toEqual(plain.points);
    expect(jpy.points.every((p, i) => Object.is(p.equity, plain.points[i]!.equity))).toBe(true);
    expect(jpy.costs).toBe(plain.costs);
    const usd = backtest({ ...input, baseCurrency: 'USD' });
    expect(usd.base!.points.map((p) => p.equity)).toEqual(plain.points.map((p) => p.equity));
    expect(usd.base!.unknownFx).toEqual([]);
  });

  it('refuses a base currency that is not an ISO code', () => {
    for (const code of ['jpy', 'JP', 'JPYY', ' JPY', '']) {
      expect(() =>
        backtest({
          strategy: { execution: 'same_close', costs },
          days: decide(['X']),
          bars: { X: [bar(D[0]!, 100)] },
          cashRate: none,
          baseCurrency: code,
        }),
      ).toThrow(/ISO 4217/);
    }
  });
});

describe('CASH_BASE', () => {
  it('accrues the deposit rate / 252 per day and moves with FX between sessions', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs },
      days: decide(['CASH_BASE', 'CASH_BASE', 'CASH_BASE']),
      bars: {},
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150, [D[1]!]: 150, [D[2]!]: 151 }),
      depositRate: deposit,
    });
    const e = r.points.map((p) => p.equity);
    expect(e[0]).toBe(1);
    expect(e[1]).toBeCloseTo(1.0001, 15);
    // The yen fell against the dollar (150 -> 151): the deposit is worth less in USD.
    expect(e[2]).toBeCloseTo(1.0001 * 1.0001 * (150 / 151), 15);
    // In yen it earned the deposit rate only.
    expect(r.base!.points[2]!.equity).toBeCloseTo(1.0001 * 1.0001 * 150, 12);
    // Entering CASH_BASE from the USD start converts (spread 0 here): no tax modeled.
    expect(r.conversions).toEqual({ count: 1, fxSpreadCosts: 0, tax: 'not_applied' });
  });

  it('a switch SPY -> CASH_BASE pays slippage, fee and the FX spread on the converted part', () => {
    const fx = at({ [D[0]!]: 150, [D[1]!]: 150, [D[2]!]: 152, [D[3]!]: 160 });
    const r = backtest({
      strategy: {
        execution: 'next_open',
        costs: { slippageBps: 10, feePct: 0.1, fxSpreadPct: 0.5 },
      },
      days: decide(['SPY', 'CASH_BASE', 'CASH_BASE', 'CASH_BASE']),
      bars: {
        SPY: [
          bar(D[0]!, 100),
          bar(D[1]!, 104, { open: 102 }),
          bar(D[2]!, 101, { open: 103 }),
          bar(D[3]!, 90, { open: 95 }),
        ],
      },
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: fx,
      depositRate: deposit,
    });
    const e = r.points.map((p) => p.equity);
    // D1 open: enter SPY (turnover 1 x 0.2%, no conversion); the day 102 -> 104.
    const d1 = 0.998 * (104 / 102);
    expect(e[1]).toBeCloseTo(d1, 14);
    // D2: the night on SPY (104 -> 103), then SPY -> CASH_BASE at the open: turnover 2 x 0.2% and
    // the converted 100% x 0.5% = 0.9%; nothing in the open-to-close part.
    const d2 = d1 * (103 / 104) * (1 - 0.009);
    expect(e[2]).toBeCloseTo(d2, 14);
    // D3: one day's deposit rate and the FX move 152 -> 160.
    expect(e[3]).toBeCloseTo(d2 * 1.0001 * (152 / 160), 14);
    expect(r.costs).toBeCloseTo(0.002 + 0.009, 15);
    expect(r.conversions).toEqual({ count: 1, fxSpreadCosts: 0.005, tax: 'not_applied' });
    expect(r.points[3]!.weights).toEqual({ CASH_BASE: 1 });
    // In yen the D3 point is the USD equity x 160.
    expect(r.base!.points[3]!.equity).toBeCloseTo(e[3]! * 160, 12);
  });

  it('pays the spread on the change in its weight only; trades within USD holdings pay none', () => {
    const days: StrategyDay[] = [
      {
        date: D[0]!,
        signals: {},
        allocation: 'a',
        holdings: [{ ticker: 'X', weight: 100 }],
        ties: [],
      },
      {
        date: D[1]!,
        signals: {},
        allocation: 'b',
        holdings: [
          { ticker: 'X', weight: 60 },
          { ticker: 'CASH_BASE', weight: 40 },
        ],
        ties: [],
      },
      {
        date: D[2]!,
        signals: {},
        allocation: 'c',
        holdings: [{ ticker: 'Y', weight: 100 }],
        ties: [],
      },
    ];
    const flat = [bar(D[0]!, 100), bar(D[1]!, 100), bar(D[2]!, 100)];
    const r = backtest({
      strategy: { execution: 'same_close', costs: { slippageBps: 0, feePct: 0, fxSpreadPct: 1 } },
      days,
      bars: { X: flat, Y: flat },
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: () => 150,
      depositRate: () => 0,
    });
    // D1: 40% converted (1% of it); D2: CASH_BASE's 40% back to USD (1% of it); X -> Y is free.
    expect(r.points.map((p) => p.equity)).toEqual([1, 1 - 0.004, (1 - 0.004) * (1 - 0.004)]);
    expect(r.conversions).toEqual({ count: 2, fxSpreadCosts: 0.008, tax: 'not_applied' });
  });

  it('pays the spread on the drifted CASH_BASE weight: X 60 / CASH_BASE 40, FX 150 -> 160, then out', () => {
    const mix = [
      { ticker: 'X', weight: 60 },
      { ticker: 'CASH_BASE', weight: 40 },
    ];
    const days: StrategyDay[] = [
      { date: D[0]!, signals: {}, allocation: 'mix', holdings: mix, ties: [] },
      { date: D[1]!, signals: {}, allocation: 'mix', holdings: mix, ties: [] },
      {
        date: D[2]!,
        signals: {},
        allocation: 'x',
        holdings: [{ ticker: 'X', weight: 100 }],
        ties: [],
      },
    ];
    const r = backtest({
      strategy: { execution: 'same_close', costs: { slippageBps: 0, feePct: 0, fxSpreadPct: 1 } },
      days,
      bars: { X: [bar(D[0]!, 100), bar(D[1]!, 110), bar(D[2]!, 110)] },
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150, [D[1]!]: 160, [D[2]!]: 160 }),
      depositRate: () => 0,
    });
    // D0: the 40% converted pays 1%: 0.996, held 60 / 40.
    // D1: X 0.6 x 1.1 = 0.66; CASH_BASE 0.4 x 150 / 160 = 0.375; together 1.035 (no trade).
    // D2: out of CASH_BASE: its drifted weight 0.375 / 1.035 is converted, paying 1% of it.
    const drifted = 0.375 / 1.035;
    const e = r.points.map((p) => p.equity);
    expect(e[0]).toBeCloseTo(0.996, 15);
    expect(e[1]).toBeCloseTo(0.996 * 1.035, 15);
    expect(r.points[1]!.weights.CASH_BASE).toBeCloseTo(drifted, 15);
    expect(e[2]).toBeCloseTo(0.996 * 1.035 * (1 - drifted * 0.01), 15);
    expect(r.conversions!.count).toBe(2);
    expect(r.conversions!.fxSpreadCosts).toBeCloseTo(0.004 + drifted * 0.01, 15);
    expect(r.costs).toBeCloseTo(0.004 + drifted * 0.01, 15);
  });

  it('reads each covered day of a gap at its own deposit rate', () => {
    // Sessions need SPY and QQQ: D1 is no session (QQQ has no bar), but SPY's bar makes it a
    // covered day, so the step D0 -> D2 accrues two days.
    const read: string[] = [];
    const r = backtest({
      strategy: {
        execution: 'same_close',
        costs,
        allocations: [
          { name: 'a', holdings: [{ ticker: 'SPY', weight: 100 }] },
          { name: 'b', holdings: [{ ticker: 'QQQ', weight: 100 }] },
          { name: 'c', holdings: [{ ticker: 'CASH_BASE', weight: 100 }] },
        ],
      },
      days: decide(['CASH_BASE', 'CASH_BASE'], [D[0]!, D[2]!]),
      bars: {
        SPY: [bar(D[0]!, 1), bar(D[1]!, 1), bar(D[2]!, 1)],
        QQQ: [bar(D[0]!, 1), bar(D[2]!, 1)],
      },
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150, [D[2]!]: 140 }),
      depositRate: (d) => {
        read.push(d);
        return d === D[1] ? 2.52 : 5.04;
      },
    });
    expect(read).toEqual([D[1], D[2]]);
    expect(r.points.map((p) => p.date)).toEqual([D[0], D[2]]);
    expect(r.points[1]!.equity).toBeCloseTo(1.0001 * 1.0002 * (150 / 140), 15);
  });

  it('fails on an unknown deposit rate while held (never 0); an unusable FX leaves its point without a value', () => {
    const run = (o: Partial<BacktestInput>, tickers = ['CASH_BASE', 'CASH_BASE']) =>
      backtest({
        strategy: { execution: 'same_close', costs },
        days: decide(tickers),
        bars: { X: [bar(D[0]!, 100), bar(D[1]!, 100)] },
        cashRate: none,
        baseCurrency: 'JPY',
        fxRate: () => 150,
        depositRate: deposit,
        ...o,
      });
    expect(() => run({ depositRate: () => undefined })).toThrow(/No deposit rate known/);
    expect(() => run({ depositRate: undefined })).toThrow(/No deposit rate known/);
    expect(() => run({ depositRate: () => Number.NaN })).toThrow(/not a finite number/);
    // Held from D0's close; D1's FX unknown: D1 has no value, with the reason.
    const d1 = run({ fxRate: at({ [D[0]!]: 150 }) });
    expect(d1.points.map((p) => p.equity)).toEqual([1, null]);
    expect(d1.points[1]!.unknown).toEqual({
      date: D[1],
      reason: 'no FX rate (USDJPY) known for 2026-01-06',
    });
    expect(d1.points[1]!.weights).toEqual({});
    // The entry into CASH_BASE on D0 cannot be priced: every point from it on is unknown.
    const d0 = run({ fxRate: at({ [D[1]!]: 150 }) });
    expect(d0.points.map((p) => p.equity)).toEqual([null, null]);
    expect(d0.points.map((p) => p.unknown!.date)).toEqual([D[0], D[0]]);
    expect(d0.points[1]!.unknown!.reason).toMatch(
      /a trade with CASH_BASE on 2026-01-05 could not be priced \(no FX rate \(USDJPY\) known for 2026-01-05\)/,
    );
    expect(run({ fxRate: () => 0 }).points[0]!.unknown!.reason).toMatch(/is 0, not above 0/);
    // Held only from D1's close on: the step D0 -> D1 is X's, so neither is read for it.
    const later = run({ depositRate: () => undefined, fxRate: at({ [D[1]!]: 150 }) }, [
      'X',
      'CASH_BASE',
    ]);
    expect(later.points.map((p) => p.equity)).toEqual([1, 1]);
  });

  it('a session without FX costs only that session: the next one with FX is valued', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs },
      days: decide(['CASH_BASE', 'CASH_BASE', 'CASH_BASE', 'CASH_BASE']),
      bars: {},
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150, [D[2]!]: 160, [D[3]!]: 160 }),
      depositRate: deposit,
    });
    // Held as 150 yen per unit of equity from D0; the yen amount earns 0.0001 a day throughout.
    const e = r.points.map((p) => p.equity);
    expect(e[0]).toBe(1);
    expect(e[1]).toBeNull();
    expect(e[2]).toBeCloseTo((150 * 1.0001 ** 2) / 160, 15);
    expect(e[3]).toBeCloseTo((150 * 1.0001 ** 3) / 160, 15);
    expect(r.base!.points.map((p) => p.equity)).toEqual([150, null, e[2]! * 160, e[3]! * 160]);
    expect(r.base!.unknownFx).toEqual([D[1]]);
  });

  it('a conversion on a session without FX leaves every later point unknown', () => {
    const r = backtest({
      strategy: { execution: 'same_close', costs: { slippageBps: 0, feePct: 0.1, fxSpreadPct: 1 } },
      days: decide(['X', 'CASH_BASE', 'X', 'X']),
      bars: { X: D.map((d) => bar(d, 100)) },
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: at({ [D[0]!]: 150, [D[2]!]: 150, [D[3]!]: 150 }),
      depositRate: deposit,
    });
    expect(r.points.map((p) => p.equity)).toEqual([0.999, null, null, null]);
    expect(r.points.slice(1).map((p) => p.unknown!.date)).toEqual([D[1], D[1], D[1]]);
    // The trades still count; their costs cannot be priced and are left out.
    expect(r.switches).toBe(2);
    expect(r.costs).toBeCloseTo(0.001, 15);
    expect(r.conversions).toBeUndefined();
    expect(() => summary(r.points)).toThrow(/equity of 2026-01-06 is unknown/);
  });

  it('needs the base currency; with base USD nothing converts and no FX is read', () => {
    const input: BacktestInput = {
      strategy: { execution: 'same_close', costs: { slippageBps: 0, feePct: 0, fxSpreadPct: 1 } },
      days: decide(['CASH_BASE', 'CASH_BASE']),
      bars: {},
      cashRate: none,
      depositRate: deposit,
    };
    expect(() => backtest(input)).toThrow(/CASH_BASE needs the base currency/);
    const usd = backtest({
      ...input,
      baseCurrency: 'USD',
      fxRate: () => {
        throw new Error('not read');
      },
    });
    expect(usd.points.map((p) => p.equity)).toEqual([1, 1.0001]);
    expect(usd.conversions).toBeUndefined();
    expect(usd.costs).toBe(0);
  });

  it('an omitted FX spread fails where a trade can convert, and only there', () => {
    const input: BacktestInput = {
      strategy: { execution: 'same_close', costs: { slippageBps: 0, feePct: 0 } },
      days: decide(['CASH_BASE', 'CASH_BASE']),
      bars: {},
      cashRate: none,
      baseCurrency: 'JPY',
      fxRate: () => 150,
      depositRate: deposit,
    };
    expect(() => backtest(input)).toThrow(/costs not resolved: fxSpreadPct/);
    // Read as 0 only where the caller says so (versions registered before C2, parity).
    expect(backtest({ ...input, omittedCostsAsZero: true }).conversions!.fxSpreadCosts).toBe(0);
    expect(backtest({ ...input, baseCurrency: 'USD' }).points).toHaveLength(2);
    // A strategy that cannot hold CASH_BASE never reads it.
    const x = backtest({
      ...input,
      days: decide(['X', 'X']),
      bars: { X: [bar(D[0]!, 100), bar(D[1]!, 100)] },
    });
    expect(x.points).toHaveLength(2);
  });

  it('whole shares refuse CASH_BASE', () => {
    expect(() =>
      backtest({
        strategy: {
          execution: 'next_open',
          costs,
          safeState: { holdings: [{ ticker: 'CASH_BASE', weight: 100 }] },
        },
        days: decide(['X', 'X']),
        bars: { X: [bar(D[0]!, 100), bar(D[1]!, 100, { open: 100 })] },
        cashRate: none,
        wholeShares: { initialAmount: '1000', currency: 'USD' },
        baseCurrency: 'JPY',
        fxRate: () => 150,
        depositRate: deposit,
      }),
    ).toThrow(/Whole shares are refused with CASH_BASE/);
  });
});

describe('CASH_BASE in a strategy', () => {
  const strategy = (holding: string, operand = 'SPY') => ({
    name: 'Base cash',
    account: 'taxable',
    safeState: { holdings: [{ ticker: holding, weight: 100 }] },
    evaluation: { frequency: 'daily' },
    signals: [
      {
        id: 'up',
        type: 'compare',
        left: { indicator: 'price', ticker: operand, totalReturn: true },
        op: '>',
        right: { indicator: 'sma', ticker: operand, length: 2, totalReturn: true },
      },
    ],
    allocations: [
      { name: 'In', when: { all: ['up'] }, holdings: [{ ticker: 'SPY', weight: 100 }] },
      { name: 'Out', holdings: [{ ticker: holding, weight: 100 }] },
    ],
  });

  it('is a holding without bars or parameters, and never an operand', () => {
    const s = Strategy.parse(strategy('CASH_BASE'));
    expect(strategyTickers(s)).toEqual(['SPY']);
    expect(heldTickers([{ ticker: 'CASH_BASE', weight: 100 }])).toEqual([]);
    for (const t of ['CASH_BASE?L=2', 'CASH_BASE?E=0.1']) {
      const r = Strategy.safeParse(strategy(t));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('CASH_BASE takes no parameters');
    }
    const op = Strategy.safeParse(strategy('CASH_USD', 'CASH_BASE'));
    expect(op.success).toBe(false);
    expect(JSON.stringify(op.error?.issues)).toContain('base-currency cash is a holding only');
  });
});
