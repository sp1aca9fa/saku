// Closing a stand-in (requirements 04 stand-in rule 5): only an admin, with a reason, once; the
// stand-in's values stay; nothing waits on it any more.
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { resolvedStandIns, unresolvedStandIns, upsertSymbols } from './market';
import { activityLog, bars, standIns, symbols, users } from './schema';
import { closeStandIn, closedStandIns, standInList } from './stand-ins';
import { testDb } from './testing';
import { createUser } from './users';

const account = (username: string, isAdmin: boolean) => ({
  username,
  passwordHash: 'scrypt:x',
  totpSecretEnc: 'v1.x',
  totpLastStep: 1,
  backupCodeHashes: [username],
  isAdmin,
});

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' },
  ]);
  const ids = Object.fromEntries(
    (await db.select().from(symbols)).map((s) => [s.ticker, s.id] as const),
  ) as Record<string, number>;
  const admin = await createUser(db, account('ada', true));
  await createUser(db, account('bo', false));
  const row = (ticker: string, date: string, over: Partial<typeof standIns.$inferInsert> = {}) => ({
    symbolId: ids[ticker]!,
    date,
    source: 's',
    close: 100,
    band: 0.001,
    basis: 'index',
    createdAt: '2026-01-07T21:30:00.000Z',
    ...over,
  });
  await db
    .insert(standIns)
    .values([
      row('AAA', '2026-01-07'),
      row('AAA', '2026-01-08', { resolvedAt: '2026-01-09T21:30:00.000Z', deviation: 0.002 }),
      row('BBB', '2026-01-07', { close: 50 }),
    ]);
  // AAA 01-07 still stands in (a distribution day); BBB 01-07 was refused by a later run.
  await db.insert(bars).values({
    symbolId: ids.AAA!,
    date: '2026-01-07',
    close: 100,
    divCash: 0.25,
    source: 's',
    standIn: true,
  });
  const close = (over: Partial<Parameters<typeof closeStandIn>[1]> = {}) =>
    closeStandIn(db, {
      ticker: 'AAA',
      date: '2026-01-07',
      username: 'ada',
      reason: 'primary will not deliver',
      now: new Date('2026-02-01T10:00:00Z'),
      ...over,
    });
  return { db, ids, admin, close };
}

