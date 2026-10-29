// The default universe template (`templates/universe/us-etf-tier0.json`) holds Tier 0 as the
// requirements list it (03-assets): every ticker, its leverage and underlying (layer C pairs) and
// SPY's index series (layer C index check).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './env';
import { activeSymbols, upsertSymbols } from './market';
import { testDb } from './testing';

describe('Tier 0 universe template', () => {
  it('imports every Tier 0 ticker with its leverage, underlying and index', async () => {
    const file = join(findRepoRoot(), 'templates', 'universe', 'us-etf-tier0.json');
    const db = await testDb();
    await upsertSymbols(db, JSON.parse(readFileSync(file, 'utf8')));
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
  });
});
