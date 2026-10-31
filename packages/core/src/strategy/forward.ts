// One forward-record day (requirements 04 fail-closed behavior, 05): the strategy's decision at a
// close, with the data health of everything it depends on. Yellow: the normal decision with its
// reasons. Red: the strategy's declared safe state instead. A stand-in price must not be able to
// flip a signal within its uncertainty band (decision-margin test), else red for this strategy.
// What the signals read before the day counts too (04 "Red in the lookback", stand-in rule 6):
// a red or ungraded day of a signal ticker in the re-check window makes the day red, and every
// unresolved stand-in price up to the day is moved by the margin test.
import type { HealthStatus, RawBar, TradingDate } from '../domain';
import { CASH_USD, parseTicker } from './backtest';
import { type StrategyDay, evaluate, signalTickers } from './engine';
import type { Holding, Strategy } from './schema';

export const SAFE_STATE = 'Safe state';

/**
 * More unresolved stand-in prices than this among the bars the signals read (the day's own and
 * earlier ones, counted per ticker and date) is red: the margin test evaluates every corner of
 * their bands, 2^n evaluations.
 */
export const MAX_MARGIN_STAND_INS = 4;

/** An unresolved stand-in price: its date and relative price band (the decision-margin test). */
export interface StandInPrice {
  date: TradingDate;
  band: number;
}

/**
 * A day before the decision's date, inside the re-check window, that keeps a signal ticker red
 * (requirements 04 "Red in the lookback"): graded red, or a session with no grade at all.
 */
export interface LookbackFlag {
  date: TradingDate;
  why: 'red' | 'ungraded';
}

export interface TickerHealth {
  /** The ticker's grade on the decision's date. */
  status: HealthStatus;
  reasons: string[];
  /**
   * The ticker's unresolved stand-in prices dated on or before the decision's date (that day's
   * own included), each with its band (requirements 04 stand-in rule, items 2 and 6). Resolved
   * ones (the primary's bar replaced them) are not listed.
   */
  standIns?: StandInPrice[];
  /** Earlier days in the re-check window graded red or not graded (see `LookbackFlag`). */
  lookback?: LookbackFlag[];
}

export interface ForwardDecision {
  date: TradingDate;
  allocation: string;
  holdings: Holding[];
  safeStateApplied: boolean;
  dataStatus: HealthStatus;
  reasons: string[];
  /** The computed signals (on a red day they are recorded but not acted on). */
  signals: Record<string, boolean | number> | null;
  ties: string[];
}

const rank: Record<HealthStatus, number> = { green: 0, yellow: 1, red: 2 };

/** Tickers whose data the strategy's decision depends on: its signals and what it may hold. */
export function dependencies(strategy: Strategy): string[] {
  const held = strategy.allocations
    .flatMap((a) => a.holdings)
    .map((h) => h.ticker)
    .filter((t) => t !== CASH_USD)
    .map((t) => parseTicker(t).base);
  return [...new Set([...signalTickers(strategy), ...held])].sort();
}

function dayOf(strategy: Strategy, bars: Record<string, RawBar[]>, date: TradingDate) {
  return evaluate(strategy, bars).find((d) => d.date === date);
}

/**
 * The bars with one ticker's close on `date` scaled by `factor` (what a band could mean). A
 * ticker without bars is left as it is: no signal reads a price that is not there.
 */
function shifted(
  bars: Record<string, RawBar[]>,
  ticker: string,
  date: TradingDate,
  factor: number,
) {
  const list = bars[ticker];
  if (!list) return bars;
  return {
    ...bars,
    [ticker]: list.map((b) => (b.date === date ? { ...b, close: b.close * factor } : b)),
  };
}

const sameSignals = (a: StrategyDay, b: StrategyDay) =>
  Object.keys(a.signals).every((k) => a.signals[k] === b.signals[k]);

/**
 * The decision for `date`. `bars` hold every dependency's canonical bars up to `date`; `health`
 * each dependency's status that day (a missing one counts as red).
 *
 * For the tickers the signals read (not those only held, whose past prices no signal reads):
 * - each `lookback` day makes the day red (`T:lookback_red@date`, `T:lookback_ungraded@date`),
 *   requirements 04 "Red in the lookback"; the day's own grade keeps its own reasons;
 * - each unresolved stand-in before the day is named (`T:stand_in_lookback@date`, yellow:
 *   "secondary source only") and moved by the decision-margin test with the day's own.
 */
export function forwardDecision(
  strategy: Strategy,
  date: TradingDate,
  bars: Record<string, RawBar[]>,
  health: Record<string, TickerHealth>,
): ForwardDecision {
  let status = 'green' as HealthStatus;
  const reasons: string[] = [];
  const flag = (s: HealthStatus, reason: string) => {
    if (rank[s] > rank[status]) status = s;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const reads = signalTickers(strategy);
  for (const t of dependencies(strategy)) {
    const h = health[t];
    if (!h) flag('red', `${t}:no_data`);
    else if (h.status !== 'green') for (const r of h.reasons) flag(h.status, `${t}:${r}`);
    if (!h || !reads.includes(t)) continue;
    for (const l of h.lookback ?? []) {
      if (l.date < date) flag('red', `${t}:lookback_${l.why}@${l.date}`);
    }
    for (const s of h.standIns ?? []) {
      if (s.date < date) flag('yellow', `${t}:stand_in_lookback@${s.date}`);
    }
  }

  let day: StrategyDay | undefined;
  try {
    day = dayOf(strategy, bars, date);
  } catch (e) {
    flag('red', `evaluation:${e instanceof Error ? e.message : String(e)}`);
  }
  if (!day) flag('red', 'no_decision');

  // Decision-margin test over every unresolved stand-in price the signals read up to the day (its
  // own and earlier ones), all at once: every corner of their bands (each close at its low or
  // high end), since two shifts together can flip what one cannot.
  if (day && status !== 'red') {
    const banded = reads.flatMap((t) =>
      (health[t]?.standIns ?? []).filter((s) => s.date <= date).map((s) => ({ t, ...s })),
    );
    const label = `${[...new Set(banded.map((b) => b.t))].join('+')}:decision_margin`;
    if (banded.length > MAX_MARGIN_STAND_INS) flag('red', label);
    else if (banded.length > 0) {
      for (let corner = 0; corner < 2 ** banded.length; corner++) {
        let moved = bars;
        banded.forEach((b, i) => {
          moved = shifted(moved, b.t, b.date, corner & (1 << i) ? 1 + b.band : 1 - b.band);
        });
        const other = dayOf(strategy, moved, date);
        if (!other || !sameSignals(day, other)) {
          flag('red', label);
          break;
        }
      }
    }
  }

  if (status === 'red' || !day) {
    return {
      date,
      allocation: SAFE_STATE,
      holdings: strategy.safeState.holdings,
      safeStateApplied: true,
      dataStatus: 'red',
      reasons,
      signals: day?.signals ?? null,
      ties: day?.ties ?? [],
    };
  }
  return {
    date,
    allocation: day.allocation,
    holdings: day.holdings,
    safeStateApplied: false,
    dataStatus: status,
    reasons,
    signals: day.signals,
    ties: day.ties,
  };
}
