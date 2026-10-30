// FRED, Federal Reserve Bank of St. Louis (official API): rates and index levels, and the H.10
// exchange rates as a secondary FX source. Every vintage is fetched (ALFRED real-time periods),
// so a past run's view can be reproduced. https://fred.stlouisfed.org/docs/api/fred/
import { isTradingDate, zonedInstant } from '@saku/core';
import {
  type FxRate,
  type FxSource,
  HttpError,
  type PluginContext,
  type PluginInfo,
  type SeriesFetch,
  type SeriesPoint,
  type SeriesSource,
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

/**
 * FRED's answer for a series it serves without vintages (e.g. `SP500`, licensed from S&P Dow
 * Jones Indices): HTTP 400 "The series does not exist in ALFRED but may exist in FRED. Try
 * setting realtime_start and realtime_end to today's date or removing the realtime_start and
 * realtime_end variables." Matched by this message, never by the status alone: any other 400
 * still fails the series.
 */
const NOT_IN_ALFRED = /series does not exist in ALFRED/i;
const notInAlfred = (e: unknown): boolean =>
  e instanceof HttpError && e.status === 400 && NOT_IN_ALFRED.test(e.detail ?? '');

/**
 * All rows of one real-time window (paged), including missing values. Without a window, FRED's
 * default real-time period applies (today: the current values only). `complete`: every page must
 * be at its offset and announce the same count as the first page (a count that changes between
 * pages means the series changed while it was read), and the rows read must be as many as that
 * count, or the answer is refused (a response declared complete for its span must not be short;
 * see `currentValues`).
 */
async function windowRows(
  id: string,
  from: string,
  to: string,
  realtime: { start: string; end: string } | null,
  ctx: PluginContext,
  complete = false,
): Promise<Row[]> {
  const out: Row[] = [];
  /** The first page's count (`complete`). */
  let announced: number | undefined;
  for (let offset = 0; ; offset += PAGE) {
    const url =
      `${API}/observations?series_id=${encodeURIComponent(id)}&api_key=${ctx.apiKey}` +
      `&file_type=json&observation_start=${from}&observation_end=${to}` +
      (realtime ? `&realtime_start=${realtime.start}&realtime_end=${realtime.end}` : '') +
      `&limit=${PAGE}&offset=${offset}`;
    const page = Observations.parse(await ctx.http.json(url));
    if (complete && page.offset !== offset) {
      throw new Error(`FRED ${id}: observation page at the wrong offset`);
    }
    if (complete) {
      announced ??= page.count;
      if (page.count !== announced) {
        throw new Error(
          `FRED ${id}: observation page at offset ${offset} announces ${page.count} rows, ` +
            `the first page ${announced}`,
        );
      }
    }
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
    if (offset + PAGE >= page.count) {
      if (complete && out.length !== page.count) {
        throw new Error(`FRED ${id}: ${out.length} observations read, ${page.count} announced`);
      }
      return out;
    }
    if (complete && page.observations.length === 0) {
      throw new Error(`FRED ${id}: empty observation page`);
    }
  }
}

/** Same published value: both missing ('.'), or the same number. */
function sameValue(a: string, b: string): boolean {
  return a === b || (a !== '.' && b !== '.' && Number(a) === Number(b));
}

/**
 * All observations of a series in the window, every vintage. Missing values ('.'): a '.' vintage
 * that follows a numeric vintage of the same date is a withdrawal (the source no longer has a
 * value for that date from that vintage on; spec 2026-10-30 withdrawn-values, assumed from FRED's
 * docs: '.' is a missing value); a '.' with no numeric vintage before it is left out (no
 * observation), as is a '.' following another '.'. A numeric vintage after a withdrawal is a
 * value again. The merge rule below runs first, so a '.' continuing across a window boundary is
 * one vintage, never a second withdrawal.
 *
 * Real-time windows: the vintage dates are split into groups of at most
 * FRED_VINTAGES_PER_WINDOW; window k runs from its first vintage (the first window from
 * 1776-07-04) to the day before the next window's first vintage (the last window to
 * 9999-12-31), so the windows cover the whole real-time axis without gaps or overlap. A series
 * that fits in one window is fetched with the single full-axis request, as before.
 *
 * Merge rule. Assumed, from FRED's documented examples: FRED clips each row's real-time period
 * to the request's window, so a value already in effect when a window starts comes back with
 * realtime_start = the window's start. Unclipped periods (realtime_start before the window,
 * realtime_end past it) are handled the same way, so either answer gives the same points. A row
 * that starts on or before a window's start (window 2 on) is a continuation, not a new vintage,
 * when the previous window has a row for the same date still in effect at that window's end
 * (realtime_end on or past it) with the same value (and, if unclipped, the same
 * realtime_start); it is then dropped and the value keeps its true, earliest realtime_start.
 * FRED never splits a real-time period where the value does not change, so a different value
 * (or no row in effect at the boundary) at a window's start is a real vintage on that date (a
 * window starts on a vintage date by construction). A row that starts before its window without
 * matching such a row, or lies outside its window, is refused.
 */
async function observations(
  id: string,
  from: string,
  to: string,
  ctx: PluginContext,
): Promise<{ points: SeriesPoint[]; currentOnly: boolean }> {
  let vintages: string[];
  try {
    vintages = await vintageDates(id, ctx);
  } catch (e) {
    if (!notInAlfred(e)) throw e;
    ctx.log.info(`FRED ${id}: no vintages in ALFRED; current values only, known from the fetch`);
    return { points: await currentValues(id, from, to, ctx), currentOnly: true };
  }
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
      if (o.realtime_start > w.end || o.realtime_end < w.start) {
        throw new Error(`FRED ${id}: row outside its real-time window ${JSON.stringify(o)}`);
      }
      // On or past the window's end: in effect when the next window starts.
      if (o.realtime_end >= w.end) atEnd.set(o.date, o);
      if (k > 0 && o.realtime_start <= w.start) {
        const before = atPreviousEnd.get(o.date);
        const continues =
          before !== undefined &&
          sameValue(before.value, o.value) &&
          (o.realtime_start === w.start || o.realtime_start === before.realtime_start);
        if (continues) continue; // see the merge rule above
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

  // Always put in observation-date, then real-time order (FRED's documented order, never relied
  // on, also with one window): withdrawal detection below reads each date's vintages in time order.
  rows.sort((a, b) =>
    a.date === b.date
      ? a.realtime_start.localeCompare(b.realtime_start)
      : a.date.localeCompare(b.date),
  );
  const out: SeriesPoint[] = [];
  /** Per date, whether its latest vintage so far (rows are in real-time order) has a value. */
  const hasValue = new Map<string, boolean>();
  for (const o of rows) {
    // The vintage date gives no time of day. Assumption: known from 18:00 New York that day
    // (the H.15 and H.10 releases come out in the afternoon), never from midnight.
    const publishedAt = zonedInstant(o.realtime_start, '18:00', 'America/New_York');
    if (o.value === '.') {
      if (hasValue.get(o.date) === true) out.push({ date: o.date, withdrawn: true, publishedAt });
      if (hasValue.has(o.date)) hasValue.set(o.date, false);
      continue;
    }
    const value = Number(o.value);
    if (!Number.isFinite(value)) throw new Error(`FRED ${id}: unreadable value "${o.value}"`);
    hasValue.set(o.date, true);
    out.push({ date: o.date, value, publishedAt });
  }
  return { points: out, currentOnly: false };
}

/**
 * The current values of a series FRED keeps no vintages for (see NOT_IN_ALFRED), missing values
 * ('.') left out. Rule: these points carry no `publishedAt`. FRED's real-time period here is the
 * request's own day (its default), the same for every row, so it says when we asked, not when the
 * value was published. Without `publishedAt`, storage sets `known_at` to the fetch time
 * (`storeSeries` in packages/db/src/market.ts; requirements 04, point-in-time reads through
 * `asOf`): a value counts as known when we first saw it, never earlier, so no read before the
 * fetch can use it (no look-ahead). A later fetch stores a row only when the value changed, at
 * its own fetch time (a revision, never an edit). One row per date is expected; a second is
 * refused (it would be two values with the same knowledge time).
 *
 * Vanished values (spec 2026-10-31 vanished-values): with no vintages, a value FRED stops
 * publishing (a date now '.' or left out) never arrives as a withdrawal. So this answer is
 * declared complete for its span (`fredSeries`): every page read and as many rows as FRED
 * announced (refused otherwise), so a date from the first value through the asked end that is not
 * in it is one FRED no longer has a value for. Assumed (spec): FRED's current values over the asked range
 * are every value it still publishes. Core compares only on full fetches.
 */
async function currentValues(
  id: string,
  from: string,
  to: string,
  ctx: PluginContext,
): Promise<SeriesPoint[]> {
  const out: SeriesPoint[] = [];
  let previous: string | undefined;
  for (const o of await windowRows(id, from, to, null, ctx, true)) {
    if (previous !== undefined && o.date <= previous) {
      throw new Error(`FRED ${id}: repeated or unordered date in current values ${o.date}`);
    }
    previous = o.date;
    if (o.value === '.') continue;
    const value = Number(o.value);
    if (!Number.isFinite(value)) throw new Error(`FRED ${id}: unreadable value "${o.value}"`);
    out.push({ date: o.date, value });
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
  // Current values only (no vintages): complete for their span, see `currentValues`. With
  // vintages a stored value can only be withdrawn by a '.' vintage (a plain list).
  async fetchSeries(id, from, to, ctx): Promise<SeriesPoint[] | SeriesFetch> {
    const got = await observations(id, from, to, ctx);
    return got.currentOnly ? { points: got.points, completeSpan: true } : got.points;
  },
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
    // FX keeps its own path: a rate that vanishes from current values is not inferred withdrawn.
    const { points } = await observations(map.series, from, to, ctx);
    return points.map((p): FxRate =>
      p.withdrawn
        ? {
            pair,
            date: p.date,
            withdrawn: true,
            ...(p.publishedAt && { publishedAt: p.publishedAt }),
          }
        : {
            pair,
            date: p.date,
            rate: map.invert ? 1 / p.value : p.value,
            ...(p.publishedAt && { publishedAt: p.publishedAt }),
          },
    );
  },
};
