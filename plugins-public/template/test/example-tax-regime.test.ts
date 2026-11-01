import {
  regimeMissingTexts,
  regimeTranslator,
  taxRegimeProblems,
  validateTaxRegimes,
} from '@saku/plugin-sdk';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exampleTaxRegime } from '../src/example-tax-regime';

interface Fault {
  path: (string | number)[];
  value: unknown;
  message: string;
}
const { faults } = JSON.parse(
  readFileSync(new URL('../fixtures/examplia-faults.json', import.meta.url), 'utf8'),
) as { faults: Fault[] };

/** The regime with one value replaced (a deep copy; the plug-in itself is never changed). */
function inject(fault: Fault): unknown {
  const copy = structuredClone(exampleTaxRegime) as unknown as Record<string | number, unknown>;
  let node = copy;
  for (const key of fault.path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[fault.path.at(-1)!] = fault.value;
  return copy;
}

describe('Examplia tax regime (template)', () => {
  it('declares a valid regime', () => {
    expect(taxRegimeProblems(exampleTaxRegime)).toEqual([]);
    expect(() => validateTaxRegimes([exampleTaxRegime])).not.toThrow();
  });

  it('writes every amount and rate as decimal text, never a number', () => {
    const numbers: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'number') numbers.push(path);
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(exampleTaxRegime, 'regime');
    // The only numbers are counts of years.
    expect(numbers.every((p) => p.endsWith('.losses.carryforwardYears'))).toBe(true);
  });

  it('refuses every injected fault, naming where it is', () => {
    expect(faults.length).toBeGreaterThan(40);
    for (const fault of faults) {
      const problems = taxRegimeProblems(inject(fault));
      expect(problems, JSON.stringify(fault)).not.toEqual([]);
      expect(problems.join('\n'), JSON.stringify(fault)).toMatch(new RegExp(fault.message));
    }
  });

  it('refuses a fault with one message naming the regime, and two regimes with one key', () => {
    const bad = inject(faults[0]!) as typeof exampleTaxRegime;
    expect(() => validateTaxRegimes([bad])).toThrow(
      /Tax regime "examplia" is refused: .*realizedGains/,
    );
    expect(() => validateTaxRegimes([exampleTaxRegime, exampleTaxRegime])).toThrow(
      /Two tax regime plug-ins use the key "examplia"/,
    );
  });

  it('has its texts in English and Japanese, amounts filled from the declaration', () => {
    expect(regimeMissingTexts(exampleTaxRegime, 'ja')).toEqual([]);
    const saver = exampleTaxRegime.accountTypes.find((a) => a.key === 'saver')!;
    const annual = saver.quota!.annual!;
    const en = regimeTranslator(exampleTaxRegime, 'en');
    expect(en(saver.descriptionKey, { annual: `${annual.amount} ${annual.currency}` })).toContain(
      'up to 1000000 XTS a year',
    );
    expect(regimeTranslator(exampleTaxRegime, 'ja')(saver.nameKey)).toBe('セーバー口座');
    // A language the regime does not have falls back to English.
    expect(regimeTranslator(exampleTaxRegime, 'fr')(saver.nameKey)).toBe('Saver account');
    expect(() => en('accounts.nothing')).toThrow(/no text/);
  });
});
