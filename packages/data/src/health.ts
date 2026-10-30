// Data health (requirements 04, severity rules): check results rolled up per symbol and date, and
// the stand-in rule for a day the primary has no bar but a secondary does. Pure functions; the
// verify job stores what they return.
import {
  type HealthStatus,
  type RawBar,
  type TradingDate,
  priceReturn,
  totalReturn,
} from '@saku/core';
import type { Sessions } from './calendar';
import { type CheckResult, TOLERANCE, layerA } from './checks';

export const RANK: Record<HealthStatus, number> = { green: 0, yellow: 1, red: 2 };
export const worst = (a: HealthStatus, b: HealthStatus): HealthStatus =>
  RANK[b] > RANK[a] ? b : a;

/** A series more than this many business days behind is red (04). */
export const MAX_STALE_DAYS = 5;

/**
 * A series' freshness on `date` (04): `sessions` is the series' own calendar, so its holidays
 * are expected gaps. Missing the latest business day is the normal publication lag (green); more
 * is an unexpected gap (yellow); more than MAX_STALE_DAYS is red.
 */
export function seriesHealth(
  sessions: Sessions,
  date: TradingDate,
  lastObservation: TradingDate | undefined,
): { status: HealthStatus; behind: number } {
  if (lastObservation === undefined) return { status: 'red', behind: Infinity };
  const behind = sessions.between(lastObservation, date).filter((d) => d > lastObservation).length;
  return { status: freshnessStatus(behind), behind };
}

/**
 * A series' freshness as read before `date`'s session opens (a backtest reads the cash rate at
 * 09:30 New York, requirements 04 "Point-in-time series"). `date`'s own observation cannot exist
 * before its day has run, so the lag is counted in business days of the series' calendar
 * strictly between `lastObservation` and `date`: the previous business day's value not yet
 * published is the normal publication lag (green, 04: `DTB3` is published the next business day,
 * one-day lag); more is a gap (yellow); more than MAX_STALE_DAYS is red; no value at all is red.
 * Undefined when the lag cannot be counted on this calendar (`date` or `lastObservation` outside
 * its valid range): unknown, never green.
 */
export function seriesHealthAtOpen(
  sessions: Sessions,
  date: TradingDate,
  lastObservation: TradingDate | undefined,
): { status: HealthStatus; behind: number } | undefined {
  const { validFrom, validTo } = sessions.calendar;
  if (date < validFrom || date > validTo) return undefined;
  if (lastObservation === undefined) return { status: 'red', behind: Infinity };
  if (lastObservation < validFrom || lastObservation > date) return undefined;
  const behind = sessions
    .between(lastObservation, date)
    .filter((d) => d > lastObservation && d < date).length;
  return { status: freshnessStatus(behind), behind };
}

/** The grade of a series `behind` business days behind (Infinity: no value at all). */
export function freshnessStatus(behind: number): HealthStatus {
  return behind <= 1 ? 'green' : behind <= MAX_STALE_DAYS ? 'yellow' : 'red';
}

/** At most this many stand-in days in a row per ticker; the next one is red (04). */
export const MAX_STAND_IN_DAYS = 2;

export interface StandIn {
  date: TradingDate;
  source: string;
  bar: RawBar;
  /**
   * Relative price uncertainty for the decision-margin test: the tolerance of the tightest
   * independent check that passed (two secondaries agreeing, the index, else layer C).
   */
  band: number;
  basis: 'secondaries_agree' | 'index' | 'layer_c' | 'unchecked';
}

export interface StandInRefusal {
  date: TradingDate;
  reason: 'no_valid_secondary' | 'secondaries_disagree' | 'layer_c' | 'index' | 'too_many_days';
}

export interface StandInInput {
  /** The primary's bars (raw), sorted by date. */
  primary: RawBar[];
  /** Each secondary's bars, un-split, in role order. */
  secondaries: [source: string, bars: RawBar[]][];
  sessions: Sessions;
  leverage: number;
  /** The underlying's canonical bars (its own stand-ins included), for layer C. */
  underlying?: RawBar[];
  /** The fund's index, for the index check. */
  index?: { date: TradingDate; value: number }[];
  to: TradingDate;
}

/**
 * Stand-ins for the sessions the primary lacks, from its first bar to `to` (04, "Primary
 * missing, secondary present"). A secondary bar qualifies when it passes layer A; when two or
 * more qualify they must agree within the layer B close tolerance; the bar must pass layer C
 * where it applies; at most two days in a row.
 */
