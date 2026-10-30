// Alpaca market data (official API): raw daily bars from 2016, with dividends and splits from
// the corporate actions endpoint. https://docs.alpaca.markets/docs/about-market-data-api
import { tradingDateOf } from '@saku/core';
import type { BarSource, PluginContext, RawBar } from '@saku/plugin-sdk';
import { z } from 'zod';

const BASE = 'https://data.alpaca.markets';
const KEY_ID = 'ALPACA_API_KEY_ID';
const SECRET = 'ALPACA_API_SECRET_KEY';

const Bar = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});
const BarsPage = z.object({
  bars: z.record(z.string(), z.array(Bar)).nullable(),
  next_page_token: z.string().nullable(),
});
const Split = z.object({ ex_date: z.string(), old_rate: z.number(), new_rate: z.number() });
const ActionsPage = z.object({
  corporate_actions: z.object({
    cash_dividends: z.array(z.object({ ex_date: z.string(), rate: z.number() })).optional(),
    forward_splits: z.array(Split).optional(),
    reverse_splits: z.array(Split).optional(),
  }),
  next_page_token: z.string().nullable(),
});

/**
 * How far before the request a bars query may end. The free (Basic) plan refuses SIP data of the
 * latest 15 minutes (https://docs.alpaca.markets/docs/about-market-data-api, "Historical data
 * limitation: latest 15 minutes"; HTTP 403 "subscription does not permit querying recent SIP
 * data"); one more minute of margin.
 */
export const ALPACA_RECENT_MS = 16 * 60_000;

/**
 * The bars query's `end` (inclusive; RFC 3339 or `YYYY-MM-DD` per the stock bars reference). A
 * date before today in New York stays a date. Today or later (a date end means the whole day,
 * which reaches into the last 15 minutes) is capped at `now` minus ALPACA_RECENT_MS as an RFC 3339
 * instant; a bar not yet complete then is fetched again by a later run, whose window covers the
 * date. `now` is the run's clock, taken before the request, so the cap is at least that far back.
 */
export function alpacaBarsEnd(to: string, now: Date): string {
  if (to < tradingDateOf(now)) return to;
  return new Date(now.getTime() - ALPACA_RECENT_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const auth = (ctx: PluginContext) => ({
  'APCA-API-KEY-ID': ctx.keys?.[KEY_ID] ?? '',
  'APCA-API-SECRET-KEY': ctx.keys?.[SECRET] ?? '',
});

/** Follows `next_page_token` until the last page. */
async function pages<T extends { next_page_token: string | null }>(
  url: string,
  schema: z.ZodType<T>,
  ctx: PluginContext,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | null = null;
  do {
    const page: T = schema.parse(
      await ctx.http.json(
        token ? `${url}&page_token=${encodeURIComponent(token)}` : url,
        auth(ctx),
      ),
    );
    out.push(page);
    token = page.next_page_token;
  } while (token);
  return out;
}

export const alpaca: BarSource = {
  info: {
    key: 'alpaca',
    kind: 'bar',
    name: 'Alpaca',
    provides: { markets: ['US'] },
    suggestedRole: 'secondary',
    limits: { perMinute: 200 },
    history: { from: '2016-01-01' },
    keyEnv: [KEY_ID, SECRET],
    termsUrl: 'https://alpaca.markets/disclosures',
    // Exchange subscriber agreements not yet read for AI use (docs/data-spike.md).
    noAi: true,
  },

  async fetchBars(ticker, from, to, ctx) {
    const symbol = encodeURIComponent(ticker);
    const end = alpacaBarsEnd(to, ctx.now);
    // Capped before `from` even starts (a run just after midnight asking for today only):
    // nothing can be asked for yet.
    if (end.length > 10 && tradingDateOf(Date.parse(end)) < from) return [];
    const barPages = await pages(
      `${BASE}/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&start=${from}&end=${encodeURIComponent(end)}&adjustment=raw&feed=sip&limit=10000`,
      BarsPage,
      ctx,
    );
    const bars = new Map<string, RawBar>();
    for (const b of barPages.flatMap((p) => p.bars?.[ticker] ?? [])) {
      // Daily bars are stamped at midnight New York time.
      const date = tradingDateOf(Date.parse(b.t));
      bars.set(date, {
        date,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        closeIsSplitAdjusted: false,
        volume: b.v,
        divCash: 0,
        splitFactor: 1,
      });
    }

    // Corporate actions are not SIP market data (no 15-minute limit) and take dates only
    // (`YYYY-MM-DD`, per the corporate actions reference): `to` as asked.
    const actions = await pages(
      `${BASE}/v1/corporate-actions?symbols=${symbol}&types=cash_dividend,forward_split,reverse_split&start=${from}&end=${to}&limit=1000`,
      ActionsPage,
      ctx,
    );
    const onDate = (date: string, what: string) => {
      const bar = bars.get(date);
      // An event without its bar means the answer is incomplete: never drop it silently.
      if (!bar) throw new Error(`Alpaca: ${what} for ${ticker} on ${date} has no bar`);
      return bar;
    };
    for (const page of actions) {
      const ca = page.corporate_actions;
      for (const d of ca.cash_dividends ?? []) onDate(d.ex_date, 'dividend').divCash += d.rate;
      for (const s of [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]) {
        onDate(s.ex_date, 'split').splitFactor *= s.new_rate / s.old_rate;
      }
    }
    return [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
  },
};
