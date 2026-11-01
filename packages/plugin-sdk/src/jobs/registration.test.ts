import { type HealthStatus, type JobType, type RawBar, Strategy } from '@saku/core';
import { translator } from '@saku/content';
import { Sessions } from '@saku/data';
import {
  type Db,
  addDepositRate,
  createUser,
  finishRun,
  schema,
  seedSourceRoles,
  setSetting,
  startRun,
  storeFx,
  storeRawBars,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  RANGE_VOLATILITY_REFUSAL,
  SAME_CLOSE_REFUSAL,
  registrationProblems,
  registrationReport,
  registrationTickers,
} from './registration';
import { verify } from './verify';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'] as const;
const LAST = D[3];

const strategy = (o: { execution?: string; ticker?: string; safe?: string } = {}) =>
  Strategy.parse({
    name: 'Test',
    account: 'taxable',
    execution: o.execution ?? 'next_open',
    safeState: { holdings: [{ ticker: o.safe ?? 'AAA', weight: 100 }] },
    evaluation: { frequency: 'daily' },
    // Every cost stated: these tests do not depend on the install's broker_costs (tested below).
    costs: { slippageBps: 5, feePct: 0.1, fxSpreadPct: 0.2 },
    allocations: [{ name: 'All', holdings: [{ ticker: o.ticker ?? 'AAA', weight: 100 }] }],
  });
/** What the report says about a strategy stating every cost: registered as it is. */
const ownCosts = () => ({ strategy: strategy(), fromInstall: [] });

const rawBar = (date: string): RawBar => ({
  date,
  close: 1,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
});

let clock = Date.parse('2026-02-01T00:00:00Z');
async function run(
  db: Db,
  jobType: JobType,
  target: string,
  o: { ok?: boolean; finished?: boolean } = {},
) {
  const id = await startRun(db, jobType, new Date((clock += 60_000)));
  if (o.finished !== false) {
    await finishRun(db, id, {
      ok: o.ok ?? true,
      datesProcessed: [target],
      ...(o.ok === false && { error: 'x' }),
    });
  }
  return id;
}

async function setup(o: { tickers?: string[]; recordsFrom?: boolean } = {}) {
  const db = await testDb();
  const tickers = o.tickers ?? ['AAA'];
  await upsertSymbols(
    db,
    tickers.map((ticker) => ({
      ticker,
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      leverageFactor: 1,
    })),
  );
  const ids: Record<string, number> = {};
  for (const t of tickers) {
    ids[t] = (await symbolId(db, t))!;
    await db.insert(schema.bars).values(
      D.map((date) => ({
        symbolId: ids[t]!,
        date,
        close: 1,
        source: 'p',
        status: 'green' as const,
      })),
    );
  }
  if (o.recordsFrom !== false) await setSetting(db, 'forward_records_from', D[0]);
  /**
   * A full pass for `target` that graded each symbol from `from` through `to`, stored its overall
   * rows (unless `overall` is false) and the symbol rows in `rows`.
   */
  const pass = async (
    p: {
      jobType?: JobType;
      target?: string;
      from?: string;
      to?: string;
      ok?: boolean;
      finished?: boolean;
      overall?: boolean;
      rows?: { ticker: string; date: string; status: HealthStatus; reasons: string[] }[];
      only?: string[];
    } = {},
  ) => {
    const id = await run(db, p.jobType ?? 'checks', p.target ?? LAST, p);
    for (const t of p.only ?? tickers) {
      await db.insert(schema.healthCoverage).values({
        runId: id,
        symbolId: ids[t]!,
        fromDate: p.from ?? D[0],
        toDate: p.to ?? LAST,
      });
    }
    for (const r of p.rows ?? []) {
      await db.insert(schema.dataHealth).values({
        runId: id,
        date: r.date,
        symbolId: ids[r.ticker]!,
        status: r.status,
        reasons: r.reasons,
      });
    }
    if (p.overall !== false) {
      for (const date of D) {
        await db
          .insert(schema.dataHealth)
          .values({ runId: id, date, symbolId: null, status: 'green', reasons: [] });
      }
    }
    return id;
  };
  return { db, ids, pass };
}

