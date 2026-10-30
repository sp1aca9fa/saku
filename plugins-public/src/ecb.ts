// ECB euro foreign exchange reference rates (official, no key). Rates against the euro are
// published around 16:00 Frankfurt time on TARGET working days; other pairs are derived as a
// cross of two euro rates (a modification the ECB asks users to state).
// https://data.ecb.europa.eu/help/api/overview
import { isTradingDate, zonedInstant } from '@saku/core';
import { type FxRate, type FxSource, HttpError, type PluginContext } from '@saku/plugin-sdk';

const BASE = 'https://data-api.ecb.europa.eu/service/data/EXR';
const CURRENCY = /^[A-Z]{3}$/;
/** The euro reference rates start on 1999-01-04; nothing exists before. */
const FIRST = '1999-01-01';
/**
 * Longest span of one request, in calendar days (about 5 years). The full history in one
 * request (27 years, two currencies, ~30 columns per row) got no answer within the client's
 * timeout; a range longer than this is split into equal parts, each 2.5 to 5 years long, so no
 * part is a near-empty tail. A shorter range is one request, as before.
 */
export const ECB_MAX_DAYS = 1826;

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Splits `from`..`to` (inclusive) into contiguous, non-overlapping parts of at most ECB_MAX_DAYS. */
export function ecbChunks(from: string, to: string): { from: string; to: string }[] {
  if (!isTradingDate(from) || !isTradingDate(to)) throw new Error(`ECB: bad range ${from}..${to}`);
  const start = dayNumber(from);
  const days = dayNumber(to) - start + 1;
  if (days <= 0) return [];
  const parts = Math.ceil(days / ECB_MAX_DAYS);
  const out: { from: string; to: string }[] = [];
  for (let i = 0; i < parts; i++) {
    const a = start + Math.floor((i * days) / parts);
    const b = start + Math.floor(((i + 1) * days) / parts) - 1;
    out.push({ from: dateOf(a), to: dateOf(b) });
  }
  return out;
}

/**
 * Parses the API's `csvdata` answer into date -> rate (units of currency per euro), adding to
 * `out`; a date already there with another rate is refused. Returns the rows read. Columns are
 * found by name; only CURRENCY, TIME_PERIOD and OBS_VALUE are used, so the request asks for
 * `detail=dataonly` (no attribute columns). An empty answer has no rows; a row with an empty
 * OBS_VALUE is no observation (not counted).
 */
function parseCsv(text: string, currency: string, out: Map<string, number>): number {
  if (text.trim() === '') return 0;
  let read = 0;
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = (header ?? '').split(',');
  const iCur = cols.indexOf('CURRENCY');
  const iDate = cols.indexOf('TIME_PERIOD');
  const iValue = cols.indexOf('OBS_VALUE');
  if (iCur < 0 || iDate < 0 || iValue < 0) throw new Error('ECB answer has unexpected columns');
  for (const row of rows) {
    const cells = row.split(',');
    if (cells[iCur] !== currency) continue;
    const date = cells[iDate] ?? '';
    if (!isTradingDate(date)) throw new Error(`ECB: unreadable row "${row}"`);
    // With `detail=dataonly`, a day the series has no rate comes as an empty OBS_VALUE (seen for
    // 1999-12-31): no observation that day, like FRED's '.'. Only an empty cell counts; a
    // non-empty value that is not a positive number, or a missing cell, is refused.
    if (cells[iValue] === '') continue;
    const value = Number(cells[iValue]);
    if (!(value > 0)) throw new Error(`ECB: unreadable row "${row}"`);
    const had = out.get(date);
    if (had !== undefined && had !== value)
      throw new Error(`ECB: two rates for ${currency} on ${date}`);
    out.set(date, value);
    read++;
  }
  return read;
}

/**
 * Parses a `firstNObservations=1` answer into currency -> date of its series' first observation.
 * Only CURRENCY and TIME_PERIOD are read: the observation's date says when the series starts,
 * whatever its value (an empty OBS_VALUE is still a dated observation). With more than one row
 * for a currency the earliest date is kept.
 */
function parseFirst(text: string): Map<string, string> {
  const out = new Map<string, string>();
  if (text.trim() === '') return out;
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = (header ?? '').split(',');
  const iCur = cols.indexOf('CURRENCY');
  const iDate = cols.indexOf('TIME_PERIOD');
  if (iCur < 0 || iDate < 0) throw new Error('ECB answer has unexpected columns');
  for (const row of rows) {
    const cells = row.split(',');
    const currency = cells[iCur] ?? '';
    const date = cells[iDate] ?? '';
    if (!CURRENCY.test(currency) || !isTradingDate(date)) {
      throw new Error(`ECB: unreadable row "${row}"`);
    }
    const had = out.get(currency);
    if (had === undefined || date < had) out.set(currency, date);
  }
  return out;
}

/**
 * Date of the first observation of each needed currency's daily series against the euro: one
 * request for all of them, `firstNObservations=1` returning at most one observation per matching
 * series, from its first (https://data.ecb.europa.eu/help/api/data). Any failure, a 404
 * included, is thrown: the caller then refuses the range rather than assume the empty span is
 * fine.
 */
