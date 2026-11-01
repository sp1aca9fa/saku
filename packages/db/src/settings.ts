// Install-wide admin settings (requirements 12). Validated here so the CLI, the app and jobs
// agree on what a setting may hold.
import { eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './client';
import { activityLog, appSettings } from './schema';

export const SETTINGS = {
  /** ISO 4217 code. Chosen before anything is stored; never changed afterwards. */
  base_currency: (v: string) => /^[A-Z]{3}$/.test(v),
  /** IANA time zone for display (trading dates stay America/New_York). */
  time_zone: (v: string) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  },
  /** Language code of the install's primary language (default for users who chose none). */
  primary_language: (v: string) => /^[a-z]{2,3}(-[A-Z]{2})?$/.test(v),
  /**
   * First trading date of forward records (registration and the daily record). Unset until the
   * A1 gate passes: before it, nothing is registered or recorded (stage A).
   */
  forward_records_from: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  /**
   * Layer D: the normal premium/discount of each fund's market close to its issuer NAV, as a JSON
   * map of ticker to a fraction (0.002 = 0.2%), each above 0 and at most MAX_NAV_TOLERANCE. Set
   * by the owner from observed data (`pnpm sources issuer-stats`; requirements 04, "Per-ETF
   * thresholds set in A3"); a fund without one is observed only (green, deviation recorded).
   */
  issuer_nav_tolerance: (v: string) => parseNavTolerances(v) !== null,
  /**
   * The red re-check deadline (requirements 04 "Red re-check before execution", decisions log
   * 2026-11-01, C16): whole minutes before the next regular US open (09:30 New York) by which a
   * day red at its first grading gets its final instruction. Default RECHECK_DEFAULT_MINUTES;
   * 0 to RECHECK_MAX_MINUTES.
   */
  red_recheck_minutes_before_open: (v: string) => parseRecheckMinutes(v) !== null,
  /**
   * The install's tax regime (requirements 07, 12): a loaded `TaxRegime` plug-in's key. Set only
   * with the loaded regimes' keys at hand (`setSetting`'s `taxRegimes`, `pnpm plugins
   * tax-regime`), so an unknown key is refused; not changed once user tax data exists.
   */
  tax_regime: (v: string) => /^[a-z][a-z0-9-]{1,39}$/.test(v),
} as const;

/**
 * The per-user tables holding tax data (tax accounts, lots, quota ledger, loss carryforward):
 * none yet, the tax engine adds them (C1). While any has a row, `tax_regime` cannot change: that
 * data was computed under the regime's account types and rules. A test makes every table with
 * an `owner_id` be listed here or declared not tax data, so a new one is never forgotten.
 */
export const USER_TAX_TABLES: readonly SQLiteTable[] = [];

/** Whether any user has tax data (a row in one of `tables`, default `USER_TAX_TABLES`). */
export async function userTaxDataExists(
  db: Db,
  tables: readonly SQLiteTable[] = USER_TAX_TABLES,
): Promise<boolean> {
  for (const table of tables) {
    if ((await db.select().from(table).limit(1)).length > 0) return true;
  }
  return false;
}

/**
 * Refuses a `tax_regime` value that names no loaded regime (`known`; undefined: not checked
 * against the loaded plug-ins, refused too) or that changes the regime while users have tax data.
 */
export async function checkTaxRegimeChange(
  db: Db,
  value: string,
  known: readonly string[] | undefined,
  tables: readonly SQLiteTable[] = USER_TAX_TABLES,
): Promise<void> {
  if (known === undefined) {
    throw new Error(
      'tax_regime is set with `pnpm plugins tax-regime <key>`, which checks the key against the loaded tax regimes.',
    );
  }
  if (!known.includes(value)) {
    throw new Error(
      `No loaded tax regime has the key ${value} (loaded: ${known.length > 0 ? known.join(', ') : 'none'}).`,
    );
  }
  const current = await getSetting(db, 'tax_regime');
  if (current !== undefined && current !== value && (await userTaxDataExists(db, tables))) {
    throw new Error(
      `tax_regime is ${current} and cannot be changed: users have tax data computed under it.`,
    );
  }
}

