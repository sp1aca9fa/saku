// Alpaca market data (official API): raw daily bars from 2016, with dividends and splits from
// the corporate actions endpoint. https://docs.alpaca.markets/docs/about-market-data-api
import { isTradingDate, tradingDateOf, zonedInstant } from '@saku/core';
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
// A readable ex-date is required: an unreadable one must never pass as "outside the span".
const ExDate = z.string().refine(isTradingDate, { message: 'unreadable ex_date' });
const Split = z.object({ ex_date: ExDate, old_rate: z.number(), new_rate: z.number() });
const ActionsPage = z.object({
  corporate_actions: z.object({
    cash_dividends: z.array(z.object({ ex_date: ExDate, rate: z.number() })).optional(),
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
 * The bars query's `end` (inclusive; RFC 3339 or `YYYY-MM-DD` per the stock bars reference),
 * always an RFC 3339 instant: the end of `to` in New York (23:59:59; a date `end` means the same,
 * which between 00:00 and 00:16 New York the next day still lies within the last 15 minutes), or
 * `now` minus ALPACA_RECENT_MS, whichever is earlier. A bar not complete at the cap is fetched
 * again by a later run, whose window covers the date. `now` is the run's clock, taken before the
 * request, so the cap is at least that far back.
 */
export function alpacaBarsEnd(to: string, now: Date): string {
  const endOfDay = Date.parse(zonedInstant(to, '23:59', 'America/New_York')) + 59_000;
  const cap = now.getTime() - ALPACA_RECENT_MS;
  return new Date(Math.min(endOfDay, cap)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * How many calendar days past `to` the corporate actions request reaches. Alpaca's
 * `/v1/corporate-actions` filters `start`/`end` on an action's `process_date`, not its `ex_date`
 * (https://docs.alpaca.markets/reference/corporateactions-1); for a cash dividend the process date
 * is about the payable date, weeks after the ex-date (SPY's 2026-09-18 ex-date was processed about
 * 2026-10-30). Reaching past `to` finds a dividend whose ex-date is in the span and whose process
 * date is later, once Alpaca lists it. 120 days covers payable dates up to about four months after
 * the ex-date; one processed later still is missed here. Alpaca may list a dividend only once it
 * is processed, so a recent ex-date can still read 0 (no dividend) when fetched before then.
 */
export const ALPACA_ACTIONS_LOOKAHEAD_DAYS = 120;

/**
 * How many calendar days before `from` the corporate actions request starts. Filtering on the
 * process date, `start=from` would miss an action processed before its ex-date: a forward split
 * is commonly processed (paid) the trading day before its ex-date (e.g. paid Friday, ex-date
 * Monday), so a span starting on that Monday would get no split, and a refetch would revise the
 * stored factor back to 1. 30 days covers a process date up to about a month before the ex-date;
 * one processed earlier still is missed. Actions found this way whose ex-date is before `from`
 * are ignored (another span holds them).
 */
export const ALPACA_ACTIONS_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

/** `date` moved by `days` calendar days (`YYYY-MM-DD`); an unreadable date is refused. */
function shiftDate(date: string, days: number): string {
  if (!isTradingDate(date)) throw new Error(`Alpaca: unreadable date "${date}"`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The corporate actions query's `start` (a date): `from` minus ALPACA_ACTIONS_LOOKBACK_DAYS. */
export function alpacaActionsStart(from: string): string {
  return shiftDate(from, -ALPACA_ACTIONS_LOOKBACK_DAYS);
}

/**
 * The corporate actions query's `end` (a date): `to` plus ALPACA_ACTIONS_LOOKAHEAD_DAYS, capped
 * at today in New York (from the run's clock `now`). Alpaca lists an action once processed, so a
 * later `end` would find nothing more, and whether Alpaca accepts an `end` in the future is not
 * verified live (a refusal would fail every run). Revisit if Alpaca turns out to list announced
 * future actions.
 */
export function alpacaActionsEnd(to: string, now: Date): string {
  const reach = shiftDate(to, ALPACA_ACTIONS_LOOKAHEAD_DAYS);
  const today = tradingDateOf(now);
  return reach < today ? reach : today;
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
    // Alpaca lists a cash dividend only once processed (about its payable date; SPY's 2026-09-18
    // ex-date about 6 weeks later): within this many days of the ex-date a dividend it does not
    // list yet is pending in layer B, not a disagreement (decisions log 2026-11-01, C20). The
    // same reach as the corporate actions request (ALPACA_ACTIONS_LOOKAHEAD_DAYS).
    dividendListingLagDays: ALPACA_ACTIONS_LOOKAHEAD_DAYS,
  },

  async fetchBars(ticker, from, to, ctx) {
    const symbol = encodeURIComponent(ticker);
    const end = alpacaBarsEnd(to, ctx.now);
    // Capped before `from` even starts (a run just after midnight asking for today only):
    // nothing can be asked for yet.
    if (tradingDateOf(Date.parse(end)) < from) return [];
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
    // (`YYYY-MM-DD`, per the corporate actions reference). `start`/`end` filter on the process
    // date, so `start` reaches before `from` (ALPACA_ACTIONS_LOOKBACK_DAYS) and `end` past `to`
    // (ALPACA_ACTIONS_LOOKAHEAD_DAYS, capped at today), and the answer may hold actions whose
    // ex-date is outside the span.
    const actions = await pages(
      `${BASE}/v1/corporate-actions?symbols=${symbol}&types=cash_dividend,forward_split,reverse_split&start=${alpacaActionsStart(from)}&end=${alpacaActionsEnd(to, ctx.now)}&limit=1000`,
      ActionsPage,
      ctx,
    );
    const onDate = (date: string, what: string) => {
      const bar = bars.get(date);
      if (bar) return bar;
      // Ex-date outside [from, to] and no bar: the action belongs to another span (its bar is
      // fetched, and the action applied, by the run whose span holds the ex-date).
      if (date < from || date > to) return undefined;
      // An event in the span without its bar means the answer is incomplete: never drop it
      // silently.
      throw new Error(`Alpaca: ${what} for ${ticker} on ${date} has no bar`);
    };
    for (const page of actions) {
      const ca = page.corporate_actions;
      for (const d of ca.cash_dividends ?? []) {
        const bar = onDate(d.ex_date, 'dividend');
        if (bar) bar.divCash += d.rate;
      }
      for (const s of [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]) {
        const bar = onDate(s.ex_date, 'split');
        if (bar) bar.splitFactor *= s.new_rate / s.old_rate;
      }
    }
    return [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
  },
};
