import { Sessions } from '@saku/data';
import { finishRun, schema, seedSourceRoles, startRun, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { spikeReport } from './spike';

type Result = typeof schema.checkResults.$inferInsert;

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-12-01',
  validTo: '2026-12-31',
  holidays: [],
});

type Db = Awaited<ReturnType<typeof testDb>>;
let clock = 0;

/** A daily run for `target` storing results per date (its window); started in call order. */
async function runFor(
  db: Db,
  target: string,
  byDate: Record<string, Omit<Result, 'runId' | 'date'>[]>,
  o: { ok?: boolean; finished?: boolean } = {},
) {
  const runId = await startRun(
    db,
    'daily',
    new Date(Date.UTC(2026, 0, 1) + ++clock * 1000),
    target,
  );
  if (o.finished !== false)
    await finishRun(db, runId, { ok: o.ok ?? true, datesProcessed: [target] });
  for (const [date, results] of Object.entries(byDate)) {
    if (results.length)
      await db.insert(schema.checkResults).values(results.map((r) => ({ ...r, runId, date })));
  }
  return runId;
}

const day = (
  db: Db,
  date: string,
  results: Omit<Result, 'runId' | 'date'>[],
  o: { ok?: boolean; finished?: boolean } = {},
) => runFor(db, date, { [date]: results }, o);

