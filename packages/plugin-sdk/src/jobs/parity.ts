// testfol parity (requirements 13 "testfol parity", 05 execution; `pnpm verify` and the weekly
// run): Saku's backtest of each exported case on the stored canonical bars, compared with the
// summary stats testfol reported. External golden values catch a misread rule that core and the
// reference would share. A case outside a tolerance is red until the cause is found and
// documented in `docs/parity.md`; tolerances are never widened to make a case pass.
//
// A case is a folder `<dir>/<case>/` (the private `plugins/test/testfol/`) holding `case.json`:
//   { "strategy": <strategy JSON, execution same_close>, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD",
//     "stats": { "cagr": <fraction>, "maxDrawdown": <negative fraction>, "switches": <integer> } }
// `from` is the first day of testfol's results and must be Saku's first decision day (the warm-up
// covered); `to` is the last (a trading day with stored bars). All three stats are required:
// requirements 13 sets a tolerance for each, so a case without one would overstate parity.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type StrategyDay,
  type TradingDate,
  Strategy,
  backtest,
  dependencies,
  evaluate,
  isTradingDate,
  parseTicker,
  summary,
} from '@saku/core';
import type { CheckResult, Sessions } from '@saku/data';
import type { Db } from '@saku/db';
import { cashRateReader } from './cash';
import { reader } from './forward';

export const PARITY_CHECK = 'testfol_parity';

/**
 * Requirements 13: CAGR +/- 0.3 percentage points and max drawdown +/- 1.0 percentage points
 * (absolute, on fractions), switches +/- 5% of testfol's count. 5% of a small count is under one
 * switch, so the switch tolerance is at least 1 (spec "Assumed").
 */
export const PARITY_TOLERANCE = {
  cagr: 0.003,
  maxDrawdown: 0.01,
  switchesRelative: 0.05,
  switchesMin: 1,
} as const;

/** Requirements 13: SPY's real history, so cases start on or after 1993-02-01. */
export const EARLIEST_START = '1993-02-01';

/** testfol names its simulated (backfilled) histories `<TICKER>SIM`; those are not real data. */
const SIMULATED = /SIM$/i;

export interface ParityStats {
  cagr: number;
  maxDrawdown: number;
  /** Trades after the first entry (Saku: any change of the held holdings). */
  switches: number;
}

export interface ParityCase {
  strategy: Strategy;
  from: TradingDate;
  to: TradingDate;
  stats: ParityStats;
}

/** A layer E result, for one case. */
export type ParityResult = CheckResult & { caseName: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a parsed `case.json`: the case, or every reason it is refused. */
export function parseCase(raw: unknown): { case: ParityCase } | { errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { errors: ['case.json must be a JSON object'] };
  const unknownKeys = (o: Record<string, unknown>, allowed: string[], where: string) => {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
    }
  };
  unknownKeys(raw, ['strategy', 'from', 'to', 'stats'], 'case');

  let strategy: Strategy | undefined;
  const parsed = Strategy.safeParse(raw.strategy);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      errors.push(`strategy.${i.path.join('.')}: ${i.message}`.replace(/\.:/, ':'));
    }
  } else {
    strategy = parsed.data;
    // Requirements 05/13: parity uses testfol's timing; an omitted execution means next_open.
    if (strategy.execution !== 'same_close') {
      errors.push(
        `strategy.execution: must be "same_close" (testfol's timing), not "${strategy.execution}"`,
      );
    }
    for (const t of dependencies(strategy)) {
      if (SIMULATED.test(parseTicker(t).base)) {
        errors.push(`strategy: ${t} is a simulated history; use the real ticker (SPY, not SPYSIM)`);
      }
    }
  }

  const date = (key: 'from' | 'to') => {
    const v = raw[key];
    if (typeof v !== 'string' || !isTradingDate(v)) {
      errors.push(`${key}: must be a date written YYYY-MM-DD`);
      return undefined;
    }
    return v;
  };
  const from = date('from');
  const to = date('to');
  if (from && from < EARLIEST_START) {
    errors.push(`from: ${from} is before ${EARLIEST_START} (SPY's real history)`);
  }
  if (from && to && from >= to) errors.push(`to: ${to} must be after from (${from})`);

  let stats: ParityStats | undefined;
  if (!isObject(raw.stats)) errors.push('stats: must be an object');
  else {
    const s = raw.stats;
    unknownKeys(s, ['cagr', 'maxDrawdown', 'switches'], 'stats');
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!finite(s.cagr) || s.cagr <= -1) {
      errors.push('stats.cagr: must be a fraction above -1 (0.153 for 15.3%)');
    }
    if (!finite(s.maxDrawdown) || s.maxDrawdown > 0 || s.maxDrawdown < -1) {
      errors.push('stats.maxDrawdown: must be a negative fraction (-0.35 for a 35% drawdown)');
    }
    if (!(Number.isInteger(s.switches) && Number(s.switches) >= 0)) {
      errors.push(
        "stats.switches: required, a whole number (testfol's switch count; requirements 13 compares it)",
      );
    }
    stats = {
      cagr: s.cagr as number,
      maxDrawdown: s.maxDrawdown as number,
      switches: s.switches as number,
    };
  }
  if (errors.length > 0 || !strategy || !from || !to || !stats) return { errors };
  return { case: { strategy, from, to, stats } };
}

