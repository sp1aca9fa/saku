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
} as const;

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
