import { fixtureContext } from '@saku/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { ALPACA_RECENT_MS, alpaca, alpacaBarsEnd } from '../src/alpaca';
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

  describe('the free plan refuses SIP data of the last 15 minutes', () => {
    // 2026-10-29 20:35 New York (EDT), as on the second bootstrap.
    const now = new Date('2026-10-30T00:35:00Z');

    it('caps an end of today at 16 minutes before the run, as an RFC 3339 instant', () => {
      expect(ALPACA_RECENT_MS).toBe(16 * 60_000);
      expect(alpacaBarsEnd('2026-10-29', now)).toBe('2026-10-30T00:19:00Z');
      // Later than today is capped the same way.
      expect(alpacaBarsEnd('2026-10-30', now)).toBe('2026-10-30T00:19:00Z');
      // A past day stays a date (its whole day is long over).
      expect(alpacaBarsEnd('2026-10-28', now)).toBe('2026-10-28');
      // Today is the New York date: 2026-10-30 in UTC is still 2026-10-29 there.
      expect(alpacaBarsEnd('2026-10-29', new Date('2026-10-30T03:59:00Z'))).toBe(
        '2026-10-30T03:43:00Z',
      );
    });

    it('asks for bars up to the cap and corporate actions up to the date', async () => {
      const ctx = fixtureContext(answers(), { keys, now });
      await alpaca.fetchBars('AAA', '2026-01-02', '2026-10-29', ctx);
      const bars = new URL(ctx.requested[0]!);
      expect(bars.searchParams.get('end')).toBe('2026-10-30T00:19:00Z');
      expect(bars.searchParams.get('start')).toBe('2026-01-02');
      const actions = new URL(ctx.requested.at(-1)!);
      expect(actions.pathname).toBe('/v1/corporate-actions');
      expect(actions.searchParams.get('end')).toBe('2026-10-29');
    });

    it('asks nothing when the cap falls before the range starts', async () => {
      // 00:05 New York on 2026-10-30, asking for that day only.
      const early = fixtureContext(answers(), { keys, now: new Date('2026-10-30T04:05:00Z') });
      expect(await alpaca.fetchBars('AAA', '2026-10-30', '2026-10-30', early)).toEqual([]);
      expect(early.requested).toHaveLength(0);
    });

    it("says why when Alpaca refuses (the provider's message, keys masked)", async () => {
      const ctx = fixtureContext(
        () => new Response(JSON.stringify(fixture('alpaca-recent-sip.json')), { status: 403 }),
        { keys },
      );
      await expect(alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx)).rejects.toThrow(
        /^HTTP 403 for https:\/\/data\.alpaca\.markets\/v2\/stocks\/bars\?.*: subscription does not permit querying recent SIP data$/,
      );
    });
  });
});
