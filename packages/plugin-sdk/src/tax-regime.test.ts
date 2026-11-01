import { testDb } from '@saku/db/testing';
import { getSetting } from '@saku/db';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPlugins } from './registry';
import {
  compareDecimalText,
  installTaxRegime,
  regimeTranslator,
  setTaxRegime,
  taxRegimeFingerprint,
  taxRegimeProblems,
} from './tax-regime';
import type { TaxRegime } from './types';

/** A made-up regime with two tax-advantaged accounts sharing a lifetime limit. */
function regime(key = 'testland'): TaxRegime {
  return {
    info: {
      key,
      kind: 'tax_regime',
      version: '1',
      nameKey: 'name',
      country: 'QZ',
      currency: 'XTS',
      sources: ['https://tax.testland.test/'],
    },
    yearStart: '01-01',
    yearDate: 'settlement_date',
    fxDate: 'trade_date',
    accountTypes: [
      {
        key: 'taxable',
        treatment: 'taxable',
        nameKey: 'a',
        descriptionKey: 'a',
        eligibility: { leveraged: true, assetClasses: 'all', purchaseModes: ['lump_sum'] },
        tax: { realizedGains: '0.20315', dividends: '1' },
        losses: {
          offsets: ['gains'],
          carryforwardYears: 'unlimited',
          conditions: [{ kind: 'filing', appliesTo: ['offsets', 'carryforward'], textKey: 'c' }],
        },
        foreignTaxCredit: { conditions: [] },
        foreignDividendBase: 'gross',
        foreignWithholding: [{ country: 'QA', rate: '0' }],
      },
      {
        key: 'growth',
        treatment: 'tax_advantaged',
        nameKey: 'a',
        descriptionKey: 'a',
        eligibility: {
          leveraged: false,
          assetClasses: ['equity'],
          purchaseModes: ['lump_sum', 'periodic'],
        },
        quota: {
          annual: { amount: '2400000', currency: 'XTS' },
          lifetime: { amount: '12000000.00', currency: 'XTS' },
          release: { limits: ['lifetime'], basis: 'book_value', from: 'next_year' },
        },
        tax: { realizedGains: '0', dividends: '0.0' },
        losses: { offsets: [], carryforwardYears: 0, conditions: [] },
        foreignTaxCredit: false,
        foreignDividendBase: 'net_of_withholding',
      },
      {
        key: 'plan',
        treatment: 'tax_advantaged',
        nameKey: 'a',
        descriptionKey: 'a',
        eligibility: {
          leveraged: false,
          assetClasses: 'all',
          designatedOnly: true,
          purchaseModes: ['periodic'],
        },
        // Frees the lifetime limit its group declares.
        quota: {
          annual: { amount: '1200000', currency: 'XTS' },
          release: { limits: ['lifetime'], basis: 'book_value', from: 'next_year' },
        },
        tax: { realizedGains: '0', dividends: '0' },
        losses: { offsets: [], carryforwardYears: 0, conditions: [] },
        foreignTaxCredit: false,
        foreignDividendBase: 'net_of_withholding',
      },
    ],
    quotaGroups: [
      {
        key: 'lifetime_shared',
        nameKey: 'a',
        accountTypes: ['growth', 'plan'],
        lifetime: { amount: '18000000', currency: 'XTS' },
      },
    ],
    costBasis: { method: 'fifo', sameDayOrder: 'purchases_first' },
    fx: {
      rates: { M: { kind: 'tax_mid', nameKey: 'a' } },
      purchases: 'M',
      sales: 'M',
      dividends: 'M',
    },
    foreignWithholding: [{ country: 'QA', rate: '0.15' }],
    transfers: [{ from: 'growth', to: 'taxable' }],
    texts: {
      en: { name: 'Testland', a: 'A', c: 'Only if you file; {carryforwardYears} years.' },
      ja: { a: 'エー' },
    },
  };
}

