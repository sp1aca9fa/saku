// Layer E on stored data (requirements 04, 13; `pnpm verify` and the weekly run). For every
// registered version, over today's canonical bars of what it reads:
// - core vs reference: the same days, signals and allocations; equity within 1e-9 relative;
// - incremental vs full: sampled days decided and valued from the bars up to that day only (as
//   the daily run does) equal the full-history pass on those days (no look-ahead, no state that
//   depends on later data).
// A difference is a calculation fault: red, never tuned away.
import {
  type StrategyDay,
  type TradingDate,
  Strategy,
  backtest,
  dependencies,
  evaluate,
} from '@saku/core';
import type { CheckResult } from '@saku/data';
import { type Db, allVersions } from '@saku/db';
import { type RefStrategy, refBacktest, refEvaluate } from '@saku/reference';
import { cashRateReader } from './cash';
import { reader, signalsDiffer } from './forward';

export const INTEGRITY_TOLERANCE = 1e-9;
/** Sampled days for incremental vs full: the latest sessions, then one a year back to the start. */
const RECENT = 20;
const EVERY = 250;

const relative = (a: number, b: number) =>
  Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);

export const INTEGRITY_CHECKS = ['core_vs_reference', 'incremental_vs_full'] as const;

/** A layer E result, for one registered version. */
export type IntegrityResult = CheckResult & { versionId: string };

export async function integrity(db: Db, o: { to: TradingDate }): Promise<IntegrityResult[]> {
  const out: IntegrityResult[] = [];
  const { loadRows, barsOf } = await reader(db);
  const cashRate = await cashRateReader(db);

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
    let equity: number[];
    try {
      strategy = Strategy.parse(JSON.parse(version.canonicalJson).strategy);
      bars = barsOf(await loadRows(dependencies(strategy), o.to));
      core = evaluate(strategy, bars);
      equity = backtest({ strategy, days: core, bars, cashRate }).points.map((p) => p.equity);
    } catch (e) {
      // Neither check can run: both are red, and the other versions are still checked.
      for (const check of INTEGRITY_CHECKS) {
        out.push(result(check, [`core could not evaluate: ${String(e)}`]));
      }
      continue;
    }
    out.push(compareReference(strategy, core, equity, bars, cashRate, result));
    out.push(compareIncremental(strategy, core, equity, bars, cashRate, result));
  }
  return out;
}

type Result = (check: string, problems: string[], deviation?: number) => IntegrityResult;
type Bars = Parameters<typeof evaluate>[1];

function compareReference(
  strategy: Strategy,
  core: StrategyDay[],
  equity: number[],
  bars: Bars,
  cashRate: (date: TradingDate) => number | undefined,
  result: Result,
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
      // Core succeeded, so no day it valued needed an unknown rate; the reference reads the rate
      // on every day (times a zero weight where unused), so an unknown one is passed as 0 there.
      const b = refBacktest(s, ref, bars, (d) => cashRate(d) ?? 0).equity;
      equity.forEach((e, i) => {
        const dev = relative(e, b[i]!);
        if (!(dev <= INTEGRITY_TOLERANCE))
          problems.push(`${core[i]!.date}: equity ${e} vs ${b[i]}`);
        if (dev > worst) worst = dev;
      });
    }
  } catch (e) {
    problems.push(`reference could not evaluate: ${String(e)}`);
  }
  return result('core_vs_reference', problems, worst);
}

function compareIncremental(
  strategy: Strategy,
  core: StrategyDay[],
  equity: number[],
  bars: Bars,
  cashRate: (date: TradingDate) => number | undefined,
  result: Result,
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
      const e = backtest({ strategy, days, bars: upTo, cashRate }).points.at(-1)!.equity;
      const dev = relative(e, equity[i]!);
      if (!(dev <= INTEGRITY_TOLERANCE)) problems.push(`${date}: equity ${e} vs ${equity[i]}`);
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
