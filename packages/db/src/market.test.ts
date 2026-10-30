import type { RawBar } from '@saku/core';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ADJ_CLOSE_ROUNDING,
  groupFactors,
  issuerRecordsOf,
  storeFx,
  storeIssuerRecords,
  storeRawBars,
  seriesPointInTime,
  fxPointInTime,
  storeSeries,
  symbolId,
  upsertSymbols,
} from './market';
import {
  barRevisions,
  barsRaw,
  fxRates,
  issuerRecords,
  readjustments,
  series,
  symbols,
} from './schema';
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

  // A provider sending single-precision floats: each adjusted close as float32 of the exact
  // value, the exact value itself recomputed with a little relative error (deterministic).
  const days = Array.from({ length: 300 }, (_, i) =>
    new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  );
  const wobble = (i: number, seed: number) => 1 + 3e-7 * Math.sin(i * 12.9898 + seed * 78.233);
  const sent = (factorOf: (i: number) => number, seed: number) =>
    days.map((d, i) => {
      const close = 20 + i * 0.37;
      return bar(d, close, {
        providerAdjClose: Math.fround(close * 0.8 * factorOf(i) * wobble(i, seed)),
      });
    });

  it('stores rounding changes of adjusted closes without a re-adjustment event', async () => {
    const { db, id } = await setup();
    const first = sent(() => 1, 1);
    await store(db, id, first, 't1');
    const again = sent(() => 1, 2);
    // Most values differ, by far more than float noise of double precision.
    const moved = again.filter((b, i) => b.providerAdjClose !== first[i]!.providerAdjClose);
    expect(moved.length).toBeGreaterThan(250);
    const result = await store(db, id, again, 't2');
    expect(result).toMatchObject({ inserted: 0, revised: 0, readjustments: 0 });
    expect(await db.select().from(readjustments)).toHaveLength(0);
    expect(await db.select().from(barRevisions)).toHaveLength(0);
    // The latest snapshot is kept all the same.
    const rows = await db.select().from(barsRaw);
    const changed = again.filter(
      (b) => rows.find((r) => r.date === b.date)!.providerAdjClose !== b.providerAdjClose,
    );
    expect(changed).toEqual([]);
  });

  it('keeps a real re-adjustment one event per factor through rounding noise', async () => {
    const { db, id } = await setup();
    await store(
      db,
      id,
      sent(() => 1, 1),
      't1',
    );
    // Two distributions since the last fetch: one going ex on day 100 (0.995), one on day 250
    // (0.99); every earlier adjusted close is rescaled, each value rounded anew.
    const factor = (i: number) => (i < 100 ? 0.995 * 0.99 : i < 250 ? 0.99 : 1);
    const result = await store(db, id, sent(factor, 2), 't2');
    expect(result.readjustments).toBe(2);
    const events = await db.select().from(readjustments);
    expect(events.map((e) => [e.fromDate, e.toDate])).toEqual([
      [days[0], days[99]],
      [days[100], days[249]],
    ]);
    expect(Math.abs(events[0]!.factor / (0.995 * 0.99) - 1)).toBeLessThan(ADJ_CLOSE_ROUNDING);
    expect(Math.abs(events[1]!.factor / 0.99 - 1)).toBeLessThan(ADJ_CLOSE_ROUNDING);
    expect(await db.select().from(barRevisions)).toHaveLength(0);
  });

  it('records a change just above the rounding threshold as a re-adjustment', async () => {
    const { db, id } = await setup();
    const adj = (d: string, a: number) => bar(d, 10, { providerAdjClose: a });
    await store(db, id, [adj('2026-01-02', 10), adj('2026-01-05', 10)], 't1');
    const f = 1 - 2 * ADJ_CLOSE_ROUNDING;
    await store(db, id, [adj('2026-01-02', 10 * f), adj('2026-01-05', 10)], 't2');
    const events = await db.select().from(readjustments);
    expect(events.map((e) => [e.fromDate, e.toDate])).toEqual([['2026-01-02', '2026-01-02']]);
  });

  it('logs a raw close change of rounding size as a revision (raw fields compared exactly)', async () => {
    const { db, id } = await setup();
    await store(db, id, [bar('2026-01-02', 10)], 't1');
    const result = await store(db, id, [bar('2026-01-02', 10 * (1 + 1e-9))], 't2');
    expect(result.revised).toBe(1);
    expect((await db.select().from(barRevisions)).map((r) => r.field)).toEqual(['close']);
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
  it('keeps slowly drifting rounding in one event and splits on a real step', () => {
    const step = ADJ_CLOSE_ROUNDING / 2;
    expect(
      groupFactors([
        { date: 'a', factor: 0.99 },
        { date: 'b', factor: 0.99 * (1 + step) },
        { date: 'c', factor: 0.99 * (1 + 2 * step) },
        { date: 'd', factor: 0.99 * (1 + 3 * step) },
        { date: 'e', factor: 0.99 * (1 + 3 * step) * (1 + 3 * ADJ_CLOSE_ROUNDING) },
      ]),
    ).toEqual([
      { from: 'a', to: 'd', factor: 0.99 },
      { from: 'e', to: 'e', factor: 0.99 * (1 + 3 * step) * (1 + 3 * ADJ_CLOSE_ROUNDING) },
    ]);
  });

  it('is empty for no changes', () => {
    expect(groupFactors([])).toEqual([]);
  });

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
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: 't1' })).toEqual({
      inserted: 2,
      revised: [],
    });
    // A new publication time is a new vintage, not a revision.
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: 't2' })).toEqual({
      inserted: 0,
      revised: [],
    });
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

  it('refuses a time without a zone, and reads old date-only rows as known at the day end', async () => {
    const db = await testDb();
    const zoneless = [{ date: '2026-01-02', value: 3.61, publishedAt: '2026-01-05T18:00' }];
    await expect(
      storeSeries(db, { series: 'S', source: 'x', points: zoneless, fetchedAt: 't1' }),
    ).rejects.toThrow(/zone/);
    // A row stored before times were required (date only).
    await db.insert(series).values({
      series: 'S',
      source: 'x',
      date: '2026-01-02',
      value: 3.61,
      publishedAt: '2026-01-05',
      fetchedAt: 't0',
      knownAt: '2026-01-05',
    });
    const pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-05', '2026-01-05T14:30:00.000Z')).toBeUndefined();
    expect(pit.asOf('2026-01-05', '2026-01-06T05:00:00.000Z')!.value).toBe(3.61);
  });

  it('a series value without a publication time is known from its fetch, never earlier', async () => {
    const db = await testDb();
    const points = [{ date: '2026-01-02', value: 5001.25 }];
    const fetchedAt = '2026-01-07T01:00:00.000Z';
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt })).toEqual({
      inserted: 1,
      revised: [],
    });
    const rows = await db.select().from(series);
    expect(rows.map((r) => [r.publishedAt, r.knownAt])).toEqual([[null, fetchedAt]]);
    const pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-02', '2026-01-07T00:59:59.999Z')).toBeUndefined();
    expect(pit.asOf('2026-01-02', fetchedAt)!.value).toBe(5001.25);
  });

  it('a refetch that reports a stored value differently is a revision: a new row, the old kept', async () => {
    const db = await testDb();
    const at = (h: number) => `2026-01-0${h}T01:00:00.000Z`;
    const points = (v: number) => [
      { date: '2026-01-02', value: v },
      { date: '2026-01-05', value: 10 },
    ];
    await storeSeries(db, { series: 'S', source: 'x', points: points(5001.25), fetchedAt: at(7) });
    // Same values again: nothing stored, nothing revised.
    expect(
      await storeSeries(db, {
        series: 'S',
        source: 'x',
        points: points(5001.25),
        fetchedAt: at(8),
      }),
    ).toEqual({ inserted: 0, revised: [] });
    // One value changed, one new date.
    expect(
      await storeSeries(db, {
        series: 'S',
        source: 'x',
        points: [...points(5002), { date: '2026-01-06', value: 11 }],
        fetchedAt: at(9),
      }),
    ).toEqual({ inserted: 1, revised: [{ item: 'S', date: '2026-01-02' }] });
    const rows = await db.select().from(series).where(eq(series.date, '2026-01-02'));
    expect(rows.map((r) => [r.value, r.knownAt])).toEqual([
      [5001.25, at(7)],
      [5002, at(9)],
    ]);
    const pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-02', at(8))!.value).toBe(5001.25);
    expect(pit.asOf('2026-01-02', at(9))!.value).toBe(5002);
    // A published vintage rewritten (same publication time, another value) is a revision too.
    const vintage = (v: number) => [
      { date: '2026-01-02', value: v, publishedAt: '2026-01-05T23:00:00Z' },
    ];
    await storeSeries(db, { series: 'T', source: 'x', points: vintage(1), fetchedAt: at(7) });
    expect(
      await storeSeries(db, { series: 'T', source: 'x', points: vintage(2), fetchedAt: at(8) }),
    ).toEqual({ inserted: 0, revised: [{ item: 'T', date: '2026-01-02' }] });
  });

  it('without a publication time, a changed value is a new row known from its fetch', async () => {
    const db = await testDb();
    const rate = (r: number) => [{ pair: 'USDXXX', date: '2026-01-02', rate: r }];
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: 't1' });
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: 't2' });
    expect(
      await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(101), fetchedAt: 't3' }),
    ).toEqual({ inserted: 0, revised: [{ item: 'USDXXX', date: '2026-01-02' }] });
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

