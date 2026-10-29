import type { HealthStatus, JobType, RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  type Db,
  finishRun,
  schema,
  seedSourceRoles,
  startRun,
  storeRawBars,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { healthReport, latestGradedDate, latestRun } from './health';
import { verify } from './verify';

// A daily run's window reaches 10 sessions back, so the calendar starts well before the dates.
const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'] as const;

let clock = Date.parse('2026-02-01T00:00:00Z');
/** A finished run for `target`, started after every earlier one. */
async function run(
  db: Db,
  jobType: JobType,
  target: string,
  o: { finished?: boolean; error?: string } = {},
) {
  const now = new Date((clock += 60_000));
  const id = await startRun(db, jobType, now);
  if (o.finished !== false) {
    await finishRun(db, id, {
      ok: !o.error,
      datesProcessed: [target],
      ...(o.error && { error: o.error }),
    });
  }
  return id;
}

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' },
  ]);
  const ids = { AAA: (await symbolId(db, 'AAA'))!, BBB: (await symbolId(db, 'BBB'))! };
  // Canonical bars from the first date (a symbol's history starts at its first one).
  for (const id of Object.values(ids)) {
    await db
      .insert(schema.bars)
      .values(D.map((date) => ({ symbolId: id, date, close: 1, source: 'p' })));
  }
  const health = (
    runId: string,
    date: string,
    symbol: number | null,
    status: HealthStatus,
    reasons: string[],
  ) => db.insert(schema.dataHealth).values({ runId, date, symbolId: symbol, status, reasons });
  /** A full-history pass that found every date up to `graded` green: the overall rows only. */
  const full = async (jobType: JobType, target: string, graded = target) => {
    const id = await run(db, jobType, target);
    for (const date of D.filter((d) => d <= graded)) await health(id, date, null, 'green', []);
    return id;
  };
  /** A daily run that graded every date of its window green except what `except` says. */
  const daily = async (target: string, except: Record<string, HealthStatus> = {}) => {
    const id = await run(db, 'daily', target);
    for (const date of D.filter((d) => d <= target)) {
      const bad = except[date];
      await health(id, date, ids.AAA, bad ?? 'green', bad ? ['B.close_match@s'] : []);
      await health(id, date, ids.BBB, 'green', []);
      await health(id, date, null, bad ?? 'green', bad ? ['AAA'] : []);
    }
    return id;
  };
  return { db, ids, health, full, daily };
}

