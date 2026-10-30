// testfol parity on synthetic cases in a temporary folder, over synthetic stored bars.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import { type Db, addChannel, createUser, schema, setSetting, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { and, between, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emptyPlugins } from '../registry';
import type { BarSource } from '../types';
import { PARITY_TOLERANCE, compareStats, parity, parseCase } from './parity';
import { type RunOptions, runJob } from './run';
import { cashRates, fakeNotifier, quiet, testInfo } from './testkit';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2024-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const TARGET = '2026-01-16';
const DATES = sessions.between('2024-06-03', TARGET);
const FROM = '2024-07-01';
/** The warm-up that makes FROM the first decision day: an SMA over the bars up to it. */
const WARM_UP = DATES.indexOf(FROM) + 1;

/** Growth with waves (so there are drawdowns); no dividends or splits. */
const closes = DATES.map((_, i) => 100 * 1.0005 ** i * (1 + 0.05 * Math.sin(i / 10)));
/** Both sources send every date, or none for `skip` (a session without a stored bar). */
const source = (key: string, skip?: string): BarSource => ({
  info: testInfo(key, 'bar'),
  async fetchBars(_ticker, from, to) {
    return DATES.flatMap((date, i): RawBar[] =>
      date >= from && date <= to && date !== skip
        ? [
            {
              date,
              open: closes[i - 1] ?? closes[i]!,
              high: Math.max(closes[i]!, closes[i - 1] ?? 0) * 1.001,
              low: Math.min(closes[i]!, closes[i - 1] ?? Infinity) * 0.999,
              close: closes[i]!,
              closeIsSplitAdjusted: false,
              volume: 1000,
              divCash: 0,
              splitFactor: 1,
            },
          ]
        : [],
    );
  },
});

/**
 * Held in AAA from the first decision (both allocations hold it): the same-close curve is AAA's
 * close relative to the start, so the expected stats follow from the closes alone.
 */
const alwaysIn = (o: { execution?: string; holding?: string; length?: number } = {}) => ({
  name: 'Always in',
  account: 'taxable',
  execution: 'same_close',
  ...(o.execution && { execution: o.execution }),
  safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'A',
      type: 'compare',
      left: { indicator: 'price', ticker: 'AAA' },
      op: '>',
      right: { indicator: 'sma', ticker: 'AAA', length: o.length ?? WARM_UP },
    },
  ],
  allocations: [
    { name: 'Up', when: { all: ['A'] }, holdings: [{ ticker: o.holding ?? 'AAA', weight: 100 }] },
    { name: 'Down', holdings: [{ ticker: o.holding ?? 'AAA', weight: 100 }] },
  ],
});