const check = (db: Db, s = strategy(), through: string = LAST) =>
  registrationProblems(db, s, { through, sessions });

describe('registrationProblems', () => {
  it('passes when the latest full pass covers the whole history with no red day', async () => {
    const { db, pass } = await setup();
    await pass({ rows: [{ ticker: 'AAA', date: D[1], status: 'yellow', reasons: ['A.x'] }] });
    expect(await check(db)).toEqual([]);
  });

  it('a strategy that may hold CASH_BASE needs the base currency, a deposit rate and FX', async () => {
    const { db, pass } = await setup();
    await pass();
    // A strategy that cannot hold it needs none of them.
    expect(await check(db)).toEqual([]);
    const s = strategy({ safe: 'CASH_BASE' });
    expect(registrationTickers(s)).toEqual(['AAA']);
    expect(await check(db, s)).toEqual([
      'The strategy may hold CASH_BASE (base-currency cash) and base_currency is not set: pnpm settings set base_currency <code> first.',
    ]);
    await setSetting(db, 'base_currency', 'XXX');
    expect(await check(db, s)).toEqual([
      `The strategy may hold CASH_BASE and no XXX deposit rate is in force on ${LAST} (never read as 0): pnpm settings deposit-rate add <ratePct> <from> XXX first.`,
      'The strategy may hold CASH_BASE and no primary FX source is set: its value in USD needs the valuation rate USDXXX.',
    ]);
    // A rate in force only after `through` is not in force on it.
    await addDepositRate(db, { ratePct: '0.1', from: '2026-01-09', currency: 'XXX' });
    expect((await check(db, s))[0]).toMatch(/no XXX deposit rate is in force on 2026-01-08/);
    await addDepositRate(db, { ratePct: '0.2', from: D[0], currency: 'XXX' });
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 });
    // The role is there but no rate is known before through's open (09:30 New York).
    const noRate = [
      `The strategy may hold CASH_BASE and no valuation rate USDXXX from fp is known before the open of ${LAST}: run pnpm jobs daily (or check the FX source) first.`,
    ];
    expect(await check(db, s)).toEqual(noRate);
    // Published after that open: still not known then.
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: [{ pair: 'USDXXX', date: LAST, rate: 150, publishedAt: `${LAST}T15:00:00Z` }],
      fetchedAt: `${LAST}T16:00:00Z`,
    });
    expect(await check(db, s)).toEqual(noRate);
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: [{ pair: 'USDXXX', date: D[2], rate: 149, publishedAt: `${D[2]}T15:00:00Z` }],
      fetchedAt: `${D[2]}T16:00:00Z`,
    });
    expect(await check(db, s)).toEqual([]);
    // Said in the install's language whether refused or not: tax on conversion, FX spread scope.
    const report = await registrationReport(db, s, { through: LAST, sessions });
    expect(report.notes).toEqual([translator('en')('registration.cashBaseNote')]);
    await setSetting(db, 'primary_language', 'ja');
    expect((await registrationReport(db, s, { through: LAST, sessions })).notes).toEqual([
      translator('ja')('registration.cashBaseNote'),
    ]);
    expect((await registrationReport(db, strategy(), { through: LAST, sessions })).notes).toEqual(
      [],
    );
  });

  it('CASH_BASE: refuses an FX the forward record would refuse (stale, or disputed), with why', async () => {
    const { db, pass } = await setup();
    await pass();
    const s = strategy({ safe: 'CASH_BASE' });
    await setSetting(db, 'base_currency', 'XXX');
    await addDepositRate(db, { ratePct: '0.2', from: D[0], currency: 'XXX' });
    await db.insert(schema.sourceRoles).values([
      { dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 },
      { dataKind: 'fx', pluginKey: 'fs1', role: 'secondary', position: 1 },
    ]);
    // The last value is from 2025-12-26: more than 5 sessions behind through.
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: [
        { pair: 'USDXXX', date: '2025-12-26', rate: 150, publishedAt: '2025-12-26T15:00:00Z' },
      ],
      fetchedAt: '2025-12-26T16:00:00Z',
    });
    const [stale] = await check(db, s);
    expect(stale).toMatch(
      new RegExp(
        `^The strategy may hold CASH_BASE and USDXXX is stale: its last value \\(2025-12-26\\) is \\d+ sessions behind ${LAST}: run pnpm jobs daily \\(or check the FX source\\) first\\.$`,
      ),
    );
    // A recent value the current secondary found wrong: refused too.
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: [{ pair: 'USDXXX', date: D[2], rate: 149, publishedAt: `${D[2]}T15:00:00Z` }],
      fetchedAt: `${D[2]}T16:00:00Z`,
    });
    const runId = await startRun(db, 'daily');
    await db.insert(schema.checkResults).values({
      runId,
      layer: 'B',
      checkName: 'fx_match',
      symbolId: null,
      source: 'fs1',
      date: D[2],
      status: 'red',
      expected: 149,
    });
    expect(await check(db, s)).toEqual([
      `The strategy may hold CASH_BASE and USDXXX of ${D[2]} disagrees with fs1 (fx_match red): run pnpm jobs daily (or check the FX source) first.`,
    ]);
  });

  it('refuses same_close, and lists every reason at once', async () => {
    const { db } = await setup({ recordsFrom: false });
    const problems = await check(db, strategy({ execution: 'same_close', ticker: 'ZZZ' }));
    expect(problems[0]).toMatch(/forward_records_from/);
    expect(problems[1]).toBe(SAME_CLOSE_REFUSAL);
    expect(problems[2]).toBe('Not in the universe: ZZZ (pnpm symbols import).');
    // AAA (the safe state) has no pass.
    expect(problems[3]).toMatch(/^AAA: its full history has not been checked; run pnpm verify/);
    expect(problems).toHaveLength(4);
  });

  // Decision C32: opens, highs and lows are not cross-checked yet.
  it.each(['parkinson', 'garman_klass', 'yang_zhang'])(
    'refuses a %s volatility (open, high and low are not checked yet), in an ensemble too',
    async (method) => {
      const { db, pass } = await setup();
      await pass();
      const vol = { indicator: 'volatility', ticker: 'AAA', length: 5, method };
      const base = strategy();
      const withSignals = (signals: unknown[]) =>
        Strategy.parse({
          ...base,
          signals,
          allocations: [
            { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
            ...base.allocations,
          ],
        });
      const range = { left: vol, op: '<', right: { threshold: 25 } };
      const close = { ...range, left: { ...vol, method: 'close' } };
      const compare = (c: object) => ({ id: 'A', type: 'compare', ...c });
      expect(await check(db, withSignals([compare(range)]))).toEqual([RANGE_VOLATILITY_REFUSAL]);
      const ensemble = { id: 'A', type: 'ensemble', threshold: 0.5, members: [close, range] };
      expect(await check(db, withSignals([ensemble]))).toEqual([RANGE_VOLATILITY_REFUSAL]);
      // The close method (the default) is not refused.
      expect(await check(db, withSignals([compare(close)]))).toEqual([]);
    },
  );

  it('refuses a ticker with no full pass (a daily run does not count)', async () => {
    const { db, ids } = await setup();
    const daily = await run(db, 'daily', LAST);
    for (const date of D) {
      await db
        .insert(schema.dataHealth)
        .values({ runId: daily, date, symbolId: ids.AAA!, status: 'green', reasons: [] });
    }
    expect(await check(db)).toEqual([
      'AAA: its full history has not been checked; run pnpm verify (full) first.',
    ]);
  });

  it('checks the safe state holdings and leveraged holdings by their base ticker', async () => {
    const { db, pass } = await setup({ tickers: ['AAA', 'BBB'] });
    expect(registrationTickers(strategy({ ticker: 'AAA?L=3', safe: 'BBB' }))).toEqual([
      'AAA',
      'BBB',
    ]);
    expect(registrationTickers(strategy({ safe: 'CASH_USD' }))).toEqual(['AAA']);
    await pass({ only: ['AAA'] });
    expect(await check(db, strategy({ safe: 'BBB' }))).toEqual([
      expect.stringMatching(/^BBB: the latest full check \(run .+\) did not grade it/),
    ]);
  });

  it('refuses a pass that ended before the latest bars or the latest final session (stale)', async () => {
    const { db, pass } = await setup();
    await pass({ to: D[2], target: D[2] });
    const [stale] = await check(db, strategy(), D[2]);
    expect(stale).toMatch(
      /graded through 2026-01-07; registration needs it through 2026-01-08 \(its latest stored bar\)/,
    );
    // A later final session with no bar yet: still stale.
    const { db: db2, pass: pass2 } = await setup();
    await pass2();
    const [behind] = await check(db2, strategy(), '2026-01-09');
    expect(behind).toMatch(/through 2026-01-09 \(the latest final session, not stored yet\)/);
  });

  it('refuses a pass that started after the first stored bar', async () => {
    const { db, pass } = await setup();
    await pass({ from: D[1] });
    expect(await check(db)).toEqual([
      expect.stringMatching(
        /^AAA: its stored bars from 2026-01-05 to before 2026-01-06 are graded by no check: .*earlier primary.*An admin/,
      ),
    ]);
  });

  it('refuses red days in history, listing the first 10 and a count', async () => {
    const { db, pass } = await setup();
    await pass({
      rows: [
        { ticker: 'AAA', date: D[2], status: 'red', reasons: ['B.close_match@s'] },
        { ticker: 'AAA', date: D[1], status: 'red', reasons: ['primary_missing'] },
      ],
    });
    const [p] = await check(db);
    expect(p).toMatch(
      /^AAA: 2 red days in its history \(the latest full check \(run .+, checks for 2026-01-08\)\): 2026-01-06 \(primary_missing\), 2026-01-07 \(B\.close_match@s\)\. /,
    );

    // Twelve red days: ten named, two counted.
    const many = await testDb();
    await upsertSymbols(many, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
    ]);
    await setSetting(many, 'forward_records_from', D[0]);
    const id = (await symbolId(many, 'AAA'))!;
    const days = sessions.between('2026-01-02', '2026-01-20');
    await many.insert(schema.bars).values(
      days.map((date) => ({
        symbolId: id,
        date,
        close: 1,
        source: 'p',
        status: 'green' as const,
      })),
    );
    const r = await run(many, 'weekly', days.at(-1)!);
    await many
      .insert(schema.healthCoverage)
      .values({ runId: r, symbolId: id, fromDate: days[0]!, toDate: days.at(-1)! });
    await many.insert(schema.dataHealth).values([
      ...days.slice(0, 12).map((date) => ({
        runId: r,
        date,
        symbolId: id,
        status: 'red' as const,
        reasons: ['primary_missing'],
      })),
      ...days.map((date) => ({
        runId: r,
        date,
        symbolId: null,
        status: 'red' as const,
        reasons: ['AAA'],
      })),
    ]);
    const [listed] = await check(many, strategy(), days.at(-1)!);
    expect(listed).toMatch(/^AAA: 12 red days/);
    expect(listed).toMatch(/, and 2 more\./);
    expect(listed!.match(/primary_missing/g)).toHaveLength(10);
  });

  it('reads only the latest full run: a later red one refuses, so does an interrupted one', async () => {
    const { db, pass } = await setup();
    await pass();
    await pass({ rows: [{ ticker: 'AAA', date: D[0], status: 'red', reasons: ['x'] }] });
    expect(await check(db)).toEqual([expect.stringMatching(/^AAA: 1 red day in its history/)]);

    // Still marked running (registration holds the jobs lock, so it was interrupted).
    const { db: db2, pass: pass2 } = await setup();
    await pass2();
    await pass2({ finished: false });
    expect(await check(db2)).toEqual([
      expect.stringMatching(/^The latest full check \(run .+, checks\) was interrupted/),
    ]);
  });

  it('refuses a later failed full run without coverage, never falling back', async () => {
    const { db, pass } = await setup();
    await pass();
    await run(db, 'weekly', LAST, { ok: false });
    expect(await check(db)).toEqual([
      expect.stringMatching(
        /^The latest full check \(run .+, weekly for 2026-01-08\) did not succeed/,
      ),
    ]);
  });

  it('refuses stored bars graded red, whatever the pass found (a later daily run grades them)', async () => {
    const { db, ids, pass } = await setup();
    await pass();
    await db
      .update(schema.bars)
      .set({ status: 'red' })
      .where(and(eq(schema.bars.symbolId, ids.AAA!), eq(schema.bars.date, D[3])));
    expect(await check(db)).toEqual([
      'AAA: 1 stored bar is graded red: 2026-01-08. Its data has not passed the checks (pnpm health --date <date> explains a day).',
    ]);
    await db.update(schema.bars).set({ status: 'red' }).where(eq(schema.bars.symbolId, ids.AAA!));
    await db.update(schema.bars).set({ status: 'yellow' }).where(eq(schema.bars.date, D[0]));
    expect(await check(db)).toEqual([
      expect.stringMatching(
        /^AAA: 3 stored bars are graded red: 2026-01-06, 2026-01-07, 2026-01-08\./,
      ),
    ]);
  });

  it('notes bars on closed days (no signal reads them); refuses those the calendar does not cover', async () => {
    const { db, ids, pass } = await setup();
    await pass();
    // A stored canonical row on a Saturday (left from before verify excluded them) and the
    // primary's raw bar on another closed day: information, not a refusal.
    await db
      .insert(schema.bars)
      .values([{ symbolId: ids.AAA!, date: '2026-01-10', close: 1, source: 'p', status: 'red' }]);
    await seedSourceRoles(db, [{ key: 'p', dataKind: 'bars', suggestedRole: 'primary' }]);
    await storeRawBars(db, {
      symbolId: ids.AAA!,
      source: 'p',
      bars: [{ ...rawBar('2026-01-04'), close: 2 }],
      runId: null,
      fetchedAt: 't',
    });
    expect(await registrationReport(db, strategy(), { through: LAST, sessions })).toEqual({
      problems: [],
      costs: ownCosts(),
      notes: [
        'AAA: 2 bars on days the market was closed, excluded (no signal reads them): ' +
          '2026-01-04, 2026-01-10.',
      ],
    });
    // A bar on a day the calendar does not cover is unknown: refused.
    await db
      .insert(schema.bars)
      .values([{ symbolId: ids.AAA!, date: '2024-12-31', close: 1, source: 'p', status: 'red' }]);
    expect(await check(db, strategy(), '2026-01-12')).toEqual([
      'AAA: 1 stored bar is on days the market calendar does not cover: 2024-12-31. Update the ' +
        'calendar plug-in.',
      // The pass is also stale and started after the (uncovered) first bar.
      expect.stringMatching(
        /stored bars from 2024-12-31 to before 2026-01-05 are graded by no check/,
      ),
      expect.stringMatching(/registration needs it through 2026-01-12/),
    ]);
  });

  it('refuses stored bars no run has graded (unknown, not green)', async () => {
    const { db, ids, pass } = await setup();
    await pass();
    await db
      .update(schema.bars)
      .set({ status: null })
      .where(and(eq(schema.bars.symbolId, ids.AAA!), eq(schema.bars.date, D[1])));
    expect(await check(db)).toEqual([
      'AAA: 1 stored bar is not graded: 2026-01-06. Run pnpm verify (full).',
    ]);
    await db.update(schema.bars).set({ status: null }).where(eq(schema.bars.symbolId, ids.AAA!));
    expect(await check(db)).toEqual([
      'AAA: 4 stored bars are not graded: 2026-01-05, 2026-01-06, 2026-01-07, 2026-01-08. Run pnpm verify (full).',
    ]);
  });

  it('lists the first 10 red bars and a count', async () => {
    const db = await testDb();
    await upsertSymbols(db, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
    ]);
    const id = (await symbolId(db, 'AAA'))!;
    const days = sessions.between('2026-01-02', '2026-01-20');
    await db
      .insert(schema.bars)
      .values(
        days.map((date) => ({ symbolId: id, date, close: 1, source: 'p', status: 'red' as const })),
      );
    const [p] = (await check(db, strategy(), days.at(-1)!)).filter((x) => x.startsWith('AAA'));
    expect(p).toMatch(/^AAA: 13 stored bars are graded red: .*, and 3 more\./);
    expect(p!.match(/2026-01-/g)).toHaveLength(10);
  });

  it('refuses when the latest pass failed, never falling back to an older one', async () => {
    const { db, pass } = await setup();
    await pass();
    await pass({ ok: false });
    expect(await check(db)).toEqual([
      expect.stringMatching(/^The latest full check \(run .+\) did not succeed/),
    ]);
  });

  it('refuses a pass whose grades are incomplete or unreadable', async () => {
    const { db, pass } = await setup();
    await pass({ overall: false });
    expect(await check(db)).toEqual([expect.stringMatching(/cannot be read/)]);

    const { db: db2, pass: pass2 } = await setup();
    await pass2({ to: 'not a date' });
    expect(await check(db2)).toEqual([expect.stringMatching(/cannot be read/)]);
  });

  it('refuses a ticker with no stored bars', async () => {
    const db = await testDb();
    await upsertSymbols(db, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
    ]);
    await setSetting(db, 'forward_records_from', D[0]);
    expect(await check(db)).toEqual(['AAA: no stored bars; run pnpm bootstrap, then pnpm verify.']);
  });
});