async function firstObservations(
  needed: string[],
  ctx: PluginContext,
): Promise<Map<string, string>> {
  const text = await ctx.http.text(
    `${BASE}/D.${needed.join('+')}.EUR.SP00.A?firstNObservations=1&detail=dataonly&format=csvdata`,
    { Accept: 'text/csv' },
  );
  return parseFirst(text);
}

export const ecb: FxSource = {
  info: {
    key: 'ecb',
    kind: 'fx',
    name: 'ECB reference rates',
    provides: { pairs: ['EURxxx', 'USDxxx (cross)'] },
    suggestedRole: 'primary',
    limits: { perMinute: 30 },
    termsUrl: 'https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html',
    // No reference rates on TARGET closing days (the calendars plug-in's `ecb-target`).
    calendar: 'ecb-target',
  },

  supports: (pair) => /^[A-Z]{6}$/.test(pair) && pair.slice(0, 3) !== pair.slice(3),

  async fetchRates(pair, from, to, ctx) {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3);
    if (pair.length !== 6 || !CURRENCY.test(base) || !CURRENCY.test(quote) || base === quote) {
      throw new Error(`Not a currency pair: ${pair}`);
    }
    const needed = [base, quote].filter((c) => c !== 'EUR');
    const baseRates = base === 'EUR' ? null : new Map<string, number>();
    const quoteRates = quote === 'EUR' ? null : new Map<string, number>();
    // Nothing exists before the euro: the range starts no earlier than 1999.
    const parts = ecbChunks(from < FIRST ? FIRST : from, to);
    // A part with no data (404 "No results found", or an empty answer) counts as zero rows only
    // at either end of the range. An empty part between two parts with rows is a multi-year hole
    // that nothing downstream checks, so it is refused. When every part is empty, the range is
    // refused, as a single request was before.
    // Leading empty parts are accepted only when the ECB itself says each needed series starts
    // after them (its first observation, asked below); otherwise a wrong 404 on an early part
    // would shorten history silently. Trailing empty parts are accepted as they are: a recent
    // gap is caught by the FX freshness check, and a series that ended stops there.
    const counts: number[] = [];
    let noResults: HttpError | null = null;
    for (const part of parts) {
      let text: string;
      try {
        text = await ctx.http.text(
          `${BASE}/D.${needed.join('+')}.EUR.SP00.A?startPeriod=${part.from}&endPeriod=${part.to}` +
            '&detail=dataonly&format=csvdata',
          { Accept: 'text/csv' },
        );
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 404) throw e;
        noResults = e;
        counts.push(0);
        continue;
      }
      let rows = 0;
      if (baseRates) rows += parseCsv(text, base, baseRates);
      if (quoteRates) rows += parseCsv(text, quote, quoteRates);
      counts.push(rows);
    }
    const first = counts.findIndex((n) => n > 0);
    const last = counts.findLastIndex((n) => n > 0);
    if (parts.length > 0 && first < 0) {
      throw noResults ?? new Error(`ECB: no rates for ${pair} from ${from} to ${to}`);
    }
    if (first > 0) {
      const leading = { from: parts[0]!.from, to: parts[first - 1]!.to };
      const starts = await firstObservations(needed, ctx);
      for (const currency of needed) {
        const start = starts.get(currency);
        // Unknown stays unknown: no first observation for a series that just gave rates is no
        // proof the empty span is before its start.
        if (start === undefined) {
          throw new Error(
            `ECB: no rates for ${pair} from ${leading.from} to ${leading.to}, and no first ` +
              `observation for ${currency} to show its series starts later`,
          );
        }
        if (start <= leading.to) {
          throw new Error(
            `ECB: no rates for ${pair} from ${leading.from} to ${leading.to}, but the ${currency} ` +
              `series starts on ${start}`,
          );
        }
        // The answer contradicts the rates received: it cannot vouch for the empty span.
        const rates = currency === base ? baseRates : quoteRates;
        const earliest = [...(rates?.keys() ?? [])].sort()[0];
        if (earliest !== undefined && earliest < start) {
          throw new Error(
            `ECB: the ${currency} series is said to start on ${start}, but has a rate on ${earliest}`,
          );
        }
      }
    }
    for (let i = first + 1; i < last; i++) {
      if (counts[i] === 0) {
        const hole = parts[i]!;
        throw new Error(
          `ECB: no rates for ${pair} from ${hole.from} to ${hole.to}, between parts with rates`,
        );
      }
    }
    const dates = [
      ...new Set([...(baseRates?.keys() ?? []), ...(quoteRates?.keys() ?? [])]),
    ].sort();
    const out: FxRate[] = [];
    for (const date of dates) {
      // quote per base = (quote per EUR) / (base per EUR)
      const q = quoteRates ? quoteRates.get(date) : 1;
      const b = baseRates ? baseRates.get(date) : 1;
      if (q === undefined || b === undefined) {
        throw new Error(`ECB: ${date} has a rate for one currency of ${pair} but not the other`);
      }
      out.push({
        pair,
        date,
        rate: q / b,
        publishedAt: zonedInstant(date, '16:00', 'Europe/Berlin'),
      });
    }
    return out;
  },
};