export function standIns(o: StandInInput): { standIns: StandIn[]; refused: StandInRefusal[] } {
  const out: StandIn[] = [];
  const refused: StandInRefusal[] = [];
  const first = o.primary[0]?.date;
  if (!first || first > o.to) return { standIns: out, refused };

  const own = new Map(o.primary.map((b) => [b.date, b]));
  const secondaries = o.secondaries.map(([source, bars]) => {
    const ok = new Map<TradingDate, boolean>();
    for (const r of layerA(bars, {
      source,
      primary: false,
      leverage: o.leverage,
      sessions: o.sessions,
    })) {
      if (r.check === 'missing_day') continue;
      ok.set(r.date, (ok.get(r.date) ?? true) && r.status === 'green');
    }
    return { source, byDate: new Map(bars.map((b) => [b.date, b])), ok };
  });
  const u = o.underlying && new Map(o.underlying.map((b) => [b.date, b]));
  const level = o.index && new Map(o.index.map((p) => [p.date, p.value]));

  let prev: RawBar | undefined;
  let run = 0;
  for (const date of o.sessions.between(first, o.to)) {
    const p = own.get(date);
    if (p) {
      prev = p;
      run = 0;
      continue;
    }
    // Days in a row without the primary, whatever stood in for them.
    run++;
    const available = secondaries.filter((s) => s.byDate.has(date));
    if (available.length === 0) {
      prev = undefined;
      continue;
    }
    const refuse = (reason: StandInRefusal['reason']) => {
      refused.push({ date, reason });
      prev = undefined;
    };
    const valid = available.filter((s) => s.ok.get(date));
    if (valid.length === 0) {
      refuse('no_valid_secondary');
      continue;
    }
    const pick = valid[0]!;
    const bar = pick.byDate.get(date)!;
    if (valid.some((s) => Math.abs(s.byDate.get(date)!.close / bar.close - 1) > TOLERANCE.close)) {
      refuse('secondaries_disagree');
      continue;
    }
    if (run > MAX_STAND_IN_DAYS) {
      refuse('too_many_days');
      continue;
    }

    // No independent check yet: the layer C base tolerance (documented assumption).
    let basis: StandIn['basis'] = 'unchecked';
    let band: number = TOLERANCE.leverageBase;
    if (valid.length >= 2) {
      basis = 'secondaries_agree';
      band = TOLERANCE.close;
    }
    const before = o.sessions.before(date);
    if (prev && prev.date === before) {
      const ub = u?.get(date);
      const ua = u?.get(before);
      if (ub && ua) {
        const expected = o.leverage * priceReturn(ua, ub);
        const tol = TOLERANCE.leverageBase + TOLERANCE.leverageShare * Math.abs(expected);
        if (Math.abs(totalReturn(prev, bar) - expected) > tol) {
          refuse('layer_c');
          continue;
        }
        if (basis === 'unchecked') {
          basis = 'layer_c';
          band = tol;
        }
      }
      const ia = level?.get(before);
      const ib = level?.get(date);
      if (ia !== undefined && ib !== undefined) {
        if (Math.abs(priceReturn(prev, bar) - (ib / ia - 1)) > TOLERANCE.index) {
          refuse('index');
          continue;
        }
        if (basis !== 'secondaries_agree') {
          basis = 'index';
          band = TOLERANCE.index;
        }
      }
    }
    out.push({ date, source: pick.source, bar, band, basis });
    prev = bar;
  }
  return { standIns: out, refused };
}

export interface DayHealth {
  status: HealthStatus;
  /** Codes, e.g. `B.close_match@alpaca`, `stand_in@yahoo`, `single_source`. */
  reasons: string[];
}

/**
 * One symbol's status per date (04, severity rules): the worst of its check results, with the
 * primary's missing day replaced by the stand-in when one was accepted (red without one), and
 * never green on a day only one source had a bar.
 */
export function symbolHealth(o: {
  dates: TradingDate[];
  results: CheckResult[];
  primary: string;
  /** Dates the primary has a bar. */
  primaryDates: Set<TradingDate>;
  /** How many sources (primary and secondaries) had a bar, per date. */
  sources: Map<TradingDate, number>;
  standIns: StandIn[];
  refused: StandInRefusal[];
}): Map<TradingDate, DayHealth> {
  const out = new Map<TradingDate, DayHealth>(
    o.dates.map((d) => [d, { status: 'green' as HealthStatus, reasons: [] as string[] }]),
  );
  const add = (date: TradingDate, status: HealthStatus, reason: string) => {
    const h = out.get(date);
    if (!h) return;
    h.status = worst(h.status, status);
    if (!h.reasons.includes(reason)) h.reasons.push(reason);
  };
  const stood = new Map(o.standIns.map((s) => [s.date, s]));
  for (const r of o.results) {
    if (r.status === 'green') continue;
    if (r.check === 'missing_day' && r.source === o.primary && stood.has(r.date)) continue;
    add(r.date, r.status, `${r.layer}.${r.check}${r.source ? `@${r.source}` : ''}`);
  }
  for (const s of o.standIns) add(s.date, 'yellow', `stand_in@${s.source}`);
  for (const r of o.refused) add(r.date, 'red', `stand_in_refused:${r.reason}`);
  for (const date of o.dates) {
    if (!o.primaryDates.has(date) && !stood.has(date)) add(date, 'red', 'primary_missing');
    if ((o.sources.get(date) ?? 0) < 2) add(date, 'yellow', 'single_source');
  }
  return out;
}