describe('healthReport', () => {
  it('a later full-history run that found the day green overrides an older daily red', async () => {
    const { db, full, daily } = await setup();
    await daily(D[3], { [D[2]]: 'red' });
    const before = await healthReport(db, { dates: [D[2]], sessions });
    expect(before[0]).toMatchObject({
      overall: { status: 'red', reasons: ['AAA'] },
      symbols: [{ ticker: 'AAA', grade: { status: 'red', reasons: ['B.close_match@s'] } }],
      green: false,
    });
    const weekly = await full('weekly', D[3]);
    const [day] = await healthReport(db, { dates: [D[2]], sessions });
    expect(day).toMatchObject({
      overall: { status: 'green' },
      symbols: [],
      green: true,
      run: { id: weekly, jobType: 'weekly', target: D[3] },
    });
  });

  it('a later daily red overrides an older full-history green', async () => {
    const { db, full, daily } = await setup();
    await full('bootstrap', D[3]);
    await daily(D[3], { [D[3]]: 'yellow' });
    const [day] = await healthReport(db, { dates: [D[3]], sessions });
    expect(day!.overall.status).toBe('yellow');
    expect(day!.green).toBe(false);
  });

  it("a daily run's missing row is not graded, never green", async () => {
    const { db, ids, health } = await setup();
    const id = await run(db, 'daily', D[3]);
    await health(id, D[3], ids.AAA, 'green', []);
    await health(id, D[3], null, 'green', []);
    const [d2, d3] = await healthReport(db, { dates: [D[2], D[3]], sessions });
    // The date in its window with no row at all.
    expect(d2).toMatchObject({ overall: { status: 'not_graded' }, green: false });
    // Overall green, but BBB has no row: listed, and the day is not green.
    expect(d3).toMatchObject({
      overall: { status: 'green' },
      symbols: [{ ticker: 'BBB', grade: { status: 'not_graded' } }],
      green: false,
    });
  });

  it('a date outside every run is not graded', async () => {
    const { db, daily } = await setup();
    await daily(D[2]);
    const [after] = await healthReport(db, { dates: [D[3]], sessions });
    expect(after).toEqual({
      date: D[3],
      overall: { status: 'not_graded', reasons: [] },
      symbols: [],
      green: false,
    });
  });

  it("covers a daily run's window only: DAILY_OVERLAP sessions before its target", async () => {
    const { db, ids, health } = await setup();
    const target = '2026-01-20';
    const first = sessions.before(target, 10); // 2026-01-06
    const id = await run(db, 'daily', target);
    for (const date of [D[0], first]) {
      await health(id, date, ids.AAA, 'green', []);
      await health(id, date, ids.BBB, 'green', []);
      await health(id, date, null, 'green', []);
    }
    const [outside, inside] = await healthReport(db, { dates: [D[0], first], sessions });
    expect(first).toBe(D[1]);
    // A row the run stored outside its window does not count (verify never stores one there).
    expect(outside).toMatchObject({ overall: { status: 'not_graded' }, green: false });
    expect(outside!.run).toBeUndefined();
    expect(inside).toMatchObject({ overall: { status: 'green' }, green: true });
  });

  it('a full-history run without the overall row is not graded, even with summaries', async () => {
    const { db, daily } = await setup();
    await daily(D[3]);
    // It failed before grading: no rows at all.
    await run(db, 'weekly', D[3], { error: 'Error: no primary bar source' });
    const [day] = await healthReport(db, { dates: [D[3]], sessions });
    expect(day).toMatchObject({ overall: { status: 'not_graded' }, green: false });
    // Its checks ran (a summary) but it graded no day (no primary bars): still not graded.
    const id = await run(db, 'checks', D[3]);
    await db
      .insert(schema.checkSummaries)
      .values({ runId: id, layer: 'A', checkName: 'bar_valid', checked: 8, passed: 8 });
    const [again] = await healthReport(db, { dates: [D[3]], sessions });
    expect(again).toMatchObject({ overall: { status: 'not_graded' }, green: false });
    expect(again!.run?.id).toBe(id);
  });

  it('a full-history run: green only on the dates it graded, nothing after its target', async () => {
    const { db, full } = await setup();
    await full('checks', D[2], D[1]);
    const [early, ok, ungraded, late] = await healthReport(db, {
      dates: ['2026-01-02', D[1], D[2], D[3]],
      sessions,
    });
    expect(early!.overall.status).toBe('not_graded');
    expect(ok!.green).toBe(true);
    // No overall row: neither the day nor any symbol was graded.
    expect(ungraded!.overall.status).toBe('not_graded');
    expect(ungraded!.symbols.map((x) => `${x.ticker} ${x.grade.status}`)).toEqual([
      'AAA not_graded',
      'BBB not_graded',
    ]);
    expect(late!.overall.status).toBe('not_graded');
    expect(late!.run).toBeUndefined();
  });

  it("a full-history run's non-green result without a health row is not graded", async () => {
    const { db, ids, full } = await setup();
    const id = await full('weekly', D[3]);
    await db.insert(schema.checkResults).values({
      runId: id,
      layer: 'A',
      checkName: 'bar_valid',
      symbolId: ids.BBB,
      source: 's',
      date: D[3],
      status: 'red',
    });
    const [day] = await healthReport(db, { dates: [D[3]], sessions });
    expect(day!.symbols).toEqual([{ ticker: 'BBB', grade: { status: 'not_graded', reasons: [] } }]);
    expect(day!.green).toBe(false);
  });

  it('symbols before their history are left out unless their inception says data should exist', async () => {
    const { db, ids, full } = await setup();
    await db.delete(schema.bars).where(eq(schema.bars.symbolId, ids.BBB));
    await db.insert(schema.bars).values({ symbolId: ids.BBB, date: D[3], close: 1, source: 'p' });
    await full('weekly', D[3]);
    const [day] = await healthReport(db, { dates: [D[1]], sessions });
    expect(day!.green).toBe(true);
    await db
      .update(schema.symbols)
      .set({ inceptionDate: D[0] })
      .where(eq(schema.symbols.id, ids.BBB));
    const [again] = await healthReport(db, { dates: [D[1]], sessions });
    expect(again!.symbols).toEqual([
      { ticker: 'BBB', grade: { status: 'not_graded', reasons: [] } },
    ]);
  });

  it('an active symbol with no canonical bar is not graded', async () => {
    const { db, full } = await setup();
    await upsertSymbols(db, [{ ticker: 'CCC', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await full('weekly', D[3]);
    const [day] = await healthReport(db, { dates: [D[3]], sessions });
    expect(day!.overall.status).toBe('green');
    expect(day!.symbols.map((s) => `${s.ticker} ${s.grade.status}`)).toEqual(['CCC not_graded']);
    expect(day!.green).toBe(false);
  });

  it('a run still going does not count; the header sees it', async () => {
    const { db, daily } = await setup();
    await daily(D[3], { [D[3]]: 'red' });
    await run(db, 'weekly', D[3], { finished: false });
    const [day] = await healthReport(db, { dates: [D[3]], sessions });
    expect(day!.overall.status).toBe('red');
    expect(await latestRun(db)).toMatchObject({ jobType: 'weekly', status: 'running' });
    expect(await latestGradedDate(db, sessions)).toBe(D[3]);
  });

  it('nothing graded yet: no latest date, every date not graded', async () => {
    const db = await testDb();
    expect(await latestGradedDate(db, sessions)).toBeUndefined();
    expect(await latestRun(db)).toBeUndefined();
    const [day] = await healthReport(db, { dates: [D[0]], sessions });
    expect(day!.green).toBe(false);
  });
});

describe('healthReport on what verify stores', () => {
  const bar = (date: string, close: number): RawBar => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    closeIsSplitAdjusted: false,
    volume: 1000,
    divCash: 0,
    splitFactor: 1,
  });
  const closes = [100, 101, 102, 101];

  it('shows the daily red, then the corrected full pass green', async () => {
    const db = await testDb();
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await seedSourceRoles(db, [
      { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    const store = async (source: string, list: number[]) =>
      storeRawBars(db, {
        symbolId: (await symbolId(db, 'AAA'))!,
        source,
        bars: list.map((c, i) => bar(D[i]!, c)),
        runId: null,
        fetchedAt: 't',
      });
    await store('p', closes);
    // The secondary's last close is wrong (layer B mismatch above 2x tolerance: red).
    await store('s', [...closes.slice(0, 3), 110]);
    const daily = await run(db, 'daily', D[3], { finished: false });
    await verify(db, {
      runId: daily,
      sessions,
      mode: 'daily',
      from: sessions.before(D[3], 10),
      to: D[3],
    });
    await finishRun(db, daily, { ok: true, datesProcessed: [D[3]] });
    const first = await healthReport(db, { dates: [...D], sessions });
    expect(first.map((d) => d.overall.status)).toEqual(['green', 'green', 'green', 'red']);
    expect(first[3]!.symbols).toEqual([
      { ticker: 'AAA', grade: { status: 'red', reasons: ['B.close_match@s'] } },
    ]);

    // The secondary corrects its close (a revision); the weekly pass stores only green overall
    // rows (no symbol row).
    await store('s', closes);
    const weekly = await run(db, 'weekly', D[3], { finished: false });
    await verify(db, { runId: weekly, sessions, mode: 'full', to: D[3] });
    await finishRun(db, weekly, { ok: true, datesProcessed: [D[3]] });
    const rows = await db
      .select()
      .from(schema.dataHealth)
      .where(eq(schema.dataHealth.runId, weekly));
    expect(rows.map((r) => `${r.date} ${r.symbolId} ${r.status}`)).toEqual(
      D.map((d) => `${d} null green`),
    );
    const second = await healthReport(db, { dates: [...D], sessions });
    expect(second.every((d) => d.green && d.run?.id === weekly)).toBe(true);
  });
});
