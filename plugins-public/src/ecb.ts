// ECB euro foreign exchange reference rates (official, no key). Rates against the euro are
// published around 16:00 Frankfurt time on TARGET working days; other pairs are derived as a
// cross of two euro rates (a modification the ECB asks users to state).
// https://data.ecb.europa.eu/help/api/overview
import { isTradingDate, zonedInstant } from '@saku/core';
import type { FxRate, FxSource } from '@saku/plugin-sdk';

const BASE = 'https://data-api.ecb.europa.eu/service/data/EXR';
const CURRENCY = /^[A-Z]{3}$/;

/** Parses the API's `csvdata` answer into date -> rate (units of currency per euro). */
function parseCsv(text: string, currency: string): Map<string, number> {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = (header ?? '').split(',');
  const iCur = cols.indexOf('CURRENCY');
  const iDate = cols.indexOf('TIME_PERIOD');
  const iValue = cols.indexOf('OBS_VALUE');
  if (iCur < 0 || iDate < 0 || iValue < 0) throw new Error('ECB answer has unexpected columns');
  const out = new Map<string, number>();
  for (const row of rows) {
    const cells = row.split(',');
    if (cells[iCur] !== currency) continue;
    const date = cells[iDate] ?? '';
    const value = Number(cells[iValue]);
    if (!isTradingDate(date) || !(value > 0)) throw new Error(`ECB: unreadable row "${row}"`);
    out.set(date, value);
  }
  return out;
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
  },

  supports: (pair) => /^[A-Z]{6}$/.test(pair) && pair.slice(0, 3) !== pair.slice(3),

  async fetchRates(pair, from, to, ctx) {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3);
    if (pair.length !== 6 || !CURRENCY.test(base) || !CURRENCY.test(quote) || base === quote) {
      throw new Error(`Not a currency pair: ${pair}`);
    }
    const needed = [base, quote].filter((c) => c !== 'EUR');
    const text = await ctx.http.text(
      `${BASE}/D.${needed.join('+')}.EUR.SP00.A?startPeriod=${from}&endPeriod=${to}&format=csvdata`,
      { Accept: 'text/csv' },
    );
    const perEuro = (c: string) => (c === 'EUR' ? null : parseCsv(text, c));
    const baseRates = perEuro(base);
    const quoteRates = perEuro(quote);
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
