// Install-wide admin settings (requirements 12). Validated here so the CLI, the app and jobs
// agree on what a setting may hold.
import { eq } from 'drizzle-orm';
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
} as const;

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

/** The NAV tolerance per ticker (none set: an empty map, every fund observed only). */
export async function navTolerances(db: Db): Promise<Record<string, number>> {
  const text = await getSetting(db, 'issuer_nav_tolerance');
  if (text === undefined) return {};
  const parsed = parseNavTolerances(text);
  // Validated when set; a stored value that no longer parses is an error, never "none set".
  if (parsed === null) throw new Error(`issuer_nav_tolerance is not valid: ${text}`);
  return parsed;
}

export type SettingKey = keyof typeof SETTINGS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export async function getSetting(db: Db, key: SettingKey): Promise<string | undefined> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row ? String(row.value) : undefined;
}

export async function setSetting(db: Db, key: SettingKey, value: string, actor = 'cli') {
  if (!SETTINGS[key](value)) throw new Error(`Not a valid ${key}: ${value}`);
  const current = await getSetting(db, key);
  if (key === 'base_currency' && current !== undefined && current !== value) {
    throw new Error(`base_currency is ${current} and cannot be changed once set.`);
  }
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  await db.insert(activityLog).values({ actor, action: 'setting.set', detail: { key, value } });
}
