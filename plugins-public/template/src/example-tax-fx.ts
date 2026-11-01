// Example Bank of Examplia: a made-up bank's published daily rates for tax (a `TaxFxSource`), to
// copy when writing one for a real bank. Steps for a real bank: read its terms (personal use, AI
// use: set `noAi`), copy its limits into `info.limits`, save real answers as fixtures in the
// private repo (synthetic ones here), and map each published rate onto the stored kind the
// install's regime names it with (here Examplia's MID, ASK, BID; `fx.rates` in
// `example-tax-regime.ts`). Never compute a rate (e.g. a mid from buy and sell): a rate the bank
// did not publish is left out, and stays unknown.
import type { PluginContext, TaxFxRate, TaxFxSource } from '@saku/plugin-sdk';
import { z } from 'zod';

const BASE = 'https://api.example-bank.test/v1';

// Validate the answer's shape: a renamed or missing field must fail loudly, not store zeros. The
// values themselves (above 0, buy >= mid >= sell) are checked by core before anything is stored.
const Rate = z.number().nullable();
const Day = z.object({
  date: z.string(),
  published: z.string(),
  mid: Rate,
  ask: Rate,
  bid: Rate,
});
const Answer = z.object({ base: z.string(), quote: z.string(), rates: z.array(Day) });

/**
 * The bank's names onto the regime's: `ask` is what the customer pays to buy the base currency
 * (the bank's selling rate, the regime's ASK, stored as `tax_buy`); `bid` what the customer gets
 * selling it (the bank's buying rate, BID, `tax_sell`); `mid` the middle rate (MID, `tax_mid`).
 */
const NAMES = [
  ['mid', 'MID', 'tax_mid'],
  ['ask', 'ASK', 'tax_buy'],
  ['bid', 'BID', 'tax_sell'],
] as const;

export const exampleTaxFx: TaxFxSource = {
  info: {
    key: 'example-bank',
    kind: 'tax_fx',
    name: 'Example Bank of Examplia',
    provides: { pairs: ['USDXTS'] },
    suggestedRole: 'primary',
    limits: { perMinute: 30, perDay: 500 },
    termsUrl: 'https://example-bank.test/terms',
  },

  supports: (pair) => pair === 'USDXTS',

  async fetchRates(pair, from, to, ctx: PluginContext) {
    const url = `${BASE}/rates/${encodeURIComponent(pair)}?start=${from}&end=${to}`;
    const answer = Answer.parse(await ctx.http.json(url));
    if (`${answer.base}${answer.quote}` !== pair) {
      throw new Error(`Example Bank answered for ${answer.base}${answer.quote}, not ${pair}`);
    }
    return answer.rates.flatMap((d) =>
      NAMES.flatMap(([field, name, kind]): TaxFxRate[] => {
        const rate = d[field];
        // Not published that day: left out (unknown), never a 0.
        if (rate === null) return [];
        return [{ pair, date: d.date, rate, publishedAt: d.published, kind, name }];
      }),
    );
  },
};