describe('issuer records', () => {
  const usd = (date: string, nav: number, extra: Record<string, unknown> = {}) => ({
    date,
    nav,
    currency: 'USD',
    ...extra,
  });

  it('adds a row only for new or changed values; reads take the latest per date', async () => {
    const { db, id } = await setup();
    const store = (records: Parameters<typeof storeIssuerRecords>[1]['records'], at: string) =>
      storeIssuerRecords(db, { symbolId: id, source: 'iss', records, fetchedAt: at });
    expect(
      await store([usd('2026-01-02', 100), usd('2026-01-05', 101, { distribution: 0.5 })], 't1'),
    ).toBe(2);
    // Same values again: nothing new. A removed distribution: a new row.
    expect(await store([usd('2026-01-02', 100), usd('2026-01-05', 101)], 't2')).toBe(1);
    expect(await store([usd('2026-01-02', 100.5)], 't3')).toBe(1);
    // The same NAV in another currency is a change too.
    expect(await store([{ date: '2026-01-05', nav: 101, currency: 'EUR' }], 't3')).toBe(1);
    expect(await db.select().from(issuerRecords)).toHaveLength(5);
    const read = await issuerRecordsOf(db, id);
    expect(read.get('iss')).toEqual([
      usd('2026-01-02', 100.5),
      { date: '2026-01-05', nav: 101, currency: 'EUR' },
    ]);
    // Back to an earlier value is a change from the latest: stored again, never overwritten.
    expect(await store([usd('2026-01-02', 100)], 't4')).toBe(1);
    expect((await issuerRecordsOf(db, id)).get('iss')![0]).toEqual(usd('2026-01-02', 100));
    expect((await issuerRecordsOf(db, id, ['other'])).size).toBe(0);
  });

  it('refuses a date twice, a bad date, a value not a number or a NAV without its currency', async () => {
    const { db, id } = await setup();
    const store = (records: Parameters<typeof storeIssuerRecords>[1]['records']) =>
      storeIssuerRecords(db, { symbolId: id, source: 'iss', records, fetchedAt: 't' });
    await expect(store([usd('2026-01-02', 1), usd('2026-01-02', 2)])).rejects.toThrow(
      /same date twice/,
    );
    await expect(store([usd('01/02/2026', 1)])).rejects.toThrow(/YYYY-MM-DD/);
    await expect(store([usd('2026-01-02', NaN)])).rejects.toThrow(/nav/);
    await expect(store([{ date: '2026-01-02', split: '2' as unknown as number }])).rejects.toThrow(
      /split/,
    );
    await expect(store([{ date: '2026-01-02', nav: 1 }])).rejects.toThrow(/without its currency/);
    await expect(store([{ date: '2026-01-02', nav: 1, currency: 'usd' }])).rejects.toThrow(
      /ISO 4217/,
    );
    expect(await db.select().from(issuerRecords)).toHaveLength(0);
    expect(await store([])).toBe(0);
    // Events without a NAV need no currency.
    expect(await store([{ date: '2026-01-02', distribution: 0.2 }])).toBe(1);
  });
});
