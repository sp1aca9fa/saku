import { describe, expect, it } from 'vitest';
import { checkKinds, emptyPlugins } from './registry';
import { assignedOnly } from './roles';
import { taxFxPairs, taxFxProblems } from './tax-fx';
import type { PluginInfo, TaxFxRate, TaxFxSource } from './types';

const fx = {
  rates: {
    MID: { kind: 'tax_mid' as const, nameKey: 'm' },
    ASK: { kind: 'tax_buy' as const, nameKey: 'b' },
    BID: { kind: 'tax_sell' as const, nameKey: 's' },
  },
};
const pair = 'USDXTS';
const day = (date: string, mid: number, buy: number, sell: number): TaxFxRate[] => [
  { pair, date, rate: mid, kind: 'tax_mid', name: 'MID' },
  { pair, date, rate: buy, kind: 'tax_buy', name: 'ASK' },
  { pair, date, rate: sell, kind: 'tax_sell', name: 'BID' },
];
const fetchedAt = '2026-01-06T00:00:00Z';
const check = (rates: unknown) => taxFxProblems(rates, { pair, fx, fetchedAt });

describe('taxFxProblems', () => {
  it('passes ordered, positive rates under the declared names; equal rates pass', () => {
    expect(
      check([...day('2026-01-05', 150, 151, 149), ...day('2026-01-06', 150, 150, 150)]),
    ).toEqual([]);
    expect(check([])).toEqual([]);
    // One kind alone on a date: nothing to order against, stored as it is.
    expect(check([day('2026-01-05', 150, 151, 149)[0]])).toEqual([]);
  });

  it('refuses a rate that is 0, negative, not finite or missing', () => {
    for (const rate of [0, -1, Number.NaN, Infinity, undefined, '150']) {
      const [mid, ...rest] = day('2026-01-05', 150, 151, 149);
      expect(check([{ ...mid, rate }, ...rest])).toEqual([
        expect.stringMatching(/is not a finite number above 0/),
      ]);
    }
  });

  it('refuses buy below mid, mid below sell and buy below sell', () => {
    expect(check(day('2026-01-05', 150, 149.5, 149))).toEqual([
      '2026-01-05: tax_buy 149.5 is below tax_mid 150',
    ]);
    expect(check(day('2026-01-05', 150, 151, 150.5))).toEqual([
      '2026-01-05: tax_mid 150 is below tax_sell 150.5',
    ]);
    const [, buy, sell] = day('2026-01-05', 150, 149, 151);
    expect(check([buy, sell])).toEqual(['2026-01-05: tax_buy 149 is below tax_sell 151']);
  });

  it('orders the latest vintage of each kind, as a point-in-time read returns it', () => {
    const at = (r: TaxFxRate, publishedAt: string) => ({ ...r, publishedAt });
    const [mid1, buy1, sell1] = day('2026-01-05', 150, 151, 149);
    const [mid2, buy2, sell2] = day('2026-01-05', 152, 153, 151);
    const t1 = '2026-01-05T01:00:00Z';
    const t2 = '2026-01-05T03:00:00Z';
    expect(
      check([
        at(mid1!, t1),
        at(buy1!, t1),
        at(sell1!, t1),
        at(mid2!, t2),
        at(buy2!, t2),
        at(sell2!, t2),
      ]),
    ).toEqual([]);
    // An earlier vintage out of order no longer counts once a later one is published.
    expect(
      check([at({ ...buy1!, rate: 100 } as TaxFxRate, t1), at(mid2!, t2), at(buy2!, t2)]),
    ).toEqual([]);
    // Only the TTS republished later, below the TTM that still holds: refused.
    expect(
      check([at(mid1!, t1), at(buy1!, t1), at({ ...buy2!, rate: 149.5 } as TaxFxRate, t2)]),
    ).toEqual(['2026-01-05: tax_buy 149.5 is below tax_mid 150']);
    // The same instant in another spelling is one publication time.
    expect(check([at(mid2!, t1), at(buy1!, '2026-01-05T10:00:00+09:00')])).toEqual([
      '2026-01-05: tax_buy 151 is below tax_mid 152',
    ]);
  });

  it('fault: a missing stamp is read as known at the fetch, so it is ordered with the rest', () => {
    const [mid, buy] = day('2026-01-05', 150, 149, 148);
    // Without a publication time the buy rate is the latest vintage (known at the fetch).
    expect(check([{ ...mid!, publishedAt: '2026-01-05T01:00:00Z' }, buy])).toEqual([
      '2026-01-05: tax_buy 149 is below tax_mid 150',
    ]);
  });

  it('refuses a stamp without a time of day or a zone (the rule storing applies)', () => {
    const [mid] = day('2026-01-05', 150, 151, 149);
    for (const publishedAt of ['2026-01-05', '2026-01-05T10:00:00', 'soon', 5]) {
      expect(check([{ ...mid, publishedAt }])).toEqual([
        expect.stringMatching(
          /publishedAt (must be an instant with a time of day and a zone|is not text)/,
        ),
      ]);
    }
    expect(check([{ ...mid, publishedAt: '2026-01-05T10:00:00+09:00' }])).toEqual([]);
  });

  it('refuses a missing or invalid date, another pair, an unknown kind or name', () => {
    const [mid] = day('2026-01-05', 150, 151, 149);
    const { date: _, ...noDate } = mid!;
    expect(check([noDate])).toEqual([expect.stringMatching(/no valid date/)]);
    expect(check([{ ...mid, date: '2026-02-30' }])).toEqual([
      expect.stringMatching(/no valid date/),
    ]);
    expect(check([{ ...mid, pair: 'USDXXX' }])).toEqual([
      expect.stringMatching(/pair USDXXX, not USDXTS/),
    ]);
    expect(check([{ ...mid, kind: 'valuation' }])).toEqual([
      expect.stringMatching(/kind is not one of/),
      expect.stringMatching(/MID is tax_mid in the regime, not valuation/),
    ]);
    expect(check([{ ...mid, name: 'TTM' }])).toEqual([
      expect.stringMatching(/rate name TTM is not one the regime declares \(MID, ASK, BID\)/),
    ]);
    // A source labeling the buying rate as mid is refused (names map onto kinds).
    expect(check([{ ...mid, name: 'ASK' }])).toEqual([
      expect.stringMatching(/ASK is tax_buy in the regime, not tax_mid/),
    ]);
    expect(check([{ ...mid, name: 'toString' }])).toEqual([
      expect.stringMatching(/not one the regime declares/),
    ]);
    expect(check('nope')).toEqual(['the response is not a list of rates']);
    expect(check([null])).toEqual(['rate 0: not an object']);
  });

  it('withdrawals carry no rate and are not ordered; one vintage stated twice is refused', () => {
    const w = { pair, date: '2026-01-05', withdrawn: true, kind: 'tax_mid', name: 'MID' };
    expect(check([w, ...day('2026-01-05', 150, 151, 149).slice(1)])).toEqual([]);
    expect(check([{ ...w, rate: 1 }])).toEqual([expect.stringMatching(/carries a rate/)]);
    expect(check([{ ...w, withdrawn: false }])).toEqual([
      expect.stringMatching(/withdrawn is neither true nor absent/),
      expect.stringMatching(/rate undefined is not a finite number above 0/),
    ]);
    const [mid] = day('2026-01-05', 150, 151, 149);
    expect(check([mid, mid])).toEqual([]);
    expect(check([mid, { ...mid, rate: 150.5 }])).toEqual([
      expect.stringMatching(/stated twice for one publication time \(150 and 150.5\)/),
    ]);
    expect(check([mid, w])).toEqual([expect.stringMatching(/\(150 and withdrawn\)/)]);
  });
});