async function setup(o: { indexed?: boolean } = {}) {
  const db = await testDb();
  await upsertSymbols(db, [
    {
      ticker: 'AAA',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      ...(o.indexed && { indexSeries: 'IDX' }),
    },
  ]);
  await seedSourceRoles(db, [
    { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
    { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
  ]);
  return { db, aaa: (await symbolId(db, 'AAA'))! };
}

const ok = (
  layer: 'A' | 'B' | 'C',
  checkName: string,
  source: string | null = null,
): Omit<Result, 'runId' | 'date'> => ({
  layer,
  checkName,
  source,
  status: 'green',
});

describe('spikeReport', () => {
  it('computes the gate from each day’s latest daily run', async () => {
    const db = await testDb();
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await seedSourceRoles(db, [
      { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    await day(db, '2026-01-05', good);
    // The secondary missed a day: not available, and B is not counted for that day.
    const missed = await day(db, '2026-01-06', [
      ok('A', 'bar_valid', 'p'),
      {
        layer: 'B',
        checkName: 'close_match',
        source: 's',
        status: 'yellow',
        message: 'no secondary bar',
      },
      ok('C', 'leverage_track'),
    ]);
    // A run that stored nothing, then a later rerun for the same date: the rerun counts.
    await day(db, '2026-01-07', []);
    await day(db, '2026-01-07', good);

    const report = await spikeReport(db, { sessions });
    expect(report.days.map((d) => [d.date, d.primaryOk, d.available.s])).toEqual([
      ['2026-01-05', true, true],
      ['2026-01-06', true, false],
      ['2026-01-07', true, true],
    ]);
    expect(report.availability.s).toBeCloseTo(2 / 3, 12);
    expect(report.layerB).toEqual({ days: 2, passed: 2 });
    expect(report.layerC).toEqual({ days: 3, passed: 3 });
    expect(report.passed).toBe(false); // 67% availability is below 95%
    expect(report.days[1]!.nonGreen).toEqual([
      {
        layer: 'B',
        check: 'close_match',
        source: 's',
        status: 'yellow',
        message: 'no secondary bar',
        runId: missed,
      },
    ]);
  });

  it('counts every session in the range; one without a finished run fails (no run)', async () => {
    const db = await testDb();
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await seedSourceRoles(db, [
      { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    await day(db, '2026-01-05', good);
    // 01-06: no run at all. 01-07: a run still going (or crashed): not finished, no run.
    await day(db, '2026-01-07', good, { finished: false });
    // 01-08: a run that finished failed (a source incomplete) counts by what it stored.
    await day(db, '2026-01-08', good, { ok: false });
    // 01-09 and 01-12 (a weekend between): no run, inside the range the caller names.

    const report = await spikeReport(db, { sessions, to: '2026-01-12' });
    expect(report.days.map((d) => [d.date, d.primaryOk, d.reason ?? null])).toEqual([
      ['2026-01-05', true, null],
      ['2026-01-06', false, 'no_run'],
      ['2026-01-07', false, 'no_run'],
      ['2026-01-08', true, null],
      ['2026-01-09', false, 'no_run'],
      ['2026-01-12', false, 'no_run'],
    ]);
    const missing = report.days[1]!;
    expect(missing).toMatchObject({
      runId: null,
      available: { s: false },
      layerBPass: false,
      layerCPass: false,
    });
    expect(report.primaryOkDays).toBe(2);
    expect(report.availability.s).toBeCloseTo(2 / 6, 12);
    expect(report.layerB).toEqual({ days: 2, passed: 2 });
    expect(report.layerC).toEqual({ days: 6, passed: 2 });
    expect(report.passed).toBe(false);
  });

  it('reports nothing measured as not passed', async () => {
    const db = await testDb();
    const report = await spikeReport(db, { sessions });
    expect(report).toMatchObject({ days: [], primaryOkDays: 0, passed: false });
  });

  it('starts at the earliest daily run of any status (a crashed first run counts as no run)', async () => {
    const { db } = await setup();
    const good = [ok('A', 'bar_valid', 'p'), ok('B', 'close_match', 's')];
    await day(db, '2026-01-02', good, { finished: false });
    await day(db, '2026-01-05', good);
    const report = await spikeReport(db, { sessions });
    expect(report.days.map((d) => [d.date, d.reason ?? null])).toEqual([
      ['2026-01-02', 'no_run'],
      ['2026-01-05', null],
    ]);
  });

  it('a secondary is available when any finished run for the day got its bars', async () => {
    const { db } = await setup();
    await day(db, '2026-01-05', [ok('A', 'bar_valid', 'p'), ok('B', 'close_match', 's')], {
      ok: false,
    });
    // A rerun the same day no longer gets the secondary's bar: it was available that day.
    await day(db, '2026-01-05', [
      ok('A', 'bar_valid', 'p'),
      {
        layer: 'B',
        checkName: 'close_match',
        source: 's',
        status: 'yellow',
        message: 'no secondary bar',
      },
    ]);
    const report = await spikeReport(db, { sessions });
    expect(report.days[0]).toMatchObject({ available: { s: true }, layerBPass: false });
    expect(report.availability.s).toBe(1);
  });

  it('the open session is pending, not failed, until its run finishes', async () => {
    const { db } = await setup();
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    await day(db, '2026-01-05', good);
    // The target's run is still going.
    await day(db, '2026-01-06', good, { finished: false });
    const report = await spikeReport(db, { sessions, to: '2026-01-06', open: '2026-01-06' });
    expect(report.days.map((d) => [d.date, d.reason ?? null])).toEqual([
      ['2026-01-05', null],
      ['2026-01-06', 'pending'],
    ]);
    // The verdict covers the judged sessions; the pending one is listed, never counted.
    expect(report.primaryOkDays).toBe(1);
    expect(report.layerC).toEqual({ days: 1, passed: 1 });
    expect(report).toMatchObject({ pending: 1, through: '2026-01-05', passed: true });
    // Once the window closed (the next target), the same session is a failure.
    const later = await spikeReport(db, { sessions, to: '2026-01-07', open: '2026-01-07' });
    expect(later.days[1]).toMatchObject({ date: '2026-01-06', reason: 'no_run' });
  });

  it("reads layer C from the latest run covering the date, so the next run's index check counts", async () => {
    const { db, aaa } = await setup({ indexed: true });
    const base = [
      { ...ok('A', 'bar_valid', 'p'), symbolId: aaa },
      { ...ok('B', 'close_match', 's'), symbolId: aaa },
    ];
    const index = { ...ok('C', 'index_match', 'idx'), symbolId: aaa };
    // The run for 01-05 has no index value for it yet (published after the run).
    await day(db, '2026-01-05', base);
    let report = await spikeReport(db, { sessions });
    expect(report.days[0]).toMatchObject({ layerCPass: false, layerCPending: true });
    expect(report).toMatchObject({ pending: 1, passed: false, layerC: { days: 0, passed: 0 } });
    expect(report.through).toBeUndefined();

    // The next run checks 01-05 in its window; 01-06 now waits for the index.
    const next = await runFor(db, '2026-01-06', {
      '2026-01-05': [...base, index],
      '2026-01-06': base,
    });
    report = await spikeReport(db, { sessions });
    expect(report.days.map((d) => [d.date, d.layerCPass, d.layerCPending ?? false])).toEqual([
      ['2026-01-05', true, false],
      ['2026-01-06', false, true],
    ]);
    expect(report.days[0]!.layerCRunId).toBe(next);
    expect(report.layerC).toEqual({ days: 1, passed: 1 });
    expect(report).toMatchObject({ through: '2026-01-05', passed: true, pending: 1 });

    // A later run that stored nothing for 01-06 did not check it: still pending.
    await runFor(db, '2026-01-07', { '2026-01-07': [...base, index] });
    report = await spikeReport(db, { sessions });
    expect(report.days[1]).toMatchObject({ date: '2026-01-06', layerCPending: true });
    // Pending from 01-06 on: 01-07 is listed, not judged, though its own layer C is green.
    expect(report).toMatchObject({ through: '2026-01-05', pending: 2 });

    // A later run that stored 01-06 without an index result: no longer pending, not passed.
    await runFor(db, '2026-01-08', { '2026-01-06': base, '2026-01-08': [...base, index] });
    report = await spikeReport(db, { sessions });
    expect(report.days[1]).toMatchObject({ date: '2026-01-06', layerCPass: false });
    expect(report.days[1]!.layerCPending).toBeUndefined();
    // 01-08's own run had its index (the test's simplification): judged through 01-08.
    expect(report.layerC).toEqual({ days: 4, passed: 3 });
    expect(report).toMatchObject({ through: '2026-01-08', pending: 0, passed: false });
  });

  it('a failure at decision time is never dropped by a later index check', async () => {
    const { db, aaa } = await setup({ indexed: true });
    const base = [
      { ...ok('A', 'bar_valid', 'p'), symbolId: aaa },
      { ...ok('B', 'close_match', 's'), symbolId: aaa },
    ];
    const green = { ...ok('C', 'index_match', 'idx'), symbolId: aaa };
    const stale = { ...green, checkName: 'index_unavailable', status: 'yellow' as const };
    // The day's own run could not check the index (yellow); the next run's check is green.
    const own = await day(db, '2026-01-05', [...base, stale]);
    await runFor(db, '2026-01-06', {
      '2026-01-05': [...base, green],
      '2026-01-06': [...base, green],
    });
    let report = await spikeReport(db, { sessions });
    expect(report.days[0]).toMatchObject({ layerCPass: false });
    expect(report.days[0]!.nonGreen).toEqual([
      expect.objectContaining({ check: 'index_unavailable', status: 'yellow', runId: own }),
    ]);

    // Green at decision time, the later index check red: not passed, listed with its run.
    const db2 = (await setup({ indexed: true })).db;
    await day(db2, '2026-01-05', [...base, green]);
    const later = await runFor(db2, '2026-01-06', {
      '2026-01-05': [...base, { ...green, status: 'red' as const }],
      '2026-01-06': [...base, green],
    });
    report = await spikeReport(db2, { sessions });
    expect(report.days[0]).toMatchObject({ layerCPass: false, layerCRunId: later });
    expect(report.days[0]!.nonGreen).toEqual([
      expect.objectContaining({ check: 'index_match', status: 'red', runId: later }),
    ]);
  });
});
