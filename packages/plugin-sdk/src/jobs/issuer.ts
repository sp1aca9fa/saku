// The observed premium/discount of each fund's market close to its issuer NAV (layer D), for the
// owner to set `issuer_nav_tolerance` from (requirements 04, "Per-ETF thresholds set in A3").
// Read-only: `pnpm sources issuer-stats [--years N]` prints it.
import type { TradingDate } from '@saku/core';
import { type IssuerPublishes, type PremiumStats, navPremiums, premiumStats } from '@saku/data';
import {
  type Db,
  activeSymbols,
  canonicalBars,
  issuerRecordsOf,
  navTolerances,
  unmatchedTolerances,
} from '@saku/db';

export interface IssuerStatsRow extends PremiumStats {
  ticker: string;
  source: string;
  /** The tolerance set for the fund, if any. */
  tolerance?: number;
  /** Days with a NAV left out: a stand-in close (not the primary's), or a day graded red. */
  leftOut: { standIn: number; red: number };
}

export interface IssuerStats {
  rows: IssuerStatsRow[];
  /** The stored `issuer_nav_tolerance` does not parse (no tolerance shown). */
  toleranceInvalid: boolean;
  /** Tolerance keys that name no active symbol. */
  toleranceUnmatched: string[];
}

/**
 * Per active fund and issuer source with stored records: the days with both a primary close and
 * an issuer NAV in the fund's currency from `from` to `to`, and the median, 99th percentile and
 * largest |close / NAV - 1|. Closes are the canonical bars from the primary; stand-in days and
 * days graded red are left out (counted), since their close is not a trusted primary value.
 * A source whose declaration (`publishes`, by source key) has no NAV has no row: it makes no NAV
 * claim (as layer D); a source without a declaration has a row from the NAVs its records hold.
 */
export async function issuerStats(
  db: Db,
  o: { from: TradingDate; to: TradingDate; publishes?: Record<string, IssuerPublishes> },
): Promise<IssuerStats> {
  const nav = await navTolerances(db);
  const symbols = await activeSymbols(db);
  const rows: IssuerStatsRow[] = [];
  for (const s of symbols) {
    const records = await issuerRecordsOf(db, s.id);
    if (records.size === 0) continue;
    const canonical = (await canonicalBars(db, s.id, o.to)).filter((b) => b.date >= o.from);
    const excluded = new Map<TradingDate, 'standIn' | 'red'>();
    for (const b of canonical) {
      if (b.standIn) excluded.set(b.date, 'standIn');
      else if (b.status === 'red') excluded.set(b.date, 'red');
    }
    const primary = canonical
      .filter((b) => !excluded.has(b.date))
      .map((b) => ({
        date: b.date,
        close: b.close,
        closeIsSplitAdjusted: false,
        divCash: b.divCash,
        splitFactor: b.splitFactor,
      }));
    for (const [source, list] of records) {
      const declared = o.publishes?.[source];
      if (declared !== undefined && declared.nav !== true) continue;
      const inPeriod = list.filter((r) => r.date >= o.from && r.date <= o.to);
      const leftOut = { standIn: 0, red: 0 };
      for (const r of inPeriod) {
        const why = r.nav !== undefined ? excluded.get(r.date) : undefined;
        if (why) leftOut[why]++;
      }
      const premiums = navPremiums(primary, inPeriod, s.currency).map((p) => p.premium);
      rows.push({
        ticker: s.ticker,
        source,
        ...premiumStats(premiums),
        ...(Object.hasOwn(nav.tolerances, s.ticker) && { tolerance: nav.tolerances[s.ticker]! }),
        leftOut,
      });
    }
  }
  return {
    rows,
    toleranceInvalid: nav.invalid,
    toleranceUnmatched: unmatchedTolerances(
      nav.tolerances,
      symbols.map((s) => s.ticker),
    ),
  };
}
