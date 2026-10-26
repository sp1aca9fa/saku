// FRED, Federal Reserve Bank of St. Louis (official API): rates and index levels, and the H.10
// exchange rates as a secondary FX source. Every vintage is fetched (ALFRED real-time periods),
// so a past run's view can be reproduced. https://fred.stlouisfed.org/docs/api/fred/
import { isTradingDate } from '@saku/core';
import type {
  FxRate,
  FxSource,
  PluginContext,
  PluginInfo,
  SeriesPoint,
  SeriesSource,
} from '@saku/plugin-sdk';
import { z } from 'zod';

const URL_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const PAGE = 100_000;

const Observations = z.object({
  count: z.number(),
  offset: z.number(),
  observations: z.array(
    z.object({ realtime_start: z.string(), date: z.string(), value: z.string() }),
  ),
});

/** H.10 series for FX pairs (base then quote: `USDXXX` = XXX per USD). */
export const FRED_FX: Record<string, { series: string; invert: boolean }> = {
  USDJPY: { series: 'DEXJPUS', invert: false },
  USDCAD: { series: 'DEXCAUS', invert: false },
  USDCHF: { series: 'DEXSZUS', invert: false },
  EURUSD: { series: 'DEXUSEU', invert: false },
  GBPUSD: { series: 'DEXUSUK', invert: false },
};

const terms = 'https://fred.stlouisfed.org/docs/api/terms_of_use.html';
const common: Omit<PluginInfo, 'kind' | 'provides' | 'suggestedRole'> = {
  key: 'fred',
  name: 'FRED',
  limits: { perMinute: 120 },
  keyEnv: 'FRED_API_KEY',
  termsUrl: terms,
};

/** All observations of a series in the window, every vintage, missing values ('.') left out. */
async function observations(id: string, from: string, to: string, ctx: PluginContext) {
  const out: SeriesPoint[] = [];
  for (let offset = 0; ; offset += PAGE) {
    // FRED takes the key only as a URL parameter; the HTTP client redacts it from messages.
    const url =
      `${URL_BASE}?series_id=${encodeURIComponent(id)}&api_key=${ctx.apiKey}&file_type=json` +
      `&observation_start=${from}&observation_end=${to}` +
      `&realtime_start=1776-07-04&realtime_end=9999-12-31&limit=${PAGE}&offset=${offset}`;
    const page = Observations.parse(await ctx.http.json(url));
    for (const o of page.observations) {
      if (!isTradingDate(o.date) || !isTradingDate(o.realtime_start)) {
        throw new Error(`FRED ${id}: unreadable date in ${JSON.stringify(o)}`);
      }
      if (o.value === '.') continue;
      const value = Number(o.value);
      if (!Number.isFinite(value)) throw new Error(`FRED ${id}: unreadable value "${o.value}"`);
      // The vintage date: the value was known from that day (FRED gives no time of day).
      out.push({ date: o.date, value, publishedAt: o.realtime_start });
    }
    if (offset + PAGE >= page.count) return out;
  }
}

export const fredSeries: SeriesSource = {
  info: {
    ...common,
    kind: 'series',
    provides: { series: ['DTB3', 'SP500'] },
    suggestedRole: 'primary',
    // S&P Dow Jones Indices' copyright: personal use only (docs/data-spike.md).
    noAiItems: ['SP500'],
  },
  fetchSeries: (id, from, to, ctx) => observations(id, from, to, ctx),
};

export const fredFx: FxSource = {
  info: {
    ...common,
    kind: 'fx',
    provides: { pairs: Object.keys(FRED_FX) },
    suggestedRole: 'secondary',
  },
  supports: (pair) => Object.hasOwn(FRED_FX, pair),
  async fetchRates(pair, from, to, ctx) {
    const map = FRED_FX[pair];
    if (!map) throw new Error(`FRED has no H.10 series for ${pair}`);
    const points = await observations(map.series, from, to, ctx);
    return points.map((p): FxRate => ({
      pair,
      date: p.date,
      rate: map.invert ? 1 / p.value : p.value,
      ...(p.publishedAt && { publishedAt: p.publishedAt }),
    }));
  },
};
