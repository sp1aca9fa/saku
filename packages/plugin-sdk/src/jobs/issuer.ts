// The observed premium/discount of each fund's market close to its issuer NAV (layer D), for the
// owner to set `issuer_nav_tolerance` from (requirements 04, "Per-ETF thresholds set in A3").
// Read-only: `pnpm sources issuer-stats [--years N]` prints it.
import type { TradingDate } from '@saku/core';
import { type PremiumStats, navPremiums, premiumStats } from '@saku/data';
import { type Db, activeSymbols, canonicalBars, issuerRecordsOf, navTolerances } from '@saku/db';

export interface IssuerStatsRow extends PremiumStats {
  ticker: string;
  source: string;
  /** The tolerance set for the fund, if any. */
  tolerance?: number;
}

/**
 * Per active fund and issuer source with stored records: the days with both a primary close and
 * an issuer NAV from `from` to `to`, and the median, 99th percentile and largest |close / NAV - 1|.
 * Closes are the canonical bars from the primary (stand-in days left out: the primary's own
 * values, as layer D compares them).
 */
export async function issuerStats(
  db: Db,
  o: { from: TradingDate; to: TradingDate },
): Promise<IssuerStatsRow[]> {
  const tolerances = await navTolerances(db);
  const out: IssuerStatsRow[] = [];
  for (const s of await activeSymbols(db)) {
    const records = await issuerRecordsOf(db, s.id);
    if (records.size === 0) continue;
    const primary = (await canonicalBars(db, s.id, o.to))
      .filter((b) => !b.standIn && b.date >= o.from)
      .map((b) => ({
        date: b.date,
        close: b.close,
        closeIsSplitAdjusted: false,
        divCash: b.divCash,
        splitFactor: b.splitFactor,
      }));
    for (const [source, list] of records) {
      const inPeriod = list.filter((r) => r.date >= o.from && r.date <= o.to);
      const premiums = navPremiums(primary, inPeriod).map((p) => p.premium);
      out.push({
        ticker: s.ticker,
        source,
        ...premiumStats(premiums),
        ...(Object.hasOwn(tolerances, s.ticker) && { tolerance: tolerances[s.ticker]! }),
      });
    }
  }
  return out;
}
