import { fixtureContext } from '@saku/plugin-sdk/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exampleBars } from '../src/example-bars';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

function answers(url: URL) {
  if (url.pathname === '/v2/eod/AAA') return fixture('eod-aaa.json');
  if (url.pathname === '/v2/symbols/AAA') return fixture('symbol-aaa.json');
  return undefined;
}

describe('Example Market Data (template)', () => {
  it('maps the answer to raw bars without adjusting anything', async () => {
    const ctx = fixtureContext(answers, { apiKey: 'test-key' });
    const bars = await exampleBars.fetchBars('AAA', '2026-01-02', '2026-01-07', ctx);
    expect(bars).toHaveLength(4);
    expect(bars[1]).toEqual({
      date: '2026-01-05',
      open: 101.2,
      high: 102.0,
      low: 100.1,
      close: 100.5,
      closeIsSplitAdjusted: false,
      volume: 980000,
      divCash: 0.5,
      splitFactor: 1,
      providerAdjClose: 49.997525,
    });
    expect(bars[2]).toMatchObject({ close: 50.8, splitFactor: 2 });
    // Missing fields stay missing (layer A decides), never become zeros.
    expect(bars[3]).toEqual({
      date: '2026-01-07',
      close: 50.9,
      closeIsSplitAdjusted: false,
      divCash: 0,
      splitFactor: 1,
    });
  });

  it('sends the key in a header, not the URL', async () => {
    const ctx = fixtureContext(answers, { apiKey: 'test-key' });
    await exampleBars.fetchBars('AAA', '2026-01-02', '2026-01-07', ctx);
    expect(ctx.requested[0]).not.toContain('test-key');
    expect(ctx.headers[0]?.Authorization).toBe('Bearer test-key');
  });

  it('fails loudly when the answer changes shape or names another ticker', async () => {
    const renamed = fixtureContext(() => ({
      symbol: 'AAA',
      currency: 'USD',
      prices: [{ day: 'x' }],
    }));
    await expect(
      exampleBars.fetchBars('AAA', '2026-01-02', '2026-01-07', renamed),
    ).rejects.toThrow();
    const other = fixtureContext(() => ({ ...(fixture('eod-aaa.json') as object), symbol: 'BBB' }));
    await expect(exampleBars.fetchBars('AAA', '2026-01-02', '2026-01-07', other)).rejects.toThrow(
      /BBB/,
    );
  });

  it('reads ticker metadata', async () => {
    const ctx = fixtureContext(answers, { apiKey: 'test-key' });
    expect(await exampleBars.fetchMeta!('AAA', ctx)).toEqual({
      ticker: 'AAA',
      name: 'Example Index Fund',
      exchange: 'EXMPL',
      inceptionDate: '1999-03-10',
      active: true,
    });
  });
});
