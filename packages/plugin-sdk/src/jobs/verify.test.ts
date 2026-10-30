import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  schema,
  seedSourceRoles,
  setSourceRole,
  startRun,
  setSetting,
  storeFx,
  storeIssuerRecords,
  storeRawBars,
  storeSeries,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { savePluginInfos } from '../registry';
import { issuerStats } from './issuer';
import { carriedReasonStatus, verify } from './verify';

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
    // Known before the dates checked (the index freshness is read through asOf).
    fetchedAt: '2026-01-02T00:00:00Z',
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

  it('grades a missing index value: the fund yellow, the index freshness on the day', async () => {
    const { db } = await setup();
    const runFor = async (to: string) => {
      const runId = await startRun(db, 'daily');
      await verify(db, { runId, sessions, mode: 'daily', from: '2026-01-06', to });
      const rows = await db
        .select()
        .from(schema.dataHealth)
        .where(eq(schema.dataHealth.runId, runId));
      const results = await db
        .select()
        .from(schema.checkResults)
        .where(eq(schema.checkResults.runId, runId));
      const aaa = (await symbolId(db, 'AAA'))!;
      return {
        overall: rows.find((r) => r.symbolId === null && r.date === to)!,
        aaa: rows.find((r) => r.symbolId === aaa && r.date === to)!,
        index: results
          .filter((r) => r.checkName.startsWith('index_'))
          .map((r) => `${r.date} ${r.checkName} ${r.status}`),
      };
    };
    // The index stops two sessions before the run's date: the fund yellow there (the check could
    // not run), the day yellow for the stale series (2 business days behind).
    await db.delete(schema.series).where(eq(schema.series.date, '2026-01-07'));
    await db.delete(schema.series).where(eq(schema.series.date, '2026-01-08'));
    const stale = await runFor('2026-01-08');
    expect(stale.index).toEqual([
      '2026-01-06 index_match green',
      '2026-01-07 index_unavailable yellow',
      '2026-01-08 index_unavailable yellow',
    ]);
    expect(stale.aaa.reasons).toContain('C.index_unavailable@idx');
    expect(stale.overall.reasons).toContain('IDX:stale(2)@idx');
    // Only the run's own day missing: the publication lag, green, compared by the next run.
    const lag = await runFor('2026-01-07');
    expect(lag.index).toEqual(['2026-01-06 index_match green']);
    expect(lag.overall.reasons.some((r) => r.startsWith('IDX:'))).toBe(false);
    // No value at all: the fund yellow on the run's date, the day red (missing).
    await db.delete(schema.series);
    const none = await runFor('2026-01-08');
    expect(none.index).toEqual(['2026-01-08 index_unavailable yellow']);
    expect(none.aaa.reasons).toContain('C.index_unavailable@idx');
    expect(none.overall).toMatchObject({ status: 'red' });
    expect(none.overall.reasons).toContain('IDX:missing@idx');
  });

  it('grades the base-currency FX: freshness on the day, a cross-check that cannot run', async () => {
    const { db } = await setup();
    await setSetting(db, 'base_currency', 'XXX');
    await seedSourceRoles(db, [
      { key: 'fx1', dataKind: 'fx', suggestedRole: 'primary' },
      { key: 'fx2', dataKind: 'fx', suggestedRole: 'secondary' },
    ]);
    const fx = (source: string, n: number) =>
      storeFx(db, {
        source,
        kind: 'valuation',
        rates: dates.slice(0, n).map((date) => ({ pair: 'USDXXX', date, rate: 150 })),
        fetchedAt: '2026-01-02T00:00:00Z',
      });
    const overallOn = async (to: string) => {
      const runId = await startRun(db, 'daily');
      await verify(db, { runId, sessions, mode: 'daily', from: to, to });
      const rows = await db
        .select()
        .from(schema.dataHealth)
        .where(and(eq(schema.dataHealth.runId, runId), eq(schema.dataHealth.date, to)));
      const symbols = rows.filter((r) => r.symbolId !== null);
      return { overall: rows.find((r) => r.symbolId === null)!, symbols };
    };
    // No primary rate at all: red for the day, the cross-check yellow; no symbol touched.
    await fx('fx2', 4);
    const none = await overallOn('2026-01-08');
    expect(none.overall.status).toBe('red');
    expect(none.overall.reasons).toEqual(
      expect.arrayContaining(['USDXXX:missing@fx1', 'USDXXX:B.fx_unavailable@fx2']),
    );
    expect(none.symbols.every((r) => !r.reasons.some((x) => x.includes('fx')))).toBe(true);
    // The primary two sessions behind: yellow, the cross-check still cannot run on the day.
    await fx('fx1', 2);
    const stale = await overallOn('2026-01-08');
    expect(stale.overall.reasons).toEqual(
      expect.arrayContaining(['USDXXX:stale(2)@fx1', 'USDXXX:B.fx_unavailable@fx2']),
    );
    // Up to date: nothing about FX.
    await fx('fx1', 4);
    const fresh = await overallOn('2026-01-08');
    expect(fresh.overall.reasons.some((r) => r.startsWith('USDXXX'))).toBe(false);
  });

  it('uses only index values known at the run (a later publication is neither used nor fresh)', async () => {
    const { db } = await setup();
    // 01-07 and 01-08 are published only on 01-09 evening.
    await db.delete(schema.series).where(eq(schema.series.date, '2026-01-07'));
    await db.delete(schema.series).where(eq(schema.series.date, '2026-01-08'));
    await storeSeries(db, {
      series: 'IDX',
      source: 'idx',
      points: [
        { date: '2026-01-07', value: 101.51 * 50, publishedAt: '2026-01-09T23:00:00Z' },
        { date: '2026-01-08', value: 100.4949 * 50, publishedAt: '2026-01-09T23:00:00Z' },
      ],
      fetchedAt: '2026-01-09T23:30:00Z',
    });
    const at = async (now: string) => {
      const runId = await startRun(db, 'daily');
      await verify(db, {
        runId,
        sessions,
        mode: 'daily',
        from: '2026-01-06',
        to: '2026-01-08',
        now: new Date(now),
      });
      const results = await db
        .select()
        .from(schema.checkResults)
        .where(eq(schema.checkResults.runId, runId));
      const [overall] = await db
        .select()
        .from(schema.dataHealth)
        .where(
          and(
            eq(schema.dataHealth.runId, runId),
            isNull(schema.dataHealth.symbolId),
            eq(schema.dataHealth.date, '2026-01-08'),
          ),
        );
      return {
        index: results
          .filter((r) => r.checkName.startsWith('index_'))
          .map((r) => `${r.date} ${r.checkName}`),
        reasons: overall!.reasons,
      };
    };
    const before = await at('2026-01-09T01:00:00Z');
    expect(before.index).toEqual([
      '2026-01-06 index_match',
      '2026-01-07 index_unavailable',
      '2026-01-08 index_unavailable',
    ]);
    expect(before.reasons).toContain('IDX:stale(2)@idx');
    const after = await at('2026-01-10T00:00:00Z');
    expect(after.index).toEqual([
      '2026-01-06 index_match',
      '2026-01-07 index_match',
      '2026-01-08 index_match',
    ]);
    expect(after.reasons.some((r) => r.startsWith('IDX:'))).toBe(false);
  });

  it('grades FX gaps on every graded date, as known at the run; declared closed days are expected', async () => {
    const { db } = await setup();
    await setSetting(db, 'base_currency', 'XXX');
    await seedSourceRoles(db, [
      { key: 'fx1', dataKind: 'fx', suggestedRole: 'primary' },
      { key: 'fx2', dataKind: 'fx', suggestedRole: 'secondary' },
    ]);
    const rate = (date: string, publishedAt = `${date}T16:00:00Z`) => ({
      pair: 'USDXXX',
      date,
      rate: 150,
      publishedAt,
    });
    // The primary lacks 01-06; its 01-08 rate is published only after the run.
    await storeFx(db, {
      source: 'fx1',
      kind: 'valuation',
      rates: [rate('2026-01-05'), rate('2026-01-07'), rate('2026-01-08', '2026-01-09T16:00:00Z')],
      fetchedAt: '2026-01-09T17:00:00Z',
    });
    await storeFx(db, {
      source: 'fx2',
      kind: 'valuation',
      rates: dates.map((d) => rate(d)),
      fetchedAt: '2026-01-09T17:00:00Z',
    });
    const run = async (o: { sourceCalendars?: Record<string, Sessions> } = {}) => {
      const runId = await startRun(db, 'daily');
      await verify(db, {
        runId,
        sessions,
        mode: 'daily',
        from: '2026-01-06',
        to: '2026-01-08',
        now: new Date('2026-01-09T01:00:00Z'),
        ...o,
      });
      const rows = await db
        .select()
        .from(schema.dataHealth)
        .where(and(eq(schema.dataHealth.runId, runId), isNull(schema.dataHealth.symbolId)));
      const fx = (
        await db.select().from(schema.checkResults).where(eq(schema.checkResults.runId, runId))
      )
        .filter((r) => r.checkName.startsWith('fx_'))
        .map((r) => `${r.date} ${r.checkName} ${r.status}`)
        .sort();
      return { rows, fx };
    };
    const plain = await run();
    expect(plain.fx).toEqual([
      '2026-01-06 fx_unavailable yellow',
      '2026-01-07 fx_match green',
      '2026-01-08 fx_unavailable yellow',
    ]);
    const on = (date: string) => plain.rows.find((r) => r.date === date)!.reasons;
    expect(on('2026-01-06')).toContain('USDXXX:B.fx_unavailable@fx2');
    // 01-08 not known at the run: one session behind (the lag) is green, the cross-check is not.
    expect(on('2026-01-08')).toContain('USDXXX:B.fx_unavailable@fx2');
    expect(on('2026-01-08').some((r) => r.startsWith('USDXXX:stale'))).toBe(false);

    // The primary declares 01-06 a closing day: an expected gap, green.
    const closed = new Sessions({
      id: 'c',
      version: 'c',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      holidays: ['2026-01-06'],
    });
    const declared = await run({ sourceCalendars: { fx1: closed } });
    expect(declared.fx).toEqual(['2026-01-07 fx_match green', '2026-01-08 fx_unavailable yellow']);
  });

  it('carries freshness and FX cross-check reasons with their status (the health merge)', () => {
    expect(carriedReasonStatus('USDXXX:B.fx_unavailable@fx2')).toBe('yellow');
    expect(carriedReasonStatus('IDX:stale(2)@idx')).toBe('yellow');
    expect(carriedReasonStatus('IDX:stale(6)@idx')).toBe('red');
    expect(carriedReasonStatus('DTB3:missing@none')).toBe('red');
    expect(carriedReasonStatus('USDXXX:B.fx_match@fx2')).toBeNull();
    expect(carriedReasonStatus('SPY')).toBeNull();
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

  it("marks the stored canonical bars red when the new primary has none of a symbol's bars", async () => {
    const { db } = await setup();
    await verify(db, {
      runId: await startRun(db, 'checks'),
      sessions,
      mode: 'full',
      to: '2026-01-08',
    });
    const aaa = (await symbolId(db, 'AAA'))!;
    const stored = () =>
      db
        .select()
        .from(schema.bars)
        .where(eq(schema.bars.symbolId, aaa))
        .orderBy(asc(schema.bars.date));
    const before = await stored();
    expect(before.find((b) => b.date === '2026-01-06')!.status).not.toBe('red');
    // The admin makes a source the primary that has none of the history.
    await setSourceRole(db, { dataKind: 'bars', key: 'q', role: 'primary', actor: 'test' });
    await verify(db, {
      runId: await startRun(db, 'daily'),
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
    });
    const after = await stored();
    // Graded dates: red; the values stay as they were; a date outside the window is untouched.
    expect(after.map((b) => b.status)).toEqual([before[0]!.status, 'red', 'red', 'red']);
    expect(after.map(({ status: _, ...values }) => values)).toEqual(
      before.map(({ status: _, ...values }) => values),
    );
  });

  /** AAA's NAVs from an issuer source, one per date, the distribution on the 7th. */
  const issue = async (
    db: Awaited<ReturnType<typeof setup>>['db'],
    source: string,
    nav: (close: number, i: number) => number,
    days = 4,
  ) =>
    storeIssuerRecords(db, {
      symbolId: (await symbolId(db, 'AAA'))!,
      source,
      records: [100, 101, 101.51, 100.4949].slice(0, days).map((close, i) => ({
        date: dates[i]!,
        nav: nav(close, i),
        currency: 'USD',
        ...(i === 2 && { distribution: 0.5 }),
      })),
      fetchedAt: 't',
    });
  const layerDResults = (db: Awaited<ReturnType<typeof setup>>['db']) =>
    db
      .select()
      .from(schema.checkResults)
      .where(eq(schema.checkResults.layer, 'D'))
      .orderBy(asc(schema.checkResults.date));

  it('runs layer D for issuer sources with a role, advisory: yellow at most', async () => {
    const { db } = await setup();
    await seedSourceRoles(db, [{ key: 'iss', dataKind: 'issuer', suggestedRole: 'check' }]);
    const aaa = (await symbolId(db, 'AAA'))!;
    // The NAV is 10% off on the 7th; a source without a role is far off every day.
    await issue(db, 'iss', (close, i) => (i === 2 ? close * 1.1 : close));
    await issue(db, 'other', (close) => close * 2);
    await setSetting(db, 'issuer_nav_tolerance', '{"AAA":0.01,"ZZZ":0.01}');
    const runId = await startRun(db, 'daily');
    const summary = await verify(db, {
      runId,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
    });
    expect(summary).toMatchObject({ toleranceInvalid: false, toleranceUnmatched: ['ZZZ'] });
    const d = await layerDResults(db);
    expect(d.every((r) => r.source === 'iss' && r.symbolId === aaa)).toBe(true);
    expect(d.every((r) => r.status !== 'red')).toBe(true);
    expect(d.filter((r) => r.status !== 'green').map((r) => `${r.checkName} ${r.date}`)).toEqual([
      'nav_premium 2026-01-07',
    ]);
    expect(d.map((r) => r.checkName)).toEqual(
      expect.arrayContaining(['distribution_match', 'issuer_stale']),
    );
    const health = await db
      .select()
      .from(schema.dataHealth)
      .where(and(eq(schema.dataHealth.symbolId, aaa), eq(schema.dataHealth.date, '2026-01-07')));
    expect(health[0]).toMatchObject({ status: 'yellow' });
    expect(health[0]!.reasons).toContain('D.nav_premium@iss');

    // The observed premium per fund and issuer source (every source with records). AAA's 8th is
    // graded red (a secondary's close is off): left out.
    const stats = await issuerStats(db, { from: '2026-01-01', to: '2026-01-08' });
    expect(stats.toleranceUnmatched).toEqual(['ZZZ']);
    expect(stats.rows.map((r) => `${r.ticker} ${r.source} ${r.days}`)).toEqual([
      'AAA iss 3',
      'AAA other 3',
    ]);
    expect(stats.rows[0]!.leftOut).toEqual({ standIn: 0, red: 1 });
    expect(stats.rows[0]!.max).toBeCloseTo(1 - 1 / 1.1, 12);
    expect(stats.rows[0]!.median).toBe(0);
    expect(stats.rows[0]!.tolerance).toBe(0.01);
    expect(stats.rows[1]!.median).toBeCloseTo(0.5, 12);
    expect((await issuerStats(db, { from: '2026-01-07', to: '2026-01-07' })).rows).toMatchObject([
      { days: 1 },
      { days: 1 },
    ]);
    expect((await issuerStats(db, { from: '2026-02-01', to: '2026-02-08' })).rows).toEqual([
      { ticker: 'AAA', source: 'iss', days: 0, tolerance: 0.01, leftOut: { standIn: 0, red: 0 } },
      { ticker: 'AAA', source: 'other', days: 0, tolerance: 0.01, leftOut: { standIn: 0, red: 0 } },
    ]);
  });

  it('stats leave out stand-in days and records before the period', async () => {
    const { db, store } = await setup({ aaaPrimaryDays: 3 });
    // The secondary's last close matches the index: it stands in for the primary's 8th.
    await store(
      'AAA',
      's',
      bars([100, 101, 101.51, 100.4949], (i) => ({ divCash: i === 2 ? 0.5 : 0 })),
    );
    await seedSourceRoles(db, [{ key: 'iss', dataKind: 'issuer', suggestedRole: 'check' }]);
    await issue(db, 'iss', (close) => close);
    const runId = await startRun(db, 'daily');
    await verify(db, { runId, sessions, mode: 'daily', from: '2026-01-06', to: '2026-01-08' });
    const standIn = await db
      .select()
      .from(schema.bars)
      .where(and(eq(schema.bars.date, '2026-01-08'), eq(schema.bars.standIn, true)));
    expect(standIn).toHaveLength(1);
    const period = { from: '2026-01-06', to: '2026-01-08' };
    const before = (await issuerStats(db, period)).rows[0]!;
    // The 5th is before the period and the 8th a stand-in: the 6th and 7th count.
    expect(before).toMatchObject({ days: 2, leftOut: { standIn: 1, red: 0 } });
    // Another record before the period changes nothing.
    await storeIssuerRecords(db, {
      symbolId: (await symbolId(db, 'AAA'))!,
      source: 'iss',
      records: [{ date: '2026-01-02', nav: 1, currency: 'USD' }],
      fetchedAt: 't2',
    });
    expect((await issuerStats(db, period)).rows[0]).toEqual(before);
  });

  it('compares only what an issuer source declares it publishes', async () => {
    const { db } = await setup();
    await seedSourceRoles(db, [
      { key: 'iss', dataKind: 'issuer', suggestedRole: 'check' },
      { key: 'iss2', dataKind: 'issuer', suggestedRole: 'check' },
    ]);
    // Both hold NAVs and the distribution of the 7th; one declares NAV only, one events only.
    await issue(db, 'iss', (close) => close);
    await issue(db, 'iss2', (close) => close);
    const runId = await startRun(db, 'daily');
    await verify(db, {
      runId,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
      issuerPublishes: { iss: { nav: true }, iss2: { distributions: true } },
    });
    const checks = async (source: string) => [
      ...new Set(
        (await layerDResults(db)).filter((r) => r.source === source).map((r) => r.checkName),
      ),
    ];
    expect((await checks('iss')).sort()).toEqual(['issuer_stale', 'nav_premium']);
    expect(await checks('iss2')).toEqual(['distribution_match']);
    // The premium statistics honor them too: no row for the source declaring no NAV.
    const period = { from: '2026-01-01', to: '2026-01-08' };
    expect((await issuerStats(db, period)).rows.map((r) => r.source)).toEqual(['iss', 'iss2']);
    const declared = await issuerStats(db, {
      ...period,
      publishes: { iss: { nav: true }, iss2: { distributions: true } },
    });
    expect(declared.rows.map((r) => r.source)).toEqual(['iss']);
  });

  it('a source whose plug-in is not loaded gets only its staleness (no inferred comparisons)', async () => {
    const { db } = await setup();
    await seedSourceRoles(db, [{ key: 'iss', dataKind: 'issuer', suggestedRole: 'check' }]);
    // NAV-only data stored earlier, far off the closes: inferred, it would be compared.
    await storeIssuerRecords(db, {
      symbolId: (await symbolId(db, 'AAA'))!,
      source: 'iss',
      records: dates.slice(0, 3).map((date) => ({ date, nav: 50, currency: 'USD' })),
      fetchedAt: 't',
    });
    await db
      .insert(schema.appSettings)
      .values({ key: 'issuer_nav_tolerance', value: '{"AAA":0.01}' });
    const runId = await startRun(db, 'daily');
    const summary = await verify(db, {
      runId,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
      issuers: [],
    });
    expect((await layerDResults(db)).map((r) => `${r.checkName} ${r.date} ${r.status}`)).toEqual([
      'issuer_stale 2026-01-08 yellow',
    ]);
    expect(summary.reasons).toContain('issuer_unavailable@iss');
  });

  it('grades a fund the issuer supports or failed for, with no NAV stored, yellow', async () => {
    const { db } = await setup();
    await seedSourceRoles(db, [
      { key: 'iss', dataKind: 'issuer', suggestedRole: 'check' },
      { key: 'iss2', dataKind: 'issuer', suggestedRole: 'check' },
    ]);
    await issue(db, 'iss', (close) => close);
    const runId = await startRun(db, 'daily');
    const summary = await verify(db, {
      runId,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
      issuers: [
        // AAA's NAV is on time; AAA2 failed this run and has nothing stored.
        { source: 'iss', supported: ['AAA', 'AAA2'], unavailable: ['AAA2'] },
        // Supports AAA, never delivered anything.
        { source: 'iss2', supported: ['AAA'], unavailable: [] },
        // No role: not used.
        { source: 'nobody', supported: ['AAA'], unavailable: ['AAA'] },
      ],
    });
    const stale = (await layerDResults(db))
      .filter((r) => r.checkName === 'issuer_stale')
      .map((r) => `${r.symbolId} ${r.source} ${r.status} ${r.message ?? ''}`);
    const [aaa, aaa2] = [(await symbolId(db, 'AAA'))!, (await symbolId(db, 'AAA2'))!];
    expect(stale.sort()).toEqual(
      [
        `${aaa} iss green `,
        `${aaa} iss2 yellow supported, no record stored`,
        `${aaa2} iss yellow not fetched, no NAV stored`,
      ].sort(),
    );
    expect(summary.reasons).toContain('issuer_unavailable@iss');
    expect(summary.reasons).not.toContain('issuer_unavailable@nobody');
    const health = await db
      .select()
      .from(schema.dataHealth)
      .where(and(eq(schema.dataHealth.symbolId, aaa2), eq(schema.dataHealth.date, '2026-01-08')));
    expect(health[0]!.reasons).toContain('D.issuer_stale@iss');
  });

  it('a source with a role but no loaded plug-in is unavailable, its funds never fresh', async () => {
    const { db } = await setup();
    await seedSourceRoles(db, [{ key: 'iss', dataKind: 'issuer', suggestedRole: 'check' }]);
    // NAVs up to the 7th: one session behind the 8th would be on time.
    await issue(db, 'iss', (close) => close, 3);
    const check = async (
      issuers: { source: string; supported: string[]; unavailable: string[] }[],
    ) => {
      const runId = await startRun(db, 'daily');
      const summary = await verify(db, {
        runId,
        sessions,
        mode: 'daily',
        from: '2026-01-06',
        to: '2026-01-08',
        issuers,
      });
      const [stale] = await db
        .select()
        .from(schema.checkResults)
        .where(
          and(
            eq(schema.checkResults.runId, runId),
            eq(schema.checkResults.checkName, 'issuer_stale'),
          ),
        );
      return { summary, stale };
    };
    // The run had no plug-in for it (no availability entry).
    const missing = await check([]);
    expect(missing.stale).toMatchObject({
      status: 'yellow',
      message: 'plug-in not loaded, latest NAV 2026-01-07',
    });
    expect(missing.summary.reasons).toContain('issuer_unavailable@iss');
    // Loaded and delivered: on time, and the day has no issuer reason.
    const loaded = await check([{ source: 'iss', supported: ['AAA'], unavailable: [] }]);
    expect(loaded.stale).toMatchObject({ status: 'green' });
    expect(loaded.summary.reasons).not.toContain('issuer_unavailable@iss');
  });

  it('an invalid stored tolerance does not stop verify: observed only, yellow, told', async () => {
    const { db } = await setup();
    await seedSourceRoles(db, [{ key: 'iss', dataKind: 'issuer', suggestedRole: 'check' }]);
    await issue(db, 'iss', (close, i) => (i === 2 ? close * 1.1 : close));
    // Only a hand edit can store this (the setting is validated when set).
    await db.insert(schema.appSettings).values({ key: 'issuer_nav_tolerance', value: '{"AAA":5}' });
    const runId = await startRun(db, 'daily');
    const summary = await verify(db, {
      runId,
      sessions,
      mode: 'daily',
      from: '2026-01-06',
      to: '2026-01-08',
    });
    expect(summary.toleranceInvalid).toBe(true);
    expect(summary.reasons).toContain('issuer_nav_tolerance_invalid');
    const d = await layerDResults(db);
    expect(d.filter((r) => r.checkName === 'nav_premium').every((r) => r.status === 'green')).toBe(
      true,
    );
    expect(d.filter((r) => r.checkName === 'nav_tolerance_invalid')).toEqual([
      expect.objectContaining({ date: '2026-01-08', status: 'yellow' }),
    ]);
  });
});
