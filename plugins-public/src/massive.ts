// Massive, formerly Polygon (official API): unadjusted daily aggregates with dividends and splits
// from the corporate actions endpoints. Free plan: 2 years, 5 calls per minute.
// https://massive.com/docs
import { tradingDateOf } from '@saku/core';
import type { BarSource, PluginContext, RawBar } from '@saku/plugin-sdk';
import { z } from 'zod';

const BASE = 'https://api.massive.com';

const Aggs = z.object({
  results: z
    .array(
      z.object({
        t: z.number(),
        o: z.number(),
        h: z.number(),
        l: z.number(),
        c: z.number(),
        v: z.number(),
      }),
    )
    .optional(),
  next_url: z.string().optional(),
});
const Dividends = z.object({
  results: z.array(
    z.object({ ex_dividend_date: z.string(), cash_amount: z.number(), currency: z.string() }),
  ),
  next_url: z.string().optional(),
});
const Splits = z.object({
  results: z.array(
    z.object({ execution_date: z.string(), split_from: z.number(), split_to: z.number() }),
  ),
  next_url: z.string().optional(),
});

const auth = (ctx: PluginContext) => ({ Authorization: `Bearer ${ctx.apiKey}` });

/** Follows `next_url` until the last page. */
async function pages<T extends { next_url?: string | undefined }>(
  url: string,
  schema: z.ZodType<T>,
  ctx: PluginContext,
): Promise<T[]> {
  const out: T[] = [];
  for (let next: string | undefined = url; next;) {
    const page: T = schema.parse(await ctx.http.json(next, auth(ctx)));
    out.push(page);
    next = page.next_url;
  }
  return out;
}

export const massive: BarSource = {
  info: {
    key: 'massive',
    kind: 'bar',
    name: 'Massive',
    provides: { markets: ['US'] },
    suggestedRole: 'secondary',
    limits: { perMinute: 5 },
    history: { years: 2 },
    keyEnv: 'MASSIVE_API_KEY',
    termsUrl: 'https://massive.com/legal/individuals-terms-of-service',
    // Market Data Terms not yet read for AI use (docs/data-spike.md).
    noAi: true,
  },

  async fetchBars(ticker, from, to, ctx) {
    const t = encodeURIComponent(ticker);
    const bars = new Map<string, RawBar>();
    const aggs = await pages(
      `${BASE}/v2/aggs/ticker/${t}/range/1/day/${from}/${to}?adjusted=false&sort=asc&limit=50000`,
      Aggs,
      ctx,
    );
    for (const a of aggs.flatMap((p) => p.results ?? [])) {
      const date = tradingDateOf(a.t);
      bars.set(date, {
        date,
        open: a.o,
        high: a.h,
        low: a.l,
        close: a.c,
        closeIsSplitAdjusted: false,
        volume: a.v,
        divCash: 0,
        splitFactor: 1,
      });
    }
    const onDate = (date: string, what: string) => {
      const bar = bars.get(date);
      if (!bar) throw new Error(`Massive: ${what} for ${ticker} on ${date} has no bar`);
      return bar;
    };
    const dividends = await pages(
      `${BASE}/stocks/v1/dividends?ticker=${t}&ex_dividend_date.gte=${from}&ex_dividend_date.lte=${to}&limit=5000`,
      Dividends,
      ctx,
    );
    for (const d of dividends.flatMap((p) => p.results)) {
      if (d.currency !== 'USD') throw new Error(`Massive: ${ticker} dividend in ${d.currency}`);
      onDate(d.ex_dividend_date, 'dividend').divCash += d.cash_amount;
    }
    const splits = await pages(
      `${BASE}/stocks/v1/splits?ticker=${t}&execution_date.gte=${from}&execution_date.lte=${to}&limit=5000`,
      Splits,
      ctx,
    );
    for (const s of splits.flatMap((p) => p.results)) {
      onDate(s.execution_date, 'split').splitFactor *= s.split_to / s.split_from;
    }
    return [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
  },
};
