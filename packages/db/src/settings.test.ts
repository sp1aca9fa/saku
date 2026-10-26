import { describe, expect, it } from 'vitest';
import { getSetting, setSetting } from './settings';
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
});