/** In AAA while its SMA is above a level, else in cash: switches at each crossing. */
const LEVEL = 108;
const switcher = {
  name: 'Switcher',
  account: 'taxable',
  execution: 'same_close',
  safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'A',
      type: 'compare',
      left: { indicator: 'sma', ticker: 'AAA', length: WARM_UP },
      op: '>',
      right: { threshold: LEVEL },
    },
  ],
  allocations: [
    { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
    { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  ],
};

/** The switcher's switches from the closes: changes of (SMA > LEVEL) after the first day. */
function expectedSwitches(): number {
  let prev: boolean | undefined;
  let switches = 0;
  for (let i = DATES.indexOf(FROM); i <= DATES.indexOf(TARGET); i++) {
    const window = closes.slice(i - WARM_UP + 1, i + 1);
    const inAaa = window.reduce((a, b) => a + b, 0) / WARM_UP > LEVEL;
    if (prev !== undefined && inAaa !== prev) switches++;
    prev = inAaa;
  }
  return switches;
}

/** Expected stats from the closes, independent of the engine: from FROM to TARGET. */
function expected() {
  const start = DATES.indexOf(FROM);
  const end = DATES.indexOf(TARGET);
  const years = (Date.parse(TARGET) - Date.parse(FROM)) / (365.25 * 86_400_000);
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (let i = start; i <= end; i++) {
    peak = Math.max(peak, closes[i]!);
    maxDrawdown = Math.min(maxDrawdown, closes[i]! / peak - 1);
  }
  return {
    cagr: (closes[end]! / closes[start]!) ** (1 / years) - 1,
    maxDrawdown,
    switches: 0,
  };
}

const SECRET = 'x'.repeat(32);
const ctx = () => ({ http: null as never, now: new Date('2026-01-17T01:30:00Z'), log: quiet });
const options = (
  job: RunOptions['job'],
  parityDir?: string,
  notifier = fakeNotifier().notifier,
): RunOptions => ({
  job,
  target: TARGET,
  sessions,
  seriesSessions: sessions,
  now: new Date('2026-01-17T01:30:00Z'),
  log: quiet,
  context: ctx,
  alerting: { date: TARGET, notifiers: [notifier], authSecret: SECRET, context: ctx, log: quiet },
  tsa: { authorities: [] },
  code: 'test',
  ...(parityDir && { parityDir }),
});
const plugins = (skip?: string, cash = true) => ({
  ...emptyPlugins(),
  bars: [source('p', skip), source('s', skip)],
  series: cash ? [cashRates(sessions, DATES, TARGET)] : [],
});

/**
 * A database with AAA's bars (two agreeing sources) and the cash rate (none: no series source
 * declares one), graded by a bootstrap.
 */
async function seeded(skip?: string, cash = true): Promise<Db> {
  const db = await testDb();
  await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  await runJob(db, plugins(skip, cash), options('bootstrap'));
  return db;
}

let db: Db;
beforeAll(async () => {
  db = await seeded();
  // Every stored bar is graded green: the cases below are not refused for data health.
  const statuses = await db.select({ status: schema.bars.status }).from(schema.bars);
  expect(new Set(statuses.map((r) => r.status))).toEqual(new Set(['green']));
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A temporary cases folder: each entry is a case folder, its case.json (text or object). */
function casesDir(cases: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'saku-parity-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(cases)) {
    mkdirSync(join(dir, name));
    if (content === undefined) continue;
    writeFileSync(
      join(dir, name, 'case.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return dir;
}

const validCase = (stats: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  strategy: alwaysIn(),
  from: FROM,
  to: TARGET,
  stats,
  ...extra,
});
const run = (dir: string | undefined, on: Db = db, seriesSessions = sessions) =>
  parity(on, { dir, to: TARGET, sessions, seriesSessions });
const STATS = { cagr: 0.1, maxDrawdown: -0.2, switches: 4 };
const caseOf = (strategy: unknown) => ({ strategy, from: FROM, to: TARGET, stats: STATS });

describe('parseCase', () => {
  it('accepts a same_close case with synthetic leverage', () => {
    const r = parseCase(validCase(STATS, { strategy: alwaysIn({ holding: 'SPY?L=3&E=0.9' }) }));
    expect('case' in r && r.case.stats).toEqual(STATS);
  });

  it.each([
    [
      'an omitted execution (next_open)',
      { strategy: { ...alwaysIn(), execution: undefined } },
      /same_close/,
    ],
    ['next_close', { strategy: alwaysIn({ execution: 'next_close' }) }, /same_close/],
    ['a start before 1993-02-01', { from: '1993-01-29' }, /before 1993-02-01/],
    ['a simulated history', { strategy: alwaysIn({ holding: 'SPYSIM?L=3' }) }, /SPYSIM.*simulated/],
    ['a date that does not exist', { to: '2026-02-30' }, /to: must be a date/],
    ['to before from', { to: '2024-06-01' }, /must be after from/],
    ['an unknown key', { stat: {} }, /unknown key "stat"/],
  ])('refuses %s', (_, extra, message) => {
    const r = parseCase(validCase(STATS, extra));
    expect('errors' in r && r.errors.join('; ')).toMatch(message);
  });

  it('refuses stats that are missing or not as described', () => {
    for (const [stats, message] of [
      [{ cagr: 0.1, maxDrawdown: 0.35, switches: 4 }, /negative fraction/],
      [{ cagr: 0.1, maxDrawdown: -35, switches: 4 }, /negative fraction/],
      [{ cagr: 'x', maxDrawdown: -0.2, switches: 4 }, /stats.cagr/],
      [{ maxDrawdown: -0.2, switches: 4 }, /stats.cagr/],
      [{ cagr: 0.1, maxDrawdown: -0.2 }, /stats.switches: required/],
      [{ cagr: 0.1, maxDrawdown: -0.2, switches: 2.5 }, /stats.switches/],
      [{ cagr: 0.1, maxDrawdown: -0.2, switches: -1 }, /stats.switches/],
      [{ cagr: 0.1, maxDrawdown: -0.2, switches: 4, switch: 3 }, /unknown key "switch"/],
    ] as const) {
      const r = parseCase(validCase(stats as never));
      expect('errors' in r && r.errors.join('; ')).toMatch(message);
    }
  });
});

describe('compareStats', () => {
  const ours = { cagr: 0.1, maxDrawdown: -0.3, switches: 40 };

  it('compares CAGR and drawdown in absolute points, switches relative with at least one', () => {
    const r = compareStats(ours, { cagr: 0.1025, maxDrawdown: -0.309, switches: 42 });
    expect(r.map((s) => [s.stat, s.within])).toEqual([
      ['cagr', true],
      ['maxDrawdown', true],
      ['switches', true],
    ]);
    expect(r[2]!.tolerance).toBeCloseTo(0.05 * 42, 12);
    const out = compareStats(ours, { cagr: 0.1035, maxDrawdown: -0.311, switches: 43 });
    expect(out.map((s) => s.within)).toEqual([false, false, false]);
    // 5% of 10 is half a switch: one switch off is still within, two is not.
    const ten = (n: number) =>
      compareStats({ ...ours, switches: n }, { ...ours, switches: 10 })[2]!;
    expect(ten(11).within).toBe(true);
    expect(ten(12).tolerance).toBe(PARITY_TOLERANCE.switchesMin);
    expect(ten(12).within).toBe(false);
  });

  it('an unknown value of ours is never within', () => {
    const r = compareStats({ ...ours, cagr: NaN }, { cagr: 0.1, maxDrawdown: -0.3, switches: 40 });
    expect(r[0]!.within).toBe(false);
  });
});

describe('parity on stored bars', () => {
  it('no folder, or an empty one: no results', async () => {
    expect(await run(undefined)).toEqual([]);
    expect(await run(join(tmpdir(), 'saku-parity-none'))).toEqual([]);
    expect(await run(casesDir({}))).toEqual([]);
  });

  it('within tolerance is green, with the window and each stat', async () => {
    const e = expected();
    const dir = casesDir({
      close: validCase({ ...e, cagr: e.cagr + 0.002, maxDrawdown: e.maxDrawdown - 0.009 }),
    });
    const [close] = await run(dir);
    expect(close).toMatchObject({ caseName: 'close', layer: 'E', check: 'testfol_parity' });
    expect(close!.status).toBe('green');
    expect(close!.message).toMatch(
      /^close: same_close \(not achievable\), 2024-07-01 to 2026-01-16: CAGR ours /,
    );
    expect(close!.message).toMatch(/switches ours 0, testfol 0, \+0 \(\+\/-1\.0\): ok$/);
    expect(close!.deviation).toBeCloseTo(0.9, 6);
  });

  it('a stat outside its tolerance is red and the message names each stat', async () => {
    const e = expected();
    const dir = casesDir({ off: validCase({ ...e, cagr: e.cagr - 0.004, switches: 3 }) });
    const [off] = await run(dir);
    expect(off!.status).toBe('red');
    expect(off!.message).toMatch(/^off: /);
    expect(off!.message).toMatch(
      /CAGR ours [\d.]+%, testfol [\d.]+%, \+0\.40pp \(\+\/-0\.3pp\): OUTSIDE/,
    );
    expect(off!.message).toMatch(/max drawdown ours .*: ok/);
    expect(off!.message).toMatch(/switches ours 0, testfol 3, -3 \(\+\/-1\.0\): OUTSIDE/);
    expect(off!.deviation).toBeCloseTo(3, 6);
  });

  it('counts the switches of a strategy that moves between AAA and cash', async () => {
    const n = expectedSwitches();
    expect(n).toBeGreaterThanOrEqual(5);
    const tolerance = Math.max(1, 0.05 * n);
    const stats = (switches: number) => ({ cagr: 0, maxDrawdown: -0.5, switches });
    const at = (switches: number) => ({
      strategy: switcher,
      from: FROM,
      to: TARGET,
      stats: stats(switches),
    });
    const dir = casesDir({
      a_exact: at(n),
      b_edge: at(n + Math.floor(tolerance)),
      c_over: at(n + Math.floor(tolerance) + 1),
      d_under: at(n - Math.floor(tolerance) - 1),
    });
    const switchesOf = (r: { message?: string }) =>
      /switches ours (\d+), testfol (\d+), [^(]+\([^)]+\): (ok|OUTSIDE)/.exec(r.message!)!.slice(1);
    const results = await run(dir);
    expect(results.map(switchesOf)).toEqual([
      [`${n}`, `${n}`, 'ok'],
      [`${n}`, `${n + Math.floor(tolerance)}`, 'ok'],
      [`${n}`, `${n + Math.floor(tolerance) + 1}`, 'OUTSIDE'],
      [`${n}`, `${n - Math.floor(tolerance) - 1}`, 'OUTSIDE'],
    ]);
    // The CAGR and drawdown given here are made up: every case is red for those as well.
    expect(results.every((r) => r.status === 'red')).toBe(true);
  });

  it('a case that cannot run is red and says why; the other cases still run', async () => {
    const e = expected();
    const dir = casesDir({
      a_invalid: validCase(e, { strategy: alwaysIn({ execution: 'next_open' }) }),
      b_empty: undefined,
      c_garbled: '{ "strategy": ',
      d_early: validCase(e, { from: '2024-05-01' }),
      e_unstored: validCase(e, { strategy: alwaysIn({ holding: 'BBB' }) }),
      f_weekend: validCase(e, { to: '2026-01-17' }),
      g_warm_up: validCase(e, { from: DATES[10] }),
      h_fine: validCase(e),
    });
    const results = await run(dir);
    expect(results.map((r) => [r.caseName, r.status])).toEqual([
      ['a_invalid', 'red'],
      ['b_empty', 'red'],
      ['c_garbled', 'red'],
      ['d_early', 'red'],
      ['e_unstored', 'red'],
      ['f_weekend', 'red'],
      ['g_warm_up', 'red'],
      ['h_fine', 'green'],
    ]);
    const message = (name: string) => results.find((r) => r.caseName === name)!.message;
    expect(message('a_invalid')).toMatch(/cannot run: invalid case: .*same_close/);
    expect(message('b_empty')).toMatch(/no case.json/);
    expect(message('c_garbled')).toMatch(/not valid JSON/);
    expect(message('d_early')).toMatch(/stored AAA starts 2024-06-03, after from \(2024-05-01\)/);
    expect(message('e_unstored')).toMatch(/no stored bars for BBB/);
    expect(message('f_weekend')).toMatch(/no decision on 2026-01-17 \(the last is 2026-01-16\)/);
    expect(message('g_warm_up')).toMatch(
      new RegExp(`first decision ${FROM} is after from ${DATES[10]}; warm-up not covered`),
    );
  });

  it('a red, ungraded or missing day from the first stored bar refuses the case; yellow days are counted', async () => {
    const e = expected();
    const dir = casesDir({ c: validCase(e) });
    const setStatus = (date: string, status: 'green' | 'yellow' | 'red' | null) =>
      db.update(schema.bars).set({ status }).where(eq(schema.bars.date, date));
    try {
      await setStatus(DATES[100]!, 'yellow');
      await setStatus(DATES[120]!, 'yellow');
      const [yellow] = await run(dir);
      expect(yellow!.status).toBe('green');
      expect(yellow!.message).toMatch(
        new RegExp(`yellow days \\(warm-up days count\\): AAA 2 \\(first ${DATES[100]}\\)$`),
      );

      await setStatus(DATES[130]!, 'red');
      await setStatus(DATES[140]!, null);
      const [red] = await run(dir);
      expect(red!.status).toBe('red');
      expect(red!.message).toMatch(
        new RegExp(
          `cannot run: AAA has 2 red, ungraded or missing days from its first stored bar \\(warm-up days count\\) to ${TARGET} \\(first ${DATES[130]}\\)`,
        ),
      );
      // A warm-up bar (before from) feeds the indicators and band state: it counts too.
      for (const d of [DATES[100], DATES[120], DATES[130], DATES[140]])
        await setStatus(d!, 'green');
      await setStatus(DATES[3]!, 'red');
      const [warmUp] = await run(dir);
      expect(warmUp!.status).toBe('red');
      expect(warmUp!.message).toMatch(
        new RegExp(`cannot run: AAA has 1 red, .* \\(first ${DATES[3]}\\)`),
      );
      expect(DATES[3]! < FROM).toBe(true);
      await setStatus(DATES[3]!, 'yellow');
      const [warmUpYellow] = await run(dir);
      expect(warmUpYellow!.status).toBe('green');
      expect(warmUpYellow!.message).toMatch(/AAA 1 \(first 2024-06-06\)$/);
    } finally {
      for (const d of [DATES[3], DATES[100], DATES[120], DATES[130], DATES[140]]) {
        await setStatus(d!, 'green');
      }
    }

    // A session the sources did not send: no bar in the window.
    const gap = await seeded(DATES[150]);
    const [missing] = await run(dir, gap);
    expect(missing!.message).toMatch(
      new RegExp(`AAA has 1 red, ungraded or missing days .* \\(first ${DATES[150]}\\)`),
    );
  });

  describe('the cash rate', () => {
    // The fixture publishes each date's rate after the next session's close, so at a session's
    // open (when the backtest reads it) the latest known value is two sessions old: the previous
    // session's not yet published is the normal lag (green).
    const leveraged = (stats = STATS) =>
      validCase(stats, { strategy: alwaysIn({ holding: 'AAA?L=2' }) });
    const fromIndex = DATES.indexOf(FROM);
    /** Deletes the stored cash rates of `n` sessions in a row from DATES[at]. */
    const dropCash = (on: Db, at: number, n: number) =>
      on
        .delete(schema.series)
        .where(
          and(
            eq(schema.series.series, 'CASH'),
            between(schema.series.date, DATES[at]!, DATES[at + n - 1]!),
          ),
        );

    it('is green on the normal publication lag for a case holding cash or leverage', async () => {
      const results = await run(
        casesDir({ a_leveraged: leveraged(), b_switcher: caseOf(switcher) }),
      );
      for (const r of results) {
        expect(r.message).not.toMatch(/cannot run|cash rate/);
      }
    });

    it('a gap of 3 sessions is noted yellow; a gap of 8 refuses the case', async () => {
      const own = await seeded();
      const g = fromIndex + 50;
      await dropCash(own, g, 3);
      const dir = casesDir({ c: leveraged() });
      const [yellow] = await run(dir, own);
      // Read at the open of the session two after each missing one: 2, 3 and 4 business days old.
      expect(yellow!.message).toMatch(
        new RegExp(
          `same_close \\(not achievable\\).*; cash rate 2 to 5 business days old: 3 decision days \\(first ${DATES[g + 2]}\\)$`,
        ),
      );

      await dropCash(own, g + 3, 5);
      const [red] = await run(dir, own);
      expect(red!.status).toBe('red');
      // 2 to 9 business days old from DATES[g + 2]: more than 5 from the fifth missing one on.
      expect(red!.message).toBe(
        `c: cannot run: the cash rate (CASH@rates) is unknown or more than 5 business days old on 4 decision days from ${FROM} to ${TARGET} (first ${DATES[g + 6]}: last value ${DATES[g - 1]}, 6 business days behind)`,
      );
    });

    it('a case without cash or leverage ignores the cash rate entirely', async () => {
      const own = await seeded();
      await own.delete(schema.series).where(eq(schema.series.series, 'CASH'));
      const e = expected();
      const [plain] = await run(casesDir({ plain: validCase(e) }), own);
      expect(plain!.status).toBe('green');
      expect(plain!.message).not.toMatch(/cash/);
      // A cash calendar that does not cover the window does not matter to it either.
      const later = new Sessions({ ...sessions.calendar, validFrom: '2025-01-01' });
      const [still] = await run(casesDir({ plain: validCase(e) }), own, later);
      expect(still!.status).toBe('green');
    });

    it('no stored value refuses a case that needs one (unknown, never 0%)', async () => {
      const own = await seeded();
      await own.delete(schema.series).where(eq(schema.series.series, 'CASH'));
      const [r] = await run(casesDir({ c: leveraged() }), own);
      expect(r!.status).toBe('red');
      expect(r!.message).toMatch(
        new RegExp(`on \\d+ decision days .* \\(first ${FROM}: no value known\\)$`),
      );
    });

    it('no cash source declared refuses a case that needs it', async () => {
      const own = await seeded(undefined, false);
      const dir = casesDir({
        a_leveraged: leveraged(),
        b_switcher: caseOf(switcher),
        c_plain: validCase(expected()),
      });
      const results = await run(dir, own);
      expect(results.map((r) => [r.caseName, r.status])).toEqual([
        ['a_leveraged', 'red'],
        ['b_switcher', 'red'],
        ['c_plain', 'green'],
      ]);
      for (const r of results.slice(0, 2)) {
        expect(r.message).toMatch(
          /cannot run: the strategy holds cash or a leveraged ticker, and no series source declares the USD cash rate$/,
        );
      }
    });

    it('a decision day outside the cash calendar is unknown and refuses the case', async () => {
      const later = new Sessions({ ...sessions.calendar, validFrom: '2025-01-01' });
      const [r] = await run(casesDir({ c: leveraged() }), db, later);
      expect(r!.status).toBe('red');
      expect(r!.message).toMatch(
        new RegExp(
          `\\(first ${FROM}: outside the cash calendar t \\(2025-01-01 to 2026-12-31\\)\\)$`,
        ),
      );
    });
  });

  it('runJob stores every case in full and fails the checks run on a red one', async () => {
    const e = expected();
    const good = validCase(e);
    const green = await runJob(db, plugins(), options('checks', casesDir({ good })));
    expect(green.ok).toBe(true);
    const summaries = await db
      .select()
      .from(schema.checkSummaries)
      .where(eq(schema.checkSummaries.runId, green.runId));
    expect(summaries.find((s) => s.checkName === 'testfol_parity')).toMatchObject({
      checked: 1,
      passed: 1,
    });

    const bad = validCase({ ...e, cagr: e.cagr + 0.01 });
    const red = await runJob(db, plugins(), options('checks', casesDir({ good, bad })));
    expect(red.ok).toBe(false);
    expect(red.error).toMatch(/testfol_parity failed: bad: /);
    const stored = await db
      .select()
      .from(schema.checkResults)
      .where(eq(schema.checkResults.runId, red.runId));
    expect(
      stored
        .filter((r) => r.checkName === 'testfol_parity')
        .map((r) => [r.status, r.message!.split(':')[0]]),
    ).toEqual([
      ['red', 'bad'],
      ['green', 'good'],
    ]);
    expect(stored.find((r) => r.status === 'green')!.message).toMatch(
      /good: same_close \(not achievable\), 2024-07-01 to 2026-01-16: CAGR ours .* testfol .*; max drawdown .*; switches/,
    );

    // No cases folder: no parity results, and the run is not failed for it.
    const none = await runJob(db, plugins(), options('checks'));
    expect(none.ok).toBe(true);
  });

  it('a red case sends one admin alert with subject parity:<case>, labeled not achievable', async () => {
    const own = await seeded();
    const admin = await createUser(own, {
      username: 'alex',
      passwordHash: 'x',
      totpSecretEnc: 'x',
      totpLastStep: 1,
      backupCodeHashes: ['a'],
      isAdmin: true,
    });
    await setSetting(own, 'forward_records_from', '2026-01-02');
    await addChannel(own, admin, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    const e = expected();
    const dir = casesDir({ bad: validCase({ ...e, switches: 9 }) });
    const r = await runJob(own, plugins(), options('checks', dir, notifier));
    expect(r.ok).toBe(false);
    const alerts = await own
      .select()
      .from(schema.alertsSent)
      .where(eq(schema.alertsSent.subject, 'parity:bad'));
    expect(alerts).toHaveLength(1);
    const told = sent.filter((m) => m.text.includes('testfol parity case failed (bad)'));
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('bad: same_close (not achievable), 2024-07-01 to 2026-01-16:');
    expect(told[0]!.text).toContain('not achievable: it trades at a close that is not yet known');
  });
});
