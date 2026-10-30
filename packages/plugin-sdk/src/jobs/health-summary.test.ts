import type { CheckLayer, HealthStatus, JobType } from '@saku/core';
import { type Db, finishRun, schema, startRun, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import {
  DATE_CAP,
  DAY,
  NO_REASON,
  compareGroups,
  compareHealthGroups,
  defaultSummaryRun,
  findRun,
  groupDates,
  nonGreenChecks,
  reasonCode,
  runHasCheck,
  runSummary,
} from './health-summary';

let clock = Date.parse('2026-02-01T00:00:00Z');
async function run(
  db: Db,
  jobType: JobType,
  target: string,
  o: { finished?: boolean; ok?: boolean } = {},
) {
  const id = await startRun(db, jobType, new Date((clock += 60_000)));
  if (o.finished !== false) {
    await finishRun(db, id, { ok: o.ok !== false, datesProcessed: [target] });
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
  const result = (
    runId: string,
    o: {
      date: string;
      status: HealthStatus;
      check?: string;
      layer?: CheckLayer;
      symbol?: number | null;
      source?: string | null;
      observed?: number;
    },
  ) =>
    db.insert(schema.checkResults).values({
      runId,
      layer: o.layer ?? 'B',
      checkName: o.check ?? 'close_match',
      symbolId: o.symbol === undefined ? ids.AAA : o.symbol,
      source: o.source === undefined ? 's2' : o.source,
      date: o.date,
      status: o.status,
      observed: o.observed ?? null,
      expected: null,
      tolerance: 0.001,
      message: null,
    });
  const health = (runId: string, date: string, symbol: number | null, status: HealthStatus) =>
    db
      .insert(schema.dataHealth)
      .values({ runId, date, symbolId: symbol, status, reasons: status === 'green' ? [] : ['x'] });
  const summaryRow = (runId: string, check: string, checked: number, passed: number) =>
    db
      .insert(schema.checkSummaries)
      .values({ runId, layer: 'B', checkName: check, checked, passed, maxDeviation: null });
  return { db, ids, result, health, summaryRow };
}

describe('defaultSummaryRun', () => {
  it('takes the latest finished full-history run that stored something', async () => {
    const { db, result, health } = await setup();
    const bootstrap = await run(db, 'bootstrap', '2026-01-05');
    await health(bootstrap, '2026-01-05', null, 'green');
    const checks = await run(db, 'checks', '2026-01-06');
    await result(checks, { date: '2026-01-06', status: 'red' });
    // Skipped: a daily run, a full run still going, a full run that stored nothing.
    const daily = await run(db, 'daily', '2026-01-07');
    await result(daily, { date: '2026-01-07', status: 'red' });
    const going = await run(db, 'weekly', '2026-01-07', { finished: false });
    await result(going, { date: '2026-01-07', status: 'red' });
    await run(db, 'weekly', '2026-01-08', { ok: false });
    expect((await defaultSummaryRun(db))?.id).toBe(checks);
  });

  it('counts a failed full run that stored results, and none when nothing counts', async () => {
    const { db, result } = await setup();
    expect(await defaultSummaryRun(db)).toBeUndefined();
    const failed = await run(db, 'weekly', '2026-01-06', { ok: false });
    await result(failed, { date: '2026-01-06', status: 'yellow' });
    expect(await defaultSummaryRun(db)).toMatchObject({ id: failed, status: 'failed' });
  });

  it('findRun returns any run by id, and none for an unknown id', async () => {
    const { db } = await setup();
    const going = await run(db, 'daily', '2026-01-06', { finished: false });
    expect(await findRun(db, going)).toMatchObject({ jobType: 'daily', finishedAt: null });
    expect(await findRun(db, 'no-such-run')).toBeUndefined();
  });
});

describe('runSummary', () => {
  it('groups by status, layer, check, symbol or the day, and source; red first, then count', async () => {
    const { db, ids, result, summaryRow } = await setup();
    const id = await run(db, 'bootstrap', '2026-01-09');
    for (const date of ['2026-01-05', '2026-01-06', '2026-01-07']) {
      await result(id, { date, status: 'yellow', check: 'single', layer: 'A', source: 'p' });
    }
    for (const date of ['2026-01-08', '2026-01-06']) {
      await result(id, { date, status: 'red' });
    }
    await result(id, { date: '2026-01-07', status: 'red', symbol: ids.BBB, source: 's3' });
    await result(id, { date: '2026-01-09', status: 'red', symbol: ids.BBB, source: 's3' });
    await result(id, { date: '2026-01-07', status: 'yellow', symbol: ids.BBB, source: 's3' });
    await result(id, {
      date: '2026-01-05',
      status: 'yellow',
      check: 'fx_match',
      symbol: null,
      source: 'fx2',
    });
    await summaryRow(id, 'close_match', 100, 95);
    await summaryRow(id, 'single', 50, 47);
    await summaryRow(id, 'fx_match', 10, 9);
    const s = await runSummary(db, (await findRun(db, id))!);
    expect(s.nonGreen).toEqual({ red: 4, yellow: 5 });
    expect(s.green).toBe(151);
    // The per-check counts agree with what is stored (9 non-green).
    expect(s.summaryNonGreen).toBe(9);
    expect(s.allGreen).toBe(false);
    expect(
      s.groups.map((g) => [
        g.status,
        g.layer,
        g.check,
        g.symbol,
        g.source,
        g.count,
        g.first,
        g.last,
      ]),
    ).toEqual([
      ['red', 'B', 'close_match', 'AAA', 's2', 2, '2026-01-06', '2026-01-08'],
      ['red', 'B', 'close_match', 'BBB', 's3', 2, '2026-01-07', '2026-01-09'],
      ['yellow', 'A', 'single', 'AAA', 'p', 3, '2026-01-05', '2026-01-07'],
      ['yellow', 'B', 'close_match', 'BBB', 's3', 1, '2026-01-07', '2026-01-07'],
      ['yellow', 'B', 'fx_match', DAY, 'fx2', 1, '2026-01-05', '2026-01-05'],
    ]);
  });

  it('never takes a green count it does not know as 0, and counts non-green health rows', async () => {
    const { db, ids, health } = await setup();
    const id = await run(db, 'weekly', '2026-01-06');
    await health(id, '2026-01-05', null, 'green');
    await health(id, '2026-01-06', null, 'yellow');
    await health(id, '2026-01-06', ids.AAA, 'yellow');
    await health(id, '2026-01-05', ids.BBB, 'red');
    const s = await runSummary(db, (await findRun(db, id))!);
    expect(s.green).toBeUndefined();
    expect(s.summaryNonGreen).toBeUndefined();
    expect(s.nonGreen).toEqual({ red: 0, yellow: 0 });
    expect(s.health).toEqual({ day: { red: 0, yellow: 1 }, symbol: { red: 1, yellow: 1 } });
    // No non-green check result, but the health rows are not green: not all green.
    expect(s.allGreen).toBe(false);
  });

  it('a run with only green rows is all green; a daily run counts its stored green results', async () => {
    const { db, result, health, summaryRow } = await setup();
    const full = await run(db, 'checks', '2026-01-05');
    await health(full, '2026-01-05', null, 'green');
    await summaryRow(full, 'close_match', 20, 20);
    expect(await runSummary(db, (await findRun(db, full))!)).toMatchObject({
      allGreen: true,
      green: 20,
      summaryNonGreen: 0,
      groups: [],
    });
    const daily = await run(db, 'daily', '2026-01-06');
    await result(daily, { date: '2026-01-06', status: 'green' });
    await result(daily, { date: '2026-01-05', status: 'green' });
    await result(daily, { date: '2026-01-06', status: 'yellow' });
    expect(await runSummary(db, (await findRun(db, daily))!)).toMatchObject({
      green: 2,
      nonGreen: { red: 0, yellow: 1 },
      allGreen: false,
    });
  });

  it('a summary of one run leaves out every other run', async () => {
    const { db, result } = await setup();
    const a = await run(db, 'bootstrap', '2026-01-05');
    const b = await run(db, 'bootstrap', '2026-01-06');
    await result(a, { date: '2026-01-05', status: 'red' });
    await result(b, { date: '2026-01-06', status: 'yellow' });
    const s = await runSummary(db, (await findRun(db, a))!);
    expect(s.nonGreen).toEqual({ red: 1, yellow: 0 });
    expect(s.groups).toHaveLength(1);
  });
});

describe('runSummary health groups', () => {
  it("groups the run's own non-green health rows by status, stored reason and symbol", async () => {
    const { db, ids } = await setup();
    const row = (
      runId: string,
      date: string,
      symbol: number | null,
      status: HealthStatus,
      reasons: string[],
    ) => db.insert(schema.dataHealth).values({ runId, date, symbolId: symbol, status, reasons });
    const id = await run(db, 'bootstrap', '2026-01-09');
    await row(id, '2026-01-05', ids.AAA, 'yellow', ['single_source']);
    await row(id, '2026-01-07', ids.AAA, 'yellow', ['single_source']);
    // Two reasons: counted under each, with the row's status.
    await row(id, '2026-01-06', ids.AAA, 'red', ['primary_missing', 'single_source']);
    await row(id, '2026-01-06', null, 'red', ['AAA', 'SP500:stale(7)@src']);
    await row(id, '2026-01-08', null, 'yellow', ['AAA']);
    // A non-green row without a reason is shown, never dropped.
    await row(id, '2026-01-09', ids.BBB, 'red', []);
    // Green rows and other runs' rows are left out.
    await row(id, '2026-01-09', null, 'green', []);
    const other = await run(db, 'bootstrap', '2026-01-09');
    await row(other, '2026-01-05', ids.AAA, 'red', ['primary_missing']);

    const s = await runSummary(db, (await findRun(db, id))!);
    expect(
      s.healthGroups.map((g) => [g.status, g.reason, g.symbol, g.count, g.first, g.last]),
    ).toEqual([
      ['red', NO_REASON, 'BBB', 1, '2026-01-09', '2026-01-09'],
      ['red', 'AAA', DAY, 1, '2026-01-06', '2026-01-06'],
      ['red', 'SP500:stale(7)@src', DAY, 1, '2026-01-06', '2026-01-06'],
      ['red', 'primary_missing', 'AAA', 1, '2026-01-06', '2026-01-06'],
      ['red', 'single_source', 'AAA', 1, '2026-01-06', '2026-01-06'],
      ['yellow', 'single_source', 'AAA', 2, '2026-01-05', '2026-01-07'],
      ['yellow', 'AAA', DAY, 1, '2026-01-08', '2026-01-08'],
    ]);
    expect(s.health).toEqual({ day: { red: 1, yellow: 1 }, symbol: { red: 2, yellow: 2 } });
    expect(s.groups).toEqual([]);
    expect(s.allGreen).toBe(false);
  });

  it('has no health groups when every row is green', async () => {
    const { db, health } = await setup();
    const id = await run(db, 'checks', '2026-01-05');
    await health(id, '2026-01-05', null, 'green');
    const s = await runSummary(db, (await findRun(db, id))!);
    expect(s.healthGroups).toEqual([]);
    expect(s.allGreen).toBe(true);
  });

  it('orders red before yellow, then by count, reason and symbol', () => {
    const g = (status: HealthStatus, count: number, reason: string) => ({
      status,
      reason,
      symbol: DAY,
      count,
      first: '2026-01-05',
      last: '2026-01-05',
    });
    expect(
      [g('yellow', 9, 'a'), g('red', 1, 'b'), g('red', 1, 'a'), g('red', 3, 'z')].sort(
        compareHealthGroups,
      ),
    ).toEqual([g('red', 3, 'z'), g('red', 1, 'a'), g('red', 1, 'b'), g('yellow', 9, 'a')]);
  });
});

describe('groupDates', () => {
  it("lists a check's non-green dates by date, filtered by symbol, the day and source", async () => {
    const { db, ids, result } = await setup();
    const id = await run(db, 'bootstrap', '2026-01-09');
    await result(id, { date: '2026-01-08', status: 'red', observed: 0.5 });
    await result(id, { date: '2026-01-06', status: 'yellow' });
    await result(id, { date: '2026-01-07', status: 'green' });
    await result(id, { date: '2026-01-07', status: 'red', symbol: ids.BBB, source: 's3' });
    await result(id, { date: '2026-01-05', status: 'red', symbol: null, source: 'fx2' });
    await result(id, { date: '2026-01-05', status: 'red', check: 'other' });

    const all = await groupDates(db, id, { check: 'close_match' });
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => [r.date, r.symbol, r.status])).toEqual([
      ['2026-01-05', DAY, 'red'],
      ['2026-01-06', 'AAA', 'yellow'],
      ['2026-01-07', 'BBB', 'red'],
      ['2026-01-08', 'AAA', 'red'],
    ]);
    expect(all.rows[3]).toMatchObject({ observed: 0.5, expected: null, tolerance: 0.001 });

    const aaa = await groupDates(db, id, { check: 'close_match', symbolId: ids.AAA });
    expect(aaa.rows.map((r) => r.date)).toEqual(['2026-01-06', '2026-01-08']);
    const day = await groupDates(db, id, { check: 'close_match', symbolId: null });
    expect(day.rows.map((r) => r.source)).toEqual(['fx2']);
    const s3 = await groupDates(db, id, { check: 'close_match', source: 's3' });
    expect(s3.rows.map((r) => r.symbol)).toEqual(['BBB']);
    const none = await groupDates(db, id, { check: 'close_match', source: 'nope' });
    expect(none).toEqual({ rows: [], total: 0 });
  });

  it('caps the listing and still counts every result', async () => {
    const { db } = await setup();
    const id = await run(db, 'bootstrap', '2026-12-31');
    const rows = Array.from({ length: DATE_CAP + 5 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return {
        runId: id,
        layer: 'A' as const,
        checkName: 'missing_day',
        symbolId: null,
        source: 'p',
        date: d,
        status: 'red' as const,
      };
    });
    await db.insert(schema.checkResults).values(rows);
    const out = await groupDates(db, id, { check: 'missing_day' });
    expect(out.total).toBe(DATE_CAP + 5);
    expect(out.rows).toHaveLength(DATE_CAP);
    expect(out.rows[0]!.date).toBe('2025-01-01');
    expect(out.rows.at(-1)!.date).toBe(rows[DATE_CAP - 1]!.date);
    expect((await groupDates(db, id, { check: 'missing_day' }, 3)).rows).toHaveLength(3);
  });

  it("knows a run's checks: green-only ones from its per-check counts", async () => {
    const { db, result, summaryRow } = await setup();
    const id = await run(db, 'bootstrap', '2026-01-09');
    await result(id, { date: '2026-01-06', status: 'red', check: 'zeta' });
    await result(id, { date: '2026-01-06', status: 'yellow', check: 'alpha' });
    await summaryRow(id, 'all_green', 10, 10);
    expect(await runHasCheck(db, id, 'zeta')).toBe(true);
    expect(await runHasCheck(db, id, 'all_green')).toBe(true);
    expect(await runHasCheck(db, id, 'unknown')).toBe(false);
    expect(await nonGreenChecks(db, id)).toEqual(['alpha', 'zeta']);
  });
});

describe('helpers', () => {
  it('reason codes match the health rows', () => {
    expect(reasonCode({ layer: 'B', check: 'close_match', source: 's2' })).toBe('B.close_match@s2');
    expect(reasonCode({ layer: 'C', check: 'index_match', source: null })).toBe('C.index_match');
  });

  it('orders red before yellow whatever the count', () => {
    const g = (status: HealthStatus, count: number) => ({
      status,
      layer: 'A' as const,
      check: 'c',
      symbol: 'AAA',
      source: null,
      count,
      first: '2026-01-05',
      last: '2026-01-05',
    });
    expect([g('yellow', 100), g('red', 1), g('red', 5)].sort(compareGroups)).toEqual([
      g('red', 5),
      g('red', 1),
      g('yellow', 100),
    ]);
  });
});
