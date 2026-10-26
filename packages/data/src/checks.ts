// Verification layers A-C (requirements 04), as pure functions over one symbol's bars. Each
// returns one result per check and date, green ones included, so pass rates can be counted.
// Tolerances are the requirements' defaults; they change only through a decision, never to make
// a run pass.
import {
  type CheckLayer,
  type HealthStatus,
  type RawBar,
  type TradingDate,
  priceReturn,
  totalReturn,
  totalReturnIndex,
} from '@saku/core';
import type { Sessions } from './calendar';

export interface CheckResult {
  layer: CheckLayer;
  check: string;
  date: TradingDate;
  /** Layer A: the source checked; layer B: the secondary compared with the primary. */
  source?: string;
  status: HealthStatus;
  observed?: number;
  expected?: number;
  tolerance?: number;
  message?: string;
}

export const TOLERANCE = {
  /** Layer A: a daily total return beyond this is flagged, 1x and 3x funds. */
  moveFlag1x: 0.25,
  moveFlag3x: 0.6,
  /** Layer B: raw close, primary vs secondary (relative). */
  close: 0.0005,
  /** Layer B: dividend and split amounts (relative). */
  event: 0.01,
  /** Layer B: daily return of our adjusted series vs a provider's (absolute, 0.02pp). */
  adjReturn: 0.0002,
  /** Layer B: FX rates (relative). */
  fx: 0.005,
  /** Layer C: leveraged fund vs underlying, base plus share of the expected move. */
  leverageBase: 0.005,
  leverageShare: 0.1,
  /** Layer C: fund price return vs its index's return (absolute, 0.1pp). */
  index: 0.001,
} as const;

/** Layer B: within tolerance green, within 2x yellow, else red. */
const statusB = (deviation: number, tol: number): HealthStatus =>
  deviation <= tol ? 'green' : deviation <= 2 * tol ? 'yellow' : 'red';
/** Layer C: within tolerance green, within 3x yellow, else red. */
const statusC = (deviation: number, tol: number): HealthStatus =>
  deviation <= tol ? 'green' : deviation <= 3 * tol ? 'yellow' : 'red';

/** The move-flag threshold for a fund's leverage: 25% at 1x, 60% at 3x, linear between. */
export function moveThreshold(leverage: number): number {
  const l = Math.min(Math.max(Math.abs(leverage), 1), 3);
  return TOLERANCE.moveFlag1x + ((l - 1) / 2) * (TOLERANCE.moveFlag3x - TOLERANCE.moveFlag1x);
}

/**
 * Restates a split-adjusted source (prices, volume, dividends on today's share basis) as traded
 * that day, using the source's own split events: a value on date D is multiplied by every split
 * after D (volume divided).
 */
export function unsplit(bars: RawBar[]): RawBar[] {
  if (!bars.some((b) => b.closeIsSplitAdjusted)) return bars;
  const out: RawBar[] = [];
  let after = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    const f = b.closeIsSplitAdjusted ? after : 1;
    const scale = (v: number | undefined) => (v === undefined ? undefined : v * f);
    out.push({
      ...b,
      ...(b.open !== undefined && { open: scale(b.open) }),
      ...(b.high !== undefined && { high: scale(b.high) }),
      ...(b.low !== undefined && { low: scale(b.low) }),
      close: b.close * f,
      ...(b.volume !== undefined && { volume: b.volume / f }),
      divCash: b.divCash * f,
      closeIsSplitAdjusted: false,
    });
    after *= b.splitFactor;
  }
  return out.reverse();
}

/**
 * Layer A for one source's bars of one symbol (sorted by date): structure, trading days, gaps,
 * large moves and unchanged closes. A missing session is red for the primary (no value to use)
 * and yellow for another source.
 */