/** The default re-check deadline: one hour before the next regular US open (C16). */
export const RECHECK_DEFAULT_MINUTES = 60;
/**
 * The earliest deadline the setting accepts (10 hours before the open, 23:30 New York the evening
 * before): earlier would end the re-check before most corrections can arrive (a typo, not a choice).
 */
export const RECHECK_MAX_MINUTES = 600;

/** `red_recheck_minutes_before_open` as a number, or null when the text is not a valid one. */
export function parseRecheckMinutes(text: string): number | null {
  if (!/^\d{1,4}$/.test(text)) return null;
  const n = Number(text);
  return n <= RECHECK_MAX_MINUTES ? n : null;
}

/**
 * The re-check deadline's minutes before the open: the default when unset. A stored value that no
 * longer parses (only a hand edit can do that) is reported as `invalid`, never read as the default
 * without saying so: the forward step then opens no re-check (the safe state at once, as before
 * C16) and the run names it.
 */
export async function recheckMinutes(db: Db): Promise<{ minutes: number } | { invalid: string }> {
  const text = await getSetting(db, 'red_recheck_minutes_before_open');
  if (text === undefined) return { minutes: RECHECK_DEFAULT_MINUTES };
  const n = parseRecheckMinutes(text);
  return n === null ? { invalid: text } : { minutes: n };
}

/** The widest NAV tolerance the setting accepts (20%): wider would not catch a decimal error. */
export const MAX_NAV_TOLERANCE = 0.2;

/** The `issuer_nav_tolerance` map, or null when the text is not a valid one. */
export function parseNavTolerances(text: string): Record<string, number> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  for (const [ticker, tol] of entries) {
    if (!/^\S{1,20}$/.test(ticker)) return null;
    if (typeof tol !== 'number' || !(tol > 0 && tol <= MAX_NAV_TOLERANCE)) return null;
  }
  // Own properties only, whatever the ticker is called.
  return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * The NAV tolerance per ticker (none set: an empty map, every fund observed only). A stored value
 * that no longer parses (only a hand edit can do that) is reported as `invalid`, never read as
 * "none set" without saying so: layer D then observes only and grades the day yellow.
 */
export async function navTolerances(
  db: Db,
): Promise<{ tolerances: Record<string, number>; invalid: boolean }> {
  const text = await getSetting(db, 'issuer_nav_tolerance');
  if (text === undefined) return { tolerances: {}, invalid: false };
  const parsed = parseNavTolerances(text);
  return parsed === null
    ? { tolerances: {}, invalid: true }
    : { tolerances: parsed, invalid: false };
}

/** Tolerance keys that name no active symbol (a typo, or a fund no longer in the universe). */
export function unmatchedTolerances(
  tolerances: Record<string, number>,
  tickers: string[],
): string[] {
  return Object.keys(tolerances)
    .filter((t) => !tickers.includes(t))
    .sort();
}

export type SettingKey = keyof typeof SETTINGS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export async function getSetting(db: Db, key: SettingKey): Promise<string | undefined> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row ? String(row.value) : undefined;
}

export async function setSetting(
  db: Db,
  key: SettingKey,
  value: string,
  actor = 'cli',
  /** `tax_regime` only: the keys of the loaded tax regimes (the setting names one of them). */
  options: { taxRegimes?: readonly string[] } = {},
) {
  if (!SETTINGS[key](value)) throw new Error(`Not a valid ${key}: ${value}`);
  const current = await getSetting(db, key);
  if (key === 'base_currency' && current !== undefined && current !== value) {
    throw new Error(`base_currency is ${current} and cannot be changed once set.`);
  }
  if (key === 'tax_regime') await checkTaxRegimeChange(db, value, options.taxRegimes);
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  await db.insert(activityLog).values({ actor, action: 'setting.set', detail: { key, value } });
}
