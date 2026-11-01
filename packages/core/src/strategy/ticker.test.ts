// The one ticker grammar (spec 2026-11-01 ticker-grammar; docs/indicators.md "Synthetic
// leverage"): the schema, the backtest and the metrics read a ticker the same way, and a
// malformed one is refused everywhere (never a silent 0 or NaN).
import { describe, expect, it } from 'vitest';
import { metrics } from '../analytics/metrics';
import type { RawBar } from '../domain';
import { backtest } from './backtest';
import type { StrategyDay } from './engine';
import { Strategy } from './schema';
import { parseTicker, tickerProblem } from './ticker';

/** Malformed tickers: the forms the spec lists, and the grammar's other edges. */
const MALFORMED: [string, string][] = [
  ['X?L=', 'L without a number (Number("") would read 0)'],
  ['X?L', 'L without "="'],
  ['X?L=0x3', 'hex'],
  ['X?L=1e1', 'exponent'],
  ['X?L=1E1', 'exponent, upper case'],
  ['X?L=%33', 'URL escape'],
  ['X?L=+3', 'plus sign'],
  ['X?L=.5', 'no digit before the point'],
  ['X?L=3.', 'no digit after the point'],
  ['X?L= 3', 'space before the value'],
  ['X?L=3 ', 'space after the value'],
  ['X ?L=3', 'space in the base'],
  ['X?L=2&L=3', 'L twice'],
  ['X?E=1&E=2', 'E twice'],
  ['X?l=2', 'lower-case key'],
  ['X?K=2', 'unknown key'],
  ['X?L=2&', 'trailing "&"'],
  ['X?&L=2', 'leading "&"'],
  ['X?', 'empty query'],
  ['X?L=2?E=1', 'second "?"'],
  ['?L=2', 'no base'],
  ['', 'empty'],
  ['X?L=0', 'L of 0'],
  ['X?L=0.0', 'L of 0, with a point'],
  ['X?L=-1', 'L below 0 (a short synthetic is not in the requirements)'],
  ['X?L=-0', 'L of negative 0'],
  ['X?E=-0.1', 'E below 0'],
  [`X?L=${'9'.repeat(400)}`, 'L not finite'],
  ['X?L=Infinity', 'Infinity spelled out'],
  ['X?L=NaN', 'NaN spelled out'],
  ['CASH_USD?L=2', 'parameters on cash'],
  ['CASH_USD?E=0.1', 'expense on cash'],
  ['X%20Y', 'URL escape in the base'],
];

describe('ticker grammar', () => {
  it('reads well-formed tickers as before', () => {
    expect(parseTicker('SPY')).toEqual({ base: 'SPY', leverage: 1, expensePct: 0 });
    expect(parseTicker('SPY?L=3&E=0.9')).toEqual({ base: 'SPY', leverage: 3, expensePct: 0.9 });
    expect(parseTicker('SPY?E=0.9&L=3')).toEqual({ base: 'SPY', leverage: 3, expensePct: 0.9 });
    expect(parseTicker('UPRO?L=2.5')).toEqual({ base: 'UPRO', leverage: 2.5, expensePct: 0 });
    expect(parseTicker('TLT?E=0.2')).toEqual({ base: 'TLT', leverage: 1, expensePct: 0.2 });
    expect(parseTicker('X?L=0.5&E=0')).toEqual({ base: 'X', leverage: 0.5, expensePct: 0 });
    expect(parseTicker('CASH_USD')).toEqual({ base: 'CASH_USD', leverage: 1, expensePct: 0 });
    expect(parseTicker('BRK.B')).toEqual({ base: 'BRK.B', leverage: 1, expensePct: 0 });
    expect(parseTicker('^GSPC')).toEqual({ base: '^GSPC', leverage: 1, expensePct: 0 });
  });

  it('reads E=-0 as 0, never a negative zero', () => {
    expect(Object.is(parseTicker('X?E=-0').expensePct, 0)).toBe(true);
  });

  it.each(MALFORMED)('refuses %j (%s): parseTicker throws, tickerProblem names it', (t) => {
    expect(() => parseTicker(t)).toThrow(/Malformed ticker/);
    expect(tickerProblem(t)).toEqual(expect.any(String));
  });

  it('tickerProblem is undefined for a well-formed ticker', () => {
    for (const t of ['SPY', 'SPY?L=3&E=0.9', 'CASH_USD', 'X?L=00003']) {
      expect(tickerProblem(t)).toBeUndefined();
    }
  });
});

