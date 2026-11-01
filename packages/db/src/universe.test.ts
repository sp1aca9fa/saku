// The default universe template (`templates/universe/us-etf-tier0.json`) holds Tier 0 as the
// requirements list it (03-assets): every ticker, its leverage and underlying (layer C pairs) and
// SPY's index series (layer C index check).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './env';
import { activeSymbols, parseSymbolList, upsertSymbols } from './market';
import { testDb } from './testing';

describe('Tier 0 universe template', () => {
  it('imports every Tier 0 ticker with its leverage, underlying and index', async () => {
    const file = join(findRepoRoot(), 'templates', 'universe', 'us-etf-tier0.json');
    const db = await testDb();
    await upsertSymbols(db, parseSymbolList(JSON.parse(readFileSync(file, 'utf8'))));
    const symbols = await activeSymbols(db);
    const ticker = (id: number | null) => symbols.find((s) => s.id === id)?.ticker ?? null;
    expect(
      symbols.map((s) => [s.ticker, s.tier, s.leverageFactor, ticker(s.underlyingSymbolId)]),
    ).toEqual([
      ['SPY', 0, 1, null],
      ['SSO', 0, 2, 'SPY'],
      ['UPRO', 0, 3, 'SPY'],
      ['SPXL', 0, 3, 'SPY'],
      ['QQQ', 0, 1, null],
      ['QLD', 0, 2, 'QQQ'],
      ['TQQQ', 0, 3, 'QQQ'],
      ['IEF', 0, 1, null],
      ['TLT', 0, 1, null],
      ['GLD', 0, 1, null],
    ]);
    expect(symbols.find((s) => s.ticker === 'SPY')?.indexSeries).toBe('SP500');
    expect(symbols.every((s) => s.domicile === 'US')).toBe(true);
  });

  it('refuses a universe file whose symbols do not state their leverage, or are malformed', () => {
    const ok = { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 };
    expect(
      parseSymbolList([ok, { ...ok, ticker: 'BBB', leverageFactor: -1, domicile: 'QX' }]),
    ).toHaveLength(2);
    const { leverageFactor: _, ...unstated } = ok;
    expect(() => parseSymbolList([unstated])).toThrow(/AAA: leverageFactor must be stated/);
    for (const bad of [0, '2', Number.NaN, null]) {
      expect(() => parseSymbolList([{ ...ok, leverageFactor: bad }])).toThrow(/leverageFactor/);
    }
    expect(() => parseSymbolList([{ ...ok, domicile: 'USA' }])).toThrow(/domicile/);
    expect(() => parseSymbolList([{ ...ok, leverage: 2 }])).toThrow(/unknown field "leverage"/);
    expect(() => parseSymbolList([{ ...ok, currency: 'usd' }])).toThrow(/currency/);
    expect(() => parseSymbolList({})).toThrow(/list/);
  });

  it('upsertSymbols checks the list whole and keeps what a re-import leaves out', async () => {
    const db = await testDb();
    const spy = {
      ticker: 'SPY',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      leverageFactor: 1,
    };
    await upsertSymbols(db, [{ ...spy, issuer: 'Fund Co', indexSeries: 'IDX', domicile: 'US' }]);
    await upsertSymbols(db, [{ ...spy, ticker: 'SSO', leverageFactor: 2, underlying: 'SPY' }]);
    // Left out: kept; the stated fields are updated.
    await upsertSymbols(db, [{ ...spy, tier: 1 }]);
    const row = async (t: string) => (await activeSymbols(db)).find((s) => s.ticker === t)!;
    expect(await row('SPY')).toMatchObject({
      tier: 1,
      issuer: 'Fund Co',
      indexSeries: 'IDX',
      domicile: 'US',
    });
    await upsertSymbols(db, [{ ...spy, ticker: 'SSO', leverageFactor: 2 }]);
    expect((await row('SSO')).underlyingSymbolId).toBe((await row('SPY')).id);
    // null clears.
    await upsertSymbols(db, [{ ...spy, issuer: null, domicile: null }]);
    expect(await row('SPY')).toMatchObject({ issuer: null, indexSeries: 'IDX', domicile: null });
    // A refused symbol stops the whole list before anything is written.
    await expect(
      upsertSymbols(db, [
        { ...spy, ticker: 'NEW' },
        { ...spy, ticker: 'BAD', leverageFactor: undefined as unknown as number },
      ]),
    ).rejects.toThrow(/BAD: leverageFactor must be stated/);
    expect((await activeSymbols(db)).map((s) => s.ticker)).toEqual(['SPY', 'SSO']);
  });
});
