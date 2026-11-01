import { fixtureContext } from '@saku/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import {
  ALPACA_ACTIONS_LOOKAHEAD_DAYS,
  ALPACA_ACTIONS_LOOKBACK_DAYS,
  ALPACA_RECENT_MS,
  alpaca,
  alpacaActionsEnd,
  alpacaActionsStart,
  alpacaBarsEnd,
} from '../src/alpaca';
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

  describe('corporate actions are filtered on the process date, not the ex-date', () => {
    // A dividend processed inside the asked span whose ex-date is before it (as SPY's 2026-09-18
    // ex-date, processed about 2026-10-30, in a daily window ending 2026-10-30).
    const action = (exDate: string, processDate: string) => ({
      corporate_actions: {
        cash_dividends: [
          {
            id: 'd9',
            symbol: 'AAA',
            cusip: '000000000',
            rate: 0.75,
            special: false,
            foreign: false,
            process_date: processDate,
            ex_date: exDate,
            record_date: exDate,
            payable_date: processDate,
          },
        ],
        forward_splits: [
          {
            id: 's9',
            symbol: 'AAA',
            cusip: '000000000',
            old_rate: 1,
            new_rate: 3,
            process_date: processDate,
            ex_date: exDate,
          },
        ],
      },
      next_page_token: null,
    });

    it('ignores an action whose ex-date is before the span', async () => {
      const ctx = fixtureContext(answers(action('2025-11-21', '2026-01-05')), { keys });
      const bars = await alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
      expect(bars.map((b) => [b.date, b.divCash, b.splitFactor])).toEqual([
        ['2026-01-02', 0, 1],
        ['2026-01-05', 0, 1],
        ['2026-01-06', 0, 1],
      ]);
    });

    it('ignores an action whose ex-date is after the span', async () => {
      const ctx = fixtureContext(answers(action('2026-01-09', '2026-02-20')), { keys });
      const bars = await alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
      expect(bars.every((b) => b.divCash === 0 && b.splitFactor === 1)).toBe(true);
    });

    it('applies an action whose ex-date is in the span and process date after it', async () => {
      const ctx = fixtureContext(answers(action('2026-01-05', '2026-02-20')), { keys });
      const bars = await alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
      expect(bars.map((b) => [b.date, b.divCash, b.splitFactor])).toEqual([
        ['2026-01-02', 0, 1],
        ['2026-01-05', 0.75, 3],
        ['2026-01-06', 0, 1],
      ]);
    });

    it('still refuses an action in the span without its bar, on the span edges too', async () => {
      // 2026-01-03 is a Saturday (no bar) inside the span.
      for (const [from, to, exDate] of [
        ['2026-01-02', '2026-01-06', '2026-01-03'],
        ['2026-01-03', '2026-01-06', '2026-01-03'],
        ['2026-01-02', '2026-01-03', '2026-01-03'],
      ] as const) {
        const ctx = fixtureContext(answers(action(exDate, '2026-02-20')), { keys });
        await expect(alpaca.fetchBars('AAA', from, to, ctx)).rejects.toThrow(
          /^Alpaca: dividend for AAA on 2026-01-03 has no bar$/,
        );
      }
    });

    it('refuses an unreadable ex-date rather than reading it as outside the span', async () => {
      const ctx = fixtureContext(answers(action('', '2026-01-05')), { keys });
      await expect(alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx)).rejects.toThrow(
        /unreadable ex_date/,
      );
    });

    it('applies an action processed before its ex-date, the ex-date being the first day', async () => {
      // A forward split paid (processed) the trading day before its ex-date: as Alpaca does,
      // the answer holds only actions whose process date is within the asked start and end.
      const split = action('2026-01-05', '2026-01-02');
      const byProcessDate = (url: URL) => {
        if (url.pathname !== '/v1/corporate-actions') return answers()(url);
        const start = url.searchParams.get('start')!;
        const end = url.searchParams.get('end')!;
        const inWindow = (a: { process_date: string }) =>
          a.process_date >= start && a.process_date <= end;
        return {
          corporate_actions: {
            cash_dividends: split.corporate_actions.cash_dividends.filter(inWindow),
            forward_splits: split.corporate_actions.forward_splits.filter(inWindow),
          },
          next_page_token: null,
        };
      };
      const ctx = fixtureContext(byProcessDate, { keys });
      const bars = await alpaca.fetchBars('AAA', '2026-01-05', '2026-01-06', ctx);
      const first = bars.find((b) => b.date === '2026-01-05')!;
      expect([first.divCash, first.splitFactor]).toEqual([0.75, 3]);
    });

    it('asks corporate actions from the look-back before the span to the look-ahead past it', async () => {
      expect(ALPACA_ACTIONS_LOOKBACK_DAYS).toBe(30);
      expect(ALPACA_ACTIONS_LOOKAHEAD_DAYS).toBe(120);
      expect(alpacaActionsStart('2026-01-02')).toBe('2025-12-03');
      // Across a leap day (2028-02-29).
      expect(alpacaActionsStart('2028-03-15')).toBe('2028-02-14');
      expect(() => alpacaActionsStart('2026-02-30')).toThrow(/unreadable date/);
      const later = new Date('2030-01-01T12:00:00Z');
      expect(alpacaActionsEnd('2026-01-06', later)).toBe('2026-05-06');
      // Across a year end and a leap day (2028-02-29).
      expect(alpacaActionsEnd('2027-12-31', later)).toBe('2028-04-29');
      expect(() => alpacaActionsEnd('2026-02-30', later)).toThrow(/unreadable date/);
      // Capped at today in New York: 2026-03-02 03:00 UTC is 2026-03-01 22:00 New York (EST).
      expect(alpacaActionsEnd('2026-01-06', new Date('2026-03-02T03:00:00Z'))).toBe('2026-03-01');
      // The cap equal to the look-ahead's end.
      expect(alpacaActionsEnd('2026-01-06', new Date('2026-05-06T16:00:00Z'))).toBe('2026-05-06');
      const ctx = fixtureContext(answers(), { keys, now: later });
      await alpaca.fetchBars('AAA', '2026-01-02', '2026-01-06', ctx);
      const actions = new URL(ctx.requested.at(-1)!);
      expect(actions.pathname).toBe('/v1/corporate-actions');
      expect(actions.searchParams.get('start')).toBe('2025-12-03');
      expect(actions.searchParams.get('end')).toBe('2026-05-06');
    });
  });

  describe('the free plan refuses SIP data of the last 15 minutes', () => {
    // 2026-10-29 20:35 New York (EDT), as on the second bootstrap.
    const now = new Date('2026-10-30T00:35:00Z');

    it('ends at the earlier of the day end in New York and 16 minutes before the run', () => {
      expect(ALPACA_RECENT_MS).toBe(16 * 60_000);
      // Today: the run's clock minus 16 minutes.
      expect(alpacaBarsEnd('2026-10-29', now)).toBe('2026-10-30T00:19:00Z');
      // Later than today is capped the same way.
      expect(alpacaBarsEnd('2026-10-30', now)).toBe('2026-10-30T00:19:00Z');
      // A past day: its end, 23:59:59 New York (EDT, UTC-4), as an instant.
      expect(alpacaBarsEnd('2026-10-28', now)).toBe('2026-10-29T03:59:59Z');
      // 00:05 New York the next day: the day's end is within the last 15 minutes, so capped.
      expect(alpacaBarsEnd('2026-10-29', new Date('2026-10-30T04:05:00Z'))).toBe(
        '2026-10-30T03:49:00Z',
      );
      // 00:20 New York the next day: the day's end is old enough.
      expect(alpacaBarsEnd('2026-10-29', new Date('2026-10-30T04:20:00Z'))).toBe(
        '2026-10-30T03:59:59Z',
      );
      // Winter time (EST, UTC-5), and the day of the clock change (2026-11-01 ends in EST).
      expect(alpacaBarsEnd('2026-01-15', now)).toBe('2026-01-16T04:59:59Z');
      expect(alpacaBarsEnd('2026-11-01', new Date('2026-11-03T00:00:00Z'))).toBe(
        '2026-11-02T04:59:59Z',
      );
      // Summer time starts 2026-03-08: that day ends in EDT.
      expect(alpacaBarsEnd('2026-03-08', now)).toBe('2026-03-09T03:59:59Z');
    });

    it('asks for bars up to the cap and corporate actions past the date', async () => {
      const ctx = fixtureContext(answers(), { keys, now });
      await alpaca.fetchBars('AAA', '2026-01-02', '2026-10-29', ctx);
      const bars = new URL(ctx.requested[0]!);
      expect(bars.searchParams.get('end')).toBe('2026-10-30T00:19:00Z');
      expect(bars.searchParams.get('start')).toBe('2026-01-02');
      const actions = new URL(ctx.requested.at(-1)!);
      expect(actions.pathname).toBe('/v1/corporate-actions');
      // 2026-10-29 plus the 120-day look-ahead (2027-02-26), capped at today in New York.
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