const strategy = (held: string, read = 'AAA', safe = 'CASH_USD') => ({
  name: 'S',
  account: 'taxable',
  safeState: { holdings: [{ ticker: safe, weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'up',
      type: 'compare',
      left: { indicator: 'price', ticker: read, totalReturn: true },
      op: '>',
      right: { indicator: 'sma', ticker: read, length: 10, totalReturn: true },
    },
  ],
  allocations: [
    { name: 'In', when: { all: ['up'] }, holdings: [{ ticker: held, weight: 100 }] },
    { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  ],
});

describe('the strategy schema refuses a malformed ticker at parse', () => {
  it.each(MALFORMED)('in a holding: %j (%s), with its path and reason', (t) => {
    const r = Strategy.safeParse(strategy(t));
    expect(r.success).toBe(false);
    const issue = r.error!.issues.find(
      (i) => i.path.join('.') === 'allocations.0.holdings.0.ticker',
    );
    expect(issue?.message).toBe(tickerProblem(t));
  });

  it('in the safe state and in an operand, with their paths', () => {
    const safe = Strategy.safeParse(strategy('AAA', 'AAA', 'X?L='));
    expect(safe.error!.issues.map((i) => i.path.join('.'))).toEqual([
      'safeState.holdings.0.ticker',
    ]);
    const read = Strategy.safeParse(strategy('AAA', 'X?L=1e1'));
    expect(read.error!.issues.map((i) => i.path.join('.')).sort()).toEqual([
      'signals.0.left.ticker',
      'signals.0.right.ticker',
    ]);
  });

  it('refuses parameters on an operand ticker (an indicator reads the plain ticker)', () => {
    for (const t of ['AAA?L=3', 'AAA?E=0.9', 'AAA?L=1']) {
      const r = Strategy.safeParse(strategy('AAA', t));
      expect(r.success).toBe(false);
      const issues = r.error!.issues;
      expect(issues.map((i) => i.path.join('.')).sort()).toEqual([
        'signals.0.left.ticker',
        'signals.0.right.ticker',
      ]);
      for (const i of issues) expect(i.message).toMatch(/holdings only\. Use "AAA"/);
    }
    // A malformed operand ticker gets the grammar's reason once, not the parameter message too.
    const bad = Strategy.safeParse(strategy('AAA', 'AAA?L='));
    expect(bad.error!.issues.map((i) => i.message)).toEqual([
      tickerProblem('AAA?L='),
      tickerProblem('AAA?L='),
    ]);
    // Parameters on a holding stay accepted.
    expect(Strategy.safeParse(strategy('AAA?L=3&E=0.9', 'AAA')).success).toBe(true);
  });

  it('accepts well-formed tickers', () => {
    for (const t of ['AAA', 'AAA?L=3&E=0.9', 'AAA?E=0.9&L=3', 'CASH_USD']) {
      expect(Strategy.safeParse(strategy(t)).success).toBe(true);
    }
  });
});

describe('the backtest and the metrics read the same grammar', () => {
  it('the backtest throws on a malformed holding rather than hold it at a guessed leverage', () => {
    const D = ['2026-01-05', '2026-01-06'];
    const bar = (date: string, close: number): RawBar => ({
      date,
      close,
      closeIsSplitAdjusted: false,
      divCash: 0,
      splitFactor: 1,
    });
    const days: StrategyDay[] = D.map((date) => ({
      date,
      signals: {},
      allocation: 'In',
      holdings: [{ ticker: 'X?L=', weight: 100 }],
      ties: [],
    }));
    expect(() =>
      backtest({
        strategy: { execution: 'same_close', costs: {} },
        days,
        bars: { X: [bar(D[0]!, 100), bar(D[1]!, 101)] },
        cashRate: () => 2,
      }),
    ).toThrow(/Malformed ticker/);
  });

  it.each(MALFORMED)('average exposure of %j (%s) is holdingsMissing, never a number', (t) => {
    const points = [
      { date: '2024-01-01', equity: 1, traded: true, weights: { SPY: 1 } },
      { date: '2024-01-02', equity: 1, traded: false, weights: { [t]: 1 } },
      { date: '2024-01-03', equity: 1, traded: false, weights: { SPY: 1 } },
    ];
    expect(metrics({ points }).averageExposure).toEqual({ ok: false, reason: 'holdingsMissing' });
  });
});
