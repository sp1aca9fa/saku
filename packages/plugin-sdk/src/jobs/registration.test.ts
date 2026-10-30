import { type HealthStatus, type JobType, type RawBar, Strategy } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  type Db,
  finishRun,
  schema,
  seedSourceRoles,
  setSetting,
  startRun,
  storeRawBars,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SAME_CLOSE_REFUSAL, registrationProblems, registrationTickers } from './registration';
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
    allocations: [{ name: 'All', holdings: [{ ticker: o.ticker ?? 'AAA', weight: 100 }] }],
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
    tickers.map((ticker) => ({ ticker, tier: 0, assetClass: 'equity', currency: 'USD' })),
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
    await upsertSymbols(many, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
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

  it('names bars on closed days apart, with what removes them', async () => {
    const { db, ids, pass } = await setup();
    await pass();
    // A Saturday bar, graded red by verify (layer A), and one the calendar does not cover.
    await db.insert(schema.bars).values([
      { symbolId: ids.AAA!, date: '2026-01-10', close: 1, source: 'p', status: 'red' },
      { symbolId: ids.AAA!, date: '2024-12-31', close: 1, source: 'p', status: 'red' },
    ]);
    expect(await check(db, strategy(), '2026-01-12')).toEqual([
      'AAA: 1 stored bar on days the market was closed: 2026-01-10. No command removes such a ' +
        'bar yet; tell the admin (an open decision: keep closed-day bars out of the canonical ' +
        'series, or an admin withdrawal).',
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
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
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
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
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

  async function verified(secondary: number[]) {
    const db = await testDb();
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
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
        bars: list.map((c, i) => bar(D[i]!, c)),
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
});
