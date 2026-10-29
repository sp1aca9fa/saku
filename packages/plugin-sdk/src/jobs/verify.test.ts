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
import { and, asc, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { savePluginInfos } from '../registry';
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

async function setup(o: { aaaPrimaryDays?: number } = {}) {
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
    })).slice(0, o.aaaPrimaryDays ?? 4),
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
  return { db, store };
}

describe('verify', () => {
  it('writes canonical bars with our adjusted series and stores daily results', async () => {
    const { db } = await setup();
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
    const { db } = await setup();
    const runId = await startRun(db, 'weekly');
    await verify(db, { runId, sessions, mode: 'full', to: '2026-01-08' });
    const results = await db.select().from(schema.checkResults);
    expect(results.map((r) => r.status)).toEqual(['red']);
    const summaries = await db.select().from(schema.checkSummaries);
    const close = summaries.find((s) => s.checkName === 'close_match')!;
    expect(close).toMatchObject({ checked: 4, passed: 3 });
    expect(close.maxDeviation).toBeCloseTo(101.5 / 100.4949 - 1, 12);
  });

  it('grades each symbol and day; one source alone is never green', async () => {
    const { db } = await setup();
    const runId = await startRun(db, 'daily');
    const summary = await verify(db, {
      runId,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
    });
    expect(summary.health).toBe('red');
    const rows = await db.select().from(schema.dataHealth).orderBy(asc(schema.dataHealth.date));
    const overall = rows.filter((r) => r.symbolId === null);
    expect(overall.map((r) => `${r.date} ${r.status}`)).toEqual([
      '2026-01-06 yellow',
      '2026-01-07 yellow',
      '2026-01-08 red',
    ]);
    expect(overall[2]!.reasons).toEqual(['AAA', 'AAA2']);
    const aaa2 = rows.find(
      (r) => r.symbolId !== null && r.date === '2026-01-06' && r.reasons.includes('single_source'),
    );
    expect(aaa2?.status).toBe('yellow');
    const canonical = await db.select().from(schema.bars).where(eq(schema.bars.date, '2026-01-08'));
    expect(canonical.map((b) => b.status).sort()).toEqual(['red', 'yellow']);
  });

  it('grades the cash series freshness on the run date', async () => {
    const { db } = await setup();
    const runFor = async (to: string) => {
      const runId = await startRun(db, 'daily');
      await verify(db, { runId, sessions, mode: 'daily', from: to, to, seriesSessions: sessions });
      const rows = await db
        .select()
        .from(schema.dataHealth)
        .where(and(eq(schema.dataHealth.runId, runId), isNull(schema.dataHealth.symbolId)));
      return rows[0]!;
    };
    // No series source declares a cash rate: red, never a silent skip.
    expect((await runFor('2026-01-07')).reasons).toContain('cash:missing@none');
    await savePluginInfos(db, [
      {
        key: 'idx',
        kind: 'series',
        name: 'Index',
        provides: { series: ['IDX', 'DTB3'], cashRates: { USD: 'DTB3' } },
        suggestedRole: 'primary',
        termsUrl: 'x',
      },
    ]);
    const cash = async (last: number) =>
      storeSeries(db, {
        series: 'DTB3',
        source: 'idx',
        points: dates.slice(0, last).map((date) => ({ date, value: 4 })),
        fetchedAt: '2026-01-02T00:00:00Z',
      });
    const overallOn = async (to: string) => {
      const runId = await startRun(db, 'daily');
      await verify(db, { runId, sessions, mode: 'daily', from: to, to, seriesSessions: sessions });
      const rows = await db
        .select()
        .from(schema.dataHealth)
        .where(and(eq(schema.dataHealth.runId, runId), isNull(schema.dataHealth.symbolId)));
      return rows[0]!;
    };
    expect((await overallOn('2026-01-07')).reasons).toContain('DTB3:missing@idx');
    await cash(1);
    const gap = await overallOn('2026-01-08');
    expect(gap.reasons).toContain('DTB3:stale(3)@idx');
    await cash(3);
    expect((await overallOn('2026-01-08')).reasons.some((r) => r.startsWith('DTB3'))).toBe(false);
  });

  it('stands a secondary bar in for a missing primary day, then resolves it', async () => {
    const { db, store } = await setup({ aaaPrimaryDays: 3 });
    // The secondary's last close matches the index this time.
    await store(
      'AAA',
      's',
      bars([100, 101, 101.51, 100.4949], (i) => ({ divCash: i === 2 ? 0.5 : 0 })),
    );
    const first = await startRun(db, 'daily');
    const summary = await verify(db, {
      runId: first,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
    });
    expect(summary.standIns).toBe(1);
    const aaa = (await symbolId(db, 'AAA'))!;
    const [bar] = await db
      .select()
      .from(schema.bars)
      .where(and(eq(schema.bars.symbolId, aaa), eq(schema.bars.date, '2026-01-08')));
    expect(bar).toMatchObject({ source: 's', standIn: true, close: 100.4949, status: 'yellow' });
    const [row] = await db.select().from(schema.standIns);
    expect(row).toMatchObject({ date: '2026-01-08', source: 's', basis: 'index', band: 0.001 });

    // The primary arrives, 0.1% off the stand-in: resolved and reported.
    await store('AAA', 'p', [bars([100, 101, 101.51, 100.5954])[3]!]);
    const second = await startRun(db, 'daily');
    const after = await verify(db, {
      runId: second,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
    });
    expect(after.standIns).toBe(0);
    expect(after.standInsOff).toHaveLength(1);
    expect(after.standInsOff[0]!.deviation).toBeCloseTo(100.5954 / 100.4949 - 1, 12);
    expect(
      await db.select().from(schema.standIns).where(isNull(schema.standIns.resolvedAt)),
    ).toEqual([]);
    const [now] = await db
      .select()
      .from(schema.bars)
      .where(and(eq(schema.bars.symbolId, aaa), eq(schema.bars.date, '2026-01-08')));
    expect(now).toMatchObject({ source: 'p', standIn: false, close: 100.5954 });
  });

  it('grades a symbol with no primary bar red primary_missing on its dates', async () => {
    const { db } = await setup();
    await upsertSymbols(db, [{ ticker: 'CCC', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    const ccc = (await symbolId(db, 'CCC'))!;
    const graded = async (mode: 'daily' | 'full', from?: string) => {
      const runId = await startRun(db, mode === 'daily' ? 'daily' : 'checks');
      const summary = await verify(db, {
        runId,
        sessions,
        mode,
        ...(from && { from }),
        to: '2026-01-08',
      });
      const rows = await db
        .select()
        .from(schema.dataHealth)
        .where(and(eq(schema.dataHealth.runId, runId), eq(schema.dataHealth.symbolId, ccc)))
        .orderBy(asc(schema.dataHealth.date));
      expect(rows.every((r) => r.status === 'red' && r.reasons[0] === 'primary_missing')).toBe(
        true,
      );
      return { dates: rows.map((r) => r.date), summary };
    };
    // Neither a canonical bar nor an inception date: the run's date only, in the overall grade.
    const none = await graded('daily', '2026-01-06');
    expect(none.dates).toEqual(['2026-01-08']);
    expect(none.summary.reasons).toContain('CCC');
    // From its inception date, within the window.
    await db
      .update(schema.symbols)
      .set({ inceptionDate: '2026-01-05' })
      .where(eq(schema.symbols.id, ccc));
    expect((await graded('daily', '2026-01-07')).dates).toEqual(['2026-01-07', '2026-01-08']);
    expect((await graded('full')).dates).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
    ]);
    // A first canonical bar is the start when there is one.
    await db
      .insert(schema.bars)
      .values({ symbolId: ccc, date: '2026-01-07', close: 1, source: 'old' });
    expect((await graded('full')).dates).toEqual(['2026-01-07', '2026-01-08']);
  });
});
