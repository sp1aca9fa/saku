// FRED, Federal Reserve Bank of St. Louis (official API): rates and index levels, and the H.10
// exchange rates as a secondary FX source. Every vintage is fetched (ALFRED real-time periods),
// so a past run's view can be reproduced. https://fred.stlouisfed.org/docs/api/fred/
import { isTradingDate, zonedInstant } from '@saku/core';
import type {
  FxRate,
  FxSource,
  PluginContext,
  PluginInfo,
  SeriesPoint,
  SeriesSource,
} from '@saku/plugin-sdk';
import { z } from 'zod';

const API = 'https://api.stlouisfed.org/fred/series';
const PAGE = 100_000;
/** The vintagedates endpoint's largest page. */
const VINTAGE_PAGE = 10_000;
/** The whole real-time axis, as FRED spells it. */
const REALTIME_FIRST = '1776-07-04';
const REALTIME_LAST = '9999-12-31';
/**
 * Vintage dates per observations request. FRED answers 400 when a request's real-time period
 * holds too many vintage dates (2000 for JSON per the docs, fewer for some output types):
 * https://fred.stlouisfed.org/docs/api/fred/series_observations.html. Daily series with a
 * vintage every business day (DTB3, SP500) pass that over their full history, so the real-time
 * axis is split into windows of at most this many vintages, well under the cap.
 */
export const FRED_VINTAGES_PER_WINDOW = 1000;

const Observations = z.object({
  count: z.number(),
  offset: z.number(),
  observations: z.array(
    z.object({
      realtime_start: z.string(),
      realtime_end: z.string(),
      date: z.string(),
      value: z.string(),
    }),
  ),
});
type Row = z.infer<typeof Observations>['observations'][number];

const VintageDates = z.object({
  count: z.number(),
  offset: z.number(),
  vintage_dates: z.array(z.string()),
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

/** The calendar day before a `YYYY-MM-DD` date. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** Every vintage date of a series, ascending (paged; checked for order and completeness). */
async function vintageDates(id: string, ctx: PluginContext): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += VINTAGE_PAGE) {
    // FRED takes the key only as a URL parameter; the HTTP client redacts it from messages.
    const url =
      `${API}/vintagedates?series_id=${encodeURIComponent(id)}&api_key=${ctx.apiKey}` +
      `&file_type=json&realtime_start=${REALTIME_FIRST}&realtime_end=${REALTIME_LAST}` +
      `&limit=${VINTAGE_PAGE}&offset=${offset}`;
    const page = VintageDates.parse(await ctx.http.json(url));
    if (page.offset !== offset) throw new Error(`FRED ${id}: vintage page at the wrong offset`);
    for (const d of page.vintage_dates) {
      const prev = out.at(-1);
      if (!isTradingDate(d) || (prev !== undefined && d <= prev)) {
        throw new Error(`FRED ${id}: unreadable or unordered vintage date "${d}"`);
      }
      out.push(d);
    }
    if (offset + VINTAGE_PAGE >= page.count) {
      if (out.length !== page.count) {
        throw new Error(`FRED ${id}: ${out.length} vintage dates read, ${page.count} announced`);
      }
      return out;
    }
    if (page.vintage_dates.length === 0) throw new Error(`FRED ${id}: empty vintage page`);
  }
}

/** All rows of one real-time window (paged), including missing values. */
async function windowRows(
  id: string,
  from: string,
  to: string,
  realtime: { start: string; end: string },
  ctx: PluginContext,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const url =
      `${API}/observations?series_id=${encodeURIComponent(id)}&api_key=${ctx.apiKey}` +
      `&file_type=json&observation_start=${from}&observation_end=${to}` +
      `&realtime_start=${realtime.start}&realtime_end=${realtime.end}` +
      `&limit=${PAGE}&offset=${offset}`;
    const page = Observations.parse(await ctx.http.json(url));
    for (const o of page.observations) {
      if (
        !isTradingDate(o.date) ||
        !isTradingDate(o.realtime_start) ||
        !isTradingDate(o.realtime_end)
      ) {
        throw new Error(`FRED ${id}: unreadable date in ${JSON.stringify(o)}`);
      }
      out.push(o);
    }
    if (offset + PAGE >= page.count) return out;
  }
}

