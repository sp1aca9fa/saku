import type { HealthStatus, JobType, RawBar } from '@saku/core';
import { NO_SECONDARY_BAR, Sessions } from '@saku/data';
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
  /**
   * A full-history pass that found every date up to `graded` green: the overall rows, and each
   * symbol's graded range (from `cover[id]`, default the first date; none for `cover[id] = null`).
   */
  const full = async (
    jobType: JobType,
    target: string,
    graded = target,
    cover: Record<number, string | null> = {},
  ) => {
    const id = await run(db, jobType, target);
    for (const [symbol, from] of Object.values(ids).map((x) => [x, cover[x] ?? D[0]] as const)) {
      if (cover[symbol] === null) continue;
      await db
        .insert(schema.healthCoverage)
        .values({ runId: id, symbolId: symbol, fromDate: from, toDate: graded });
    }
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

  it('a run that failed before storing anything does not hide an older red', async () => {
    const { db, daily } = await setup();
    const red = await daily(D[3], { [D[3]]: 'red' });
    await run(db, 'weekly', D[3], { error: 'Error: no primary bar source' });
    await run(db, 'daily', D[3], { error: 'Error: database is locked' });
    const [day] = await healthReport(db, { dates: [D[3]], sessions });
    expect(day).toMatchObject({ overall: { status: 'red' }, green: false, run: { id: red } });
  });

  it('a full-history run without the overall row is not graded, even with summaries', async () => {
    const { db, daily } = await setup();
    await daily(D[3]);
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
    await full('weekly', D[3], D[3], { [ids.BBB]: D[3] });
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

  it('an active symbol with no bar yet is left out before its inception date', async () => {
    const { db, full } = await setup();
    await upsertSymbols(db, [{ ticker: 'CCC', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await db
      .update(schema.symbols)
      .set({ inceptionDate: D[3] })
      .where(eq(schema.symbols.ticker, 'CCC'));
    await full('weekly', D[3]);
    const [before, on] = await healthReport(db, { dates: [D[2], D[3]], sessions });
    expect(before!.green).toBe(true);
    // From its inception on, data should exist: not graded.
    expect(on!.symbols.map((s) => `${s.ticker} ${s.grade.status}`)).toEqual(['CCC not_graded']);
  });

  it('a symbol the full-history run did not grade is not graded (added later, or an old run)', async () => {
    const { db, ids, full } = await setup();
    await full('weekly', D[3], D[3], { [ids.BBB]: null });
    // Added with its history after the run: canonical bars, but no range in that run.
    await upsertSymbols(db, [{ ticker: 'CCC', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    const ccc = (await symbolId(db, 'CCC'))!;
    await db
      .insert(schema.bars)
      .values(D.map((date) => ({ symbolId: ccc, date, close: 1, source: 'p' })));
    const [day] = await healthReport(db, { dates: [D[2]], sessions });
    expect(day!.overall.status).toBe('green');
    // BBB: no range in that run (as in a run from before the coverage was stored).
    expect(day!.symbols.map((s) => `${s.ticker} ${s.grade.status}`)).toEqual([
      'BBB not_graded',
      'CCC not_graded',
    ]);
    expect(day!.green).toBe(false);
  });

  it('a symbol is green from a full-history run only inside its graded range', async () => {
    const { db, ids, full } = await setup();
    await full('weekly', D[3], D[3], { [ids.BBB]: D[2] });
    const [d1, d2] = await healthReport(db, { dates: [D[1], D[2]], sessions });
    expect(d1!.symbols).toEqual([{ ticker: 'BBB', grade: { status: 'not_graded', reasons: [] } }]);
    expect(d2!.green).toBe(true);
  });

  it("a cash-red day stays red after a later run that did not grade that day's cash rate", async () => {
    const { db, ids, health } = await setup();
    const store = async (runId: string, date: string, status: HealthStatus, reasons: string[]) => {
      await health(runId, date, ids.AAA, 'green', []);
      await health(runId, date, ids.BBB, 'green', []);
      await health(runId, date, null, status, reasons);
    };
    // Each run grades the cash rate on its own date only.
    const stale = await run(db, 'daily', D[1]);
    await store(stale, D[0], 'green', []);
    await store(stale, D[1], 'yellow', ['DTB3:stale(3)@fred']);
    const first = await run(db, 'daily', D[2]);
    for (const d of [D[0], D[1]]) await store(first, d, 'green', []);
    await store(first, D[2], 'red', ['DTB3:missing@fred']);
    const next = await run(db, 'daily', D[3]);
    for (const d of D) await store(next, d, 'green', []);
    const [d0, d1, d2, d3] = await healthReport(db, { dates: [...D], sessions });
    expect(d2).toMatchObject({
      overall: { status: 'red', reasons: ['DTB3:missing@fred'] },
      green: false,
      run: { id: next },
    });
    // A stale rate keeps its own grade (3 business days behind: yellow).
    expect(d1!.overall).toEqual({ status: 'yellow', reasons: ['DTB3:stale(3)@fred'] });
    expect(d0!.green).toBe(true);
    expect(d3!.green).toBe(true);
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

  it('reads an old-style missing secondary bar as secondary_missing; a real disagreement stays', async () => {
    const { db, ids, health } = await setup();
    const result = (runId: string, symbol: number, status: HealthStatus, message: string | null) =>
      db.insert(schema.checkResults).values({
        runId,
        layer: 'B',
        checkName: 'close_match',
        symbolId: symbol,
        source: 's',
        date: D[3],
        status,
        observed: message === null ? 1.1 : null,
        expected: message === null ? 1 : null,
        tolerance: 0.001,
        message,
      });
    // An older run's missing-bar result for BBB is not used: only the run that stored the row.
    const older = await run(db, 'daily', D[3]);
    await result(older, ids.BBB, 'yellow', NO_SECONDARY_BAR);
    // An older run's real disagreement for AAA must not replace the deciding run's reading.
    await result(older, ids.AAA, 'yellow', null);
    const id = await run(db, 'daily', D[3]);
    // AAA: stored before secondary_missing existed, plus the new code (read twice, listed once).
    await result(id, ids.AAA, 'yellow', NO_SECONDARY_BAR);
    await health(id, D[3], ids.AAA, 'yellow', ['B.close_match@s', 'B.secondary_missing@s']);
    // BBB: the closes really differ.
    await result(id, ids.BBB, 'yellow', null);
    await health(id, D[3], ids.BBB, 'yellow', ['B.close_match@s', 'single_source']);
    await health(id, D[3], null, 'yellow', ['AAA', 'BBB']);
    const [day] = await healthReport(db, { dates: [D[3]], sessions });
    expect(day).toMatchObject({
      overall: { status: 'yellow', reasons: ['AAA', 'BBB'] },
      symbols: [
        { ticker: 'AAA', grade: { status: 'yellow', reasons: ['B.secondary_missing@s'] } },
        {
          ticker: 'BBB',
          grade: { status: 'yellow', reasons: ['B.close_match@s', 'single_source'] },
        },
      ],
      green: false,
      run: { id },
    });
    // Stored rows untouched.
    const stored = await db
      .select({ symbolId: schema.dataHealth.symbolId, reasons: schema.dataHealth.reasons })
      .from(schema.dataHealth)
      .where(eq(schema.dataHealth.runId, id));
    expect(stored.find((r) => r.symbolId === ids.AAA)!.reasons).toEqual([
      'B.close_match@s',
      'B.secondary_missing@s',
    ]);
    expect(stored.find((r) => r.symbolId === ids.BBB)!.reasons).toEqual([
      'B.close_match@s',
      'single_source',
    ]);
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
    // rows (no symbol row) and AAA's graded range.
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
    const coverage = await db
      .select()
      .from(schema.healthCoverage)
      .where(eq(schema.healthCoverage.runId, weekly));
    expect(coverage).toEqual([
      { runId: weekly, symbolId: (await symbolId(db, 'AAA'))!, fromDate: D[0], toDate: D[3] },
    ]);
    const second = await healthReport(db, { dates: [...D], sessions });
    expect(second.every((d) => d.green && d.run?.id === weekly)).toBe(true);
  });

  it('a symbol with canonical bars but no primary bar is red primary_missing, not left out', async () => {
    const db = await testDb();
    await upsertSymbols(db, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
      { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' },
    ]);
    await seedSourceRoles(db, [
      { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    const aaa = (await symbolId(db, 'AAA'))!;
    const bbb = (await symbolId(db, 'BBB'))!;
    for (const source of ['p', 's']) {
      await storeRawBars(db, {
        symbolId: aaa,
        source,
        bars: closes.map((c, i) => bar(D[i]!, c)),
        runId: null,
        fetchedAt: 't',
      });
    }
    // BBB's canonical history came from an earlier primary; the current one has none of it.
    await db
      .insert(schema.bars)
      .values(D.slice(1).map((date) => ({ symbolId: bbb, date, close: 1, source: 'old' })));
    await storeRawBars(db, {
      symbolId: bbb,
      source: 's',
      bars: closes.map((c, i) => bar(D[i]!, c)),
      runId: null,
      fetchedAt: 't',
    });
    const weekly = await run(db, 'weekly', D[3], { finished: false });
    await verify(db, { runId: weekly, sessions, mode: 'full', to: D[3] });
    await finishRun(db, weekly, { ok: true, datesProcessed: [D[3]] });
    const report = await healthReport(db, { dates: [...D], sessions });
    // From its first canonical bar on: red, and the day overall with it.
    expect(report[0]!.green).toBe(true);
    for (const day of report.slice(1)) {
      expect(day.overall).toEqual({ status: 'red', reasons: ['BBB'] });
      expect(day.symbols).toEqual([
        { ticker: 'BBB', grade: { status: 'red', reasons: ['primary_missing'] } },
      ]);
    }
    const coverage = await db
      .select()
      .from(schema.healthCoverage)
      .where(eq(schema.healthCoverage.symbolId, bbb));
    expect(coverage).toMatchObject([{ fromDate: D[1], toDate: D[3] }]);
  });
});
