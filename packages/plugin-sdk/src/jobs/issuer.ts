// The observed premium/discount of each fund's market close to its issuer NAV (layer D), for the
// owner to set `issuer_nav_tolerance` from (requirements 04, "Per-ETF thresholds set in A3").
// Read-only: `pnpm sources issuer-stats [--years N]` prints it. Also the issuer records layer D
// does not compare for being in another currency (C15 (a)), for the run's log and `pnpm health`.
import type { TradingDate } from '@saku/core';
import {
  type IssuerPublishes,
  type PremiumStats,
  navPremiums,
  notComparedByCurrency,
  otherCurrency,
  premiumStats,
} from '@saku/data';
import {
  type Db,
  activeSymbols,
  canonicalBars,
  issuerRecordsOf,
  navTolerances,
  unmatchedTolerances,
} from '@saku/db';
import { roles } from './verify';

/**
 * Issuer records of one fund and source not compared because they are in another known currency
 * than the fund's (decisions log 2026-11-01, C15 (a): "not compared"; `notComparedByCurrency`).
 */
export interface NotCompared {
  ticker: string;
  source: string;
  currency: string;
  count: number;
}

/** Counts per currency as `2 XXX, 1 YYY` (sorted by currency), or `0` without any. */
export function describeCounts(counts: Record<string, number>): string {
  const list = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return list.length === 0 ? '0' : list.map(([c, n]) => `${n} ${c}`).join(', ');
}

/** One line per fund, source and currency, for the run's log and `pnpm health`. */
export function notComparedLines(list: NotCompared[]): string[] {
  return list.map(
    (x) =>
      `${x.ticker} ${x.source}: ${x.count} issuer record${x.count === 1 ? '' : 's'} in ` +
      `${x.currency}, not the fund's currency: NAV and distributions not compared ` +
      '(no conversion; layer D has no result for them)',
  );
}

/**
 * Per active fund and issuer source with a role, the stored records dated `from` to `to` that
 * layer D does not compare for being in another currency (as stored now). `loaded`: the keys of
 * the issuer plug-ins loaded (a source with a role not among them compares nothing unless its
 * declaration is known); absent, every source counts as loaded.
 */
export async function issuerNotCompared(
  db: Db,
  o: {
    from?: TradingDate;
    to: TradingDate;
    publishes?: Record<string, IssuerPublishes>;
    loaded?: string[];
  },
): Promise<NotCompared[]> {
  const r = await roles(db, 'issuer');
  const sources = [...(r.primary ? [r.primary] : []), ...r.secondaries, ...r.checks];
  if (sources.length === 0) return [];
  const out: NotCompared[] = [];
  for (const s of await activeSymbols(db)) {
    const stored = await issuerRecordsOf(db, s.id, sources);
    for (const source of sources) {
      const publishes = o.publishes?.[source];
      const counts = notComparedByCurrency(stored.get(source) ?? [], {
        currency: s.currency,
        to: o.to,
        ...(o.from !== undefined && { from: o.from }),
        ...(publishes && { publishes }),
        ...(o.loaded !== undefined && !o.loaded.includes(source) && { notLoaded: true }),
      });
      for (const [currency, count] of Object.entries(counts)) {
        out.push({ ticker: s.ticker, source, currency, count });
      }
    }
  }
  return out;
}

export interface IssuerStatsRow extends PremiumStats {
  ticker: string;
  source: string;
  /** The tolerance set for the fund, if any. */
  tolerance?: number;
  /**
   * Days with a NAV in the fund's currency left out: a stand-in close (not the primary's), or a
   * day graded red.
   */
  leftOut: { standIn: number; red: number };
  /**
   * Records in the period not compared because they are in another known currency (decisions
   * log 2026-11-01, C15 (a); layer D has no result for their NAV and distribution), counted per
   * currency (ISO 4217).
   */
  otherCurrency: Record<string, number>;
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
 * Records in another known currency are not compared (C15 (a)): counted per currency, never in
 * the premiums or the days left out.
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
        // A NAV in another currency is never a premium: not a day left out (counted below).
        if (otherCurrency(r, s.currency)) continue;
        const why = r.nav !== undefined ? excluded.get(r.date) : undefined;
        if (why) leftOut[why]++;
      }
      const premiums = navPremiums(primary, inPeriod, s.currency).map((p) => p.premium);
      const other = notComparedByCurrency(inPeriod, {
        currency: s.currency,
        to: o.to,
        ...(declared && { publishes: declared }),
      });
      rows.push({
        ticker: s.ticker,
        source,
        ...premiumStats(premiums),
        ...(Object.hasOwn(nav.tolerances, s.ticker) && { tolerance: nav.tolerances[s.ticker]! }),
        leftOut,
        otherCurrency: other,
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
