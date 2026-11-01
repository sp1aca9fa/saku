// Tax FX (requirements 07 "What a regime plug-in declares": FX for tax; 15 `TaxFxSource`; 04
// sources table "FX for tax"): broker-style rates the tax engine converts trades and dividends
// with. Core checks every response before anything is stored (layer A for this data path); a
// response with any problem is refused whole, so no partial or mislabeled set is ever stored.
//
// Structural checks (each a problem line):
// - every rate names the requested pair, a real calendar date (`YYYY-MM-DD`), a tax kind
//   (`tax_mid`, `tax_buy`, `tax_sell`) and a rate name the install's regime declares that maps
//   onto that same kind (`TaxRegime.fx.rates`);
// - a value is a finite number above 0 (never 0 as "unknown"); a withdrawal carries no value;
// - one vintage (pair, kind, date, publication time) is stated once (two different statements
//   would make which one holds a guess);
// - on one date and publication time, every `tax_buy` >= every `tax_mid` >= every `tax_sell`, and
//   `tax_buy` >= `tax_sell` (the customer buys the pair's base currency at the higher rate; see
//   `TaxFxRate`). Equal rates pass.
//
// Not built (an owner decision, docs/data-pipeline.md): a cross-check of tax rates against the
// valuation rates within a tolerance. A date with no rate is not a structural problem here:
// a missing rate stays unknown and the tax engine says so, never filling it from another date.
import { isTradingDate } from '@saku/core';
import { TAX_FX_KINDS } from './tax-regime';
import type { TaxFx, TaxFxKind, TaxFxRate, TaxRegime } from './types';

/**
 * The pairs tax rates are fetched for: the US dollar against the regime's currency (the Tier 1
 * assets trade in USD), none when the regime's currency is the dollar.
 */
export function taxFxPairs(regime: Pick<TaxRegime, 'info'>): string[] {
  return regime.info.currency === 'USD' ? [] : [`USD${regime.info.currency}`];
}

/** The order on one date: higher rank, higher or equal rate. */
const RANK: Record<TaxFxKind, number> = { tax_sell: 0, tax_mid: 1, tax_buy: 2 };

/** A publication time as one key per instant (any spelling of the same instant); none: ''. */
function publishedKey(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return `?${String(value)}`;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : `?${value}`;
}

/**
 * The problems of one tax FX response for `pair` under the regime's declared rate names (`fx`);
 * empty when it may be stored. Reads the response as unknown data (a plug-in's types are not
 * trusted at run time).
 */
export function taxFxProblems(
  rates: readonly unknown[] | unknown,
  o: { pair: string; fx: Pick<TaxFx, 'rates'> },
): string[] {
  if (!Array.isArray(rates)) return ['the response is not a list of rates'];
  const problems: string[] = [];
  const vintages = new Map<string, string>();
  /** Per date and publication time, the values per kind. */
  const groups = new Map<string, { date: string; byKind: Map<TaxFxKind, number[]> }>();
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
    if (r.publishedAt !== undefined && typeof r.publishedAt !== 'string') {
      problems.push(`${where}: publishedAt is not text`);
      ok = false;
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
    const published = publishedKey(r.publishedAt);
    const statement = withdrawn ? 'withdrawn' : String(r.rate);
    const vintage = `${String(r.kind)}|${String(r.date)}|${published}`;
    const seen = vintages.get(vintage);
    if (seen !== undefined && seen !== statement) {
      problems.push(`${where}: stated twice for one publication time (${seen} and ${statement})`);
      return;
    }
    vintages.set(vintage, statement);
    if (withdrawn) return;
    const key = `${String(r.date)}|${published}`;
    const group = groups.get(key) ?? { date: r.date as string, byKind: new Map() };
    groups.set(key, group);
    const kind = r.kind as TaxFxKind;
    group.byKind.set(kind, [...(group.byKind.get(kind) ?? []), r.rate as number]);
  });
  for (const { date, byKind } of groups.values()) {
    const kinds = [...byKind.keys()].sort((a, b) => RANK[a] - RANK[b]);
    for (const [i, lower] of kinds.entries()) {
      for (const higher of kinds.slice(i + 1)) {
        const low = Math.max(...byKind.get(lower)!);
        const high = Math.min(...byKind.get(higher)!);
        if (high < low) {
          problems.push(`${date}: ${higher} ${high} is below ${lower} ${low}`);
        }
      }
    }
  }
  return problems;
}
