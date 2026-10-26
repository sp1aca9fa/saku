import { fixtureContext } from '@saku/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { massive } from '../src/massive';
import { fixture } from './fixture';

const answers = (url: URL) =>
  url.pathname.startsWith('/v2/aggs/ticker/AAA/')
    ? fixture('massive-aggs.json')
    : url.pathname === '/stocks/v1/dividends'
      ? fixture('massive-dividends.json')
      : url.pathname === '/stocks/v1/splits'
        ? fixture('massive-splits.json')
        : undefined;

describe('Massive', () => {
  it('joins unadjusted aggregates with dividends and splits', async () => {
    const ctx = fixtureContext(answers, { apiKey: 'k' });
    const bars = await massive.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
    expect(bars.map((b) => [b.date, b.close, b.divCash, b.splitFactor])).toEqual([
      ['2026-01-02', 101.0, 0, 1],
      ['2026-01-05', 100.5, 0.5, 1],
      ['2026-01-06', 50.8, 0, 2],
    ]);
    expect(ctx.requested[0]).toContain('adjusted=false');
    expect(ctx.headers[0]?.Authorization).toBe('Bearer k');
  });

  it('follows next_url', async () => {
    let first = true;
    const ctx = fixtureContext(
      (url) => {
        if (url.pathname.startsWith('/v2/aggs/')) {
          const page = fixture('massive-aggs.json') as { results: unknown[] };
          if (!first) return { results: page.results.slice(2) };
          first = false;
          return {
            results: page.results.slice(0, 2),
            next_url: 'https://api.massive.com/v2/aggs/cursor/x',
          };
        }
        return answers(url);
      },
      { apiKey: 'k' },
    );
    const bars = await massive.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
    expect(bars).toHaveLength(3);
  });
});