export interface StatComparison {
  stat: 'cagr' | 'maxDrawdown' | 'switches';
  ours: number;
  theirs: number;
  difference: number;
  tolerance: number;
  within: boolean;
}

/** Each stat against the tolerances; a NaN value of ours is never within. */
export function compareStats(
  ours: { cagr: number; maxDrawdown: number; switches: number },
  theirs: ParityStats,
): StatComparison[] {
  const one = (
    stat: StatComparison['stat'],
    a: number,
    b: number,
    tolerance: (b: number) => number,
  ): StatComparison => {
    const difference = a - b;
    const tol = tolerance(b);
    return {
      stat,
      ours: a,
      theirs: b,
      difference,
      tolerance: tol,
      within: Math.abs(difference) <= tol,
    };
  };
  return [
    one('cagr', ours.cagr, theirs.cagr, () => PARITY_TOLERANCE.cagr),
    one('maxDrawdown', ours.maxDrawdown, theirs.maxDrawdown, () => PARITY_TOLERANCE.maxDrawdown),
    one('switches', ours.switches, theirs.switches, (b) =>
      Math.max(PARITY_TOLERANCE.switchesMin, PARITY_TOLERANCE.switchesRelative * b),
    ),
  ];
}

const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
const pp = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)}pp`;

function statLine(c: StatComparison): string {
  const label = { cagr: 'CAGR', maxDrawdown: 'max drawdown', switches: 'switches' }[c.stat];
  const verdict = c.within ? 'ok' : 'OUTSIDE';
  if (c.stat === 'switches') {
    const d = c.difference;
    return `${label} ours ${c.ours}, testfol ${c.theirs}, ${d >= 0 ? '+' : ''}${d} (+/-${c.tolerance.toFixed(1)}): ${verdict}`;
  }
  return `${label} ours ${pct(c.ours)}, testfol ${pct(c.theirs)}, ${pp(c.difference)} (+/-${(100 * c.tolerance).toFixed(1)}pp): ${verdict}`;
}

/** The case folders under `dir`, by name; none when the folder does not exist. */
export function caseFolders(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** A dependency's days in the window that are not green, by their latest grade. */
interface WindowHealth {
  ticker: string;
  /** Red, never graded, or a session without a stored bar: the case is refused. */
  bad: TradingDate[];
  yellow: TradingDate[];
}

/**
 * Every case in `dir` on the stored data, one result each (none without cases). Decisions come
 * from the whole stored history up to `to` (indicators and bands warm up on earlier data); the
 * equity curve runs from `from`, which must be the first decision day, to `to`.
 *
 * Data health in the window (requirements 04: never a confident number on doubtful data): each
 * dependency's canonical bar carries its latest grade (set by every verify run). A red or
 * ungraded bar, or a session of `sessions` without a stored bar, refuses the case; yellow days
 * are computed and counted in the message, the status still follows the tolerances.
 */
export async function parity(
  db: Db,
  o: { dir: string | undefined; to: TradingDate; sessions: Sessions },
): Promise<ParityResult[]> {
  const names = caseFolders(o.dir);
  if (names.length === 0) return [];
  const { loadRows, barsOf } = await reader(db);
  const cashRate = await cashRateReader(db);
  const out: ParityResult[] = [];

  for (const name of names) {
    // Deviation: the worst |difference| / tolerance over the stats (1 = at the edge).
    const result = (
      status: 'green' | 'red',
      message: string,
      deviation?: number,
    ): ParityResult => ({
      caseName: name,
      layer: 'E',
      check: PARITY_CHECK,
      date: o.to,
      status,
      ...(deviation !== undefined && { deviation }),
      tolerance: 1,
      message: `${name}: ${message}`,
    });
    const refuse = (why: string) => out.push(result('red', `cannot run: ${why}`));

    const file = join(o.dir!, name, 'case.json');
    if (!existsSync(file)) {
      refuse('no case.json in the folder');
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      refuse(`case.json is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const parsed = parseCase(raw);
    if ('errors' in parsed) {
      refuse(`invalid case: ${parsed.errors.join('; ')}`);
      continue;
    }
    const c = parsed.case;

    try {
      const deps = dependencies(c.strategy);
      const rows = await loadRows(deps, c.to);
      // The stored history must cover the case: a later first bar would compare other years.
      const gaps: string[] = [];
      for (const t of deps) {
        const first = rows[t]?.[0]?.date;
        if (!first) gaps.push(`no stored bars for ${t}`);
        else if (first > c.from) gaps.push(`stored ${t} starts ${first}, after from (${c.from})`);
      }
      if (gaps.length > 0) {
        refuse(gaps.join('; '));
        continue;
      }

      const sessions = o.sessions.between(c.from, c.to);
      const health: WindowHealth[] = deps.map((t) => {
        const byDate = new Map(rows[t]!.map((r) => [r.date, r.status]));
        const h: WindowHealth = { ticker: t, bad: [], yellow: [] };
        for (const d of sessions) {
          const status = byDate.get(d);
          if (status === 'yellow') h.yellow.push(d);
          else if (status !== 'green') h.bad.push(d);
        }
        return h;
      });
      const bad = health.filter((h) => h.bad.length > 0);
      if (bad.length > 0) {
        refuse(
          bad
            .map(
              (h) =>
                `${h.ticker} has ${h.bad.length} red, ungraded or missing days from ${c.from} to ${c.to} (first ${h.bad[0]})`,
            )
            .join('; '),
        );
        continue;
      }

      const bars = barsOf(rows);
      const days: StrategyDay[] = evaluate(c.strategy, bars).filter((d) => d.date >= c.from);
      const start = days[0]?.date;
      const end = days.at(-1)?.date;
      if (!start || days.length < 2) {
        refuse(`fewer than two decision days from ${c.from} to ${c.to}`);
        continue;
      }
      if (start !== c.from) {
        refuse(`first decision ${start} is after from ${c.from}; warm-up not covered`);
        continue;
      }
      if (end !== c.to) {
        refuse(`no decision on ${c.to} (the last is ${end}); to must be a stored trading day`);
        continue;
      }
      const run = backtest({ strategy: c.strategy, days, bars, cashRate });
      const s = summary(run.points);
      const stats = compareStats({ ...s, switches: run.switches }, c.stats);
      const red = stats.some((x) => !x.within);
      const deviation = Math.max(...stats.map((x) => Math.abs(x.difference) / x.tolerance));
      const yellow = health.filter((h) => h.yellow.length > 0);
      const notes = yellow.length
        ? `; yellow days: ${yellow.map((h) => `${h.ticker} ${h.yellow.length} (first ${h.yellow[0]})`).join(', ')}`
        : '';
      out.push(
        result(
          red ? 'red' : 'green',
          `${start} to ${end}: ${stats.map(statLine).join('; ')}${notes}`,
          // NaN (an unknown value of ours) is stored as unknown, never as a small deviation.
          Number.isFinite(deviation) ? deviation : undefined,
        ),
      );
    } catch (e) {
      refuse(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
