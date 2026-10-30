import type { RawBar } from '@saku/core';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_ADJ_CLOSE_ROUNDING,
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
  fxWithdrawals,
  readjustments,
  series,
  seriesWithdrawals,
  symbols,
} from './schema';
import { testDb } from './testing';

/** Fetch times (UTC ISO, as the jobs pass them), after every publication time the tests use. */
const [T1, T2, T3, T4] = [1, 2, 3, 4].map((n) => `2026-02-0${n}T01:00:00.000Z`) as [
  string,
  string,
  string,
  string,
];

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
  adjCloseRounding?: number,
) =>
  storeRawBars(db, {
    symbolId,
    source: 'example',
    bars,
    runId: null,
    fetchedAt: at,
    ...(adjCloseRounding !== undefined && { adjCloseRounding }),
  });

/** A source declaring single-precision rounding of its adjusted closes. */
const ROUNDING = 1e-6;

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
  // value, the exact value itself recomputed with a relative error of at most 1.5e-7
  // (deterministic). A ratio is then within 4.2e-7 of the true factor, two ratios within 8.4e-7:
  // inside the declared 1e-6.
  const days = Array.from({ length: 300 }, (_, i) =>
    new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  );
  const wobble = (i: number, seed: number) => 1 + 1.5e-7 * Math.sin(i * 12.9898 + seed * 78.233);
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
    await store(db, id, first, 't1', ROUNDING);
    const again = sent(() => 1, 2);
    // Most values differ, by far more than float noise of double precision.
    const moved = again.filter((b, i) => b.providerAdjClose !== first[i]!.providerAdjClose);
    expect(moved.length).toBeGreaterThan(250);
    const result = await store(db, id, again, 't2', ROUNDING);
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
    const result = await store(db, id, sent(factor, 2), 't2', ROUNDING);
    expect(result.readjustments).toBe(2);
    const events = await db.select().from(readjustments);
    expect(events.map((e) => [e.fromDate, e.toDate])).toEqual([
      [days[0], days[99]],
      [days[100], days[249]],
    ]);
    expect(Math.abs(events[0]!.factor / (0.995 * 0.99) - 1)).toBeLessThan(ROUNDING);
    expect(Math.abs(events[1]!.factor / 0.99 - 1)).toBeLessThan(ROUNDING);
    expect(await db.select().from(barRevisions)).toHaveLength(0);
  });

  it('records a change just above the rounding threshold as a re-adjustment', async () => {
    const { db, id } = await setup();
    const adj = (d: string, a: number) => bar(d, 10, { providerAdjClose: a });
    await store(db, id, [adj('2026-01-02', 10), adj('2026-01-05', 10)], 't1', ROUNDING);
    const f = 1 - 2 * ROUNDING;
    await store(db, id, [adj('2026-01-02', 10 * f), adj('2026-01-05', 10)], 't2', ROUNDING);
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

  it('without a declared rounding, the default records the same noise as events', async () => {
    const { db, id } = await setup();
    await store(
      db,
      id,
      sent(() => 1, 1),
      't1',
    );
    expect(
      (
        await store(
          db,
          id,
          sent(() => 1, 2),
          't2',
        )
      ).readjustments,
    ).toBeGreaterThan(0);
    expect(DEFAULT_ADJ_CLOSE_ROUNDING).toBe(1e-9);
  });

  it('refuses a declared rounding that is not a small positive number', async () => {
    const { db, id } = await setup();
    for (const bad of [0, -1e-6, 2e-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store(db, id, [bar('2026-01-02', 10)], 't1', bad)).rejects.toThrow(
        /adjCloseRounding/,
      );
    }
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
  it('compares each date with the event factor: small steps adding up past it split', () => {
    const step = 0.6 * ROUNDING;
    expect(
      groupFactors(
        [
          { date: 'a', factor: 0.99 },
          { date: 'b', factor: 0.99 * (1 + step) },
          { date: 'c', factor: 0.99 * (1 + 2 * step) },
          { date: 'd', factor: 0.99 * (1 + 3 * step) },
        ],
        ROUNDING,
      ),
    ).toEqual([
      { from: 'a', to: 'b', factor: 0.99 },
      { from: 'c', to: 'd', factor: 0.99 * (1 + 2 * step) },
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
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: T1 })).toEqual({
      inserted: 2,
      revised: [],
      withdrawn: [],
    });
    // A new publication time is a new vintage, not a revision.
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: T2 })).toEqual({
      inserted: 0,
      revised: [],
      withdrawn: [],
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
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: T1 }),
    ).rejects.toThrow(/time of day/);
  });

  it('refuses a time without a zone, and reads old date-only rows as known at the day end', async () => {
    const db = await testDb();
    const zoneless = [{ date: '2026-01-02', value: 3.61, publishedAt: '2026-01-05T18:00' }];
    await expect(
      storeSeries(db, { series: 'S', source: 'x', points: zoneless, fetchedAt: T1 }),
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
      withdrawn: [],
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
    ).toEqual({ inserted: 0, revised: [], withdrawn: [] });
    // One value changed, one new date.
    expect(
      await storeSeries(db, {
        series: 'S',
        source: 'x',
        points: [...points(5002), { date: '2026-01-06', value: 11 }],
        fetchedAt: at(9),
      }),
    ).toEqual({ inserted: 1, revised: [{ item: 'S', date: '2026-01-02' }], withdrawn: [] });
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
    ).toEqual({ inserted: 0, revised: [{ item: 'T', date: '2026-01-02' }], withdrawn: [] });
  });

  it('without a publication time, a changed value is a new row known from its fetch', async () => {
    const db = await testDb();
    const rate = (r: number) => [{ pair: 'USDXXX', date: '2026-01-02', rate: r }];
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: T1 });
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: T2 });
    expect(
      await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(101), fetchedAt: T3 }),
    ).toEqual({ inserted: 0, revised: [{ item: 'USDXXX', date: '2026-01-02' }], withdrawn: [] });
    await storeFx(db, { source: 'x', kind: 'valuation', rates: rate(100), fetchedAt: T4 });
    const rows = await db.select().from(fxRates);
    expect(rows.map((r) => [r.rate, r.knownAt])).toEqual([
      [100, T1],
      [101, T3],
      [100, T4],
    ]);
    const pit = await fxPointInTime(db, 'USDXXX', 'x');
    expect(pit.asOf('2026-01-02', T3)!.value).toBe(101);
    expect(pit.asOf('2026-01-02', T4)!.value).toBe(100);
  });
});