export function layerA(
  bars: RawBar[],
  o: { source: string; primary: boolean; leverage: number; sessions: Sessions; from?: TradingDate },
): CheckResult[] {
  const out: CheckResult[] = [];
  const base = { layer: 'A' as const, source: o.source };
  const threshold = moveThreshold(o.leverage);
  const byDate = new Map(bars.map((b) => [b.date, b]));
  bars.forEach((b, i) => {
    const problems: string[] = [];
    const prices = [b.open, b.high, b.low, b.close].filter((v): v is number => v !== undefined);
    if (prices.some((p) => !(p > 0))) problems.push('price not positive');
    const top = Math.max(b.open ?? b.close, b.close);
    const bottom = Math.min(b.open ?? b.close, b.close);
    if (b.high !== undefined && b.high < top) problems.push('high below open or close');
    if (b.low !== undefined && b.low > bottom) problems.push('low above open or close');
    if (b.volume !== undefined && !(b.volume >= 0)) problems.push('negative volume');
    if (!(b.divCash >= 0)) problems.push('negative dividend');
    if (!(b.splitFactor > 0)) problems.push('split factor not positive');
    if (!o.sessions.isSession(b.date)) problems.push('not a trading day');
    out.push({
      ...base,
      check: 'bar_valid',
      date: b.date,
      status: problems.length ? 'red' : 'green',
      ...(problems.length && { message: problems.join('; ') }),
    });
    const prev = bars[i - 1];
    if (!prev) return;
    const move = totalReturn(prev, b);
    out.push({
      ...base,
      check: 'large_move',
      date: b.date,
      status: Math.abs(move) > threshold ? 'yellow' : 'green',
      observed: move,
      tolerance: threshold,
    });
    out.push({
      ...base,
      check: 'unchanged_close',
      date: b.date,
      status: b.close === prev.close && b.splitFactor === 1 ? 'yellow' : 'green',
      observed: b.close,
    });
  });
  // Gaps: every session from the first bar (or `from`) to the last needs a bar.
  const first = o.from && bars[0] && o.from > bars[0].date ? o.from : bars[0]?.date;
  const last = bars.at(-1)?.date;
  if (first && last) {
    for (const date of o.sessions.between(first, last)) {
      if (!byDate.has(date)) {
        out.push({
          ...base,
          check: 'missing_day',
          date,
          status: o.primary ? 'red' : 'yellow',
          message: 'no bar on a trading day',
        });
      }
    }
  }
  return out;
}

/**
 * Layer B: the primary against one secondary (already un-split), on the primary's dates. A date
 * the secondary lacks is yellow (secondary unavailable). Events must fall on the same dates.
 */
export function layerB(primary: RawBar[], secondary: RawBar[], source: string): CheckResult[] {
  const out: CheckResult[] = [];
  const base = { layer: 'B' as const, source };
  const other = new Map(secondary.map((b) => [b.date, b]));
  const mine = new Map(primary.map((b) => [b.date, b]));
  for (const p of primary) {
    const s = other.get(p.date);
    if (!s) {
      out.push({
        ...base,
        check: 'close_match',
        date: p.date,
        status: 'yellow',
        message: 'no secondary bar',
      });
      continue;
    }
    const dev = Math.abs(s.close / p.close - 1);
    out.push({
      ...base,
      check: 'close_match',
      date: p.date,
      status: statusB(dev, TOLERANCE.close),
      observed: s.close,
      expected: p.close,
      tolerance: TOLERANCE.close,
    });
  }
  // Events on any date either side reports (within the dates both cover).
  const firstShared = primary.find((p) => other.has(p.date))?.date;
  const lastShared = [...primary].reverse().find((p) => other.has(p.date))?.date;
  if (!firstShared || !lastShared) return out;
  const dates = [...new Set([...mine.keys(), ...other.keys()])]
    .filter((d) => d >= firstShared && d <= lastShared)
    .sort();
  for (const date of dates) {
    const p = mine.get(date);
    const s = other.get(date);
    for (const ev of [
      { check: 'dividend_match', get: (b?: RawBar) => b?.divCash ?? 0, none: 0 },
      { check: 'split_match', get: (b?: RawBar) => b?.splitFactor ?? 1, none: 1 },
    ]) {
      const a = ev.get(p);
      const b = ev.get(s);
      if (a === ev.none && b === ev.none) continue;
      // An event on one side only is a mismatch in the event's date.
      const dev = a === ev.none || b === ev.none ? Infinity : Math.abs(b / a - 1);
      out.push({
        ...base,
        check: ev.check,
        date,
        status: statusB(dev, TOLERANCE.event),
        observed: b,
        expected: a,
        tolerance: TOLERANCE.event,
        ...(dev === Infinity && {
          message: a === ev.none ? 'event only in secondary' : 'event missing in secondary',
        }),
      });
    }
  }
  return out;
}

