import { is, sql } from 'drizzle-orm';
import { SQLiteTable, getTableConfig, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema';
import { appSettings } from './schema';
import {
  USER_TAX_TABLES,
  checkTaxRegimeChange,
  getSetting,
  navTolerances,
  parseNavTolerances,
  parseRecheckMinutes,
  RECHECK_DEFAULT_MINUTES,
  recheckMinutes,
  setSetting,
  unmatchedTolerances,
  userTaxDataExists,
} from './settings';
import { testDb } from './testing';

describe('settings', () => {
  it('validates values and keeps the base currency once set', async () => {
    const db = await testDb();
    await expect(setSetting(db, 'base_currency', 'yen')).rejects.toThrow(/valid/);
    await setSetting(db, 'base_currency', 'XXX');
    await setSetting(db, 'base_currency', 'XXX');
    await expect(setSetting(db, 'base_currency', 'YYY')).rejects.toThrow(/cannot be changed/);
    expect(await getSetting(db, 'base_currency')).toBe('XXX');
    await expect(setSetting(db, 'time_zone', 'Mars/Base')).rejects.toThrow();
    await setSetting(db, 'time_zone', 'Europe/Paris');
    expect(await getSetting(db, 'time_zone')).toBe('Europe/Paris');
  });

  it('validates the red re-check minutes: whole minutes 0..600, default 60', async () => {
    const db = await testDb();
    expect(RECHECK_DEFAULT_MINUTES).toBe(60);
    expect(await recheckMinutes(db)).toEqual({ minutes: 60 });
    for (const bad of ['', ' 60', '60 ', '-1', '1.5', '601', '1e2', 'sixty', '00601', '99999']) {
      expect(parseRecheckMinutes(bad)).toBeNull();
      await expect(setSetting(db, 'red_recheck_minutes_before_open', bad)).rejects.toThrow(/valid/);
    }
    for (const [text, n] of [
      ['0', 0],
      ['90', 90],
      ['600', 600],
    ] as const) {
      await setSetting(db, 'red_recheck_minutes_before_open', text);
      expect(await recheckMinutes(db)).toEqual({ minutes: n });
    }
    // A stored value that no longer parses (a hand edit) is reported, never read as the default.
    await db.update(appSettings).set({ value: '9000' });
    expect(await recheckMinutes(db)).toEqual({ invalid: '9000' });
  });

  it('validates the layer D NAV tolerances: a map of ticker to a fraction in (0, 0.2]', async () => {
    const db = await testDb();
    expect(await navTolerances(db)).toEqual({ tolerances: {}, invalid: false });
    for (const bad of [
      '',
      '[]',
      'null',
      '{"AAA":0}',
      '{"AAA":-0.01}',
      '{"AAA":0.21}',
      '{"AAA":"0.01"}',
      '{"A A":0.01}',
      '{"AAA":null}',
    ]) {
      expect(parseNavTolerances(bad)).toBeNull();
      await expect(setSetting(db, 'issuer_nav_tolerance', bad)).rejects.toThrow(/valid/);
    }
    expect(parseNavTolerances('{}')).toEqual({});
    await setSetting(db, 'issuer_nav_tolerance', '{"AAA":0.005,"BBB":0.2}');
    expect(await navTolerances(db)).toEqual({
      tolerances: { AAA: 0.005, BBB: 0.2 },
      invalid: false,
    });
    expect(unmatchedTolerances({ BBB: 0.2, AAA: 0.005, ZZZ: 0.01 }, ['AAA'])).toEqual([
      'BBB',
      'ZZZ',
    ]);
    // A ticker named like an object property is still only what was set.
    await setSetting(db, 'issuer_nav_tolerance', '{"__proto__":0.01}');
    const t = (await navTolerances(db)).tolerances;
    expect(Object.hasOwn(t, '__proto__')).toBe(true);
    expect(Object.hasOwn(t, 'constructor')).toBe(false);
    // A stored value that no longer parses (a hand edit) is reported, not read as "none set".
    await db.update(appSettings).set({ value: '{"AAA":5}' });
    expect(await navTolerances(db)).toEqual({ tolerances: {}, invalid: true });
  });

  it('sets tax_regime only to a loaded regime, and keeps it while users have tax data', async () => {
    const db = await testDb();
    await expect(
      setSetting(db, 'tax_regime', 'Bad Key', 'cli', { taxRegimes: [] }),
    ).rejects.toThrow(/valid/);
    // Without the loaded regimes at hand (`pnpm settings set`), refused: the key is unchecked.
    await expect(setSetting(db, 'tax_regime', 'examplia')).rejects.toThrow(/pnpm plugins/);
    await expect(
      setSetting(db, 'tax_regime', 'other', 'cli', { taxRegimes: ['examplia'] }),
    ).rejects.toThrow(/No loaded tax regime has the key other \(loaded: examplia\)/);
    await setSetting(db, 'tax_regime', 'examplia', 'cli', { taxRegimes: ['examplia', 'other'] });
    // No user tax data yet: a change is allowed.
    await setSetting(db, 'tax_regime', 'other', 'cli', { taxRegimes: ['examplia', 'other'] });
    expect(await getSetting(db, 'tax_regime')).toBe('other');

    // With a row in a user tax table, the regime cannot change (the same value can be set again).
    const lots = sqliteTable('test_tax_lots', { ownerId: text('owner_id').notNull() });
    await db.run(sql`CREATE TABLE test_tax_lots (owner_id text NOT NULL)`);
    expect(await userTaxDataExists(db, [lots])).toBe(false);
    await checkTaxRegimeChange(db, 'examplia', ['examplia', 'other'], [lots]);
    await db.insert(lots).values({ ownerId: 'u1' });
    expect(await userTaxDataExists(db, [lots])).toBe(true);
    await expect(
      checkTaxRegimeChange(db, 'examplia', ['examplia', 'other'], [lots]),
    ).rejects.toThrow(/tax_regime is other and cannot be changed/);
    await checkTaxRegimeChange(db, 'other', ['examplia', 'other'], [lots]);
  });

  it('lists every per-user table as tax data or not, so the tax_regime lock never misses one', () => {
    // Per-user tables that hold no tax data. A new table with an owner_id must be added here or
    // to USER_TAX_TABLES (the tax engine's accounts, lots, quota ledger, carryforward).
    const notTax = [
      'user_settings',
      'strategies',
      'strategy_versions',
      'journal_entries',
      'notification_channels',
      'alerts_sent',
    ];
    const taxNames = USER_TAX_TABLES.map((t) => getTableConfig(t).name);
    const owned = (Object.values(schema) as unknown[])
      .filter((v): v is SQLiteTable => is(v, SQLiteTable))
      .map((t) => getTableConfig(t))
      .filter((c) => c.columns.some((col) => col.name === 'owner_id'))
      .map((c) => c.name)
      .sort();
    expect(owned).toEqual([...notTax, ...taxNames].sort());
  });
});