describe('withdrawn values', () => {
  const pub = (d: string) => `${d}T23:00:00.000Z`;
  const value = (date: string, v: number, at: string) => ({ date, value: v, publishedAt: pub(at) });
  const gone = (date: string, at: string) => ({
    date,
    withdrawn: true as const,
    publishedAt: pub(at),
  });

  it('stores a withdrawal once, keeps the old value, and reads it point in time', async () => {
    const db = await testDb();
    const points = [
      value('2026-01-02', 3.61, '2026-01-05'),
      value('2026-01-05', 3.6, '2026-01-06'),
      gone('2026-01-05', '2026-01-08'),
    ];
    const store = (fetchedAt: string) =>
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt });
    expect(await store(T1)).toEqual({
      inserted: 2,
      revised: [{ item: 'S', date: '2026-01-05' }],
      withdrawn: [{ item: 'S', date: '2026-01-05' }],
    });
    // Refetch: nothing new, nothing reported (idempotent).
    expect(await store(T2)).toEqual({ inserted: 0, revised: [], withdrawn: [] });
    expect(await db.select().from(series)).toHaveLength(2);
    const rows = await db.select().from(seriesWithdrawals);
    expect(rows.map((r) => [r.date, r.knownAt, r.fetchedAt])).toEqual([
      ['2026-01-05', pub('2026-01-08'), T1],
    ]);
    const pit = await seriesPointInTime(db, 'S', 'x');
    // Before the withdrawal: the old value. From it on: 01-05 has none, the read looks back.
    expect(pit.asOf('2026-01-05', pub('2026-01-07'))).toMatchObject({
      date: '2026-01-05',
      value: 3.6,
    });
    expect(pit.asOf('2026-01-05', pub('2026-01-08'))).toMatchObject({
      date: '2026-01-02',
      value: 3.61,
    });
    expect(pit.knownAt(pub('2026-01-09')).map((p) => p.date)).toEqual(['2026-01-02']);
  });

  it('a value after a withdrawal restores the date; restating a withdrawn vintage is a revision', async () => {
    const db = await testDb();
    const fetched = (d: string) => `${d}T12:00:00.000Z`;
    await storeSeries(db, {
      series: 'S',
      source: 'x',
      points: [value('2026-01-05', 3.6, '2026-01-06'), gone('2026-01-05', '2026-01-08')],
      fetchedAt: fetched('2026-01-09'),
    });
    // A later vintage brings a value back: a new vintage, not a revision.
    expect(
      await storeSeries(db, {
        series: 'S',
        source: 'x',
        points: [value('2026-01-05', 3.7, '2026-01-12')],
        fetchedAt: fetched('2026-01-13'),
      }),
    ).toEqual({ inserted: 1, revised: [], withdrawn: [] });
    let pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-05', pub('2026-01-10'))).toBeUndefined();
    expect(pit.asOf('2026-01-05', pub('2026-01-12'))!.value).toBe(3.7);
    // The source restates the withdrawn vintage (01-08) itself as a value: a revision, a new row,
    // known only from its fetch (spec 2026-10-30 restated-vintage).
    expect(
      await storeSeries(db, {
        series: 'S',
        source: 'x',
        points: [value('2026-01-05', 3.65, '2026-01-08')],
        fetchedAt: fetched('2026-01-14'),
      }),
    ).toEqual({ inserted: 0, revised: [{ item: 'S', date: '2026-01-05' }], withdrawn: [] });
    expect(await db.select().from(seriesWithdrawals)).toHaveLength(1);
    const restated = await db.select().from(series).where(eq(series.value, 3.65));
    expect(restated.map((r) => r.knownAt)).toEqual([fetched('2026-01-14')]);
    pit = await seriesPointInTime(db, 'S', 'x');
    // Before its fetch the restatement did not exist yet: the withdrawal still holds (this test
    // used to expect 3.65 here, read before it was fetched: look-ahead).
    expect(pit.asOf('2026-01-05', pub('2026-01-10'))).toBeUndefined();
    // After its fetch an older vintage restated never outranks the newer 01-12 vintage.
    expect(pit.asOf('2026-01-05', pub('2026-01-13'))!.value).toBe(3.7);
    expect(pit.asOf('2026-01-05', fetched('2026-01-15'))!.value).toBe(3.7);
    expect(pit.knownAt(fetched('2026-01-15'))).toEqual([{ date: '2026-01-05', value: 3.7 }]);
  });

  it('a restated vintage counts only from its fetch, then over the original', async () => {
    const db = await testDb();
    const fetched = (d: string) => `${d}T12:00:00.000Z`;
    const store = (points: Parameters<typeof storeSeries>[1]['points'], d: string) =>
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: fetched(d) });
    await store([value('2026-01-05', 3.6, '2026-01-06')], '2026-01-07');
    expect(await store([value('2026-01-05', 3.62, '2026-01-06')], '2026-01-09')).toEqual({
      inserted: 0,
      revised: [{ item: 'S', date: '2026-01-05' }],
      withdrawn: [],
    });
    const rows = await db.select().from(series);
    // The first-seen vintage keeps its publication time; the restatement is known from its fetch.
    expect(rows.map((r) => [r.value, r.knownAt])).toEqual([
      [3.6, pub('2026-01-06')],
      [3.62, fetched('2026-01-09')],
    ]);
    let pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-05', pub('2026-01-08'))!.value).toBe(3.6);
    expect(pit.asOf('2026-01-05', fetched('2026-01-09'))!.value).toBe(3.62);
    // A withdrawal of the same vintage is a restatement too: known from its fetch.
    await store([gone('2026-01-05', '2026-01-06')], '2026-01-11');
    pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-05', pub('2026-01-10'))!.value).toBe(3.62);
    expect(pit.asOf('2026-01-05', fetched('2026-01-11'))).toBeUndefined();
    const w = await db.select().from(seriesWithdrawals);
    expect(w.map((r) => r.knownAt)).toEqual([fetched('2026-01-11')]);
  });

  it('a restated FX vintage counts only from its fetch, and never over a newer vintage', async () => {
    const db = await testDb();
    const fetched = (d: string) => `${d}T12:00:00.000Z`;
    const rate = (r: number, at: string) => ({
      pair: 'USDXXX',
      date: '2026-01-05',
      rate: r,
      publishedAt: pub(at),
    });
    const store = (rates: ReturnType<typeof rate>[], d: string) =>
      storeFx(db, { source: 'x', kind: 'valuation', rates, fetchedAt: fetched(d) });
    await store([rate(150, '2026-01-06'), rate(151, '2026-01-08')], '2026-01-09');
    await store([rate(149, '2026-01-06')], '2026-01-12');
    const pit = await fxPointInTime(db, 'USDXXX', 'x');
    expect(pit.asOf('2026-01-05', pub('2026-01-07'))!.value).toBe(150);
    expect(pit.asOf('2026-01-05', pub('2026-01-10'))!.value).toBe(151);
    expect(pit.asOf('2026-01-05', fetched('2026-01-13'))!.value).toBe(151);
  });

  it('the same publication moment spelled differently is one vintage', async () => {
    const db = await testDb();
    const fetched = (d: string) => `${d}T12:00:00.000Z`;
    const at = (v: number, publishedAt: string) => [{ date: '2026-01-05', value: v, publishedAt }];
    const store = (points: ReturnType<typeof at>, d: string) =>
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: fetched(d) });
    // 2026-01-06 18:00 in New York, as Z and as an offset.
    const utc = '2026-01-06T23:00:00Z';
    const ny = '2026-01-06T18:00:00-05:00';
    await store(at(3.6, utc), '2026-01-07');
    // Unchanged under the other spelling: nothing stored, nothing reported.
    expect(await store(at(3.6, ny), '2026-01-08')).toEqual({
      inserted: 0,
      revised: [],
      withdrawn: [],
    });
    // Restated under the other spelling: a revision, known only from its fetch.
    expect(await store(at(3.62, ny), '2026-01-09')).toEqual({
      inserted: 0,
      revised: [{ item: 'S', date: '2026-01-05' }],
      withdrawn: [],
    });
    expect((await db.select().from(series)).map((r) => [r.value, r.knownAt])).toEqual([
      [3.6, pub('2026-01-06')],
      [3.62, fetched('2026-01-09')],
    ]);
    const pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-05', pub('2026-01-08'))!.value).toBe(3.6);
    expect(pit.asOf('2026-01-05', fetched('2026-01-09'))!.value).toBe(3.62);
    // Two spellings of one moment in one response with different values: refused.
    await expect(
      storeSeries(db, {
        series: 'S',
        source: 'x',
        points: [...at(1, utc), ...at(2, ny)],
        fetchedAt: fetched('2026-01-10'),
      }),
    ).rejects.toThrow(/two different values/);
  });

  it('reads a later stored row of a vintage as known only from its fetch (legacy rows too)', async () => {
    const db = await testDb();
    const row = { series: 'S', source: 'x', date: '2026-01-02', publishedAt: '2026-01-05' };
    // A legacy first-seen row (date-only publication), and a restatement of the same vintage
    // stored before the restatement rule, with the publication date as its known_at.
    await db.insert(series).values([
      { ...row, value: 3.61, fetchedAt: '2026-01-06T01:00:00.000Z', knownAt: '2026-01-05' },
      { ...row, value: 3.65, fetchedAt: '2026-01-09T01:00:00.000Z', knownAt: '2026-01-05' },
    ]);
    const pit = await seriesPointInTime(db, 'S', 'x');
    // The original, known from the end of its publication day, until the restatement's fetch.
    expect(pit.asOf('2026-01-02', '2026-01-06T05:00:00.000Z')!.value).toBe(3.61);
    expect(pit.asOf('2026-01-02', '2026-01-09T00:59:59.999Z')!.value).toBe(3.61);
    expect(pit.asOf('2026-01-02', '2026-01-09T01:00:00.000Z')!.value).toBe(3.65);
    // Nothing stored was changed.
    expect((await db.select().from(series)).map((r) => r.knownAt)).toEqual([
      '2026-01-05',
      '2026-01-05',
    ]);
  });

  // A legacy row stored its vintage as a date only; the same source now sends that vintage as an
  // instant on the same New York day (FRED: 18:00). Both are one vintage (review of e288a4a).
  describe('a legacy date-only vintage and the same vintage as an instant', () => {
    const legacy = {
      series: 'S',
      source: 'x',
      date: '2026-01-05',
      value: 3.6,
      publishedAt: '2026-01-06',
      fetchedAt: '2026-01-07T12:00:00.000Z',
      knownAt: '2026-01-06',
    };
    // 2026-01-06 18:00 in New York; the legacy row reads as known from 23:59 there (04:59Z).
    const evening = '2026-01-06T18:00:00-05:00';
    const dayEnd = '2026-01-07T04:59:00.000Z';
    const fetched = (d: string) => `${d}T12:00:00.000Z`;
    let db: Awaited<ReturnType<typeof testDb>>;
    const store = (v: number, publishedAt: string, d: string) =>
      storeSeries(db, {
        series: 'S',
        source: 'x',
        points: [{ date: '2026-01-05', value: v, publishedAt }],
        fetchedAt: fetched(d),
      });
    const none = { inserted: 0, revised: [], withdrawn: [] };

    it('the same value as an instant stores nothing; a restatement counts only from its fetch', async () => {
      db = await testDb();
      await db.insert(series).values(legacy);
      expect(await store(3.6, evening, '2026-01-08')).toEqual(none);
      expect(await db.select().from(series)).toHaveLength(1);
      // Restated: a revision known from its fetch, never from 18:00 on the vintage day.
      expect(await store(3.65, evening, '2026-01-09')).toEqual({
        inserted: 0,
        revised: [{ item: 'S', date: '2026-01-05' }],
        withdrawn: [],
      });
      // A newer vintage (2026-01-08 18:00 New York), first seen: known from its publication.
      await store(3.7, '2026-01-08T18:00:00-05:00', '2026-01-10');
      const rows = await db.select().from(series);
      expect(rows.map((r) => [r.value, r.knownAt])).toEqual([
        [3.6, '2026-01-06'],
        [3.65, fetched('2026-01-09')],
        [3.7, '2026-01-08T23:00:00.000Z'],
      ]);
      const pit = await seriesPointInTime(db, 'S', 'x');
      expect(pit.asOf('2026-01-05', '2026-01-06T23:30:00.000Z')).toBeUndefined();
      expect(pit.asOf('2026-01-05', dayEnd)!.value).toBe(3.6);
      expect(pit.asOf('2026-01-05', '2026-01-08T22:59:59.999Z')!.value).toBe(3.6);
      // The newer vintage holds, and the restated older one never outranks it.
      expect(pit.asOf('2026-01-05', '2026-01-08T23:00:00.000Z')!.value).toBe(3.7);
      expect(pit.asOf('2026-01-05', fetched('2026-01-11'))!.value).toBe(3.7);
    });

    it('a restatement outranks the legacy value after its fetch, and only then', async () => {
      db = await testDb();
      await db.insert(series).values(legacy);
      await store(3.65, evening, '2026-01-09');
      // The legacy value again under the instant: the latest stored row of the vintage is the
      // restatement, so this is a revision too.
      expect((await store(3.6, evening, '2026-01-12')).revised).toHaveLength(1);
      const pit = await seriesPointInTime(db, 'S', 'x');
      expect(pit.asOf('2026-01-05', '2026-01-09T11:59:59.999Z')!.value).toBe(3.6);
      expect(pit.asOf('2026-01-05', fetched('2026-01-09'))!.value).toBe(3.65);
      expect(pit.asOf('2026-01-05', fetched('2026-01-12'))!.value).toBe(3.6);
    });

    it('reads an instant row stored as first seen after a legacy row as a restatement', async () => {
      db = await testDb();
      // Stored before this rule: the restatement kept its publication time as known_at.
      await db.insert(series).values([
        legacy,
        {
          ...legacy,
          value: 3.65,
          publishedAt: '2026-01-06T23:00:00.000Z',
          fetchedAt: fetched('2026-01-09'),
          knownAt: '2026-01-06T23:00:00.000Z',
        },
      ]);
      const pit = await seriesPointInTime(db, 'S', 'x');
      expect(pit.asOf('2026-01-05', '2026-01-06T23:30:00.000Z')).toBeUndefined();
      expect(pit.asOf('2026-01-05', dayEnd)!.value).toBe(3.6);
      expect(pit.asOf('2026-01-05', '2026-01-09T11:59:59.999Z')!.value).toBe(3.6);
      expect(pit.asOf('2026-01-05', fetched('2026-01-09'))!.value).toBe(3.65);
    });

    it('two different instants of one day stay two vintages', async () => {
      db = await testDb();
      const morning = '2026-01-06T10:00:00-05:00';
      // Without a legacy row: both first seen, each known from its publication.
      expect(await store(3.6, morning, '2026-01-08')).toEqual({ ...none, inserted: 1 });
      expect(await store(3.61, evening, '2026-01-08')).toEqual({ ...none, inserted: 1 });
      // With one: each instant is compared with the legacy row, not with the other instant.
      db = await testDb();
      await db.insert(series).values(legacy);
      expect((await store(3.61, evening, '2026-01-08')).revised).toHaveLength(1);
      expect(await store(3.6, morning, '2026-01-09')).toEqual(none);
      expect(await db.select().from(series)).toHaveLength(2);
    });

    it('works the same for FX', async () => {
      db = await testDb();
      const { source, date, publishedAt, fetchedAt, knownAt } = legacy;
      await db.insert(fxRates).values({
        ...{ source, date, publishedAt, fetchedAt, knownAt },
        pair: 'USDXXX',
        kind: 'valuation',
        rate: 3.6,
      });
      const fx = (r: number, d: string) =>
        storeFx(db, {
          source: 'x',
          kind: 'valuation',
          rates: [{ pair: 'USDXXX', date: '2026-01-05', rate: r, publishedAt: evening }],
          fetchedAt: fetched(d),
        });
      expect(await fx(3.6, '2026-01-08')).toEqual(none);
      expect((await fx(3.65, '2026-01-09')).revised).toHaveLength(1);
      const pit = await fxPointInTime(db, 'USDXXX', 'x');
      expect(pit.asOf('2026-01-05', '2026-01-06T23:30:00.000Z')).toBeUndefined();
      expect(pit.asOf('2026-01-05', '2026-01-09T11:59:59.999Z')!.value).toBe(3.6);
      expect(pit.asOf('2026-01-05', fetched('2026-01-09'))!.value).toBe(3.65);
    });
  });

  it('refuses a fetch time that is not an instant with a zone', async () => {
    const db = await testDb();
    const points = [{ date: '2026-01-02', value: 1 }];
    for (const fetchedAt of ['t1', '2026-01-07', '2026-01-07T01:00:00']) {
      await expect(
        storeSeries(db, { series: 'S', source: 'x', points, fetchedAt }),
      ).rejects.toThrow(/fetchedAt must be an instant/);
      await expect(
        storeFx(db, {
          source: 'x',
          kind: 'valuation',
          rates: [{ pair: 'USDXXX', date: '2026-01-02', rate: 1 }],
          fetchedAt,
        }),
      ).rejects.toThrow(/fetchedAt must be an instant/);
    }
    // An offset is normalized to UTC text, so it compares with known_at as a string.
    await storeSeries(db, {
      series: 'S',
      source: 'x',
      points,
      fetchedAt: '2026-01-06T20:00:00-05:00',
    });
    expect((await db.select().from(series)).map((r) => [r.fetchedAt, r.knownAt])).toEqual([
      ['2026-01-07T01:00:00.000Z', '2026-01-07T01:00:00.000Z'],
    ]);
  });

  it('refuses a value and a withdrawal for the same date and publication time', async () => {
    const db = await testDb();
    const points = [value('2026-01-05', 3.6, '2026-01-06'), gone('2026-01-05', '2026-01-06')];
    await expect(
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: T1 }),
    ).rejects.toThrow(/a value and a withdrawal/);
    expect(await db.select().from(series)).toHaveLength(0);
  });

  // A plug-in's response is untyped at run time: a point is refused unless it is a withdrawal
  // (`withdrawn: true`, no value) or a finite number, and the whole response with it.
  it.each([
    ['a null value without the withdrawn flag', { date: '2026-01-05', value: null }],
    ['a NaN value', { date: '2026-01-05', value: Number.NaN }],
    ['an infinite value', { date: '2026-01-05', value: Number.POSITIVE_INFINITY }],
    ['a missing value', { date: '2026-01-05' }],
    ['a value given as text', { date: '2026-01-05', value: '3.6' }],
    ['a withdrawal that carries a value', { date: '2026-01-05', withdrawn: true, value: 3.6 }],
    ['a withdrawn flag that is not true', { date: '2026-01-05', withdrawn: 'yes', value: 3.6 }],
  ])('refuses a series response with %s, storing nothing', async (_, bad) => {
    const db = await testDb();
    const points = [value('2026-01-02', 3.5, '2026-01-03'), bad] as never;
    await expect(
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: T1 }),
    ).rejects.toThrow(/finite number|carries a value|neither true nor absent/);
    expect(await db.select().from(series)).toHaveLength(0);
    expect(await db.select().from(seriesWithdrawals)).toHaveLength(0);
  });

  it.each([
    ['a null rate without the withdrawn flag', { pair: 'USDYYY', date: '2026-01-05', rate: null }],
    ['a NaN rate', { pair: 'USDYYY', date: '2026-01-05', rate: Number.NaN }],
  ])('refuses an FX response with %s, storing no pair', async (_, bad) => {
    const db = await testDb();
    // The valid pair comes first: it is not stored either.
    const rates = [
      { pair: 'USDXXX', date: '2026-01-05', rate: 150, publishedAt: pub('2026-01-06') },
      bad,
    ] as never;
    await expect(
      storeFx(db, { source: 'x', kind: 'valuation', rates, fetchedAt: T1 }),
    ).rejects.toThrow(/finite number/);
    expect(await db.select().from(fxRates)).toHaveLength(0);
    expect(await db.select().from(fxWithdrawals)).toHaveLength(0);
  });

  it('refuses two different values for the same date and publication time, storing nothing', async () => {
    const db = await testDb();
    const points = [
      value('2026-01-02', 3.5, '2026-01-03'),
      value('2026-01-05', 3.6, '2026-01-06'),
      value('2026-01-05', 3.7, '2026-01-06'),
    ];
    await expect(
      storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: T1 }),
    ).rejects.toThrow(/two different values for 2026-01-05/);
    expect(await db.select().from(series)).toHaveLength(0);
    const rates = [
      { pair: 'USDXXX', date: '2026-01-05', rate: 150, publishedAt: pub('2026-01-06') },
      { pair: 'USDXXX', date: '2026-01-05', rate: 151, publishedAt: pub('2026-01-06') },
    ];
    await expect(
      storeFx(db, { source: 'x', kind: 'valuation', rates, fetchedAt: T1 }),
    ).rejects.toThrow(/two different values for 2026-01-05/);
    expect(await db.select().from(fxRates)).toHaveLength(0);
  });

  it('keeps the same vintage sent twice in one response once', async () => {
    const db = await testDb();
    const points = [value('2026-01-05', 3.6, '2026-01-06'), value('2026-01-05', 3.6, '2026-01-06')];
    expect(await storeSeries(db, { series: 'S', source: 'x', points, fetchedAt: T1 })).toEqual({
      inserted: 1,
      revised: [],
      withdrawn: [],
    });
    expect(await db.select().from(series)).toHaveLength(1);
  });

  it('stores FX withdrawals per pair and kind, once', async () => {
    const db = await testDb();
    const rates = [
      { pair: 'USDXXX', date: '2026-01-05', rate: 150, publishedAt: pub('2026-01-06') },
      {
        pair: 'USDXXX',
        date: '2026-01-05',
        withdrawn: true as const,
        publishedAt: pub('2026-01-08'),
      },
    ];
    const store = (fetchedAt: string) =>
      storeFx(db, { source: 'x', kind: 'valuation', rates, fetchedAt });
    expect(await store(T1)).toEqual({
      inserted: 1,
      revised: [{ item: 'USDXXX', date: '2026-01-05' }],
      withdrawn: [{ item: 'USDXXX', date: '2026-01-05' }],
    });
    expect(await store(T2)).toEqual({ inserted: 0, revised: [], withdrawn: [] });
    expect(await db.select().from(fxRates)).toHaveLength(1);
    expect(await db.select().from(fxWithdrawals)).toHaveLength(1);
    const pit = await fxPointInTime(db, 'USDXXX', 'x');
    expect(pit.asOf('2026-01-05', pub('2026-01-07'))!.value).toBe(150);
    expect(pit.asOf('2026-01-05', pub('2026-01-08'))).toBeUndefined();
    // Another kind is not affected.
    expect((await fxPointInTime(db, 'USDXXX', 'x', 'tax_mid')).asOf('2026-01-05', 'z')).toBe(
      undefined,
    );
  });

  it('a withdrawal without a publication time is known from its fetch', async () => {
    const db = await testDb();
    const fetchedAt = '2026-01-07T01:00:00.000Z';
    await storeSeries(db, {
      series: 'S',
      source: 'x',
      points: [{ date: '2026-01-02', value: 5 }],
      fetchedAt: '2026-01-06T01:00:00.000Z',
    });
    expect(
      await storeSeries(db, {
        series: 'S',
        source: 'x',
        points: [{ date: '2026-01-02', withdrawn: true }],
        fetchedAt,
      }),
    ).toMatchObject({ withdrawn: [{ item: 'S', date: '2026-01-02' }] });
    const pit = await seriesPointInTime(db, 'S', 'x');
    expect(pit.asOf('2026-01-02', '2026-01-07T00:59:59.999Z')!.value).toBe(5);
    expect(pit.asOf('2026-01-02', fetchedAt)).toBeUndefined();
  });
});

