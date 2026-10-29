import { describe, expect, it } from 'vitest';
import { appSettings } from './schema';
import {
  getSetting,
  navTolerances,
  parseNavTolerances,
  setSetting,
  unmatchedTolerances,
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
});
