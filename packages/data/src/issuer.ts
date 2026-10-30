// Verification layer D, issuer reconciliation (requirements 04: "Market close vs issuer NAV within
// normal premium/discount; distributions and splits match issuer records", best effort, a check
// and not a gate). Pure functions over one symbol's primary bars and one issuer source's records.
// Issuer data is for verification only: nothing here becomes a value used in calculations.
import type { HealthStatus, IssuerRecord, RawBar, TradingDate } from '@saku/core';
import type { Sessions } from './calendar';
import { type CheckResult, TOLERANCE } from './checks';
import { RANK } from './health';

/**
 * The highest status a layer D result can have: advisory (yellow at most) until the owner sets
 * per-fund NAV thresholds from observed data and decides that layer D may turn a day red
 * (requirements 04, "Per-ETF thresholds set in A3"; docs/data-pipeline.md, "Issuer
 * reconciliation (layer D)"). Raising it needs that decision in the decisions log.
 */
export const LAYER_D_MAX_STATUS: HealthStatus = 'yellow';

/** The issuer's latest NAV may be this many sessions behind the run's date (publication lag). */
export const ISSUER_MAX_BEHIND = 1;

const cap = (s: HealthStatus): HealthStatus =>
  RANK[s] > RANK[LAYER_D_MAX_STATUS] ? LAYER_D_MAX_STATUS : s;

/** As layer B (04 severity rules): within tolerance green, within 2x yellow, else red; capped. */
const statusD = (deviation: number, tol: number): HealthStatus =>
  cap(deviation <= tol ? 'green' : deviation <= 2 * tol ? 'yellow' : 'red');

/**
 * The market close's premium (+) or discount (-) to the issuer's NAV, close / NAV - 1, on dates
 * the primary has a bar and the issuer a NAV in the fund's currency. Both are per share as traded
 * that day (the primary un-split). Dates where either value is not positive, or the NAV is in
 * another (or no) currency, have no premium (layer D flags them).
 */
export function navPremiums(
  primary: RawBar[],
  records: IssuerRecord[],
  currency: string,
): { date: TradingDate; close: number; nav: number; premium: number }[] {
  const close = new Map(primary.map((b) => [b.date, b.close]));
  return records.flatMap((r) => {
    const c = close.get(r.date);
    if (c === undefined || r.nav === undefined || r.currency !== currency) return [];
    if (!(r.nav > 0) || !(c > 0)) return [];
    return [{ date: r.date, close: c, nav: r.nav, premium: c / r.nav - 1 }];
  });
}

/** The kinds an issuer source can declare it publishes (the one list; the registry validates). */
export const ISSUER_PUBLISHED_KINDS = ['nav', 'distributions', 'splits'] as const;

/**
 * What an issuer source declares it publishes (`PluginInfo.publishes`). Layer D compares only the
 * declared kinds: an undeclared one gets no result for its check (the source makes no claim, so
 * nothing was compared and nothing is green). Values of an undeclared kind in its records are
 * ignored. Not declared at all: what it publishes is inferred from its records (NAV when any
 * record has one, distributions and splits always compared).
 */
export type IssuerPublishes = { [K in (typeof ISSUER_PUBLISHED_KINDS)[number]]?: true };

export interface LayerDOptions {
  /** The issuer source's key (stored with each result). */
  source: string;
  /** The fund's trading currency (ISO 4217): a NAV in another one is not compared. */
  currency: string;
  /** The fund's NAV tolerance (`issuer_nav_tolerance`); none: observed only, always green. */
  tolerance?: number;
  /**
   * The stored `issuer_nav_tolerance` does not parse: premiums are observed only and one yellow
   * `nav_tolerance_invalid` result on the run's date says so (for a source with NAV).
   */
  toleranceInvalid?: boolean;
  /** What the source declares it publishes; absent: inferred from its records. */
  publishes?: IssuerPublishes;
  /** The source says it publishes this fund (`supports`). */
  supported?: boolean;
  /** This run's fetch from the source failed or stopped for this fund. */
  unavailable?: boolean;
  /**
   * The source has a role but its plug-in is not loaded (the private package absent or failed to
   * load): nothing was fetched, so a fund with records from it is never fresh (yellow).
   */
  notLoaded?: boolean;
  sessions: Sessions;
  /** The run's date: records after it are ignored; freshness is judged on it. */
  to: TradingDate;
}

