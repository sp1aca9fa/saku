// Examplia: a made-up country's tax rules, to copy when writing a regime for a real one. A
// regime only declares; the tax engine computes. Steps for a real country: name the official
// sources in `info.sources`, write every amount and rate as decimal text in the regime's
// currency (never a number), put every name and explanation in `messages/<regime>/<lang>.json`
// (English complete; amounts and rates as `{placeholders}` the app fills from the declaration,
// so a text never disagrees with a rule), and have someone who knows the rules check them.
import type { TaxRegime } from '@saku/plugin-sdk';
import en from '../messages/examplia/en.json' with { type: 'json' };
import ja from '../messages/examplia/ja.json' with { type: 'json' };

/** ISO 4217 reserves XTS for testing: a made-up country's money. */
const XTS = (amount: string) => ({ amount, currency: 'XTS' });

export const exampleTaxRegime: TaxRegime = {
  info: {
    key: 'examplia',
    kind: 'tax_regime',
    // Raised with every change of a rule (an install set to an older one refuses the change).
    version: '2026.1',
    nameKey: 'name',
    // A user-assigned ISO 3166-1 code (QM-QZ): no real country.
    country: 'QX',
    currency: 'XTS',
    sources: ['https://tax.examplia.test/rules'],
  },
  // Examplia's tax year runs from April 1 to March 31.
  yearStart: '04-01',
  // A trade belongs to the year of its trade date and is converted at that date's rate.
  yearDate: 'trade_date',
  fxDate: 'trade_date',
  accountTypes: [
    {
      key: 'taxable',
      treatment: 'taxable',
      nameKey: 'accounts.general.name',
      descriptionKey: 'accounts.general.description',
      eligibility: {
        leveraged: true,
        assetClasses: 'all',
        purchaseModes: ['lump_sum', 'periodic'],
      },
      tax: { realizedGains: '0.25', dividends: '0.25' },
      losses: {
        offsets: ['gains', 'dividends'],
        carryforwardYears: 5,
        // In-year offsets need nothing; the carryforward needs a filed return.
        conditions: [{ kind: 'filing', appliesTo: ['carryforward'], textKey: 'losses.filing' }],
      },
      foreignTaxCredit: { conditions: [{ kind: 'filing', textKey: 'credit.filing' }] },
      // The dividend tax is charged on what is left after the foreign withholding.
      foreignDividendBase: 'net_of_withholding',
    },
    {
      key: 'saver',
      treatment: 'tax_advantaged',
      nameKey: 'accounts.saver.name',
      descriptionKey: 'accounts.saver.description',
      eligibility: {
        leveraged: false,
        assetClasses: ['equity'],
        purchaseModes: ['lump_sum', 'periodic'],
      },
      // No release: selling gives no quota back.
      quota: { annual: XTS('1000000') },
      tax: { realizedGains: '0', dividends: '0' },
      losses: { offsets: [], carryforwardYears: 0, conditions: [] },
      foreignTaxCredit: false,
      foreignDividendBase: 'gross',
      // A made-up treaty exempts saver accounts from the other country's withholding.
      foreignWithholding: [{ country: 'QY', rate: '0' }],
    },
  ],
  costBasis: { method: 'moving_average', sameDayOrder: 'execution' },
  fx: {
    rates: {
      MID: { kind: 'tax_mid', nameKey: 'fx.mid' },
      ASK: { kind: 'tax_buy', nameKey: 'fx.buy' },
      BID: { kind: 'tax_sell', nameKey: 'fx.sell' },
    },
    purchases: 'ASK',
    sales: 'BID',
    dividends: 'MID',
  },
  // A made-up treaty rate with another made-up country.
  foreignWithholding: [{ country: 'QY', rate: '0.1' }],
  // Holdings cannot move into or out of the saver account: a move is a sale and a new purchase.
  transfers: [],
  texts: { en, ja },
};
