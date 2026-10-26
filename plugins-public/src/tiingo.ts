// Tiingo end-of-day prices (official API): raw OHLCV, dividends and splits, and Tiingo's
// adjusted close for return checks. https://www.tiingo.com/documentation/end-of-day
import { isTradingDate } from '@saku/core';
import type { BarSource, PluginContext, RawBar } from '@saku/plugin-sdk';
import { z } from 'zod';

const BASE = 'https://api.tiingo.com/tiingo/daily';

const Price = z.object({
  date: z.string(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number(),
  volume: z.number().nullable(),
  adjClose: z.number().nullable(),
  divCash: z.number(),
  splitFactor: z.number(),
});
const Meta = z.object({
  ticker: z.string(),
  name: z.string().nullable(),
  exchangeCode: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});

const auth = (ctx: PluginContext) => ({ Authorization: `Token ${ctx.apiKey}` });

/** Tiingo sends `2026-01-02T00:00:00.000Z`; the date part is the trading date. */
function dateOf(text: string): string {
  const date = text.slice(0, 10);
  if (!isTradingDate(date)) throw new Error(`Tiingo sent an unreadable date "${text}"`);
  return date;
}

export const tiingo: BarSource = {
  info: {
    key: 'tiingo',
    kind: 'bar',
    name: 'Tiingo',
    provides: { markets: ['US'] },
    suggestedRole: 'primary',
    limits: { perHour: 50, perDay: 1000, symbolsPerMonth: 500 },
    keyEnv: 'TIINGO_API_KEY',
    termsUrl: 'https://www.tiingo.com/about/pricing',
    // Free plan is "internal use only"; AI use not confirmed (docs/data-spike.md).
    noAi: true,
  },

  async fetchBars(ticker, from, to, ctx) {
    const url = `${BASE}/${encodeURIComponent(ticker.toLowerCase())}/prices?startDate=${from}&endDate=${to}&format=json`;
    const prices = z.array(Price).parse(await ctx.http.json(url, auth(ctx)));
    return prices.map((p): RawBar => ({
      date: dateOf(p.date),
      ...(p.open !== null && { open: p.open }),
      ...(p.high !== null && { high: p.high }),
      ...(p.low !== null && { low: p.low }),
      close: p.close,
      closeIsSplitAdjusted: false,
      ...(p.volume !== null && { volume: p.volume }),
      divCash: p.divCash,
      splitFactor: p.splitFactor,
      ...(p.adjClose !== null && { providerAdjClose: p.adjClose }),
    }));
  },

  async fetchMeta(ticker, ctx) {
    const url = `${BASE}/${encodeURIComponent(ticker.toLowerCase())}`;
    const m = Meta.parse(await ctx.http.json(url, auth(ctx)));
    return {
      ticker: m.ticker.toUpperCase(),
      ...(m.name && { name: m.name }),
      ...(m.exchangeCode && { exchange: m.exchangeCode }),
      ...(m.startDate && { inceptionDate: dateOf(m.startDate) }),
    };
  },
};
