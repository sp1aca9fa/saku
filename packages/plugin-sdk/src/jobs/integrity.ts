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
  zonedInstant,
} from '@saku/core';
import type { CheckResult } from '@saku/data';
import { type Db, allVersions, seriesPointInTime } from '@saku/db';
import { type RefStrategy, refBacktest, refEvaluate } from '@saku/reference';
import { cashSeries } from './cash';
import { reader, signalsDiffer } from './forward';

export const INTEGRITY_TOLERANCE = 1e-9;
/** Sampled days for incremental vs full: the latest sessions, then one a year back to the start. */
const RECENT = 20;
const EVERY = 250;

const relative = (a: number, b: number) =>
  Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);

export async function integrity(db: Db, o: { to: TradingDate }): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { loadRows, barsOf } = await reader(db);
  const source = await cashSeries(db);
  const cash = source ? await seriesPointInTime(db, source.series, source.source) : null;
  const cashRate = (date: TradingDate) =>
    cash?.asOf(date, zonedInstant(date, '09:30', 'America/New_York'))?.value;

  for (const version of await allVersions(db)) {
    const strategy = Strategy.parse(JSON.parse(version.canonicalJson).strategy);
    const bars = barsOf(await loadRows(dependencies(strategy), o.to));
    const result = (check: string, problems: string[], deviation = 0): CheckResult => ({
      layer: 'E',
      check,
      date: o.to,
      status: problems.length ? 'red' : 'green',
      deviation,
      tolerance: INTEGRITY_TOLERANCE,
      message: `${version.name} (${version.id})${problems.length ? `: ${problems.slice(0, 3).join('; ')}` : ''}`,
    });
    let core: StrategyDay[];
    let equity: number[];
    try {
      core = evaluate(strategy, bars);
      equity = backtest({ strategy, days: core, bars, cashRate }).points.map((p) => p.equity);
    } catch (e) {
      out.push(result('core_vs_reference', [`core could not evaluate: ${String(e)}`]));
      continue;
    }
    out.push(compareReference(strategy, core, equity, bars, cashRate, result));
    out.push(compareIncremental(strategy, core, equity, bars, cashRate, result));
  }
  return out;
}

type Result = (check: string, problems: string[], deviation?: number) => CheckResult;
type Bars = Parameters<typeof evaluate>[1];

function compareReference(
  strategy: Strategy,
  core: StrategyDay[],
  equity: number[],
  bars: Bars,
  cashRate: (date: TradingDate) => number | undefined,
  result: Result,
): CheckResult {
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
      const b = refBacktest(s, ref, bars, (d) => cashRate(d) ?? Number.NaN).equity;
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
): CheckResult {
  const problems: string[] = [];
  let worst = 0;
  const sample = new Set<number>();
  for (let i = core.length - 1; i >= 0 && i >= core.length - RECENT; i--) sample.add(i);
  for (let i = core.length - 1 - RECENT; i >= 0; i -= EVERY) sample.add(i);
  for (const i of [...sample].sort((a, b) => a - b)) {
    const date = core[i]!.date;
    const upTo = Object.fromEntries(
      Object.entries(bars).map(([t, list]) => [t, list.filter((b) => b.date <= date)]),
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