/**
 * Layer D for one symbol and one issuer source, one result per check and date, every status
 * capped at LAYER_D_MAX_STATUS. With a `publishes` declaration only the declared kinds are
 * checked (`nav_premium`, the NAV's `issuer_stale` and `nav_tolerance_invalid` with NAV;
 * `distribution_match` with distributions; `split_match` with splits); an undeclared kind has no
 * result, never a green one. Without a declaration, as below (inferred from the records):
 * - `nav_premium`: |close / NAV - 1| against the fund's tolerance (no tolerance: green, the
 *   deviation recorded). A NAV that is not positive, or not in the fund's currency, is a
 *   mismatch and never a premium.
 * - `distribution_match`, `split_match`: the issuer's events against the primary's on the same
 *   dates (an event on one side only is a mismatch; amounts within the layer B event tolerance,
 *   1%), within the dates both cover. A source that publishes NAV is compared on the dates it
 *   has a record; a primary event on a date it has none is yellow "not compared" (issuer data
 *   unavailable, 04 severity rules), never a mismatch. A source without NAV (events only)
 *   reports every event in its range, so a date without its record reads as no event. A source
 *   declaring events only (no NAV) covers no date after its last record: a primary event of a
 *   declared kind after it, or any primary event when it supports the fund and has no record, is
 *   yellow "not compared" (unknown, never no result), unless this run's fetch failed or its
 *   plug-in is not loaded (then `issuer_stale` says so).
 * - `issuer_stale`: on the run's date, the latest NAV more than ISSUER_MAX_BEHIND sessions
 *   behind. With no NAV stored at all, yellow when this run's fetch failed for the fund, or when
 *   the source supports it and has no record of it (a NAV-less source that delivered records is
 *   events-only and has no freshness). A source whose plug-in is not loaded is yellow for every fund
 *   it has records for, whatever their age. A source declaring NAV with records but no NAV among
 *   them is yellow (its NAV is unknown). A source declaring no NAV has no NAV freshness: only a
 *   fetch that failed this run, or a plug-in not loaded, is yellow (what it publishes is unknown
 *   for the run); having no record is not (a fund may have had no event).
 * A plug-in not loaded with no declaration known gets only that yellow `issuer_stale` (for the
 * funds it has records for), no comparisons: what its records hold is unknown.
 */