/**
 * Layer B: daily returns of our adjusted series (from the primary) against a provider's adjusted
 * closes, on dates both have with the day before. Levels are never compared (they drift).
 */
export function adjReturnCheck(
  primary: RawBar[],
  provider: RawBar[],
  source: string,
): CheckResult[] {
  const out: CheckResult[] = [];
  const ours = totalReturnIndex(primary);
  const ourIndex = new Map(primary.map((b, i) => [b.date, i]));
  const theirs = new Map(
    provider
      .filter((b) => b.providerAdjClose !== undefined)
      .map((b) => [b.date, b.providerAdjClose!]),
  );
  for (let i = 1; i < primary.length; i++) {
    const date = primary[i]!.date;
    const prevDate = primary[i - 1]!.date;
    const t = theirs.get(date);
    const tp = theirs.get(prevDate);
    if (t === undefined || tp === undefined || ourIndex.get(prevDate) !== i - 1) continue;
    const our = ours[i]! / ours[i - 1]! - 1;
    const their = t / tp - 1;
    const dev = Math.abs(our - their);
    out.push({
      layer: 'B',
      check: 'adj_return_match',
      source,
      date,
      status: statusB(dev, TOLERANCE.adjReturn),
      observed: their,
      expected: our,
      tolerance: TOLERANCE.adjReturn,
    });
  }
  return out;
}

/**
 * Layer C: a leveraged fund's daily total return against `leverage` times its underlying's
 * price return (the fund tracks the index, whose level excludes dividends). A deviation beyond
 * tolerance three days in a row is red.
 */
export function leverageCheck(
  fund: RawBar[],
  underlying: RawBar[],
  leverage: number,
): CheckResult[] {
  const out: CheckResult[] = [];
  const u = new Map(underlying.map((b, i) => [b.date, i]));
  let streak = 0;
  for (let i = 1; i < fund.length; i++) {
    const date = fund[i]!.date;
    const j = u.get(date);
    if (j === undefined || j === 0 || underlying[j - 1]!.date !== fund[i - 1]!.date) continue;
    const expected = leverage * priceReturn(underlying[j - 1]!, underlying[j]!);
    const observed = totalReturn(fund[i - 1]!, fund[i]!);
    const tol = TOLERANCE.leverageBase + TOLERANCE.leverageShare * Math.abs(expected);
    const dev = Math.abs(observed - expected);
    streak = dev > tol ? streak + 1 : 0;
    out.push({
      layer: 'C',
      check: 'leverage_track',
      date,
      status: streak >= 3 ? 'red' : statusC(dev, tol),
      observed,
      expected,
      tolerance: tol,
      ...(streak >= 3 && { message: `outside tolerance ${streak} days in a row` }),
    });
  }
  return out;
}

/** Layer C: a fund's price return against its index's return, on dates both have. */
export function indexCheck(
  fund: RawBar[],
  index: { date: TradingDate; value: number }[],
): CheckResult[] {
  const out: CheckResult[] = [];
  const level = new Map(index.map((p) => [p.date, p.value]));
  for (let i = 1; i < fund.length; i++) {
    const a = level.get(fund[i - 1]!.date);
    const b = level.get(fund[i]!.date);
    if (a === undefined || b === undefined) continue;
    const expected = b / a - 1;
    const observed = priceReturn(fund[i - 1]!, fund[i]!);
    out.push({
      layer: 'C',
      check: 'index_match',
      date: fund[i]!.date,
      status: statusC(Math.abs(observed - expected), TOLERANCE.index),
      observed,
      expected,
      tolerance: TOLERANCE.index,
    });
  }
  return out;
}

/** Layer B for FX: primary rate against a secondary's, on dates both have. */
export function fxCheck(
  primary: { date: TradingDate; rate: number }[],
  secondary: { date: TradingDate; rate: number }[],
  source: string,
): CheckResult[] {
  const other = new Map(secondary.map((r) => [r.date, r.rate]));
  return primary.flatMap((p) => {
    const s = other.get(p.date);
    if (s === undefined) return [];
    const dev = Math.abs(s / p.rate - 1);
    return [
      {
        layer: 'B' as const,
        check: 'fx_match',
        source,
        date: p.date,
        status: statusB(dev, TOLERANCE.fx),
        observed: s,
        expected: p.rate,
        tolerance: TOLERANCE.fx,
      },
    ];
  });
}
