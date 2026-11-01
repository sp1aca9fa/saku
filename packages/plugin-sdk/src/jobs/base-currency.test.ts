// A backtest's base-currency inputs from the database (spec 2026-11-02 base-currency;
// docs/indicators.md "Base currency", "Base-currency cash") and the forward equity of a version
// that may hold CASH_BASE.
import { type RawBar, type StrategyDay, Strategy } from '@saku/core';
import { Sessions } from '@saku/data';
import { addDepositRate, schema, setSetting, startRun, storeFx } from '@saku/db';
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

describe('the forward record reads the deposit rate point in time', () => {
  it('a 0.1% rate corrected to 0.5% later: the earlier day computes as it did', async () => {
    const db = await testDb();
    await setSetting(db, 'base_currency', 'XXX');
    // Entered before the days it covers; corrected after D2's read (09:30 New York, 14:30 UTC).
    const [row] = await db
      .insert(schema.depositRates)
      .values({
        ratePct: '0.1',
        fromDate: D[0],
        currency: 'XXX',
        actor: 't',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      .returning();
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 });
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: D.map((date) => ({
        pair: 'USDXXX',
        date,
        rate: 150,
        publishedAt: '2026-01-01T00:00:00Z',
      })),
      fetchedAt: '2026-01-02T00:00:00Z',
    });
    const s = strategy('CASH_BASE');
    const days = D.map((d) => day(d, 'CASH_BASE'));
    // The record's D2 entry: CASH_BASE entered at D1's open, one day at 0.1% on D2.
    const run = async (o: { pointInTime: boolean }) =>
      forwardEquity(
        s,
        days.slice(0, 2),
        bars,
        () => 0,
        days[2]!,
        false,
        undefined,
        await baseCurrencyInputs(db, o),
      );
    const recorded = await run({ pointInTime: true });
    expect(recorded).toBeCloseTo((1 - 0.005) * (1 + 0.1 / 100 / 252), 15);
    await db.insert(schema.depositRateRevisions).values({
      entryId: row!.id,
      oldRatePct: '0.1',
      newRatePct: '0.5',
      reason: 'bank letter',
      actor: 't',
      createdAt: '2026-01-07T20:00:00.000Z',
    });
    // Recomputed after the correction: D2 still reads 0.1% (what was known at its read).
    expect(await run({ pointInTime: true })).toBe(recorded);
    // The next day reads the corrected 0.5%; a draft (latest reading) reads it on D2 too.
    expect((await baseCurrencyInputs(db, { pointInTime: true })).depositRate!('2026-01-08')).toBe(
      0.5,
    );
    expect(await run({ pointInTime: false })).toBeCloseTo((1 - 0.005) * (1 + 0.5 / 100 / 252), 15);
    // A rate entered after the days it covers is unknown on them: no equity, with the reason.
    const later = await testDb();
    await setSetting(later, 'base_currency', 'XXX');
    await addDepositRate(later, { ratePct: '0.1', from: D[0], currency: 'XXX' }, { now });
    const r = await baseCurrencyInputs(later, { pointInTime: true });
    expect(r.depositRate!(D[2])).toBeUndefined();
    expect((await baseCurrencyInputs(later)).depositRate!(D[2])).toBe(0.1);
  });
});

describe('the forward record refuses a stale or disputed FX', () => {
  const sessions = new Sessions({
    id: 't',
    version: 't',
    validFrom: '2025-01-01',
    validTo: '2026-12-31',
    holidays: [],
  });
  const W = sessions.between('2026-01-05', '2026-01-16');

  async function withFx(dates: readonly string[]) {
    const db = await testDb();
    await setSetting(db, 'base_currency', 'XXX');
    await db.insert(schema.depositRates).values({
      ratePct: '2.52',
      fromDate: W[0]!,
      currency: 'XXX',
      actor: 't',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 });
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: dates.map((date) => ({
        pair: 'USDXXX',
        date,
        rate: 150,
        publishedAt: '2026-01-01T00:00:00Z',
      })),
      fetchedAt: '2026-01-02T00:00:00Z',
    });
    return db;
  }
  const guarded = (db: Awaited<ReturnType<typeof testDb>>) =>
    baseCurrencyInputs(db, { pointInTime: true, guard: { sessions } });
  const longBars = { AAA: W.map((d) => bar(d, 100, 100)) };
  const held = (upTo: number) => W.slice(0, upTo + 1).map((d) => day(d, 'CASH_BASE'));

  it('more than MAX_STALE_DAYS sessions behind at the read: refused, with the reason', async () => {
    // The last rate is W[0]'s: W[6] reads it 5 sessions behind (allowed), W[7] 6 (refused).
    const db = await withFx([W[0]!]);
    const base = await guarded(db);
    expect(base.fxRate!(W[6]!)).toBe(150);
    expect(base.fxRate!(W[7]!)).toBeUndefined();
    expect(base.fxProblem!(W[7]!)).toBe(
      `USDXXX is stale: its last value (${W[0]}) is 6 sessions behind ${W[7]}`,
    );
    const problems: string[] = [];
    const s = strategy('CASH_BASE');
    const days = held(7);
    expect(
      forwardEquity(
        s,
        days.slice(0, -1),
        longBars,
        () => 0,
        days.at(-1)!,
        false,
        (r) => problems.push(r),
        base,
      ),
    ).toBeNull();
    expect(problems).toEqual([
      `No FX rate (USDXXX) known for ${W[7]}: CASH_BASE is held. (USDXXX is stale: its last value (${W[0]}) is 6 sessions behind ${W[7]})`,
    ]);
    // Unguarded (drafts, integrity) the same value is read: asOf alone bounds by observations.
    expect((await baseCurrencyInputs(db)).fxRate!(W[7]!)).toBe(150);
    // A USD-only version is not touched.
    const usd = strategy('CASH_USD');
    const plain = W.slice(0, 8).map((d) => day(d, 'AAA'));
    expect(
      forwardEquity(
        usd,
        plain.slice(0, -1),
        longBars,
        () => 0,
        plain.at(-1)!,
        false,
        undefined,
        base,
      ),
    ).toBe(1);
  });

  it('a rate the cross-check graded red (fx_match): refused, with the source', async () => {
    const db = await withFx(W);
    const runId = await startRun(db, 'daily');
    const result = (status: 'green' | 'red', source: string) => ({
      runId,
      layer: 'B' as const,
      checkName: 'fx_match',
      symbolId: null,
      source,
      date: W[2]!,
      status,
    });
    await db.insert(schema.checkResults).values([result('green', 'fs1'), result('red', 'fs2')]);
    const base = await guarded(db);
    expect(base.fxRate!(W[1]!)).toBe(150);
    // W[2]'s own rate is known before its open here (published long before).
    expect(base.fxRate!(W[2]!)).toBeUndefined();
    expect(base.fxProblem!(W[2]!)).toBe(`USDXXX of ${W[2]} disagrees with fs2 (fx_match red)`);
    const s = strategy('CASH_BASE');
    const days = held(3);
    const problems: string[] = [];
    expect(
      forwardEquity(
        s,
        days.slice(0, -1),
        longBars,
        () => 0,
        days.at(-1)!,
        false,
        (r) => problems.push(r),
        base,
      ),
    ).toBeNull();
    expect(problems[0]).toMatch(/fx_match red/);
    // A later run's green grade for the same source clears it.
    await db.insert(schema.checkResults).values(result('green', 'fs2'));
    expect((await guarded(db)).fxRate!(W[2]!)).toBe(150);
  });
});