export function layerD(
  primary: RawBar[],
  records: IssuerRecord[],
  o: LayerDOptions,
): CheckResult[] {
  const out: CheckResult[] = [];
  const base = { layer: 'D' as const, source: o.source };
  const bars = primary.filter((b) => b.date <= o.to);
  const recs = records.filter((r) => r.date <= o.to).sort((a, b) => a.date.localeCompare(b.date));
  const mine = new Map(bars.map((b) => [b.date, b]));
  const tolerance = o.toleranceInvalid ? undefined : o.tolerance;
  const later = (a: TradingDate, b: TradingDate) => (a > b ? a : b);
  const earlier = (a: TradingDate, b: TradingDate) => (a < b ? a : b);
  const d = o.publishes;
  if (o.notLoaded && d === undefined) {
    // Plug-in not loaded and no declaration known: what its records hold is unknown, and
    // inferring it could read a NAV-only source's missing events as mismatches. Only the
    // staleness, for the funds it has records for (which funds it would support is unknown).
    if (recs.length > 0) {
      const lastNav = recs.filter((r) => r.nav !== undefined).at(-1)?.date;
      out.push({
        ...base,
        check: 'issuer_stale',
        date: o.to,
        status: cap('yellow'),
        tolerance: ISSUER_MAX_BEHIND,
        message: `plug-in not loaded${lastNav ? `, latest NAV ${lastNav}` : ''}`,
      });
    }
    return out;
  }
  // Compared kinds: the declared ones; without a declaration, all (NAV where records have it).
  const navOn = d === undefined || d.nav === true;
  const eventsOn: Record<string, boolean> = {
    distribution_match: d === undefined || d.distributions === true,
    split_match: d === undefined || d.splits === true,
  };
  const navs = navOn ? recs.filter((r) => r.nav !== undefined) : [];
  // A NAV source has a record per date it publishes (a date without one is unknown); an
  // events-only source has records on event dates only (a date without one has no event).
  const publishesNav = d === undefined ? navs.length > 0 : d.nav === true;

  for (const r of navs) {
    const b = mine.get(r.date);
    if (!b || r.nav === undefined) continue;
    const bad =
      r.currency !== o.currency
        ? `NAV currency differs (${r.currency ?? 'none'}, the fund trades in ${o.currency})`
        : !(r.nav > 0)
          ? 'issuer NAV not positive'
          : undefined;
    const dev = bad === undefined ? Math.abs(b.close / r.nav - 1) : undefined;
    const message =
      bad ?? (tolerance === undefined ? 'no tolerance set (observed only)' : undefined);
    out.push({
      ...base,
      check: 'nav_premium',
      date: r.date,
      status:
        dev === undefined
          ? cap('red')
          : tolerance === undefined
            ? 'green'
            : statusD(dev, tolerance),
      ...(dev !== undefined && { deviation: dev }),
      observed: b.close,
      expected: r.nav,
      ...(tolerance !== undefined && { tolerance }),
      ...(message !== undefined && { message }),
    });
  }

  // Events on any date either side reports, within the dates both cover (after the issuer's last
  // record, its staleness speaks instead).
  const first = bars[0] && recs[0] && later(recs[0].date, bars[0].date);
  const last = bars[0] && recs[0] && earlier(recs.at(-1)!.date, bars.at(-1)!.date);
  if (first && last && first <= last) {
    const theirs = new Map(recs.map((r) => [r.date, r]));
    const dates = [...new Set([...mine.keys(), ...theirs.keys()])]
      .filter((d) => d >= first && d <= last)
      .sort();
    for (const date of dates) {
      const p = mine.get(date);
      const s = theirs.get(date);
      for (const ev of [
        { check: 'distribution_match', a: p?.divCash ?? 0, b: s?.distribution ?? 0, none: 0 },
        { check: 'split_match', a: p?.splitFactor ?? 1, b: s?.split ?? 1, none: 1 },
      ]) {
        if (!eventsOn[ev.check]) continue;
        if (ev.a === ev.none && ev.b === ev.none) continue;
        if (!s && publishesNav) {
          // A NAV source without a record that day: the event cannot be compared (unknown).
          out.push({
            ...base,
            check: ev.check,
            date,
            status: cap('yellow'),
            expected: ev.a,
            message: 'not compared: the issuer has no record on this date',
          });
          continue;
        }
        // An event on one side only is a mismatch on the event's date.
        const oneSide = ev.a === ev.none || ev.b === ev.none;
        const dev = oneSide ? Infinity : Math.abs(ev.b / ev.a - 1);
        out.push({
          ...base,
          check: ev.check,
          date,
          status: statusD(dev, TOLERANCE.event),
          ...(Number.isFinite(dev) && { deviation: dev }),
          observed: ev.b,
          expected: ev.a,
          tolerance: TOLERANCE.event,
          ...(oneSide && {
            message:
              ev.a === ev.none ? 'event only in issuer data' : 'event missing in issuer data',
          }),
        });
      }
    }
  }

  // A declared events-only source covers no date after its last record (none at all: no date,
  // when it supports the fund): a primary event there is unknown, never no result. A fetch that
  // failed or a plug-in not loaded is graded by `issuer_stale` below instead.
  if (d !== undefined && !publishesNav && !o.unavailable && !o.notLoaded) {
    const lastRec = recs.at(-1)?.date;
    if (lastRec !== undefined || o.supported) {
      for (const b of bars) {
        if (lastRec !== undefined && b.date <= lastRec) continue;
        for (const ev of [
          { check: 'distribution_match', a: b.divCash, none: 0 },
          { check: 'split_match', a: b.splitFactor, none: 1 },
        ]) {
          if (!eventsOn[ev.check] || ev.a === ev.none) continue;
          out.push({
            ...base,
            check: ev.check,
            date: b.date,
            status: cap('yellow'),
            expected: ev.a,
            message: 'not compared: no issuer record covers this date',
          });
        }
      }
    }
  }

  // Freshness on the run's date.
  const lastNav = navs.at(-1)?.date;
  if (!navOn) {
    // No NAV declared: no freshness to judge, but a fetch that failed or a plug-in not loaded
    // leaves this run's events unknown (never left silent; not loaded, as below, only for the
    // funds it has records for).
    if ((o.notLoaded && recs.length > 0) || o.unavailable) {
      out.push({
        ...base,
        check: 'issuer_stale',
        date: o.to,
        status: cap('yellow'),
        message: o.notLoaded ? 'plug-in not loaded' : 'not fetched',
      });
    }
  } else if (o.notLoaded) {
    // Which funds it would support is unknown: those it has records for are graded.
    if (recs.length > 0) {
      out.push({
        ...base,
        check: 'issuer_stale',
        date: o.to,
        status: cap('yellow'),
        tolerance: ISSUER_MAX_BEHIND,
        message: `plug-in not loaded${lastNav ? `, latest NAV ${lastNav}` : ''}`,
      });
    }
  } else if (lastNav !== undefined) {
    // A NAV older than the calendar counts the calendar's sessions (still far behind).
    const start = later(lastNav, o.sessions.calendar.validFrom);
    const behind = o.sessions.between(start, o.to).filter((d) => d > lastNav).length;
    out.push({
      ...base,
      check: 'issuer_stale',
      date: o.to,
      status: cap(behind <= ISSUER_MAX_BEHIND ? 'green' : 'yellow'),
      observed: behind,
      tolerance: ISSUER_MAX_BEHIND,
      ...(behind > ISSUER_MAX_BEHIND && { message: `latest NAV ${lastNav}` }),
    });
  } else if (o.unavailable || (o.supported && recs.length === 0) || (d && recs.length > 0)) {
    // Never graded green by having nothing to compare (a declared NAV with none stored included).
    out.push({
      ...base,
      check: 'issuer_stale',
      date: o.to,
      status: cap('yellow'),
      tolerance: ISSUER_MAX_BEHIND,
      message: o.unavailable
        ? 'not fetched, no NAV stored'
        : recs.length === 0
          ? 'supported, no record stored'
          : 'NAV declared, none stored',
    });
  }

  if (o.toleranceInvalid && navs.length > 0) {
    out.push({
      ...base,
      check: 'nav_tolerance_invalid',
      date: o.to,
      status: cap('yellow'),
      message: 'the issuer_nav_tolerance setting is invalid: premiums observed only',
    });
  }
  return out;
}

export interface PremiumStats {
  days: number;
  /** Of |premium|; undefined without any day. */
  median?: number;
  p99?: number;
  max?: number;
}

/**
 * Linear interpolation between the closest ranks (Hyndman and Fan type 7, the default of R and
 * NumPy) of sorted values; p in [0, 1].
 */
export function quantile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * The observed size of a fund's premium/discount, for the owner to set its NAV tolerance from
 * (`pnpm sources issuer-stats`): days, and the median, 99th percentile and largest |premium|.
 * Values that are not finite are left out (never counted as 0).
 */
export function premiumStats(premiums: number[]): PremiumStats {
  const abs = premiums
    .filter((p) => Number.isFinite(p))
    .map((p) => Math.abs(p))
    .sort((a, b) => a - b);
  if (abs.length === 0) return { days: 0 };
  return {
    days: abs.length,
    median: quantile(abs, 0.5)!,
    p99: quantile(abs, 0.99)!,
    max: abs.at(-1)!,
  };
}
