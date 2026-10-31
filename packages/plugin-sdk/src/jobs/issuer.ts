// The observed premium/discount of each fund's market close to its issuer NAV (layer D), for the
// owner to set `issuer_nav_tolerance` from (requirements 04, "Per-ETF thresholds set in A3").
// Read-only: `pnpm sources issuer-stats [--years N]` prints it. Also the issuer records layer D
// does not compare for being in another currency (C15 (a)), for the run's log and `pnpm health`.
import type { TradingDate } from '@saku/core';
import {
  type IssuerPublishes,
  type NotComparedCounts,
  type PremiumStats,
  type Sessions,
  navPremiums,
  notComparedOf,
  premiumStats,
  unsplit,
} from '@saku/data';
import {
  type Db,
  activeSymbols,
  canonicalBars,
  issuerRecordsOf,
  navTolerances,
  unmatchedTolerances,
} from '@saku/db';
import { rawBars, roles } from './verify';

/**
 * What layer D did not compare for one fund, source and currency, the record being in another
 * known currency than the fund's (decisions log 2026-11-01, C15 (a): "not compared";
 * `notComparedOf`): positive NAVs, and distributions both sides report.
 */
export interface NotCompared {
  ticker: string;
  source: string;
  currency: string;
  navs: number;
  distributions: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const navsAndDistributions = (c: { navs: number; distributions: number }) =>
  [
    ...(c.navs > 0 ? [plural(c.navs, 'NAV')] : []),
    ...(c.distributions > 0 ? [plural(c.distributions, 'distribution')] : []),
  ].join(' and ');

/** Counts per currency as `XXX 12 NAVs and 1 distribution; YYY 3 NAVs`, or `0` without any. */
export function describeCounts(counts: NotComparedCounts): string {
  const list = Object.entries(counts)
    .filter(([, c]) => c.navs + c.distributions > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return list.length === 0
    ? '0'
    : list.map(([currency, c]) => `${currency} ${navsAndDistributions(c)}`).join('; ');
}

/** One line per fund, source and currency, for the run's log and `pnpm health`. */
export function notComparedLines(list: NotCompared[]): string[] {
  return list.map(
    (x) =>
      `${x.ticker} ${x.source}: ${navsAndDistributions(x)} in ${x.currency}, not the fund's ` +
      'currency, not compared (no conversion; layer D has no result for them)',
  );
}

/** The flat list of one fund and source's counts. */
export function notComparedList(
  ticker: string,
  source: string,
  counts: NotComparedCounts,
): NotCompared[] {
  return Object.entries(counts).map(([currency, c]) => ({ ticker, source, currency, ...c }));
}

/**
 * Per active fund and issuer source with a role, what layer D does not compare for being in
 * another currency, dated `from` to `to`: its comparisons run now on the stored records and the
 * primary's raw bars as verify feeds them (as stored now, not necessarily what a run saw).
 * `loaded`: the keys of the issuer plug-ins loaded (a source with a role not among them compares
 * nothing unless its declaration is known); absent, every source counts as loaded.
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
  const barsPrimary = (await roles(db, 'bars')).primary;
  if (sources.length === 0 || barsPrimary === undefined) return [];
  const out: NotCompared[] = [];
  for (const s of await activeSymbols(db)) {
    const stored = await issuerRecordsOf(db, s.id, sources);
    if (stored.size === 0) continue;
    const primary = unsplit(
      ((await rawBars(db, s.id)).get(barsPrimary) ?? []).filter((b) => b.date <= o.to),
    );
    for (const source of sources) {
      const publishes = o.publishes?.[source];
      const counts = notComparedOf(primary, stored.get(source) ?? [], {
        source,
        currency: s.currency,
        to: o.to,
        ...(o.from !== undefined && { from: o.from }),
        ...(publishes && { publishes }),
        ...(o.loaded !== undefined && !o.loaded.includes(source) && { notLoaded: true }),
      });
      out.push(...notComparedList(s.ticker, source, counts));
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
   * Days with a NAV left out: a stand-in close (not the primary's), or a day graded red (in any
   * currency: such a day is not counted as not compared below).
   */
  leftOut: { standIn: number; red: number };
  /**
   * NAVs and distributions in the period that layer D does not compare because their record is
   * in another known currency (decisions log 2026-11-01, C15 (a); `notComparedOf` on the closes
   * used here), per currency (ISO 4217).
   */
  otherCurrency: NotComparedCounts;
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
 * NAVs in another known currency are not compared (C15 (a)): never a premium; those on a day kept
 * are counted per currency (with the distributions not compared), those on a day left out count
 * as left out.
 * A source whose declaration (`publishes`, by source key) has no NAV has no row: it makes no NAV
 * claim (as layer D); a source without a declaration has a row from the NAVs its records hold.
 */
export async function issuerStats(
  db: Db,
  o: {
    from: TradingDate;
    to: TradingDate;
    publishes?: Record<string, IssuerPublishes>;
    /** The market calendar (closed-day rows are not in the canonical series, `canonicalBars`). */
    sessions: Sessions;
  },
): Promise<IssuerStats> {
  const nav = await navTolerances(db);
  const symbols = await activeSymbols(db);
  const rows: IssuerStatsRow[] = [];
  for (const s of symbols) {
    const records = await issuerRecordsOf(db, s.id);
    if (records.size === 0) continue;
    const canonical = (await canonicalBars(db, s.id, o.to, o.sessions)).filter(
      (b) => b.date >= o.from,
    );
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
      const other = notComparedOf(primary, inPeriod, {
        source,
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
