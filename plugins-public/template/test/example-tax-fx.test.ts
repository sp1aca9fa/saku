import { taxFxProblems } from '@saku/plugin-sdk';
import { fixtureContext } from '@saku/plugin-sdk/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exampleTaxFx } from '../src/example-tax-fx';
import { exampleTaxRegime } from '../src/example-tax-regime';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

interface Fault {
  name: string;
  path: (string | number)[];
  value?: unknown;
  remove?: boolean;
  message: string;
}
const { faults } = fixture('examplia-tax-fx-faults.json') as { faults: Fault[] };

/** The bank's answer with one value replaced or removed (a deep copy of the fixture). */
function inject(fault: Fault): unknown {
  const copy = structuredClone(fixture('rates-usdxts.json')) as Record<string | number, unknown>;
  let node = copy;
  for (const key of fault.path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = fault.path.at(-1)!;
  if (fault.remove) delete node[last];
  else node[last] = fault.value;
  return copy;
}

/** What the plug-in returns, then what core's checks say (as the daily run does). */
async function fetchAndCheck(answer: unknown): Promise<string[]> {
  const ctx = fixtureContext((url) => (url.pathname === '/v1/rates/USDXTS' ? answer : undefined));
  try {
    const rates = await exampleTaxFx.fetchRates('USDXTS', '2026-01-02', '2026-01-06', ctx);
    return taxFxProblems(rates, { pair: 'USDXTS', fx: exampleTaxRegime.fx });
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

describe('Example Bank of Examplia (template tax FX)', () => {
  it("maps each published rate onto the regime's name and kind; an unpublished one is left out", async () => {
    const ctx = fixtureContext(() => fixture('rates-usdxts.json'));
    const rates = await exampleTaxFx.fetchRates('USDXTS', '2026-01-02', '2026-01-06', ctx);
    expect(ctx.requested).toEqual([
      'https://api.example-bank.test/v1/rates/USDXTS?start=2026-01-02&end=2026-01-06',
    ]);
    expect(rates.filter((r) => r.date === '2026-01-05')).toEqual([
      {
        pair: 'USDXTS',
        date: '2026-01-05',
        rate: 151.1,
        publishedAt: '2026-01-05T01:00:00Z',
        kind: 'tax_mid',
        name: 'MID',
      },
      {
        pair: 'USDXTS',
        date: '2026-01-05',
        rate: 152.1,
        publishedAt: '2026-01-05T01:00:00Z',
        kind: 'tax_buy',
        name: 'ASK',
      },
      {
        pair: 'USDXTS',
        date: '2026-01-05',
        rate: 150.1,
        publishedAt: '2026-01-05T01:00:00Z',
        kind: 'tax_sell',
        name: 'BID',
      },
    ]);
    // The ask was not published on 2026-01-06: no rate, never a 0.
    expect(rates.filter((r) => r.date === '2026-01-06').map((r) => r.kind)).toEqual([
      'tax_mid',
      'tax_sell',
    ]);
    // Every name is one the regime declares, on the same kind.
    for (const r of rates) expect(exampleTaxRegime.fx.rates[r.name]?.kind).toBe(r.kind);
  });

  it("passes core's checks as published", async () => {
    expect(await fetchAndCheck(fixture('rates-usdxts.json'))).toEqual([]);
  });

  it('uses only the SDK client and supports only its pair', () => {
    expect(exampleTaxFx.info.kind).toBe('tax_fx');
    expect(exampleTaxFx.supports('USDXTS')).toBe(true);
    expect(exampleTaxFx.supports('USDXXX')).toBe(false);
  });

  it('has fault cases', () => expect(faults.length).toBeGreaterThanOrEqual(3));

  for (const fault of faults) {
    it(`fault: ${fault.name} is refused`, async () => {
      const problems = await fetchAndCheck(inject(fault));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join('\n')).toMatch(new RegExp(fault.message));
    });
  }
});
