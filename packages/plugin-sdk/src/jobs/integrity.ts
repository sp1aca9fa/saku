// Layer E on stored data (requirements 04, 13; `pnpm verify` and the weekly run). For every
// registered version, over today's canonical bars of what it reads:
// - core vs reference: the same days, signals and allocations; the same sessions (a session
//   without a decision included, docs/indicators.md "Days without a decision") and equity on each
//   within 1e-9 relative, matched by date;
// - incremental vs full: sampled days decided and valued from the bars up to that day only (as
//   the daily run does) equal the full-history pass on those days (no look-ahead, no state that
//   depends on later data).
// A difference is a calculation fault: red, never tuned away.
import {
  type StrategyDay,
  type TradingDate,
  Strategy,
  StoredStrategy,
  backtest,
  evaluate,
  strategyTickers,
} from '@saku/core';
import type { CheckResult, Sessions } from '@saku/data';
import { type Db, allVersions } from '@saku/db';
import { type RefStrategy, refBacktest, refEvaluate } from '@saku/reference';
import { type BaseCurrencyInputs, baseCurrencyInputs } from './base-currency';
import { cashRateReader } from './cash';
import { cashBaseInputs, reader, signalsDiffer } from './forward';

export const INTEGRITY_TOLERANCE = 1e-9;
/** Sampled days for incremental vs full: the latest sessions, then one a year back to the start. */
const RECENT = 20;
const EVERY = 250;

const relative = (a: number, b: number) =>
  Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);

export const INTEGRITY_CHECKS = ['core_vs_reference', 'incremental_vs_full'] as const;

/** A layer E result, for one registered version. */
export type IntegrityResult = CheckResult & { versionId: string };

export async function integrity(
  db: Db,
  o: { to: TradingDate; sessions: Sessions },
): Promise<IntegrityResult[]> {
  const out: IntegrityResult[] = [];
  const { loadRows, barsOf } = await reader(db, o.sessions);
  const cashRate = await cashRateReader(db);
  // The deposit rate point in time, as the forward record reads it.
  const baseInputs = await baseCurrencyInputs(db, { pointInTime: true });

  for (const version of await allVersions(db)) {
    const result = (check: string, problems: string[], deviation = 0): IntegrityResult => ({
      versionId: version.id,
      layer: 'E',
      check,
      date: o.to,
      status: problems.length ? 'red' : 'green',
      deviation,
      tolerance: INTEGRITY_TOLERANCE,
      message: `${version.name} (${version.id})${problems.length ? `: ${problems.slice(0, 3).join('; ')}` : ''}`,
    });
    let strategy: Strategy;
    let bars: Bars;
    let core: StrategyDay[];
    /** Core's equity per session, by date. */
    let equity: Map<TradingDate, number>;
    // Only a version registered before C2's cost freeze reads an omitted cost as 0 (as when it
    // was recorded); for any other an omitted cost fails (docs/indicators.md "Costs").
    const omittedCostsAsZero = !version.costsResolved;
    let base: BaseCurrencyInputs = {};
    try {
      // Read as registered (`StoredStrategy`, as forward.ts `parseVersion`).
      strategy = StoredStrategy.parse(JSON.parse(version.canonicalJson).strategy);
      // Every ticker it may hold, the safe state's included (backtest sessions).
      bars = barsOf(await loadRows(strategyTickers(strategy), o.to));
      core = evaluate(strategy, bars);
      // The base currency, FX and deposit rate as the forward record reads them (CASH_BASE only).
      base = cashBaseInputs(strategy, baseInputs);
      equity = new Map(
        backtest({ strategy, days: core, bars, cashRate, omittedCostsAsZero, ...base }).points.map(
          (p) => [p.date, p.equity],
        ),
      );
    } catch (e) {
      // Neither check can run: both are red, and the other versions are still checked.
      for (const check of INTEGRITY_CHECKS) {
        out.push(result(check, [`core could not evaluate: ${String(e)}`]));
      }
      continue;
    }
    out.push(
      compareReference(strategy, core, equity, bars, cashRate, omittedCostsAsZero, result, base),
    );
    out.push(
      compareIncremental(strategy, core, equity, bars, cashRate, omittedCostsAsZero, result, base),
    );
  }
  return out;
}

type Result = (check: string, problems: string[], deviation?: number) => IntegrityResult;
type Bars = Parameters<typeof evaluate>[1];

