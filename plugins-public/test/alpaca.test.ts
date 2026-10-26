import { fixtureContext } from '@saku/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { alpaca } from '../src/alpaca';
import { fixture } from './fixture';

const keys = { ALPACA_API_KEY_ID: 'id', ALPACA_API_SECRET_KEY: 'secret' };

function answers(actions: unknown = fixture('alpaca-actions.json')) {
  return (url: URL) => {
    if (url.pathname === '/v2/stocks/bars') {
      return url.searchParams.get('page_token')
        ? fixture('alpaca-bars-2.json')
        : fixture('alpaca-bars-1.json');
    }
    if (url.pathname === '/v1/corporate-actions') return actions;
    return undefined;
  };
}

describe('Alpaca', () => {
  it('joins raw bars across pages with dividends and splits', async () => {
    const ctx = fixtureContext(answers(), { keys });
    const bars = await alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
    expect(bars.map((b) => [b.date, b.close, b.divCash, b.splitFactor])).toEqual([
      ['2026-01-02', 101.0, 0, 1],
      ['2026-01-05', 100.5, 0.5, 1],
      ['2026-01-06', 50.8, 0, 2],
    ]);
    expect(ctx.requested[0]).toContain('adjustment=raw');
    expect(ctx.headers[0]).toMatchObject({
      'APCA-API-KEY-ID': 'id',
      'APCA-API-SECRET-KEY': 'secret',
    });
  });

  it('refuses an event that has no bar', async () => {
    const orphan = {
      corporate_actions: { cash_dividends: [{ ex_date: '2026-01-03', rate: 0.5 }] },
      next_page_token: null,
    };
    const ctx = fixtureContext(answers(orphan), { keys });
    await expect(alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx)).rejects.toThrow(
      /no bar/,
    );
  });
});