/** Same published value: both missing ('.'), or the same number. */
function sameValue(a: string, b: string): boolean {
  return a === b || (a !== '.' && b !== '.' && Number(a) === Number(b));
}

/**
 * All observations of a series in the window, every vintage, missing values ('.') left out.
 *
 * Real-time windows: the vintage dates are split into groups of at most
 * FRED_VINTAGES_PER_WINDOW; window k runs from its first vintage (the first window from
 * 1776-07-04) to the day before the next window's first vintage (the last window to
 * 9999-12-31), so the windows cover the whole real-time axis without gaps or overlap. A series
 * that fits in one window is fetched with the single full-axis request, as before.
 *
 * Merge rule: FRED clips each row's real-time period to the request's window, so a value that
 * was already in effect when a window starts comes back with realtime_start = the window's
 * start. Such a row is a continuation, not a new vintage, when the previous window has a row for
 * the same date that was still in effect at that window's end (realtime_end = its end) with the
 * same value; it is then dropped and the value keeps its true, earliest realtime_start. FRED
 * never splits a real-time period where the value does not change, so a different value (or no
 * row in effect at the boundary) at a window's start is a real vintage on that date (a window
 * starts on a vintage date by construction).
 */
async function observations(id: string, from: string, to: string, ctx: PluginContext) {
  const vintages = await vintageDates(id, ctx);
  const windows: { start: string; end: string }[] = [];
  for (let i = 0; i < Math.max(1, vintages.length); i += FRED_VINTAGES_PER_WINDOW) {
    const next = vintages[i + FRED_VINTAGES_PER_WINDOW];
    windows.push({
      start: i === 0 ? REALTIME_FIRST : vintages[i]!,
      end: next === undefined ? REALTIME_LAST : dayBefore(next),
    });
  }

  const rows: Row[] = [];
  /** Per date, the row in effect at the end of the previous window. */
  let atPreviousEnd = new Map<string, Row>();
  for (const [k, w] of windows.entries()) {
    const atEnd = new Map<string, Row>();
    for (const o of await windowRows(id, from, to, w, ctx)) {
      if (o.realtime_start > o.realtime_end) {
        throw new Error(`FRED ${id}: real-time period ends before it starts ${JSON.stringify(o)}`);
      }
      // At or past the window's end: in effect when the next window starts (past it only if a
      // period came back unclipped).
      if (o.realtime_end >= w.end) atEnd.set(o.date, o);
      if (k > 0 && o.realtime_start <= w.start) {
        const before = atPreviousEnd.get(o.date);
        if (before && sameValue(before.value, o.value)) continue; // continuation, see above
        if (o.realtime_start < w.start) {
          // Claims a start inside an earlier window that the earlier window did not show.
          throw new Error(
            `FRED ${id}: row starts before its real-time window ${JSON.stringify(o)}`,
          );
        }
      }
      rows.push(o);
    }
    atPreviousEnd = atEnd;
  }

  // One window keeps FRED's own order (observation date, then real time); several are put in
  // that order again.
  if (windows.length > 1) {
    rows.sort((a, b) =>
      a.date === b.date
        ? a.realtime_start.localeCompare(b.realtime_start)
        : a.date.localeCompare(b.date),
    );
  }
  const out: SeriesPoint[] = [];
  for (const o of rows) {
    if (o.value === '.') continue;
    const value = Number(o.value);
    if (!Number.isFinite(value)) throw new Error(`FRED ${id}: unreadable value "${o.value}"`);
    // The vintage date gives no time of day. Assumption: known from 18:00 New York that day
    // (the H.15 and H.10 releases come out in the afternoon), never from midnight.
    out.push({
      date: o.date,
      value,
      publishedAt: zonedInstant(o.realtime_start, '18:00', 'America/New_York'),
    });
  }
  return out;
}

export const fredSeries: SeriesSource = {
  info: {
    ...common,
    kind: 'series',
    // DTB3: the 3-month Treasury bill, secondary market rate (USD cash and financing).
    provides: { series: ['DTB3', 'SP500'], cashRates: { USD: 'DTB3' } },
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
