import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { activityLog, appSettings, userTaxAccounts } from './schema';
import { userTaxDataExists } from './settings';
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
    const again = await openTaxAccount(db, alice, { regime, accountType: 'saver' });
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
