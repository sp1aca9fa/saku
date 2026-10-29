// One forward-record day (requirements 04 fail-closed behavior, 05): the strategy's decision at a
// close, with the data health of everything it depends on. Yellow: the normal decision with its
// reasons. Red: the strategy's declared safe state instead. A stand-in price must not be able to
// flip a signal within its uncertainty band (decision-margin test), else red for this strategy.
import type { HealthStatus, RawBar, TradingDate } from '../domain';
import { CASH_USD, parseTicker } from './backtest';
import { type StrategyDay, evaluate, signalTickers } from './engine';
import type { Holding, Strategy } from './schema';

export const SAFE_STATE = 'Safe state';

/** More stand-ins than this in one day's signals is red (2^n evaluations otherwise). */
export const MAX_MARGIN_TICKERS = 4;

export interface TickerHealth {
  status: HealthStatus;
  reasons: string[];
  /** Set when the day's bar is a secondary's stand-in: its relative price band. */
  standInBand?: number;
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

/** The bars with one ticker's close on `date` scaled by `factor` (what a band could mean). */
function shifted(
  bars: Record<string, RawBar[]>,
  ticker: string,
  date: TradingDate,
  factor: number,
) {
  return {
    ...bars,
    [ticker]: bars[ticker]!.map((b) => (b.date === date ? { ...b, close: b.close * factor } : b)),
  };
}

const sameSignals = (a: StrategyDay, b: StrategyDay) =>
  Object.keys(a.signals).every((k) => a.signals[k] === b.signals[k]);

/**
 * The decision for `date`. `bars` hold every dependency's canonical bars up to `date`; `health`
 * each dependency's status that day (a missing one counts as red).
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
  for (const t of dependencies(strategy)) {
    const h = health[t];
    if (!h) flag('red', `${t}:no_data`);
    else if (h.status !== 'green') for (const r of h.reasons) flag(h.status, `${t}:${r}`);
  }

  let day: StrategyDay | undefined;
  try {
    day = dayOf(strategy, bars, date);
  } catch (e) {
    flag('red', `evaluation:${e instanceof Error ? e.message : String(e)}`);
  }
  if (!day) flag('red', 'no_decision');

  // Decision-margin test over the stand-ins the signals read, all at once: every corner of their
  // bands (each close at its low or high end), since two shifts together can flip what one cannot.
  if (day && status !== 'red') {
    const banded = signalTickers(strategy).flatMap((t) => {
      const band = health[t]?.standInBand;
      return band === undefined ? [] : [{ t, band }];
    });
    const label = `${banded.map((b) => b.t).join('+')}:decision_margin`;
    if (banded.length > MAX_MARGIN_TICKERS) flag('red', label);
    else if (banded.length > 0) {
      for (let corner = 0; corner < 2 ** banded.length; corner++) {
        let moved = bars;
        banded.forEach((b, i) => {
          moved = shifted(moved, b.t, date, corner & (1 << i) ? 1 + b.band : 1 - b.band);
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
