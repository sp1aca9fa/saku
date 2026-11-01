// Red re-check rows (requirements 04 "Red re-check before execution"; migration 0014): what a row
// records is never changed, each later column is set once, no row is deleted.
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeRecheck, insertRecheck, markRecheckSent, openRechecks, recheckOf } from './rechecks';
import { redRechecks } from './schema';
import { registerVersion } from './strategies';
import { testDb } from './testing';

const provisional = {
  allocation: 'Safe state',
  holdings: [{ ticker: 'AAA', weight: 100 }],
  dataStatus: 'red' as const,
  reasons: ['AAA:B.close_match@s'],
  signals: { A: true },
  ties: [],
};

async function setup() {
  const db = await testDb();
  const version = await registerVersion(db, { ownerId: null, name: 'V', strategy: { v: 1 } });
  const row = await insertRecheck(db, {
    versionId: version.id,
    date: '2026-01-09',
    firstRedAt: '2026-01-10T01:30:00.000Z',
    firstRunId: null,
    deadline: '2026-01-12T13:30:00.000Z',
    provisional,
  });
  return { db, version, row };
}

describe('red re-checks', () => {
  it('opens, records the sending times once, closes once', async () => {
    const { db, version, row } = await setup();
    expect(row).toMatchObject({ reasons: provisional.reasons, provisional, outcome: null });
    expect((await openRechecks(db)).map((r) => r.id)).toEqual([row.id]);
    await markRecheckSent(db, row.id, 'provisional', '2026-01-10T01:31:00.000Z');
    await markRecheckSent(db, row.id, 'provisional', '2026-01-10T02:31:00.000Z');
    expect((await recheckOf(db, version.id, '2026-01-09'))!.provisionalSentAt).toBe(
      '2026-01-10T01:31:00.000Z',
    );
    await closeRecheck(db, row.id, {
      finalAt: '2026-01-12T13:20:00.000Z',
      finalRunId: null,
      outcome: 'safe_state',
    });
    expect(await openRechecks(db)).toEqual([]);
    // A second close never overwrites the final.
    await expect(
      closeRecheck(db, row.id, {
        finalAt: '2026-01-12T14:20:00.000Z',
        finalRunId: null,
        outcome: 'cleared',
      }),
    ).rejects.toThrow(/not open/);
    expect(await recheckOf(db, version.id, '2026-01-09')).toMatchObject({
      outcome: 'safe_state',
      finalAt: '2026-01-12T13:20:00.000Z',
    });
  });

  it('refuses changes to what it recorded, a second row for the day, and deletes', async () => {
    const { db, version, row } = await setup();
    const where = eq(redRechecks.id, row.id);
    await expect(db.update(redRechecks).set({ reasons: [] }).where(where)).rejects.toThrow();
    await expect(
      db.update(redRechecks).set({ deadline: '2026-01-12T14:30:00.000Z' }).where(where),
    ).rejects.toThrow();
    await expect(db.update(redRechecks).set({ firstRedAt: 'x' }).where(where)).rejects.toThrow();
    // An outcome without its time (or the reverse) is refused.
    await expect(db.update(redRechecks).set({ outcome: 'cleared' }).where(where)).rejects.toThrow();
    await expect(db.delete(redRechecks).where(where)).rejects.toThrow();
    await expect(
      insertRecheck(db, {
        versionId: version.id,
        date: '2026-01-09',
        firstRedAt: '2026-01-10T02:30:00.000Z',
        firstRunId: null,
        deadline: '2026-01-12T13:30:00.000Z',
        provisional,
      }),
    ).rejects.toThrow();
    await markRecheckSent(db, row.id, 'provisional', '2026-01-10T01:31:00.000Z');
    await expect(
      db.update(redRechecks).set({ provisionalSentAt: null }).where(where),
    ).rejects.toThrow();
    expect(
      (
        await db
          .select()
          .from(redRechecks)
          .where(sql`1 = 1`)
      ).length,
    ).toBe(1);
  });

  it('a late first grading is recorded closed at once (not_rechecked)', async () => {
    const { db, version } = await setup();
    const row = await insertRecheck(db, {
      versionId: version.id,
      date: '2026-01-12',
      firstRedAt: '2026-01-12T13:00:00.000Z',
      firstRunId: null,
      deadline: '2026-01-13T13:30:00.000Z',
      provisional,
      notRechecked: { finalRunId: null },
    });
    expect(row).toMatchObject({ outcome: 'not_rechecked', finalAt: '2026-01-12T13:00:00.000Z' });
    expect((await openRechecks(db)).map((r) => r.date)).toEqual(['2026-01-09']);
  });
});
