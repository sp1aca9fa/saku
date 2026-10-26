import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  schema,
  seedSourceRoles,
  startRun,
  storeRawBars,
  storeSeries,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { asc } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { verify } from './verify';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
const bars = (closes: number[], extra: (i: number) => Partial<RawBar> = () => ({})): RawBar[] =>
  closes.map((close, i) => ({
    date: dates[i]!,
    open: close,
    high: close,
    low: close,
    close,
    closeIsSplitAdjusted: false,
    volume: 1000,
    divCash: 0,
    splitFactor: 1,
    ...extra(i),
  }));

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', indexSeries: 'IDX' },
    {
      ticker: 'AAA2',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      leverageFactor: 2,
      underlying: 'AAA',
    },
  ]);
  await seedSourceRoles(db, [
    { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
    { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    { key: 'idx', dataKind: 'series', suggestedRole: 'primary' },
  ]);
  const store = async (ticker: string, source: string, list: RawBar[]) =>
    storeRawBars(db, {
      symbolId: (await symbolId(db, ticker))!,
      source,
      bars: list,
      runId: null,
      fetchedAt: 't',
    });
  // AAA +1%, +1% total (0.5 of it a dividend), -1%; AAA2 tracks 2x its price return; the index
  // follows its price; the secondary agrees except a wrong close on the last day.
  await store(
    'AAA',
    'p',
    bars([100, 101, 101.51, 100.4949], (i) => ({
      divCash: i === 2 ? 0.5 : 0,
      providerAdjClose: [50, 50.5, 51.005, 50.495][i],
    })),
  );
  await store(
    'AAA',
    's',
    bars([100, 101, 101.51, 101.5], (i) => ({ divCash: i === 2 ? 0.5 : 0 })),
  );
  await store('AAA2', 'p', bars([50, 51, 51.515, 50.4258]));
  await storeSeries(db, {
    series: 'IDX',
    source: 'idx',
    points: [100, 101, 101.51, 100.4949].map((close, i) => ({
      date: dates[i]!,
      value: close * 50,
    })),
    fetchedAt: 't',
  });
  return db;
}

describe('verify', () => {
  it('writes canonical bars with our adjusted series and stores daily results', async () => {
    const db = await setup();
    const runId = await startRun(db, 'daily');
    const summary = await verify(db, {
      runId,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
    });
    const canonical = await db
      .select()
      .from(schema.bars)
      .orderBy(asc(schema.bars.symbolId), asc(schema.bars.date));
    expect(canonical).toHaveLength(8);
    expect(canonical[0]).toMatchObject({ adjClose: 1, source: 'p', standIn: false });
    expect(canonical[2]!.adjClose).toBeCloseTo(1.01 * (102.01 / 101), 12);
    const results = await db.select().from(schema.checkResults);
    expect(results.length).toBe(summary.stored);
    expect(results.every((r) => r.date >= '2026-01-06')).toBe(true);
    const red = results
      .filter((r) => r.status === 'red')
      .map((r) => `${r.layer} ${r.checkName} ${r.source} ${r.date}`);
    expect(red).toEqual(['B close_match s 2026-01-08']);
    const checks = new Set(results.map((r) => `${r.layer} ${r.checkName}`));
    expect([...checks].sort()).toEqual([
      'A bar_valid',
      'A large_move',
      'A unchanged_close',
      'B adj_return_match',
      'B close_match',
      'B dividend_match',
      'C index_match',
      'C leverage_track',
    ]);
  });

  it('full passes store summaries and only non-green results', async () => {
    const db = await setup();
    const runId = await startRun(db, 'weekly');
    await verify(db, { runId, sessions, mode: 'full', to: '2026-01-08' });
    const results = await db.select().from(schema.checkResults);
    expect(results.map((r) => r.status)).toEqual(['red']);
    const summaries = await db.select().from(schema.checkSummaries);
    const close = summaries.find((s) => s.checkName === 'close_match')!;
    expect(close).toMatchObject({ checked: 4, passed: 3 });
    expect(close.maxDeviation).toBeCloseTo(101.5 / 100.4949 - 1, 12);
  });
});
