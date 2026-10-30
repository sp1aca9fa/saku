import { type Db, schema, startRun, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import {
  WITHIN,
  defaultReadjustmentRun,
  levelOf,
  parseReadjustmentArgs,
  readjustmentRun,
  readjustmentStats,
  readjustmentText,
  spreadOf,
} from './readjustments';

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  return { db, id: (await symbolId(db, 'AAA'))! };
}

/** A stored bar (with its adjusted close, or none) and an event starting on its date. */
async function event(
  db: Db,
  o: {
    symbolId: number;
    source: string;
    date: string;
    factor: number;
    adjClose?: number | null;
    runId: string | null;
  },
) {
  if (o.adjClose !== undefined) {
    await db.insert(schema.barsRaw).values({
      symbolId: o.symbolId,
      date: o.date,
      source: o.source,
      close: 1,
      closeIsSplitAdjusted: false,
      divCash: 0,
      splitFactor: 1,
      providerAdjClose: o.adjClose,
      fetchedAt: 't',
    });
  }
  await db.insert(schema.readjustments).values({
    symbolId: o.symbolId,
    source: o.source,
    fromDate: o.date,
    toDate: o.date,
    factor: o.factor,
    detectedAt: 't',
    runId: o.runId,
  });
}

const day = (i: number) =>
  new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

describe('parseReadjustmentArgs', () => {
  it('takes --source and --run once each and refuses anything else', () => {
    expect(parseReadjustmentArgs([])).toEqual({});
    expect(parseReadjustmentArgs(['--source', 'x', '--run', 'r'])).toEqual({
      source: 'x',
      run: 'r',
    });
    expect(parseReadjustmentArgs(['--days', '3'])).toHaveProperty('error');
    expect(parseReadjustmentArgs(['--source'])).toHaveProperty('error');
    expect(parseReadjustmentArgs(['--source', '--run'])).toHaveProperty('error');
    expect(parseReadjustmentArgs(['--run', 'a', '--run', 'b'])).toHaveProperty('error');
    expect(parseReadjustmentArgs(['x'])).toHaveProperty('error');
  });
});

describe('spreadOf and levelOf', () => {
  it('gives type 7 quantiles, the maximum and the counts within each tolerance', () => {
    const s = spreadOf([4e-7, 1e-7, 3e-7, 2e-7, 5e-3]);
    expect(s.count).toBe(5);
    expect(s.p50).toBe(3e-7);
    expect(s.max).toBe(5e-3);
    expect(s.p90).toBeCloseTo(4e-7 + 0.6 * (5e-3 - 4e-7), 15);
    expect(s.within).toEqual(
      WITHIN.map((t) => [4e-7, 1e-7, 3e-7, 2e-7, 5e-3].filter((d) => d <= t).length),
    );
  });

  it('is empty without values (no quantile invented)', () => {
    expect(spreadOf([])).toEqual({ count: 0, within: WITHIN.map(() => 0) });
  });

  it('bands levels, unknown without a stored adjusted close', () => {
    expect([levelOf(9.99), levelOf(10), levelOf(99.9), levelOf(100), levelOf(null)]).toEqual([
      '<10',
      '10-100',
      '10-100',
      '>=100',
      'unknown',
    ]);
  });
});

describe('readjustmentStats', () => {
  it("reads one run's events per source, split by adjusted-close level", async () => {
    const { db, id } = await setup();
    const old = await startRun(db, 'bootstrap', new Date('2026-10-29T15:00:00Z'));
    const run = await startRun(db, 'bootstrap', new Date('2026-10-30T02:00:00Z'));
    const daily = await startRun(db, 'daily', new Date('2026-10-30T23:00:00Z'));
    // Noise at three levels plus one real dividend, from source `a`; one event from `b`.
    const a = [
      { adjClose: 5, factor: 1 + 2e-7 },
      { adjClose: 5, factor: 1 - 6e-7 },
      { adjClose: 50, factor: 1 + 1e-7 },
      { adjClose: 500, factor: 1 - 5e-8 },
      { adjClose: null, factor: 0.99 },
    ];
    for (const [i, e] of a.entries()) {
      await event(db, { symbolId: id, source: 'a', date: day(i), runId: run, ...e });
    }
    await event(db, { symbolId: id, source: 'b', date: day(0), factor: 1.5, runId: run });
    await event(db, { symbolId: id, source: 'a', date: day(9), factor: 2, runId: old });
    await event(db, { symbolId: id, source: 'a', date: day(10), factor: 3, runId: daily });

    // The default is the latest bootstrap or weekly run with any event (not the daily one).
    expect((await defaultReadjustmentRun(db))?.id).toBe(run);
    expect((await defaultReadjustmentRun(db, 'c'))?.id).toBeUndefined();

    const stats = await readjustmentStats(db, { runId: run });
    expect(stats.map((s) => [s.source, s.count])).toEqual([
      ['a', 5],
      ['b', 1],
    ]);
    const sa = stats[0]!;
    expect(sa.max).toBeCloseTo(0.01, 12);
    // Within 1e-6: the four noise events, not the dividend.
    expect(sa.within[WITHIN.indexOf(1e-6)]).toBe(4);
    expect(sa.byLevel.map((l) => [l.level, l.count])).toEqual([
      ['<10', 2],
      ['10-100', 1],
      ['>=100', 1],
      ['unknown', 1],
    ]);
    expect(sa.byLevel[0]!.max).toBeCloseTo(6e-7, 15);
    // `b` has no stored bar on its date: its level is unknown.
    expect(stats[1]!.byLevel.map((l) => l.level)).toEqual(['unknown']);

    const onlyB = await readjustmentStats(db, { runId: run, source: 'b' });
    expect(onlyB.map((s) => s.source)).toEqual(['b']);
    expect(await readjustmentStats(db, { runId: run, source: 'c' })).toEqual([]);

    const text = readjustmentText((await readjustmentRun(db, run))!, stats, (k) =>
      k === 'a' ? 1e-6 : undefined,
    );
    expect(text).toContain(`run ${run} (bootstrap`);
    expect(text).toContain('a (rounding: declared 1.00e-6)');
    expect(text).toContain('b (rounding: none declared, default 1.00e-9)');
    expect(text.split('\n').filter((l) => l.startsWith('<10 '))).toHaveLength(1);
  });

  it('says so when there are no events, and finds no default run', async () => {
    const { db } = await setup();
    expect(await defaultReadjustmentRun(db)).toBeUndefined();
    const run = await startRun(db, 'weekly');
    expect(await readjustmentStats(db, { runId: run })).toEqual([]);
    expect(readjustmentText((await readjustmentRun(db, run))!, [], () => undefined)).toContain(
      'No re-adjustment events.',
    );
    expect(await readjustmentRun(db, 'nope')).toBeUndefined();
  });
});
