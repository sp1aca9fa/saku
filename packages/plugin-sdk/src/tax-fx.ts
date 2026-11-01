// Tax FX (requirements 07 "What a regime plug-in declares": FX for tax; 15 `TaxFxSource`; 04
// sources table "FX for tax"): broker-style rates the tax engine converts trades and dividends
// with. Core checks every response before anything is stored (layer A for this data path); a
// response with any problem is refused whole, so no partial or mislabeled set is ever stored.
//
// Checks on the response (`taxFxProblems`, each a problem line):
// - every rate names the requested pair, a real calendar date (`YYYY-MM-DD`), a tax kind
//   (`tax_mid`, `tax_buy`, `tax_sell`) and a rate name the install's regime declares that maps
//   onto that same kind (`TaxRegime.fx.rates`);
// - a publication time, when given, is an instant with a time of day and a zone (the rule storing
//   applies, `publicationInstant`): a date alone or a zone-less time is refused;
// - a value is a finite number above 0 (never 0 as "unknown"); a withdrawal carries no value;
// - one vintage (pair, kind, date, publication time) is stated once (two different statements
//   would make which one holds a guess);
// - the order rule (`taxFxOrderProblems` in @saku/db): per date, on the latest vintage of each
//   kind as a point-in-time read would return it once the response is stored,
//   `tax_buy >= tax_mid >= tax_sell` (equal passes; the customer buys the pair's base currency
//   at the higher rate, see `TaxFxRate`). Here on the response alone; storing (`storeTaxFx`)
//   runs it again on the response merged with the stored rows, so a partial revision that
//   breaks the order against a stored rate is refused too.
//
// Not built (an owner decision, docs/data-pipeline.md): a cross-check of tax rates against the
// valuation rates within a tolerance. A date with no rate is not a structural problem here:
// a missing rate stays unknown and the tax engine says so, never filling it from another date.
import { isTradingDate } from '@saku/core';
import { type TaxFxVintage, publicationInstant, taxFxOrderProblems } from '@saku/db';
import { TAX_FX_KINDS } from './tax-regime';
import type { TaxFx, TaxFxKind, TaxFxRate, TaxRegime } from './types';

/**
 * The pairs tax rates are fetched for: the US dollar against the regime's currency (the Tier 1
 * assets trade in USD), none when the regime's currency is the dollar.
 */
export function taxFxPairs(regime: Pick<TaxRegime, 'info'>): string[] {
  return regime.info.currency === 'USD' ? [] : [`USD${regime.info.currency}`];
}

/**
 * The problems of one tax FX response for `pair` under the regime's declared rate names (`fx`);
 * empty when it may be stored. Reads the response as unknown data (a plug-in's types are not
 * trusted at run time). `fetchedAt`: when the response was fetched (ISO; default now), the known
 * time of a rate without a publication time.
 */
export function taxFxProblems(
  rates: readonly unknown[] | unknown,
  o: { pair: string; fx: Pick<TaxFx, 'rates'>; fetchedAt?: string },
): string[] {
  if (!Array.isArray(rates)) return ['the response is not a list of rates'];
  const fetchedAt = new Date(o.fetchedAt ?? Date.now()).toISOString();
  const problems: string[] = [];
  const vintages = new Map<string, string>();
  /** Per kind, the response's vintages as a point-in-time read sees them. */
  const byKind: Partial<Record<TaxFxKind, TaxFxVintage[]>> = {};
  const dates: string[] = [];
  let readAt = fetchedAt;
  rates.forEach((raw: unknown, i) => {
    const at = `rate ${i}`;
    if (raw === null || typeof raw !== 'object') {
      problems.push(`${at}: not an object`);
      return;
    }
    const r = raw as Partial<Record<keyof TaxFxRate, unknown>>;
    const where = `${at} (${String(r.date)} ${String(r.kind)})`;
    let ok = true;
    if (r.pair !== o.pair) {
      problems.push(`${where}: pair ${String(r.pair)}, not ${o.pair}`);
      ok = false;
    }
    if (typeof r.date !== 'string' || !isTradingDate(r.date)) {
      problems.push(`${where}: no valid date (YYYY-MM-DD)`);
      ok = false;
    }
    if (!(TAX_FX_KINDS as readonly unknown[]).includes(r.kind)) {
      problems.push(`${where}: kind is not one of ${TAX_FX_KINDS.join(', ')}`);
      ok = false;
    }
    const declared =
      typeof r.name === 'string' && Object.hasOwn(o.fx.rates, r.name)
        ? o.fx.rates[r.name]
        : undefined;
    if (!declared) {
      problems.push(
        `${where}: rate name ${String(r.name)} is not one the regime declares (${Object.keys(o.fx.rates).join(', ')})`,
      );
      ok = false;
    } else if (declared.kind !== r.kind) {
      problems.push(
        `${where}: rate name ${String(r.name)} is ${declared.kind} in the regime, not ${String(r.kind)}`,
      );
      ok = false;
    }
    let published: string | null = null;
    if (r.publishedAt !== undefined) {
      try {
        if (typeof r.publishedAt !== 'string') throw new Error('publishedAt is not text');
        published = publicationInstant(r.publishedAt);
      } catch (e) {
        problems.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
        ok = false;
      }
    }
    const withdrawn = r.withdrawn === true;
    if (r.withdrawn !== undefined && !withdrawn) {
      problems.push(`${where}: withdrawn is neither true nor absent`);
      ok = false;
    }
    if (withdrawn && r.rate !== undefined) {
      problems.push(`${where}: a withdrawal carries a rate`);
      ok = false;
    }
    if (!withdrawn && !(typeof r.rate === 'number' && Number.isFinite(r.rate) && r.rate > 0)) {
      problems.push(`${where}: rate ${String(r.rate)} is not a finite number above 0`);
      ok = false;
    }
    if (!ok) return;
    const statement = withdrawn ? 'withdrawn' : String(r.rate);
    const vintage = `${String(r.kind)}|${String(r.date)}|${published ?? ''}`;
    const seen = vintages.get(vintage);
    if (seen !== undefined && seen !== statement) {
      problems.push(`${where}: stated twice for one publication time (${seen} and ${statement})`);
      return;
    }
    vintages.set(vintage, statement);
    const knownAt = published ?? fetchedAt;
    if (knownAt > readAt) readAt = knownAt;
    dates.push(r.date as string);
    (byKind[r.kind as TaxFxKind] ??= []).push({
      date: r.date as string,
      publishedAt: (r.publishedAt as string | undefined) ?? null,
      knownAt,
      fetchedAt,
      value: withdrawn ? null : (r.rate as number),
    });
  });
  // The order is read only on a response whose rates all passed (a refused one is refused anyway).
  if (problems.length > 0) return problems;
  return taxFxOrderProblems(byKind, dates, readAt);
}