describe('tax FX pairs and loading', () => {
  it('fetches the dollar against the regime currency, none for a dollar regime', () => {
    expect(taxFxPairs({ info: { currency: 'XTS' } } as never)).toEqual(['USDXTS']);
    expect(taxFxPairs({ info: { currency: 'USD' } } as never)).toEqual([]);
  });

  const info = (kind: PluginInfo['kind']): PluginInfo => ({
    key: 'bank',
    kind,
    name: 'Bank',
    provides: {},
    suggestedRole: 'primary',
    termsUrl: 'https://bank.test/terms',
  });
  const source = (kind: PluginInfo['kind']): TaxFxSource => ({
    info: info(kind),
    supports: () => true,
    fetchRates: async () => [],
  });

  it('refuses a plug-in declaring another kind than its array', () => {
    expect(() => checkKinds({ taxFx: [source('tax_fx')] })).not.toThrow();
    expect(() => checkKinds({ taxFx: [source('fx')] })).toThrow(
      /exported in taxFx but declares kind fx, not tax_fx/,
    );
    expect(() => checkKinds({ fx: [source('tax_fx')] })).toThrow(/declares kind tax_fx, not fx/);
  });

  it('keeps tax FX sources by their own role (data kind tax_fx), never the valuation one', () => {
    const plugins = { ...emptyPlugins(), taxFx: [source('tax_fx')] };
    expect(assignedOnly(plugins, [{ dataKind: 'fx', pluginKey: 'bank' }]).taxFx).toEqual([]);
    expect(assignedOnly(plugins, [{ dataKind: 'tax_fx', pluginKey: 'bank' }]).taxFx).toHaveLength(
      1,
    );
  });
});
