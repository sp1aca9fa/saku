// `pnpm plugins tax-regime` (setTaxRegime) passes the regime's account types, so a regime change
// is refused while stored benchmarks name an account type it lacks (spec 2026-11-02 c2-settings,
// review item 3; the rule is tested in db settings-c2.test.ts).
import { benchmarkSet, getSetting, setSetting } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { setTaxRegime } from './tax-regime';
import type { TaxRegime } from './types';

/** Only what setTaxRegime reads: the key, version, rules (fingerprinted) and account type keys. */
const regime = (key: string, accounts: string[]) =>
  ({
    info: { key, kind: 'tax_regime', version: '1' },
    accountTypes: accounts.map((k) => ({ key: k })),
  }) as unknown as TaxRegime;

describe('setTaxRegime and the benchmarks', () => {
  it('refuses a regime whose account types do not cover the stored benchmarks', async () => {
    const db = await testDb();
    const a = regime('aland', ['taxable', 'tax_free']);
    const b = regime('bland', ['taxable']);
    await setTaxRegime(db, 'aland', [a, b]);
    const benchmarks = JSON.stringify([
      {
        id: 'free',
        holdings: [{ ticker: 'AAA', weight: 100 }],
        feePctPerYear: '0.1',
        account: 'tax_free',
      },
    ]);
    await setSetting(db, 'benchmarks', benchmarks, 'cli', {
      accountTypes: ['taxable', 'tax_free'],
    });
    await expect(setTaxRegime(db, 'bland', [a, b])).rejects.toThrow(/bland regime does not define/);
    expect(await getSetting(db, 'tax_regime')).toBe('aland');
    expect(await benchmarkSet(db, ['taxable', 'tax_free'])).toMatchObject({
      benchmarks: [{ id: 'free' }],
    });
  });
});