// Spec 2026-10-31 vanished-values: a response complete for its span (current values only, e.g.
// FRED's SP500) compared with the stored dates on a full fetch.
describe('vanished values (a response complete for its span)', () => {
  const [D1, D2, D3, D4, D5] = [
    '2026-01-05',
    '2026-01-06',
    '2026-01-07',
    '2026-01-08',
    '2026-01-09',
  ];
  const store = (
    db: Awaited<ReturnType<typeof testDb>>,
    dates: string[],
    fetchedAt: string,
    completeSpan?: boolean,
    value = (d: string) => Number(d.slice(-2)),
  ) =>
    storeSeries(db, {
      series: 'IDX',
      source: 'x',
      points: dates.map((date) => ({ date, value: value(date) })),
      fetchedAt,
      ...(completeSpan !== undefined && { completeSpan }),
    });
  const withdrawalRows = async (db: Awaited<ReturnType<typeof testDb>>) =>
    (await db.select().from(seriesWithdrawals)).map((r) => [r.date, r.knownAt, r.publishedAt]);

  it('a stored date inside the span that the source left out is withdrawn from the fetch', async () => {
    const db = await testDb();
    await store(db, [D1, D2, D3, D4], T1);
    const r = await store(db, [D1, D2, D4], T2, true);
    expect(r).toEqual({
      inserted: 0,
      revised: [{ item: 'IDX', date: D3 }],
      withdrawn: [{ item: 'IDX', date: D3 }],
      outsideSpan: [],
    });
    // Known from the fetch, no publication time claimed; the value kept beside it.
    expect(await withdrawalRows(db)).toEqual([[D3, T2, null]]);
    expect(
      (await db.select().from(series)).filter((x) => x.date === D3).map((x) => x.value),
    ).toEqual([7]);
    // asOf: before the fetch the old value, from it on the date is skipped (the day before).
    const pit = await seriesPointInTime(db, 'IDX', 'x');
    expect(pit.asOf(D3, '2026-02-02T00:59:59.999Z')).toMatchObject({ date: D3, value: 7 });
    expect(pit.asOf(D3, T2)).toMatchObject({ date: D2, value: 6 });
    expect(pit.knownAt(T2).map((x) => x.date)).toEqual([D1, D2, D4]);
    // The same answer again: nothing new (idempotent).
    expect(await store(db, [D1, D2, D4], T3, true)).toEqual({
      inserted: 0,
      revised: [],
      withdrawn: [],
      outsideSpan: [],
    });
    expect(await withdrawalRows(db)).toHaveLength(1);
  });

  it('a vanished value that reappears is a new value from that fetch, the withdrawal kept', async () => {
    const db = await testDb();
    await store(db, [D1, D2, D3], T1);
    await store(db, [D1, D3], T2, true);
    const r = await store(db, [D1, D2, D3], T3, true, (d) => (d === D2 ? 66 : Number(d.slice(-2))));
    expect(r).toMatchObject({ revised: [{ item: 'IDX', date: D2 }], withdrawn: [] });
    expect(await withdrawalRows(db)).toEqual([[D2, T2, null]]);
    const pit = await seriesPointInTime(db, 'IDX', 'x');
    expect(pit.asOf(D2, T2)).toMatchObject({ date: D1 });
    expect(pit.asOf(D2, T3)).toMatchObject({ date: D2, value: 66 });
  });

  it('a span that starts later (a licence window moving forward) withdraws nothing', async () => {
    const db = await testDb();
    await store(db, [D1, D2, D3, D4], T1);
    const r = await store(db, [D3, D4, D5], T2, true);
    expect(r).toEqual({ inserted: 1, revised: [], withdrawn: [], outsideSpan: [D1, D2] });
    expect(await withdrawalRows(db)).toEqual([]);
    const pit = await seriesPointInTime(db, 'IDX', 'x');
    expect(pit.asOf(D1, T2)).toMatchObject({ date: D1, value: 5 });
  });

  it('a stored date after the last one served is listed outside the span, never withdrawn', async () => {
    const db = await testDb();
    await store(db, [D1, D2, D3], T1);
    expect(await store(db, [D1, D2], T2, true)).toMatchObject({
      withdrawn: [],
      outsideSpan: [D3],
    });
    expect(await withdrawalRows(db)).toEqual([]);
  });

  it('without completeSpan (a partial or vintage answer) a left-out date keeps its value', async () => {
    const db = await testDb();
    await store(db, [D1, D2, D3], T1);
    for (const flag of [undefined, false]) {
      const r = await store(db, [D1, D3], T2, flag);
      expect(r).toEqual({ inserted: 0, revised: [], withdrawn: [] });
    }
    expect(await withdrawalRows(db)).toEqual([]);
  });

  it('an empty answer compares nothing; an already withdrawn date is not listed again', async () => {
    const db = await testDb();
    await store(db, [D1, D2, D3], T1);
    expect(await store(db, [], T2, true)).toEqual({ inserted: 0, revised: [], withdrawn: [] });
    await storeSeries(db, {
      series: 'IDX',
      source: 'x',
      points: [{ date: D1, withdrawn: true }],
      fetchedAt: T2,
    });
    // D1 has no value at T3: neither withdrawn again nor listed outside the span.
    expect(await store(db, [D2, D3], T3, true)).toEqual({
      inserted: 0,
      revised: [],
      withdrawn: [],
      outsideSpan: [],
    });
    expect(await withdrawalRows(db)).toHaveLength(1);
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