describe('tax regime declarations', () => {
  it('compares decimal texts exactly, without floats', () => {
    expect(compareDecimalText('0.1', '0.10')).toBe(0);
    expect(compareDecimalText('1', '1.000')).toBe(0);
    expect(compareDecimalText('0.20315', '0.2032')).toBe(-1);
    expect(compareDecimalText('10', '9.999')).toBe(1);
    expect(compareDecimalText('1000000', '999999.99')).toBe(1);
    // Beyond float precision: still exact.
    expect(compareDecimalText('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareDecimalText('0.10000000000000000001', '0.1')).toBe(1);
  });

  it('accepts shared groups, a release resting on a group limit, unlimited carryforward', () => {
    expect(taxRegimeProblems(regime())).toEqual([]);
  });

  it('refuses a non-object, and names every problem at once', () => {
    expect(taxRegimeProblems(null)).toEqual(['regime: must be an object']);
    const r = regime() as unknown as Record<string, unknown>;
    delete r.fx;
    r.yearStart = '1-1';
    expect(taxRegimeProblems(r)).toEqual([
      'regime: "fx" is required',
      'yearStart: must be a day of the year as MM-DD (not 02-29)',
    ]);
    // A hole in a list is a problem, never skipped.
    const holes = regime() as unknown as Record<string, unknown[]>;
    holes.transfers = [undefined];
    holes.foreignWithholding = [undefined];
    expect(taxRegimeProblems(holes)).toEqual([
      'foreignWithholding[0]: must be an object',
      'transfers[0]: must be an object',
    ]);
  });

  it('refuses a group annual limit above its lifetime limit and duplicate group keys', () => {
    const r = regime();
    r.quotaGroups = [
      { ...r.quotaGroups![0]!, annual: { amount: '18000000.01', currency: 'XTS' } },
      r.quotaGroups![0]!,
    ];
    expect(taxRegimeProblems(r)).toEqual([
      'quotaGroups[0]: annual limit 18000000.01 is above the lifetime limit 18000000',
      'quotaGroups[1].key: "lifetime_shared" declared twice',
    ]);
  });

  it('refuses an account quota with no limit, and a carryforward beyond 100 years', () => {
    const r = regime();
    r.accountTypes[1]!.quota = {};
    r.accountTypes[0]!.losses.carryforwardYears = 101;
    expect(taxRegimeProblems(r)).toEqual([
      'accountTypes[0].losses.carryforwardYears: a whole number of years from 0 to 100, or "unlimited"',
      'accountTypes[1].quota: declare an annual or a lifetime limit (leave quota out for none)',
    ]);
  });

  it('loads regimes with the plug-ins and refuses a bad one at load', async () => {
    // A fresh folder each time (an imported module is cached by path).
    const write = (r: unknown) => {
      const root = mkdtempSync(join(tmpdir(), 'saku-regimes-'));
      mkdirSync(join(root, 'plugins-public', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'plugins-public', 'src', 'index.ts'),
        `export const taxRegimes = [${JSON.stringify(r)}];`,
      );
      return root;
    };
    const loaded = await loadPlugins(write(regime()));
    expect(loaded.taxRegimes.map((r) => r.info.key)).toEqual(['testland']);
    const bad = regime();
    bad.accountTypes[0]!.tax.realizedGains = 0.2 as unknown as string;
    await expect(loadPlugins(write(bad))).rejects.toThrow(
      /Tax regime "testland" is refused: accountTypes\[0\]\.tax\.realizedGains/,
    );
  });

  it('the install regime: unset, set only to a loaded key, unknown once removed', async () => {
    const db = await testDb();
    const loaded = [regime(), regime('otherland')];
    expect(await installTaxRegime(db, loaded)).toEqual({ unset: true });
    await expect(setTaxRegime(db, 'nowhere', loaded)).rejects.toThrow(/No loaded tax regime/);
    expect(await getSetting(db, 'tax_regime')).toBeUndefined();
    await setTaxRegime(db, 'testland', loaded);
    expect(await installTaxRegime(db, loaded)).toEqual({ regime: loaded[0] });
    // The plug-in removed or renamed since: unknown, never another regime.
    expect(await installTaxRegime(db, [regime('otherland')])).toEqual({ unknown: 'testland' });
  });

  it("bounds an account type's limits by its groups' limits", () => {
    const r = regime();
    r.quotaGroups![0]!.lifetime = { amount: '11999999.99', currency: 'XTS' };
    r.quotaGroups![0]!.annual = { amount: '1000000', currency: 'XTS' };
    expect(taxRegimeProblems(r)).toEqual([
      'accountTypes[1].quota: annual limit 2400000 is above the annual limit 1000000 of quotaGroups[0]',
      'accountTypes[1].quota: lifetime limit 12000000.00 is above the lifetime limit 11999999.99 of quotaGroups[0]',
      'accountTypes[2].quota: annual limit 1200000 is above the annual limit 1000000 of quotaGroups[0]',
    ]);
  });

  it('fingerprints the rules, not the wording or the key order', () => {
    const base = taxRegimeFingerprint(regime());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const worded = regime();
    worded.texts.en!.a = 'Another wording';
    expect(taxRegimeFingerprint(worded)).toBe(base);
    const reordered = regime();
    reordered.info = { ...reordered.info };
    const { key, ...rest } = reordered.info;
    reordered.info = { ...rest, key } as typeof reordered.info;
    expect(taxRegimeFingerprint(reordered)).toBe(base);
    const rule = regime();
    rule.accountTypes[0]!.tax.dividends = '0.99';
    expect(taxRegimeFingerprint(rule)).not.toBe(base);
    const yearDate = regime();
    yearDate.yearDate = 'trade_date';
    expect(taxRegimeFingerprint(yearDate)).not.toBe(base);
  });

  it('a changed declaration is not used until set again (refused once users have tax data)', async () => {
    const db = await testDb();
    await setTaxRegime(db, 'testland', [regime()]);
    const updated = regime();
    updated.info.version = '2';
    updated.accountTypes[0]!.tax.realizedGains = '0.3';
    expect(await installTaxRegime(db, [updated])).toEqual({
      changed: { key: 'testland', version: '2', setVersion: '1' },
    });
    // No user tax data (no tax tables yet): the admin accepts it by setting the regime again.
    await setTaxRegime(db, 'testland', [updated]);
    expect(await installTaxRegime(db, [updated])).toEqual({ regime: updated });
  });

  it('fills placeholders and throws on one left unfilled', () => {
    const t = regimeTranslator(regime(), 'ja');
    expect(t('c', { carryforwardYears: 3 })).toBe('Only if you file; 3 years.');
    expect(() => t('c')).toThrow(/text c needs a value for \{carryforwardYears\}/);
    expect(t('a')).toBe('エー');
  });
});
