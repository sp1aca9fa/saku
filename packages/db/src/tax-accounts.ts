// Per-user tax accounts (requirements 07 "Model": accounts are per person; the install's regime
// defines the account types; a tax-advantaged account such as a savings scheme is opened by
// choice per user). Every function takes the signed-in user's id and reads or changes only that
// user's rows; no function reads another user's.
//
// The regime's `taxable` type is implied: every user holds it, so it is never stored (one source
// of truth; the table refuses it). Rows are never deleted and only `closed_on` is set, once
// (triggers in migration 0017); reopening an account adds a new row. A row in this table locks
// the install's `tax_regime` (`USER_TAX_TABLES`).
import { isTradingDate } from '@saku/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from './client';
import { activityLog, appSettings, userTaxAccounts, users } from './schema';

/** The account type every regime declares and every user holds without opening it. */
export const IMPLIED_TAX_ACCOUNT = 'taxable';

export interface TaxAccount {
  id: string;
  accountType: string;
  /** `YYYY-MM-DD`, or null when not given. */
  openedOn: string | null;
  createdAt: string;
  /** `YYYY-MM-DD`; null while open. */
  closedOn: string | null;
}

/**
 * The install's regime as an account is opened under: its key (the `tax_regime` setting, read
 * again in the transaction) and its account type keys. Callers pass the loaded regime the setting
 * names, with the declaration it was set with (`installTaxRegime` in the plug-in SDK).
 */
export interface RegimeAccountTypes {
  key: string;
  accountTypes: readonly string[];
}

const columns = {
  id: userTaxAccounts.id,
  accountType: userTaxAccounts.accountType,
  openedOn: userTaxAccounts.openedOn,
  createdAt: userTaxAccounts.createdAt,
  closedOn: userTaxAccounts.closedOn,
};

/** The user's stored tax accounts, open and closed, oldest first (`taxable` is implied, not listed). */
export async function taxAccountsOf(db: Db, ownerId: string): Promise<TaxAccount[]> {
  return db
    .select(columns)
    .from(userTaxAccounts)
    .where(eq(userTaxAccounts.ownerId, ownerId))
    .orderBy(asc(userTaxAccounts.createdAt), asc(userTaxAccounts.id));
}

function checkDate(value: string, what: string): void {
  if (!isTradingDate(value)) throw new Error(`${what} must be a date YYYY-MM-DD (got ${value}).`);
}

/**
 * Opens an account of `accountType` for the user. Refused: `taxable` (implied), a type the
 * install's regime does not declare, a regime other than the one the `tax_regime` setting names
 * (it may have changed since the caller read it), an account of that type already open for the
 * user, an invalid `openedOn`. Returns the new row's id.
 */
export async function openTaxAccount(
  db: Db,
  ownerId: string,
  o: { regime: RegimeAccountTypes; accountType: string; openedOn?: string; actor?: string },
): Promise<string> {
  if (o.accountType === IMPLIED_TAX_ACCOUNT) {
    throw new Error(
      `The ${IMPLIED_TAX_ACCOUNT} account is implied for every user; it is not opened or closed.`,
    );
  }
  if (!o.regime.accountTypes.includes(o.accountType)) {
    throw new Error(
      `The ${o.regime.key} regime has no account type ${o.accountType} (it has: ${o.regime.accountTypes.join(', ')}).`,
    );
  }
  if (o.openedOn !== undefined) checkDate(o.openedOn, 'The opening date');
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId));
    if (!user) throw new Error('No such user.');
    const [setting] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'tax_regime'));
    if (setting === undefined || String(setting.value) !== o.regime.key) {
      throw new Error(
        `The install's tax regime is ${setting === undefined ? 'not set' : String(setting.value)}, not ${o.regime.key}.`,
      );
    }
    const open = await tx
      .select({ id: userTaxAccounts.id })
      .from(userTaxAccounts)
      .where(
        and(
          eq(userTaxAccounts.ownerId, ownerId),
          eq(userTaxAccounts.accountType, o.accountType),
          isNull(userTaxAccounts.closedOn),
        ),
      );
    if (open.length > 0) throw new Error(`The user already has an open ${o.accountType} account.`);
    const [row] = await tx
      .insert(userTaxAccounts)
      .values({ ownerId, accountType: o.accountType, openedOn: o.openedOn ?? null })
      .returning({ id: userTaxAccounts.id });
    await tx.insert(activityLog).values({
      actor: o.actor ?? ownerId,
      action: 'tax_account.open',
      detail: {
        ownerId,
        id: row!.id,
        accountType: o.accountType,
        openedOn: o.openedOn ?? null,
        regime: o.regime.key,
      },
    });
    return row!.id;
  });
}

/**
 * Closes the user's open account of `accountType` on `closedOn` (`YYYY-MM-DD`, not before the
 * date it opened). Refused when the user has no open account of that type (another user's is
 * never found) or for `taxable` (implied). The row is kept.
 */
export async function closeTaxAccount(
  db: Db,
  ownerId: string,
  o: { accountType: string; closedOn: string; actor?: string },
): Promise<void> {
  if (o.accountType === IMPLIED_TAX_ACCOUNT) {
    throw new Error(
      `The ${IMPLIED_TAX_ACCOUNT} account is implied for every user; it is not opened or closed.`,
    );
  }
  checkDate(o.closedOn, 'The closing date');
  await db.transaction(async (tx) => {
    const where = and(
      eq(userTaxAccounts.ownerId, ownerId),
      eq(userTaxAccounts.accountType, o.accountType),
      isNull(userTaxAccounts.closedOn),
    );
    const [open] = await tx.select(columns).from(userTaxAccounts).where(where);
    if (!open) throw new Error(`No open ${o.accountType} account.`);
    if (open.openedOn !== null && o.closedOn < open.openedOn) {
      throw new Error(
        `The closing date ${o.closedOn} is before the account opened (${open.openedOn}).`,
      );
    }
    await tx
      .update(userTaxAccounts)
      .set({ closedOn: o.closedOn })
      .where(and(eq(userTaxAccounts.id, open.id), where));
    await tx.insert(activityLog).values({
      actor: o.actor ?? ownerId,
      action: 'tax_account.close',
      detail: { ownerId, id: open.id, accountType: o.accountType, closedOn: o.closedOn },
    });
  });
}