function compareReference(
  strategy: Strategy,
  core: StrategyDay[],
  equity: Map<TradingDate, number>,
  bars: Bars,
  cashRate: (date: TradingDate) => number | undefined,
  omittedCostsAsZero: boolean,
  result: Result,
  base: BaseCurrencyInputs,
): IntegrityResult {
  const problems: string[] = [];
  let worst = 0;
  try {
    const s = strategy as unknown as RefStrategy;
    const ref = refEvaluate(s, bars);
    if (ref.length !== core.length || ref.some((d, i) => d.date !== core[i]!.date)) {
      problems.push(`days differ (core ${core.length}, reference ${ref.length})`);
    } else {
      core.forEach((d, i) => {
        const r = ref[i]!;
        if (d.allocation !== r.allocation) {
          problems.push(`${d.date}: allocation ${d.allocation} vs ${r.allocation}`);
        }
        const signals = signalsDiffer(d.signals, r.signals);
        if (signals.length) problems.push(`${d.date}: signals ${signals.join(', ')}`);
      });
      // The same base currency, FX and deposit rate as core (a version that may hold CASH_BASE;
      // none otherwise), read only where CASH_BASE is held.
      // Core succeeded, so no day it valued needed an unknown rate; the reference reads the rate
      // on every day (times a zero weight where unused), so an unknown one is passed as 0 there.
      // Matched by date: both value every session, those without a decision included.
      const b = refBacktest(s, ref, bars, (d) => cashRate(d) ?? 0, { omittedCostsAsZero, ...base });
      const theirs = new Map(b.dates.map((d, i) => [d, b.equity[i]!]));
      const ours = [...equity.keys()];
      if (ours.length !== b.dates.length || ours.some((d) => !theirs.has(d))) {
        problems.push(`sessions differ (core ${ours.length}, reference ${b.dates.length})`);
      } else {
        for (const [date, e] of equity) {
          const r = theirs.get(date)!;
          const dev = relative(e, r);
          if (!(dev <= INTEGRITY_TOLERANCE)) problems.push(`${date}: equity ${e} vs ${r}`);
          if (dev > worst) worst = dev;
        }
      }
    }
  } catch (e) {
    problems.push(`reference could not evaluate: ${String(e)}`);
  }
  return result('core_vs_reference', problems, worst);
}

function compareIncremental(
  strategy: Strategy,
  core: StrategyDay[],
  equity: Map<TradingDate, number>,
  bars: Bars,
  cashRate: (date: TradingDate) => number | undefined,
  omittedCostsAsZero: boolean,
  result: Result,
  base: BaseCurrencyInputs,
): IntegrityResult {
  const problems: string[] = [];
  let worst = 0;
  const sample = new Set<number>();
  for (let i = core.length - 1; i >= 0 && i >= core.length - RECENT; i--) sample.add(i);
  for (let i = core.length - 1 - RECENT; i >= 0; i -= EVERY) sample.add(i);
  for (const i of [...sample].sort((a, b) => a - b)) {
    const date = core[i]!.date;
    const upTo = Object.fromEntries(
      Object.entries(bars).map(([t, list]) => [t, list.slice(0, upperBound(list, date))]),
    );
    try {
      const days = evaluate(strategy, upTo);
      const last = days.at(-1);
      if (last?.date !== date) {
        problems.push(`${date}: no decision from the bars up to that day`);
        continue;
      }
      if (last.allocation !== core[i]!.allocation) {
        problems.push(`${date}: allocation ${last.allocation} vs ${core[i]!.allocation}`);
      }
      const signals = signalsDiffer(last.signals, core[i]!.signals);
      if (signals.length) problems.push(`${date}: signals ${signals.join(', ')}`);
      const point = backtest({
        strategy,
        days,
        bars: upTo,
        cashRate,
        omittedCostsAsZero,
        ...base,
      }).points.at(-1)!;
      const full = equity.get(date);
      if (point.date !== date || full === undefined) {
        problems.push(`${date}: no equity on that day (${point.date})`);
        continue;
      }
      const e = point.equity;
      const dev = relative(e, full);
      if (!(dev <= INTEGRITY_TOLERANCE)) problems.push(`${date}: equity ${e} vs ${full}`);
      if (dev > worst) worst = dev;
    } catch (e) {
      problems.push(`${date}: ${String(e)}`);
    }
  }
  return result('incremental_vs_full', problems, worst);
}

/** The number of bars dated on or before `date` (bars are sorted by date). */
function upperBound(list: { date: TradingDate }[], date: TradingDate): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.date <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
