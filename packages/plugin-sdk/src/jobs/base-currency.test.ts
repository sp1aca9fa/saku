// A backtest's base-currency inputs from the database (spec 2026-11-02 base-currency;
// docs/indicators.md "Base currency", "Base-currency cash") and the forward equity of a version
// that may hold CASH_BASE.
import { type RawBar, type StrategyDay, Strategy } from '@saku/core';
import { addDepositRate, schema, setSetting, storeFx } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { baseCurrencyInputs } from './base-currency';
import { forwardEquity } from './forward';

const D = ['2026-01-05', '2026-01-06', '2026-01-07'] as const;
const now = new Date('2026-01-09T12:00:00Z');

async function install(o: { fx?: boolean } = {}) {
  const db = await testDb();
  await setSetting(db, 'base_currency', 'XXX');
  await addDepositRate(db, { ratePct: '2.52', from: D[0], currency: 'XXX' }, { now });
  if (o.fx !== false) {
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 });
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: [
        // Published the evening before each date (New York): known before its open.
        { pair: 'USDXXX', date: D[0], rate: 150, publishedAt: '2026-01-04T21:00:00Z' },
        { pair: 'USDXXX', date: D[1], rate: 151, publishedAt: '2026-01-05T21:00:00Z' },
        // Published after D2's open (09:30 New York = 14:30 UTC): D2 reads D1's rate.
        { pair: 'USDXXX', date: D[2], rate: 152, publishedAt: '2026-01-07T15:00:00Z' },
        // Another pair and another source are never read.
        { pair: 'USDYYY', date: D[2], rate: 9, publishedAt: '2026-01-06T21:00:00Z' },
      ],
      fetchedAt: '2026-01-08T00:00:00Z',
    });
    await storeFx(db, {
      source: 'other',
      kind: 'valuation',
      rates: [{ pair: 'USDXXX', date: D[2], rate: 1, publishedAt: '2026-01-06T21:00:00Z' }],
      fetchedAt: '2026-01-08T00:00:00Z',
    });
  }
  return db;
}

describe('baseCurrencyInputs', () => {
  it('nothing without base_currency', async () => {
    expect(await baseCurrencyInputs(await testDb())).toEqual({});
  });

  it('FX from the primary source, as known before the open; the deposit rate in force', async () => {
    const r = await baseCurrencyInputs(await install());
    expect(r.baseCurrency).toBe('XXX');
    expect(r.fxRate!('2026-01-02')).toBeUndefined();
    expect(D.map((d) => r.fxRate!(d))).toEqual([150, 151, 151]);
    expect(r.depositRate!('2026-01-02')).toBeUndefined();
    expect(r.depositRate!(D[2])).toBe(2.52);
  });

  it('no primary FX source: unknown on every date, never a guess', async () => {
    const r = await baseCurrencyInputs(await install({ fx: false }));
    expect(D.map((d) => r.fxRate!(d))).toEqual([undefined, undefined, undefined]);
  });

  it('an invalid stored deposit rate fails the read with the reason, never used', async () => {
    const db = await install();
    await db
      .insert(schema.depositRates)
      .values({ ratePct: '0,5', fromDate: D[2], currency: 'XXX', actor: 't' });
    const r = await baseCurrencyInputs(db);
    expect(r.depositRate!(D[1])).toBe(2.52);
    expect(() => r.depositRate!(D[2])).toThrow(/deposit rate in force on 2026-01-07 is invalid/);
  });
});

const bar = (date: string, open: number, close: number): RawBar => ({
  date,
  open,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
});
const bars = { AAA: [bar(D[0], 100, 100), bar(D[1], 100, 110), bar(D[2], 110, 121)] };
const day = (date: string, ticker: string): StrategyDay => ({
  date,
  signals: {},
  allocation: ticker,
  holdings: [{ ticker, weight: 100 }],
  ties: [],
});
const strategy = (out: string) =>
  Strategy.parse({
    name: 'S',
    account: 'taxable',
    execution: 'next_open',
    safeState: { holdings: [{ ticker: out, weight: 100 }] },
    evaluation: { frequency: 'daily' },
    costs: { slippageBps: 0, feePct: 0, fxSpreadPct: 0.5 },
    signals: [],
    allocations: [{ name: 'All', holdings: [{ ticker: 'AAA', weight: 100 }] }],
  });

describe('forwardEquity with CASH_BASE', () => {
  it('reads the base inputs for a version that may hold CASH_BASE', async () => {
    const base = await baseCurrencyInputs(await install());
    const s = strategy('CASH_BASE');
    const prior = [day(D[0], 'CASH_BASE'), day(D[1], 'CASH_BASE')];
    const problems: string[] = [];
    const e = forwardEquity(
      s,
      prior,
      bars,
      () => 0,
      day(D[2], 'CASH_BASE'),
      false,
      undefined,
      base,
    );
    // Entered at D1's open (the spread on 100% converted), then one day's deposit rate and the
    // FX move D1 -> D2 (151 -> 151, D2's own rate not yet known at its open).
    expect(e).toBeCloseTo((1 - 0.005) * 1.0001, 14);
    // Without the base inputs the equity is unknown, with the reason.
    expect(
      forwardEquity(
        s,
        prior,
        bars,
        () => 0,
        day(D[2], 'CASH_BASE'),
        false,
        (r) => problems.push(r),
      ),
    ).toBeNull();
    expect(problems).toEqual([
      'CASH_BASE needs the base currency: the strategy may hold it and no base currency is given.',
    ]);
  });

  it('a USD-only version never reads FX: its equity does not depend on it', () => {
    const throwing = {
      baseCurrency: 'XXX',
      fxRate: () => {
        throw new Error('FX read');
      },
      depositRate: () => {
        throw new Error('deposit read');
      },
    };
    const s = strategy('CASH_USD');
    const prior = [day(D[0], 'AAA'), day(D[1], 'AAA')];
    const plain = forwardEquity(s, prior, bars, () => 0, day(D[2], 'AAA'), false);
    expect(
      forwardEquity(s, prior, bars, () => 0, day(D[2], 'AAA'), false, undefined, throwing),
    ).toBe(plain);
    expect(plain).toBeCloseTo(1.21, 14);
  });
});
