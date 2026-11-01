// Red re-check rows (requirements 04 "Red re-check before execution"; migrations 0014, 0015): what
// a row records is never changed, each later column is set once, no row is deleted; a sending time
// is recorded only for a message that reached a channel.
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeRecheck, insertRecheck, markRecheckSent, openRechecks, recheckOf } from './rechecks';
import { redRechecks } from './schema';
import { annotationsOf, registerVersion } from './strategies';
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
    const told = (at: string) => ({ channels: 1, at });
    expect(await markRecheckSent(db, row.id, 'provisional', told('2026-01-10T01:31:00.000Z'))).toBe(
      true,
    );
    expect(await markRecheckSent(db, row.id, 'provisional', told('2026-01-10T02:31:00.000Z'))).toBe(
      false,
    );
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
    // A sending time with no channel count, or a count of none with a time, is refused.
    await expect(
      db.update(redRechecks).set({ provisionalSentAt: '2026-01-10T01:31:00.000Z' }).where(where),
    ).rejects.toHaveProperty('cause.message', expect.stringMatching(/channels/));
    await expect(
      db
        .update(redRechecks)
        .set({ provisionalSentAt: '2026-01-10T01:31:00.000Z', provisionalChannels: 0 })
        .where(where),
    ).rejects.toHaveProperty('cause.message', expect.stringMatching(/channels/));
    await expect(
      db.update(redRechecks).set({ provisionalChannels: 1 }).where(where),
    ).rejects.toHaveProperty('cause.message', expect.stringMatching(/channels/));
    await markRecheckSent(db, row.id, 'provisional', {
      channels: 1,
      at: '2026-01-10T01:31:00.000Z',
    });
    await expect(
      db.update(redRechecks).set({ provisionalSentAt: null }).where(where),
    ).rejects.toThrow();
    await expect(
      db.update(redRechecks).set({ provisionalChannels: 2 }).where(where),
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

  it('a final told to no channel: closed, counted 0, no sending time and no annotation', async () => {
    const { db, version, row } = await setup();
    await closeRecheck(db, row.id, {
      finalAt: '2026-01-12T13:20:00.000Z',
      finalRunId: null,
      outcome: 'safe_state',
    });
    // A time without a channel, or a channel without a time, is refused before any write.
    await expect(
      markRecheckSent(db, row.id, 'final', { channels: 0, at: '2026-01-12T13:21:00.000Z' }),
    ).rejects.toThrow(/at least one channel/);
    await expect(markRecheckSent(db, row.id, 'final', { channels: 1, at: null })).rejects.toThrow(
      /at least one channel/,
    );
    await expect(markRecheckSent(db, row.id, 'final', { channels: -1, at: null })).rejects.toThrow(
      /whole number/,
    );
    expect(await markRecheckSent(db, row.id, 'final', { channels: 0, at: null })).toBe(true);
    expect(await recheckOf(db, version.id, '2026-01-09')).toMatchObject({
      finalSentAt: null,
      finalChannels: 0,
    });
    expect(await annotationsOf(db, version.id, 'red_recheck_sent')).toEqual([]);
    // Marked once: a later delivery is not recorded over it.
    expect(
      await markRecheckSent(db, row.id, 'final', { channels: 1, at: '2026-01-12T13:22:00.000Z' }),
    ).toBe(false);
    await expect(
      db.update(redRechecks).set({ finalChannels: null }).where(eq(redRechecks.id, row.id)),
    ).rejects.toThrow();
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
