// testfol parity on synthetic cases in a temporary folder, over synthetic stored bars.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import { type Db, schema, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { eq } from 'drizzle-orm';
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

/** Growth with waves (so there are drawdowns); no dividends or splits. */
const closes = DATES.map((_, i) => 100 * 1.0005 ** i * (1 + 0.05 * Math.sin(i / 10)));
const source = (key: string): BarSource => ({
  info: testInfo(key, 'bar'),
  async fetchBars(_ticker, from, to) {
    return DATES.flatMap((date, i): RawBar[] =>
      date >= from && date <= to
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
const alwaysIn = (o: { execution?: string; holding?: string } = {}) => ({
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
      right: { indicator: 'sma', ticker: 'AAA', length: 5 },
    },
  ],
  allocations: [
    { name: 'Up', when: { all: ['A'] }, holdings: [{ ticker: o.holding ?? 'AAA', weight: 100 }] },
    { name: 'Down', holdings: [{ ticker: o.holding ?? 'AAA', weight: 100 }] },
  ],
});

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
  return { cagr: (closes[end]! / closes[start]!) ** (1 / years) - 1, maxDrawdown };
}

const ctx = () => ({ http: null as never, now: new Date('2026-01-17T01:30:00Z'), log: quiet });
const options = (job: RunOptions['job'], parityDir?: string): RunOptions => ({
  job,
  target: TARGET,
  sessions,
  seriesSessions: sessions,
  now: new Date('2026-01-17T01:30:00Z'),
  log: quiet,
  context: ctx,
  alerting: {
    date: TARGET,
    notifiers: [fakeNotifier().notifier],
    authSecret: 'x'.repeat(32),
    context: ctx,
    log: quiet,
  },
  tsa: { authorities: [] },
  code: 'test',
  ...(parityDir && { parityDir }),
});
const plugins = () => ({
  ...emptyPlugins(),
  bars: [source('p'), source('s')],
  series: [cashRates(sessions, DATES, TARGET)],
});

let db: Db;
beforeAll(async () => {
  db = await testDb();
  await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  const r = await runJob(db, plugins(), options('bootstrap'));
  expect(r.ok).toBe(true);
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

describe('parseCase', () => {
  it('accepts a same_close case with synthetic leverage and no switches', () => {
    const r = parseCase(
      validCase(
        { cagr: 0.1, maxDrawdown: -0.2 },
        { strategy: alwaysIn({ holding: 'SPY?L=3&E=0.9' }) },
      ),
    );
    expect('case' in r && r.case.stats).toEqual({ cagr: 0.1, maxDrawdown: -0.2 });
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
    const r = parseCase(validCase({ cagr: 0.1, maxDrawdown: -0.2 }, extra));
    expect('errors' in r && r.errors.join('; ')).toMatch(message);
  });

  it('refuses stats that are not fractions as described', () => {
    for (const [stats, message] of [
      [{ cagr: 0.1, maxDrawdown: 0.35 }, /negative fraction/],
      [{ cagr: 0.1, maxDrawdown: -35 }, /negative fraction/],
      [{ cagr: 'x', maxDrawdown: -0.2 }, /stats.cagr/],
      [{ maxDrawdown: -0.2 }, /stats.cagr/],
      [{ cagr: 0.1, maxDrawdown: -0.2, switches: 2.5 }, /stats.switches/],
      [{ cagr: 0.1, maxDrawdown: -0.2, switches: -1 }, /stats.switches/],
      [{ cagr: 0.1, maxDrawdown: -0.2, switch: 3 }, /unknown key "switch"/],
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
    expect(compareStats({ ...ours, switches: 11 }, { ...ours, switches: 10 })[2]!.within).toBe(
      true,
    );
    expect(compareStats({ ...ours, switches: 12 }, { ...ours, switches: 10 })[2]!.tolerance).toBe(
      PARITY_TOLERANCE.switchesMin,
    );
    expect(compareStats({ ...ours, switches: 12 }, { ...ours, switches: 10 })[2]!.within).toBe(
      false,
    );
  });

  it('an unknown value of ours is never within; absent switches are not compared', () => {
    const r = compareStats({ ...ours, cagr: NaN }, { cagr: 0.1, maxDrawdown: -0.3 });
    expect(r[0]!.within).toBe(false);
    expect(r[2]).toEqual({ stat: 'switches', ours: 40 });
  });
});

describe('parity on stored bars', () => {
  it('no folder, or an empty one: no results', async () => {
    expect(await parity(db, { dir: undefined, to: TARGET })).toEqual([]);
    expect(await parity(db, { dir: join(tmpdir(), 'saku-parity-none'), to: TARGET })).toEqual([]);
    expect(await parity(db, { dir: casesDir({}), to: TARGET })).toEqual([]);
  });

  it('within tolerance is green; switches left out are reported as not compared', async () => {
    const e = expected();
    const dir = casesDir({
      close: validCase({ cagr: e.cagr + 0.002, maxDrawdown: e.maxDrawdown - 0.009, switches: 0 }),
      'no-switches': validCase({ cagr: e.cagr, maxDrawdown: e.maxDrawdown }),
    });
    const [close, noSwitches] = await parity(db, { dir, to: TARGET });
    expect(close).toMatchObject({ caseName: 'close', layer: 'E', check: 'testfol_parity' });
    expect(close!.status).toBe('green');
    expect(close!.message).toMatch(
      /^close: same_close \(not achievable\), 2024-07-01 to 2026-01-16:/,
    );
    expect(close!.deviation).toBeCloseTo(0.9, 6);
    expect(noSwitches!.status).toBe('green');
    expect(noSwitches!.message).toMatch(/switches 0 not compared \(not in case.json\)/);
    expect(noSwitches!.deviation).toBeLessThan(1e-9);
  });

  it('a stat outside its tolerance is red and the message names each stat', async () => {
    const e = expected();
    const dir = casesDir({
      off: validCase({ cagr: e.cagr - 0.004, maxDrawdown: e.maxDrawdown, switches: 3 }),
    });
    const [off] = await parity(db, { dir, to: TARGET });
    expect(off!.status).toBe('red');
    expect(off!.message).toMatch(/^off: /);
    expect(off!.message).toMatch(
      /CAGR ours [\d.]+%, testfol [\d.]+%, \+0\.40pp \(\+\/-0\.3pp\): OUTSIDE/,
    );
    expect(off!.message).toMatch(/max drawdown ours .*: ok/);
    expect(off!.message).toMatch(/switches ours 0, testfol 3, -3 \(\+\/-1\.0\): OUTSIDE/);
    expect(off!.deviation).toBeCloseTo(3, 6);
  });

  it('a case that cannot run is red and says why; the other cases still run', async () => {
    const e = expected();
    const ok = { cagr: e.cagr, maxDrawdown: e.maxDrawdown };
    const dir = casesDir({
      a_invalid: validCase(ok, { strategy: alwaysIn({ execution: 'next_open' }) }),
      b_empty: undefined,
      c_garbled: '{ "strategy": ',
      d_early: validCase(ok, { from: '2024-05-01' }),
      e_unstored: validCase(ok, { strategy: alwaysIn({ holding: 'BBB' }) }),
      f_weekend: validCase(ok, { to: '2026-01-17' }),
      g_fine: validCase(ok),
    });
    const results = await parity(db, { dir, to: TARGET });
    expect(results.map((r) => [r.caseName, r.status])).toEqual([
      ['a_invalid', 'red'],
      ['b_empty', 'red'],
      ['c_garbled', 'red'],
      ['d_early', 'red'],
      ['e_unstored', 'red'],
      ['f_weekend', 'red'],
      ['g_fine', 'green'],
    ]);
    const message = (name: string) => results.find((r) => r.caseName === name)!.message;
    expect(message('a_invalid')).toMatch(/cannot run: invalid case: .*same_close/);
    expect(message('b_empty')).toMatch(/no case.json/);
    expect(message('c_garbled')).toMatch(/not valid JSON/);
    expect(message('d_early')).toMatch(/stored AAA starts 2024-06-03, after from \(2024-05-01\)/);
    expect(message('e_unstored')).toMatch(/no stored bars for BBB/);
    expect(message('f_weekend')).toMatch(/no decision on 2026-01-17 \(the last is 2026-01-16\)/);
  });

  it('runJob stores each case and fails the checks run on a red one', async () => {
    const e = expected();
    const good = validCase({ cagr: e.cagr, maxDrawdown: e.maxDrawdown, switches: 0 });
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

    const bad = validCase({ cagr: e.cagr + 0.01, maxDrawdown: e.maxDrawdown, switches: 0 });
    const red = await runJob(db, plugins(), options('checks', casesDir({ good, bad })));
    expect(red.ok).toBe(false);
    expect(red.error).toMatch(/testfol_parity failed: bad: /);
    const stored = await db
      .select()
      .from(schema.checkResults)
      .where(eq(schema.checkResults.runId, red.runId));
    expect(stored.filter((r) => r.checkName === 'testfol_parity').map((r) => r.status)).toEqual([
      'red',
    ]);

    // No cases folder: no parity results, and the run is not failed for it.
    const none = await runJob(db, plugins(), options('checks'));
    expect(none.ok).toBe(true);
  });
});
