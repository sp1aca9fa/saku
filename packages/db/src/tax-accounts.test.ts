import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { activityLog, appSettings, userTaxAccounts } from './schema';
import { getSetting, setSetting, userTaxDataExists } from './settings';
import { closeTaxAccount, openTaxAccount, taxAccountsOf } from './tax-accounts';
import { testDb } from './testing';
import { createUser } from './users';

const user = (username: string) => ({
  username,
  passwordHash: 'scrypt:x',
  totpSecretEnc: 'v1.x',
  totpLastStep: 100,
  backupCodeHashes: ['a'],
  isAdmin: false,
});

const regime = { key: 'examplia', accountTypes: ['taxable', 'saver'] };

async function setup(taxRegime: string | null = 'examplia') {
  const db = await testDb();
  const alice = await createUser(db, user('alice'));
  const bob = await createUser(db, user('bob'));
  if (taxRegime !== null)
    await db.insert(appSettings).values({ key: 'tax_regime', value: taxRegime });
  return { db, alice, bob };
}

describe('tax accounts', () => {
  it('opens, lists and closes a user account; a reopened account is a new row', async () => {
    const { db, alice } = await setup();
    expect(await taxAccountsOf(db, alice)).toEqual([]);
    expect(await userTaxDataExists(db)).toBe(false);
    const id = await openTaxAccount(db, alice, {
      regime,
      accountType: 'saver',
      openedOn: '2026-01-05',
    });
    // A row locks the install's tax regime (USER_TAX_TABLES).
    expect(await userTaxDataExists(db)).toBe(true);
    expect(await taxAccountsOf(db, alice)).toMatchObject([
      { id, accountType: 'saver', openedOn: '2026-01-05', closedOn: null },
    ]);
    await expect(openTaxAccount(db, alice, { regime, accountType: 'saver' })).rejects.toThrow(
      /already has an open saver account/,
    );
    await closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-06-30' });
    await expect(
      closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-07-01' }),
    ).rejects.toThrow(/No open saver account/);
    const again = await openTaxAccount(db, alice, {
      regime,
      accountType: 'saver',
      openedOn: '2026-07-01',
    });
    const list = await taxAccountsOf(db, alice);
    expect(list.map((a) => [a.id, a.closedOn])).toEqual([
      [id, '2026-06-30'],
      [again, null],
    ]);
    const log = await db.select().from(activityLog);
    expect(log.map((l) => l.action)).toEqual(
      expect.arrayContaining(['tax_account.open', 'tax_account.close']),
    );
  });

  it('never stores the implied taxable account, nor a type the regime lacks', async () => {
    const { db, alice } = await setup();
    await expect(openTaxAccount(db, alice, { regime, accountType: 'taxable' })).rejects.toThrow(
      /implied for every user/,
    );
    await expect(
      closeTaxAccount(db, alice, { accountType: 'taxable', closedOn: '2026-01-05' }),
    ).rejects.toThrow(/implied for every user/);
    await expect(openTaxAccount(db, alice, { regime, accountType: 'pension' })).rejects.toThrow(
      /has no account type pension/,
    );
    // The table refuses `taxable` too, whatever writes it.
    await expect(
      db.insert(userTaxAccounts).values({ ownerId: alice, accountType: 'taxable' }),
    ).rejects.toThrow();
    expect(await taxAccountsOf(db, alice)).toEqual([]);
  });

  it('opens only under the regime the install is set to', async () => {
    const unset = await setup(null);
    await expect(
      openTaxAccount(unset.db, unset.alice, { regime, accountType: 'saver' }),
    ).rejects.toThrow(/tax regime is not set/);
    const other = await setup('otherland');
    await expect(
      openTaxAccount(other.db, other.alice, { regime, accountType: 'saver' }),
    ).rejects.toThrow(/tax regime is otherland, not examplia/);
    const { db } = await setup();
    await expect(openTaxAccount(db, 'nobody', { regime, accountType: 'saver' })).rejects.toThrow(
      /No such user/,
    );
  });

  it('refuses dates later than today in the install time zone', async () => {
    const { db, alice } = await setup();
    await db.insert(appSettings).values({ key: 'time_zone', value: 'Asia/Tokyo' });
    // 2026-03-01 23:30 UTC is 2026-03-02 08:30 in Tokyo.
    const now = new Date('2026-03-01T23:30:00Z');
    await expect(
      openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-03-03', now }),
    ).rejects.toThrow(
      /The opening date 2026-03-03 is later than today \(2026-03-02 in Asia\/Tokyo\)/,
    );
    await openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-03-02', now });
    await expect(
      closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-03-03', now }),
    ).rejects.toThrow(/later than today/);
    // Without a date: today there.
    expect(await closeTaxAccount(db, alice, { accountType: 'saver', now })).toBe('2026-03-02');
    expect(await taxAccountsOf(db, alice)).toMatchObject([{ closedOn: '2026-03-02' }]);
  });

  it('without a time zone: the closing date is required, a date later than today anywhere refused', async () => {
    const { db, alice } = await setup();
    const now = new Date('2026-03-01T09:00:00Z');
    // 2026-03-01 09:00 UTC is already 2026-03-01 23:00 at UTC+14, not yet 2026-03-02 anywhere.
    await expect(
      openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-03-02', now }),
    ).rejects.toThrow(/later than today anywhere \(2026-03-01; time_zone is not set\)/);
    await openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-03-01', now });
    await expect(closeTaxAccount(db, alice, { accountType: 'saver', now })).rejects.toThrow(
      /time_zone is not set, so today is not known: give the closing date/,
    );
    await closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-03-01', now });
  });

  it('periods of one type never overlap: a reopen starts after the latest close', async () => {
    const { db, alice, bob } = await setup();
    await openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-01-05' });
    await closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-03-31' });
    await expect(openTaxAccount(db, alice, { regime, accountType: 'saver' })).rejects.toThrow(
      /Give the opening date: an earlier saver account closed on 2026-03-31/,
    );
    for (const openedOn of ['2026-03-31', '2026-02-01']) {
      await expect(
        openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn }),
      ).rejects.toThrow(/is not after 2026-03-31, when an earlier saver account closed/);
    }
    // Another user's closed account does not constrain Bob.
    await openTaxAccount(db, bob, { regime, accountType: 'saver', openedOn: '2026-02-01' });
    await openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-04-01' });
    await closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-05-31' });
    // Against the latest close, not the first one.
    await expect(
      openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-05-01' }),
    ).rejects.toThrow(/not after 2026-05-31/);
  });

  it('opening an account and changing the regime never interleave (one write transaction each)', async () => {
    const db = await testDb();
    const alice = await createUser(db, user('alice'));
    const known = [
      { key: 'examplia', version: '1', fingerprint: 'a' },
      { key: 'otherland', version: '1', fingerprint: 'b' },
    ];
    await setSetting(db, 'tax_regime', 'examplia', 'cli', { taxRegimes: known });
    for (let round = 0; round < 5; round++) {
      const results = await Promise.allSettled([
        openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-01-05' }),
        setSetting(db, 'tax_regime', 'otherland', 'cli', { taxRegimes: known }),
      ]);
      const [opened, changed] = results.map((r) => r.status === 'fulfilled');
      // Exactly one wins: an account under examplia locks the regime, or the regime changed first
      // and the account is refused. Never an account under a regime that is no longer the install's.
      expect(opened !== changed).toBe(true);
      const regimeNow = await getSetting(db, 'tax_regime');
      const accounts = await taxAccountsOf(db, alice);
      if (opened) {
        expect(regimeNow).toBe('examplia');
        expect(accounts.filter((a) => a.closedOn === null)).toHaveLength(1);
        return;
      }
      expect(regimeNow).toBe('otherland');
      expect(accounts).toEqual([]);
      await setSetting(db, 'tax_regime', 'examplia', 'cli', { taxRegimes: known });
    }
  });

  it('refuses invalid dates and a close before the opening date', async () => {
    const { db, alice } = await setup();
    for (const openedOn of ['2026-02-30', '2026-1-5', '', 'yesterday']) {
      await expect(
        openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn }),
      ).rejects.toThrow(/YYYY-MM-DD/);
    }
    await openTaxAccount(db, alice, { regime, accountType: 'saver', openedOn: '2026-03-02' });
    await expect(
      closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-13-01' }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-03-01' }),
    ).rejects.toThrow(/before the account opened/);
    // The same day is allowed.
    await closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-03-02' });
  });

  it('wrong user: another user can neither list nor close an account', async () => {
    const { db, alice, bob } = await setup();
    const id = await openTaxAccount(db, alice, { regime, accountType: 'saver' });
    expect(await taxAccountsOf(db, bob)).toEqual([]);
    await expect(
      closeTaxAccount(db, bob, { accountType: 'saver', closedOn: '2026-06-30' }),
    ).rejects.toThrow(/No open saver account/);
    expect(await taxAccountsOf(db, alice)).toMatchObject([{ id, closedOn: null }]);
    // Bob opening his own account leaves Alice's alone, and each sees only their own.
    const bobs = await openTaxAccount(db, bob, { regime, accountType: 'saver' });
    await closeTaxAccount(db, bob, { accountType: 'saver', closedOn: '2026-06-30' });
    expect((await taxAccountsOf(db, alice)).map((a) => [a.id, a.closedOn])).toEqual([[id, null]]);
    expect((await taxAccountsOf(db, bob)).map((a) => [a.id, a.closedOn])).toEqual([
      [bobs, '2026-06-30'],
    ]);
  });

  it('keeps rows: no delete, no edit, a close date set once', async () => {
    const { db, alice } = await setup();
    const id = await openTaxAccount(db, alice, { regime, accountType: 'saver' });
    const row = eq(userTaxAccounts.id, id);
    await expect(db.delete(userTaxAccounts).where(row)).rejects.toThrow();
    await expect(
      db.update(userTaxAccounts).set({ accountType: 'other' }).where(row),
    ).rejects.toThrow();
    await expect(
      db.update(userTaxAccounts).set({ openedOn: '2026-01-01' }).where(row),
    ).rejects.toThrow();
    await closeTaxAccount(db, alice, { accountType: 'saver', closedOn: '2026-06-30' });
    await expect(
      db.update(userTaxAccounts).set({ closedOn: '2026-07-01' }).where(row),
    ).rejects.toThrow();
    await expect(db.update(userTaxAccounts).set({ closedOn: null }).where(row)).rejects.toThrow();
    // Two open rows of one type for one user are refused by the table as well.
    await db.insert(userTaxAccounts).values({ ownerId: alice, accountType: 'saver' });
    await expect(
      db.insert(userTaxAccounts).values({ ownerId: alice, accountType: 'saver' }),
    ).rejects.toThrow();
    const [count] = await db.all<{ n: number }>(sql`select count(*) as n from user_tax_accounts`);
    expect(count?.n).toBe(2);
  });
});