describe('closing a stand-in', () => {
  it('refuses a missing, disabled or non-admin account, an empty reason, an unknown stand-in', async () => {
    const { db, close } = await setup();
    const refused = async (over: Parameters<typeof close>[0], error: RegExp) => {
      const r = await close(over);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(error);
    };
    // Wrong user: an account that is not an admin is refused before anything is read.
    await refused({ username: 'bo' }, /bo is not an admin/);
    await refused({ username: 'nobody' }, /No account nobody/);
    await db
      .update(users)
      .set({ disabledAt: '2026-01-01T00:00:00Z' })
      .where(eq(users.username, 'bo'));
    await refused({ username: 'bo' }, /bo is disabled/);
    await refused({ reason: '' }, /Give the reason/);
    await refused({ reason: '   ' }, /Give the reason/);
    await refused({ date: '2026-02-30' }, /not a date/);
    await refused({ ticker: 'ZZZ' }, /No stand-in for ZZZ on 2026-01-07/);
    await refused({ date: '2026-01-09' }, /No stand-in for AAA on 2026-01-09/);
    await refused({ date: '2026-01-08' }, /the primary replaced it at 2026-01-09T21:30:00.000Z/);
    // Nothing was written.
    expect(
      await db.select().from(activityLog).where(eq(activityLog.action, 'stand_in.close')),
    ).toEqual([]);
    expect(await closedStandIns(db)).toEqual([]);
  });

  it('records the close once, logged; the values stay; nothing waits on it any more', async () => {
    const { db, ids, admin, close } = await setup();
    const before = (await db.select().from(standIns).where(eq(standIns.symbolId, ids.AAA!)))[0];
    expect(await close({ reason: '  primary will not deliver  ' })).toEqual({
      ok: true,
      closedAt: '2026-02-01T10:00:00.000Z',
      userId: admin,
    });
    const [after] = await db
      .select()
      .from(standIns)
      .where(and(eq(standIns.symbolId, ids.AAA!), eq(standIns.date, '2026-01-07')));
    expect(after).toEqual({
      ...before,
      closedAt: '2026-02-01T10:00:00.000Z',
      closedBy: admin,
      closeReason: 'primary will not deliver',
    });
    const [log] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, 'stand_in.close'));
    expect(log).toMatchObject({
      actor: admin,
      detail: {
        username: 'ada',
        ticker: 'AAA',
        date: '2026-01-07',
        source: 's',
        close: 100,
        reason: 'primary will not deliver',
      },
    });
    // Settled: no longer among the open ones (corrections stop waiting on it).
    expect(await unresolvedStandIns(db)).toEqual([{ ticker: 'BBB', date: '2026-01-07' }]);
    expect(await closedStandIns(db)).toEqual([
      {
        ticker: 'AAA',
        date: '2026-01-07',
        runId: null,
        createdAt: '2026-01-07T21:30:00.000Z',
        closedAt: '2026-02-01T10:00:00.000Z',
        closeReason: 'primary will not deliver',
        resolvedAt: null,
      },
    ]);
    // Once: a second close is refused, and the first stays.
    const again = await close({ reason: 'other' });
    expect(!again.ok && again.error).toMatch(/already closed at 2026-02-01T10:00:00.000Z/);
    expect(
      await db.select().from(activityLog).where(eq(activityLog.action, 'stand_in.close')),
    ).toHaveLength(1);
  });

  it('a closed row is frozen (triggers), yet a primary arriving later still resolves it', async () => {
    const { db, ids, close } = await setup();
    await close();
    const where = and(eq(standIns.symbolId, ids.AAA!), eq(standIns.date, '2026-01-07'));
    for (const set of [
      { close: 101 },
      { band: 0.01 },
      { source: 't' },
      { closeReason: 'changed' },
      { closedAt: null },
    ] as const) {
      await expect(db.update(standIns).set(set).where(where)).rejects.toThrow();
    }
    await expect(db.delete(standIns).where(where)).rejects.toThrow();
    // Resolution after the close: compared and recorded, the close untouched.
    await db
      .update(standIns)
      .set({ primaryClose: 100.5, deviation: 0.005, resolvedAt: '2026-02-02T21:30:00.000Z' })
      .where(where);
    const [r] = (await resolvedStandIns(db)).filter(
      (s) => s.ticker === 'AAA' && s.date === '2026-01-07',
    );
    expect(r).toMatchObject({ closedAt: '2026-02-01T10:00:00.000Z', deviation: 0.005 });
    expect((await closedStandIns(db))[0]).toMatchObject({
      closeReason: 'primary will not deliver',
      resolvedAt: '2026-02-02T21:30:00.000Z',
    });
  });

  it('a close without its admin or reason is refused by the database too', async () => {
    const { db, ids, admin } = await setup();
    const where = and(eq(standIns.symbolId, ids.BBB!), eq(standIns.date, '2026-01-07'));
    const at = '2026-02-01T10:00:00.000Z';
    await expect(
      db.update(standIns).set({ closedAt: at, closedBy: admin }).where(where),
    ).rejects.toThrow();
    await expect(
      db.update(standIns).set({ closedAt: at, closedBy: admin, closeReason: ' ' }).where(where),
    ).rejects.toThrow();
    await expect(
      db.update(standIns).set({ closedAt: at, closeReason: 'x' }).where(where),
    ).rejects.toThrow();
    await expect(
      db.insert(standIns).values({
        symbolId: ids.BBB!,
        date: '2026-01-06',
        source: 's',
        close: 1,
        band: 0.001,
        basis: 'index',
        closedAt: at,
        closedBy: admin,
      }),
    ).rejects.toThrow();
    expect(await closedStandIns(db)).toEqual([]);
    // An open row still changes as before (a later run replaces an unresolved stand-in).
    await db.update(standIns).set({ close: 51 }).where(where);
    const [count] = await db.all<{ n: number }>(sql`select count(*) as n from stand_ins`);
    expect(count!.n).toBe(3);
  });

  it('lists every stand-in or the open ones, with its canonical bar', async () => {
    const { db, close } = await setup();
    await close();
    const all = await standInList(db);
    expect(all.map((r) => [r.ticker, r.date, r.closedBy, r.canonical])).toEqual([
      ['AAA', '2026-01-07', 'ada', { source: 's', standIn: true, divCash: 0.25 }],
      ['BBB', '2026-01-07', null, null],
      ['AAA', '2026-01-08', null, null],
    ]);
    expect((await standInList(db, { open: true })).map((r) => [r.ticker, r.date])).toEqual([
      ['BBB', '2026-01-07'],
    ]);
  });
});
