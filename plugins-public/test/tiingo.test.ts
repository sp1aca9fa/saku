import { fixtureContext } from '@saku/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { tiingo } from '../src/tiingo';
import { fixture } from './fixture';

const answers = (url: URL) =>
  url.pathname === '/tiingo/daily/aaa/prices'
    ? fixture('tiingo-prices.json')
    : url.pathname === '/tiingo/daily/aaa'
      ? fixture('tiingo-meta.json')
      : undefined;

describe('Tiingo', () => {
  it('maps prices to raw bars, keeping Tiingo’s adjusted close for checks', async () => {
    const ctx = fixtureContext(answers, { apiKey: 'k' });
    const bars = await tiingo.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
    expect(bars.map((b) => b.date)).toEqual(['2026-01-02', '2026-01-05', '2026-01-06']);
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
    expect(ctx.requested[0]).toBe(
      'https://api.tiingo.com/tiingo/daily/aaa/prices?startDate=2026-01-02&endDate=2026-01-06&format=json',
    );
    expect(ctx.headers[0]?.Authorization).toBe('Token k');
  });

  it('reads metadata', async () => {
    const ctx = fixtureContext(answers, { apiKey: 'k' });
    expect(await tiingo.fetchMeta!('AAA', ctx)).toEqual({
      ticker: 'AAA',
      name: 'Example Index Fund',
      exchange: 'NYSE ARCA',
      inceptionDate: '1999-03-10',
    });
  });

  it('fails on a changed answer', async () => {
    const ctx = fixtureContext(() => [{ date: '2026-01-02', close: '101' }], { apiKey: 'k' });
    await expect(tiingo.fetchBars('AAA', '2026-01-02', '2026-01-02', ctx)).rejects.toThrow();
  });
});
