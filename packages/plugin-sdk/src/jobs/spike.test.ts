import { finishRun, schema, seedSourceRoles, startRun, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { spikeReport } from './spike';

type Result = typeof schema.checkResults.$inferInsert;

async function day(
  db: Awaited<ReturnType<typeof testDb>>,
  date: string,
  results: Omit<Result, 'runId' | 'date'>[],
) {
  const runId = await startRun(db, 'daily', new Date(`${date}T23:00:00Z`));
  await finishRun(db, runId, { ok: true, datesProcessed: [date] });
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
    // The primary failed, then a later rerun for the same date succeeded: the latest run counts.
    await day(db, '2026-01-07', []);
    await day(db, '2026-01-07', good);

    const report = await spikeReport(db);
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
});
