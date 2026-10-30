// Example Market Data: a made-up provider, to copy when writing a bar source for a real one.
// Steps for a real provider: read its terms (personal use, AI use: set `noAi`), copy its limits
// into `info.limits`, save real answers as fixtures in the private repo (synthetic ones here),
// and map its fields to `RawBar` without adjusting anything.
import type { BarSource, PluginContext, RawBar, TickerMeta } from '@saku/plugin-sdk';
import { z } from 'zod';

const BASE = 'https://api.example-market-data.test/v2';

// Validate the answer's shape: a renamed or missing field must fail loudly, not store zeros.
const Price = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number(),
  volume: z.number().nullable(),
  dividend: z.number(),
  split_ratio: z.number(),
  adjusted_close: z.number().nullable(),
});
const EodAnswer = z.object({ symbol: z.string(), currency: z.string(), prices: z.array(Price) });
const SymbolAnswer = z.object({
  symbol: z.string(),
  name: z.string(),
  exchange: z.string(),
  listed: z.string(),
  status: z.enum(['active', 'delisted']),
});

/** The key goes in a header, never in the URL (URLs end up in logs). */
const auth = (ctx: PluginContext) => ({ Authorization: `Bearer ${ctx.apiKey}` });

export const exampleBars: BarSource = {
  info: {
    key: 'example-market-data',
    kind: 'bar',
    name: 'Example Market Data',
    provides: { markets: ['US'] },
    suggestedRole: 'secondary',
    // Another plug-in for this provider (e.g. its FX) sets the same `provider` and `limits`, so
    // their requests share one count. Left out, the provider is the key.
    // provider: 'example-market-data',
    limits: { perMinute: 60, perDay: 1000 },
    keyEnv: 'EXAMPLE_MARKET_DATA_KEY',
    termsUrl: 'https://example-market-data.test/terms',
  },

  async fetchBars(ticker, from, to, ctx) {
    const url = `${BASE}/eod/${encodeURIComponent(ticker)}?start=${from}&end=${to}`;
    const answer = EodAnswer.parse(await ctx.http.json(url, auth(ctx)));
    if (answer.symbol !== ticker) {
      throw new Error(`Example Market Data answered for ${answer.symbol}, not ${ticker}`);
    }
    if (answer.currency !== 'USD') throw new Error(`Unexpected currency ${answer.currency}`);
    return answer.prices.map((p): RawBar => ({
      date: p.date,
      ...(p.open !== null && { open: p.open }),
      ...(p.high !== null && { high: p.high }),
      ...(p.low !== null && { low: p.low }),
      close: p.close,
      // This provider's close is the price as traded that day (not split-adjusted).
      closeIsSplitAdjusted: false,
      ...(p.volume !== null && { volume: p.volume }),
      divCash: p.dividend,
      splitFactor: p.split_ratio,
      ...(p.adjusted_close !== null && { providerAdjClose: p.adjusted_close }),
    }));
  },

  async fetchMeta(ticker, ctx): Promise<TickerMeta> {
    const url = `${BASE}/symbols/${encodeURIComponent(ticker)}`;
    const s = SymbolAnswer.parse(await ctx.http.json(url, auth(ctx)));
    return {
      ticker: s.symbol,
      name: s.name,
      exchange: s.exchange,
      inceptionDate: s.listed,
      active: s.status === 'active',
    };
  },
};
