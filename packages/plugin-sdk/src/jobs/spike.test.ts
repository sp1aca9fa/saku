import { Sessions } from '@saku/data';
import { finishRun, schema, seedSourceRoles, startRun, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { spikeReport } from './spike';

type Result = typeof schema.checkResults.$inferInsert;

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});

async function day(
  db: Awaited<ReturnType<typeof testDb>>,
  date: string,
  results: Omit<Result, 'runId' | 'date'>[],
  o: { ok?: boolean; finished?: boolean } = {},
) {
  const runId = await startRun(db, 'daily', new Date(`${date}T23:00:00Z`));
  if (o.finished !== false)
    await finishRun(db, runId, { ok: o.ok ?? true, datesProcessed: [date] });
  if (results.length)
    await db.insert(schema.checkResults).values(results.map((r) => ({ ...r, runId, date })));
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
    await day(db, '2026-01-06', [
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
});
