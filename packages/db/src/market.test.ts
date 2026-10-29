import type { RawBar } from '@saku/core';
import { describe, expect, it } from 'vitest';
import {
  groupFactors,
  storeFx,
  storeRawBars,
  seriesPointInTime,
  fxPointInTime,
  storeSeries,
  symbolId,
  upsertSymbols,
} from './market';
import { barRevisions, barsRaw, fxRates, readjustments, series, symbols } from './schema';
import { testDb } from './testing';

const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    {
      ticker: 'AAA2',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      leverageFactor: 2,
      underlying: 'AAA',
    },
  ]);
  return { db, id: (await symbolId(db, 'AAA'))! };
}

const store = (
  db: Awaited<ReturnType<typeof testDb>>,
  symbolId: number,
  bars: RawBar[],
  at: string,
) => storeRawBars(db, { symbolId, source: 'example', bars, runId: null, fetchedAt: at });

describe('symbols', () => {
  it('links a leveraged fund to its underlying and refuses an unknown one', async () => {
    const { db, id } = await setup();
    const rows = await db.select().from(symbols);
    expect(rows.find((r) => r.ticker === 'AAA2')).toMatchObject({
      leverageFactor: 2,
      underlyingSymbolId: id,
    });
    await expect(
      upsertSymbols(db, [
        { ticker: 'X', tier: 0, assetClass: 'equity', currency: 'USD', underlying: 'NOPE' },
      ]),
    ).rejects.toThrow(/Unknown symbol/);
  });
});

describe('storeRawBars', () => {
  it('inserts new dates and logs every changed raw field before updating', async () => {
    const { db, id } = await setup();
    expect(await store(db, id, [bar('2026-01-02', 10), bar('2026-01-05', 11)], 't1')).toMatchObject(
      {
        inserted: 2,
        revised: 0,
      },
    );
    const again = await store(
      db,
      id,
      [bar('2026-01-02', 10), bar('2026-01-05', 11.5, { divCash: 0.1 })],
      't2',
    );
    expect(again).toMatchObject({ inserted: 0, revised: 1 });
    const revs = await db.select().from(barRevisions);
    expect(revs.map((r) => [r.date, r.field, r.oldValue, r.newValue, r.detectedAt])).toEqual([
      ['2026-01-05', 'close', 11, 11.5, 't2'],
      ['2026-01-05', 'div_cash', 0, 0.1, 't2'],
    ]);
    const rows = await db.select().from(barsRaw);
    expect(rows.find((r) => r.date === '2026-01-05')).toMatchObject({
      close: 11.5,
      fetchedAt: 't2',
    });
  });

  it('records one re-adjustment event per factor, not one revision per day', async () => {
    const { db, id } = await setup();
    const adj = (d: string, c: number, a: number) => bar(d, c, { providerAdjClose: a });
    await store(
      db,
      id,
      [adj('2026-01-02', 10, 9), adj('2026-01-05', 11, 9.9), adj('2026-01-06', 12, 12)],
      't1',
    );
    // A dividend on 01-06 rescales the provider's earlier adjusted closes by 0.99.
    await store(
      db,
      id,
      [adj('2026-01-02', 10, 8.91), adj('2026-01-05', 11, 9.801), adj('2026-01-06', 12, 12)],
      't2',
    );
    expect(await db.select().from(barRevisions)).toHaveLength(0);
    const events = await db.select().from(readjustments);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromDate: '2026-01-02', toDate: '2026-01-05' });
    expect(events[0]!.factor).toBeCloseTo(0.99, 12);
  });

  it('reports stored dates the source stopped returning, and keeps them', async () => {
    const { db, id } = await setup();
    await store(
      db,
      id,
      [bar('2026-01-02', 10), bar('2026-01-05', 11), bar('2026-01-06', 12)],
      't1',
    );
    const result = await store(db, id, [bar('2026-01-02', 10), bar('2026-01-06', 12)], 't2');
    expect(result.missing).toEqual(['2026-01-05']);
    expect(await db.select().from(barsRaw)).toHaveLength(3);
  });

  it('refuses a date sent twice', async () => {
    const { db, id } = await setup();
    await expect(
      store(db, id, [bar('2026-01-02', 10), bar('2026-01-02', 10)], 't1'),
    ).rejects.toThrow(/twice/);
  });
});

describe('groupFactors', () => {
  it('splits on a different factor', () => {
    expect(
      groupFactors([
        { date: 'a', factor: 0.99 },
        { date: 'b', factor: 0.99 * (1 + 1e-12) },
        { date: 'c', factor: 0.5 },
      ]),
    ).toEqual([
      { from: 'a', to: 'b', factor: 0.99 },
      { from: 'c', to: 'c', factor: 0.5 },
    ]);
  });
});

describe('vintages', () => {
  it('keeps every published version of a series value, and only new ones', async () => {
    const db = await testDb();
    const points = [
      { date: '2026-01-02', value: 3.61, publishedAt: '2026-01-05T23:00:00Z' },
      { date: '2026-01-02', value: 3.62, publishedAt: '2026-01-07T18:00:00-05:00' },
    ];
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: 't1' })).toBe(2);
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: 't2' })).toBe(0);
    expect(await db.select().from(series)).toHaveLength(2);
    const pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-02', '2026-01-06')!.value).toBe(3.61);
    expect(pit.asOf('2026-01-02', '2026-01-08')!.value).toBe(3.62);
    // Stored as UTC text, so string comparison is time comparison.
    expect(pit.asOf('2026-01-02', '2026-01-07T22:59:00.000Z')!.value).toBe(3.61);
  });

  it('refuses a publication date without a time of day (it would read as midnight)', async () => {
    const db = await testDb();
    const points = [{ date: '2026-01-02', value: 3.61, publishedAt: '2026-01-05' }];
    await expect(
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: 't1' }),
    ).rejects.toThrow(/time of day/);
  });

  it('without a publication time, a changed value is a new row known from its fetch', async () => {
    const db = await testDb();
    const rate = (r: number) => [{ pair: 'USDXXX', date: '2026-01-02', rate: r }];
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: 't1' });
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: 't2' });
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(101), fetchedAt: 't3' });
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: 't4' });
    const rows = await db.select().from(fxRates);
    expect(rows.map((r) => [r.rate, r.knownAt])).toEqual([
      [100, 't1'],
      [101, 't3'],
      [100, 't4'],
    ]);
    const pit = await fxPointInTime(db, 'USDXXX', 'x');
    expect(pit.asOf('2026-01-02', 't3x')!.value).toBe(101);
  });
});
