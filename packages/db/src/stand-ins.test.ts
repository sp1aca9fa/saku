// Closed stand-ins in the database (requirements 04 stand-in rule 5): set once with the admin and
// reason, the row's values frozen; settled only while the canonical bar is that stand-in. The
// close command itself (admin, lock, refetch window) is tested in the plug-in SDK.
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { resolvedStandIns, unresolvedStandIns, upsertSymbols } from './market';
import { bars, standIns, symbols } from './schema';
import { closedStandIns, isOpenStandIn, standInList, standInMatchesBar } from './stand-ins';
import { testDb } from './testing';
import { createUser } from './users';

const CLOSED_AT = '2026-02-01T10:00:00.000Z';

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' },
  ]);
  const ids = Object.fromEntries(
    (await db.select().from(symbols)).map((s) => [s.ticker, s.id] as const),
  ) as Record<string, number>;
  const admin = await createUser(db, {
    username: 'ada',
    passwordHash: 'scrypt:x',
    totpSecretEnc: 'v1.x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
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
  const where = (ticker: string, date = '2026-01-07') =>
    and(eq(standIns.symbolId, ids[ticker]!), eq(standIns.date, date));
  const close = (ticker = 'AAA') =>
    db
      .update(standIns)
      .set({ closedAt: CLOSED_AT, closedBy: admin, closeReason: 'primary will not deliver' })
      .where(where(ticker));
  return { db, ids, admin, where, close };
}

describe('closed stand-ins in the database', () => {
  it('a closed row is frozen (triggers), yet a primary arriving later still resolves it', async () => {
    const { db, where, close } = await setup();
    await close();
    for (const set of [
      { close: 101 },
      { band: 0.01 },
      { source: 't' },
      { closeReason: 'changed' },
      { closedAt: null },
    ] as const) {
      await expect(db.update(standIns).set(set).where(where('AAA'))).rejects.toThrow();
    }
    await expect(db.delete(standIns).where(where('AAA'))).rejects.toThrow();
    // Resolution after the close: compared and recorded, the close untouched.
    await db
      .update(standIns)
      .set({ primaryClose: 100.5, deviation: 0.005, resolvedAt: '2026-02-02T21:30:00.000Z' })
      .where(where('AAA'));
    const [r] = (await resolvedStandIns(db)).filter(
      (s) => s.ticker === 'AAA' && s.date === '2026-01-07',
    );
    expect(r).toMatchObject({ closedAt: CLOSED_AT, deviation: 0.005 });
    expect((await closedStandIns(db))[0]).toMatchObject({
      closeReason: 'primary will not deliver',
      resolvedAt: '2026-02-02T21:30:00.000Z',
    });
  });

  it('a close without its admin or reason is refused by the database', async () => {
    const { db, ids, admin, where } = await setup();
    for (const set of [
      { closedAt: CLOSED_AT, closedBy: admin },
      { closedAt: CLOSED_AT, closedBy: admin, closeReason: ' ' },
      { closedAt: CLOSED_AT, closeReason: 'x' },
    ]) {
      await expect(db.update(standIns).set(set).where(where('BBB'))).rejects.toThrow();
    }
    await expect(
      db.insert(standIns).values({
        symbolId: ids.BBB!,
        date: '2026-01-06',
        source: 's',
        close: 1,
        band: 0.001,
        basis: 'index',
        closedAt: CLOSED_AT,
        closedBy: admin,
      }),
    ).rejects.toThrow();
    expect(await closedStandIns(db)).toEqual([]);
    // An open row still changes as before (a later run replaces an unresolved stand-in).
    await db.update(standIns).set({ close: 51 }).where(where('BBB'));
  });

  it('settled only while the canonical bar is that stand-in', async () => {
    const { db, ids, close } = await setup();
    await close();
    expect(await unresolvedStandIns(db)).toEqual([{ ticker: 'BBB', date: '2026-01-07' }]);
    // A later run builds the day from a revised value: open again (the close stays on record).
    const bar = and(eq(bars.symbolId, ids.AAA!), eq(bars.date, '2026-01-07'));
    await db.update(bars).set({ close: 100.4 }).where(bar);
    expect(await unresolvedStandIns(db)).toEqual([
      { ticker: 'AAA', date: '2026-01-07' },
      { ticker: 'BBB', date: '2026-01-07' },
    ]);
    // ...from another secondary, or refused (no canonical bar): open too.
    await db.update(bars).set({ close: 100, source: 's2' }).where(bar);
    expect((await unresolvedStandIns(db)).map((r) => r.ticker)).toEqual(['AAA', 'BBB']);
    await db.delete(bars).where(bar);
    expect((await unresolvedStandIns(db)).map((r) => r.ticker)).toEqual(['AAA', 'BBB']);
    expect(await closedStandIns(db)).toHaveLength(1);
    const row = { source: 's', close: 100 };
    expect(standInMatchesBar(row, { standIn: true, source: 's', close: 100 })).toBe(true);
    expect(standInMatchesBar(row, { standIn: false, source: 's', close: 100 })).toBe(false);
    expect(standInMatchesBar(row, undefined)).toBe(false);
    expect(isOpenStandIn({ ...row, resolvedAt: CLOSED_AT, closedAt: null }, undefined)).toBe(false);
  });

  it('lists every stand-in or the open ones, with its canonical bar', async () => {
    const { db, close } = await setup();
    await close();
    const all = await standInList(db);
    expect(all.map((r) => [r.ticker, r.date, r.closedBy, r.canonical])).toEqual([
      ['AAA', '2026-01-07', 'ada', { source: 's', standIn: true, close: 100, divCash: 0.25 }],
      ['BBB', '2026-01-07', null, null],
      ['AAA', '2026-01-08', null, null],
    ]);
    expect((await standInList(db, { open: true })).map((r) => [r.ticker, r.date])).toEqual([
      ['BBB', '2026-01-07'],
    ]);
  });
});