describe('registrationProblems on what verify stores', () => {
  const bar = (date: string, close: number): RawBar => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    closeIsSplitAdjusted: false,
    volume: 1000,
    divCash: 0,
    splitFactor: 1,
  });
  const closes = [100, 101, 102, 101];

  /** `closedDay`: bars each source also has on days the market was closed. */
  async function verified(secondary: number[], closedDay: { p?: RawBar[]; s?: RawBar[] } = {}) {
    const db = await testDb();
    await upsertSymbols(db, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
    ]);
    await seedSourceRoles(db, [
      { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    await setSetting(db, 'forward_records_from', D[0]);
    for (const [source, list] of [
      ['p', closes],
      ['s', secondary],
    ] as const) {
      await storeRawBars(db, {
        symbolId: (await symbolId(db, 'AAA'))!,
        source,
        bars: [...list.map((c, i) => bar(D[i]!, c)), ...(closedDay[source] ?? [])].sort((a, b) =>
          a.date < b.date ? -1 : 1,
        ),
        runId: null,
        fetchedAt: 't',
      });
    }
    const id = await run(db, 'checks', LAST, { finished: false });
    await verify(db, { runId: id, sessions, mode: 'full', to: LAST });
    await finishRun(db, id, { ok: true, datesProcessed: [LAST] });
    return { db, id };
  }

  it('a clean full pass allows registration', async () => {
    const { db } = await verified(closes);
    expect(await check(db)).toEqual([]);
  });

  it('a red day the full pass found refuses it', async () => {
    // The secondary's last close is far off (layer B mismatch above 2x tolerance: red).
    const { db, id } = await verified([...closes.slice(0, 3), 110]);
    const red = await db.select().from(schema.dataHealth).where(eq(schema.dataHealth.runId, id));
    expect(red.some((r) => r.symbolId !== null && r.status === 'red')).toBe(true);
    // Both the bar's grade and the pass's red day.
    expect(await check(db)).toEqual([
      'AAA: 1 stored bar is graded red: 2026-01-08. Its data has not passed the checks (pnpm health --date <date> explains a day).',
      expect.stringMatching(/^AAA: 1 red day in its history .*: 2026-01-08 \(B\.close_match@s\)/),
    ]);
  });

  it('a bar on a closed day only: registers, with the bars noted (its red day stays stored)', async () => {
    // The primary dates a bar on the Saturday before its sessions (01-03), the secondary one on
    // the Sunday (01-04): both red in layer A, neither in the series the signals read.
    const { db, id } = await verified(closes, {
      p: [bar('2026-01-03', 99)],
      s: [bar('2026-01-04', 98)],
    });
    const health = await db
      .select()
      .from(schema.dataHealth)
      .where(and(eq(schema.dataHealth.runId, id), eq(schema.dataHealth.date, '2026-01-03')));
    expect(health.find((h) => h.symbolId !== null)).toMatchObject({ status: 'red' });
    expect(await registrationReport(db, strategy(), { through: LAST, sessions })).toEqual({
      problems: [],
      costs: ownCosts(),
      notes: [
        'AAA: 1 bar on days the market was closed, excluded (no signal reads them): 2026-01-03.',
      ],
    });
  });

  it('a closed-day bar with a dividend, or another red on that day, still refuses', async () => {
    const { db } = await verified(closes, { p: [{ ...bar('2026-01-03', 99), divCash: 0.5 }] });
    // The dividend is in no series bar: every session after it is red too (`closed_day_event`,
    // C19), until the source corrects it or an admin resolves it.
    expect(await check(db)).toEqual([
      'AAA: 4 stored bars are graded red: 2026-01-05, 2026-01-06, 2026-01-07, 2026-01-08. Its data has not passed the checks (pnpm health --date <date> explains a day).',
      expect.stringMatching(
        /^AAA: 5 red days in its history .*: 2026-01-03 \(A\.bar_valid@p, single_source\), 2026-01-05 \(closed_day_event@2026-01-03\), 2026-01-06 \(closed_day_event@2026-01-03\), 2026-01-07 .*2026-01-08 \(closed_day_event@2026-01-03\)/,
      ),
    ]);
    // A bar on a closed day that is also broken (a price not positive): refused.
    const broken = await verified(closes, { p: [{ ...bar('2026-01-03', 99), low: -1 }] });
    expect(await check(broken.db)).toEqual([
      expect.stringMatching(/^AAA: 1 red day in its history .*: 2026-01-03/),
    ]);
  });

  it('a closed-day event an admin resolved as not real: registers after the next full pass', async () => {
    const event = { ...bar('2026-01-03', 99), divCash: 0.5 };
    const { db } = await verified(closes, { p: [event] });
    const aaa = (await symbolId(db, 'AAA'))!;
    const admin = await createUser(db, {
      username: 'ada',
      passwordHash: 'x',
      totpSecretEnc: 'x',
      totpLastStep: 1,
      backupCodeHashes: ['ada'],
      isAdmin: true,
    });
    await db.insert(schema.closedEventResolutions).values({
      symbolId: aaa,
      date: '2026-01-03',
      source: 'p',
      divCash: 0.5,
      splitFactor: 1,
      resolvedBy: admin,
      reason: 'no such dividend (issuer site)',
      resolvedAt: '2026-02-01T00:00:00.000Z',
    });
    // Until a full pass grades it again, the stored grades still refuse.
    expect(await check(db)).toHaveLength(2);
    const id = await run(db, 'checks', LAST, { finished: false });
    await verify(db, { runId: id, sessions, mode: 'full', to: LAST });
    await finishRun(db, id, { ok: true, datesProcessed: [LAST] });
    expect(await registrationReport(db, strategy(), { through: LAST, sessions })).toEqual({
      problems: [],
      costs: ownCosts(),
      notes: [
        'AAA: 1 bar on days the market was closed, excluded (no signal reads them): 2026-01-03.',
      ],
    });
    // A resolution covers the event it was made for: another amount stored later is red again.
    await storeRawBars(db, {
      symbolId: aaa,
      source: 'p',
      bars: [{ ...event, divCash: 0.6 }],
      runId: null,
      fetchedAt: 't2',
    });
    const again = await run(db, 'checks', LAST, { finished: false });
    await verify(db, { runId: again, sessions, mode: 'full', to: LAST });
    await finishRun(db, again, { ok: true, datesProcessed: [LAST] });
    expect(await check(db)).toEqual([
      expect.stringMatching(/^AAA: 4 stored bars are graded red/),
      expect.stringMatching(/^AAA: 5 red days in its history/),
    ]);
  });

  it('a red reason on a closed day that is not a check result refuses (unknown is not excused)', async () => {
    const { db, id } = await verified(closes, { p: [bar('2026-01-03', 99)] });
    const aaa = (await symbolId(db, 'AAA'))!;
    await db
      .update(schema.dataHealth)
      .set({ reasons: ['A.bar_valid@p', 'stand_in_refused:layer_c'] })
      .where(
        and(
          eq(schema.dataHealth.runId, id),
          eq(schema.dataHealth.symbolId, aaa),
          eq(schema.dataHealth.date, '2026-01-03'),
        ),
      );
    expect(await check(db)).toEqual([
      expect.stringMatching(
        /^AAA: 1 red day in its history .*: 2026-01-03 \(A\.bar_valid@p, stand_in_refused/,
      ),
    ]);
  });
});

// Requirements 05 "Costs": a cost the strategy omits is the install's broker_costs; with none set,
// registration refuses (never 0). Spec 2026-11-02 c2-settings.
describe('registration costs', () => {
  const omitting = (costs: object) => Strategy.parse({ ...strategy(), costs });

  it('refuses a strategy omitting a cost when the install has no broker costs', async () => {
    const { db, pass } = await setup();
    await pass();
    const report = await registrationReport(db, omitting({ slippageBps: 5 }), {
      through: LAST,
      sessions,
    });
    expect(report.problems).toEqual([
      expect.stringMatching(
        /^The strategy leaves out costs\.feePct, costs\.fxSpreadPct and the install has no broker costs set \(never read as 0\)/,
      ),
    ]);
    expect(report.costs).toBeUndefined();
    // Listed with every other reason at once.
    const same = await check(db, Strategy.parse({ ...omitting({}), execution: 'same_close' }));
    expect(same).toEqual([
      expect.stringMatching(/leaves out costs\.slippageBps/),
      SAME_CLOSE_REFUSAL,
    ]);
  });

  it("takes each omitted cost from the install's broker costs, and names them", async () => {
    const { db, pass } = await setup();
    await pass();
    await setSetting(
      db,
      'broker_costs',
      '{"slippageBps":"2","feePct":"0.05","fxSpreadPct":"0.25"}',
    );
    const report = await registrationReport(db, omitting({ feePct: 0 }), {
      through: LAST,
      sessions,
    });
    expect(report.problems).toEqual([]);
    // The strategy's own 0 is its own: stated, not omitted.
    expect(report.costs).toEqual({
      strategy: { ...strategy(), costs: { slippageBps: 2, feePct: 0, fxSpreadPct: 0.25 } },
      fromInstall: ['slippageBps', 'fxSpreadPct'],
    });
  });

  it('refuses when the stored broker costs no longer parse (a hand edit), never reading 0', async () => {
    const { db, pass } = await setup();
    await pass();
    await db.insert(schema.appSettings).values({ key: 'broker_costs', value: '{"feePct":"x"}' });
    expect(await check(db, omitting({}))).toEqual([
      expect.stringMatching(/^The strategy leaves out .* broker_costs does not parse \(/),
    ]);
    // A strategy stating every cost does not read the setting.
    expect(await check(db)).toEqual([]);
  });
});
