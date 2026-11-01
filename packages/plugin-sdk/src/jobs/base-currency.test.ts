// A backtest's base-currency inputs from the database (spec 2026-11-02 base-currency;
// docs/indicators.md "Base currency", "Base-currency cash") and the forward equity of a version
// that may hold CASH_BASE.
import { type RawBar, type StrategyDay, Strategy } from '@saku/core';
import { Sessions } from '@saku/data';
import { addDepositRate, schema, setSetting, startRun, storeFx } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { baseCurrencyInputs } from './base-currency';
import { forwardEquity } from './forward';

const D = ['2026-01-05', '2026-01-06', '2026-01-07'] as const;
const now = new Date('2026-01-09T12:00:00Z');

async function install(o: { fx?: boolean } = {}) {
  const db = await testDb();
  await setSetting(db, 'base_currency', 'XXX');
  await addDepositRate(db, { ratePct: '2.52', from: D[0], currency: 'XXX' }, { now });
  if (o.fx !== false) {
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 });
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: [
        // Published the evening before each date (New York): known before its open.
        { pair: 'USDXXX', date: D[0], rate: 150, publishedAt: '2026-01-04T21:00:00Z' },
        { pair: 'USDXXX', date: D[1], rate: 151, publishedAt: '2026-01-05T21:00:00Z' },
        // Published after D2's open (09:30 New York = 14:30 UTC): D2 reads D1's rate.
        { pair: 'USDXXX', date: D[2], rate: 152, publishedAt: '2026-01-07T15:00:00Z' },
        // Another pair and another source are never read.
        { pair: 'USDYYY', date: D[2], rate: 9, publishedAt: '2026-01-06T21:00:00Z' },
      ],
      fetchedAt: '2026-01-08T00:00:00Z',
    });
    await storeFx(db, {
      source: 'other',
      kind: 'valuation',
      rates: [{ pair: 'USDXXX', date: D[2], rate: 1, publishedAt: '2026-01-06T21:00:00Z' }],
      fetchedAt: '2026-01-08T00:00:00Z',
    });
  }
  return db;
}

describe('baseCurrencyInputs', () => {
  it('nothing without base_currency', async () => {
    expect(await baseCurrencyInputs(await testDb())).toEqual({});
  });

  it('FX from the primary source, as known before the open; the deposit rate in force', async () => {
    const r = await baseCurrencyInputs(await install());
    expect(r.baseCurrency).toBe('XXX');
    expect(r.fxRate!('2026-01-02')).toBeUndefined();
    expect(D.map((d) => r.fxRate!(d))).toEqual([150, 151, 151]);
    expect(r.depositRate!('2026-01-02')).toBeUndefined();
    expect(r.depositRate!(D[2])).toBe(2.52);
  });

  it('no primary FX source: unknown on every date, never a guess', async () => {
    const r = await baseCurrencyInputs(await install({ fx: false }));
    expect(D.map((d) => r.fxRate!(d))).toEqual([undefined, undefined, undefined]);
  });

  it('an invalid stored deposit rate fails the read with the reason, never used', async () => {
    const db = await install();
    await db
      .insert(schema.depositRates)
      .values({ ratePct: '0,5', fromDate: D[2], currency: 'XXX', actor: 't' });
    const r = await baseCurrencyInputs(db);
    expect(r.depositRate!(D[1])).toBe(2.52);
    expect(() => r.depositRate!(D[2])).toThrow(/deposit rate in force on 2026-01-07 is invalid/);
  });
});

const bar = (date: string, open: number, close: number): RawBar => ({
  date,
  open,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
});
const bars = { AAA: [bar(D[0], 100, 100), bar(D[1], 100, 110), bar(D[2], 110, 121)] };
const day = (date: string, ticker: string): StrategyDay => ({
  date,
  signals: {},
  allocation: ticker,
  holdings: [{ ticker, weight: 100 }],
  ties: [],
});
const strategy = (out: string) =>
  Strategy.parse({
    name: 'S',
    account: 'taxable',
    execution: 'next_open',
    safeState: { holdings: [{ ticker: out, weight: 100 }] },
    evaluation: { frequency: 'daily' },
    costs: { slippageBps: 0, feePct: 0, fxSpreadPct: 0.5 },
    signals: [],
    allocations: [{ name: 'All', holdings: [{ ticker: 'AAA', weight: 100 }] }],
  });

describe('forwardEquity with CASH_BASE', () => {
  it('reads the base inputs for a version that may hold CASH_BASE', async () => {
    const base = await baseCurrencyInputs(await install());
    const s = strategy('CASH_BASE');
    const prior = [day(D[0], 'CASH_BASE'), day(D[1], 'CASH_BASE')];
    const problems: string[] = [];
    const e = forwardEquity(
      s,
      prior,
      bars,
      () => 0,
      day(D[2], 'CASH_BASE'),
      false,
      undefined,
      base,
    );
    // Entered at D1's open (the spread on 100% converted), then one day's deposit rate and the
    // FX move D1 -> D2 (151 -> 151, D2's own rate not yet known at its open).
    expect(e).toBeCloseTo((1 - 0.005) * 1.0001, 14);
    // Without the base inputs the equity is unknown, with the reason.
    expect(
      forwardEquity(
        s,
        prior,
        bars,
        () => 0,
        day(D[2], 'CASH_BASE'),
        false,
        (r) => problems.push(r),
      ),
    ).toBeNull();
    expect(problems).toEqual([
      'CASH_BASE needs the base currency: the strategy may hold it and no base currency is given.',
    ]);
  });

  it('a USD-only version never reads FX: its equity does not depend on it', () => {
    const throwing = {
      baseCurrency: 'XXX',
      fxRate: () => {
        throw new Error('FX read');
      },
      depositRate: () => {
        throw new Error('deposit read');
      },
    };
    const s = strategy('CASH_USD');
    const prior = [day(D[0], 'AAA'), day(D[1], 'AAA')];
    const plain = forwardEquity(s, prior, bars, () => 0, day(D[2], 'AAA'), false);
    expect(
      forwardEquity(s, prior, bars, () => 0, day(D[2], 'AAA'), false, undefined, throwing),
    ).toBe(plain);
    expect(plain).toBeCloseTo(1.21, 14);
  });
});

describe('the forward record reads the deposit rate point in time', () => {
  it('a 0.1% rate corrected to 0.5% later: the earlier day computes as it did', async () => {
    const db = await testDb();
    await setSetting(db, 'base_currency', 'XXX');
    // Entered before the days it covers; corrected after D2's read (09:30 New York, 14:30 UTC).
    const [row] = await db
      .insert(schema.depositRates)
      .values({
        ratePct: '0.1',
        fromDate: D[0],
        currency: 'XXX',
        actor: 't',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      .returning();
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 });
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: D.map((date) => ({
        pair: 'USDXXX',
        date,
        rate: 150,
        publishedAt: '2026-01-01T00:00:00Z',
      })),
      fetchedAt: '2026-01-02T00:00:00Z',
    });
    const s = strategy('CASH_BASE');
    const days = D.map((d) => day(d, 'CASH_BASE'));
    // The record's D2 entry: CASH_BASE entered at D1's open, one day at 0.1% on D2.
    const run = async (o: { pointInTime: boolean }) =>
      forwardEquity(
        s,
        days.slice(0, 2),
        bars,
        () => 0,
        days[2]!,
        false,
        undefined,
        await baseCurrencyInputs(db, o),
      );
    const recorded = await run({ pointInTime: true });
    expect(recorded).toBeCloseTo((1 - 0.005) * (1 + 0.1 / 100 / 252), 15);
    await db.insert(schema.depositRateRevisions).values({
      entryId: row!.id,
      oldRatePct: '0.1',
      newRatePct: '0.5',
      reason: 'bank letter',
      actor: 't',
      createdAt: '2026-01-07T20:00:00.000Z',
    });
    // Recomputed after the correction: D2 still reads 0.1% (what was known at its read).
    expect(await run({ pointInTime: true })).toBe(recorded);
    // The next day reads the corrected 0.5%; a draft (latest reading) reads it on D2 too.
    expect((await baseCurrencyInputs(db, { pointInTime: true })).depositRate!('2026-01-08')).toBe(
      0.5,
    );
    expect(await run({ pointInTime: false })).toBeCloseTo((1 - 0.005) * (1 + 0.5 / 100 / 252), 15);
    // A rate entered after the days it covers is unknown on them: no equity, with the reason.
    const later = await testDb();
    await setSetting(later, 'base_currency', 'XXX');
    await addDepositRate(later, { ratePct: '0.1', from: D[0], currency: 'XXX' }, { now });
    const r = await baseCurrencyInputs(later, { pointInTime: true });
    expect(r.depositRate!(D[2])).toBeUndefined();
    expect((await baseCurrencyInputs(later)).depositRate!(D[2])).toBe(0.1);
  });
});

describe('the forward record grades each FX it reads', () => {
  const sessions = new Sessions({
    id: 't',
    version: 't',
    validFrom: '2025-01-01',
    validTo: '2026-12-31',
    holidays: [],
  });
  const W = sessions.between('2026-01-05', '2026-01-16');
  type Db = Awaited<ReturnType<typeof testDb>>;

  async function withFx(
    rates: Record<string, number>,
    o: { source?: string; secondaries?: string[] } = {},
  ) {
    const db = await testDb();
    await setSetting(db, 'base_currency', 'XXX');
    await db.insert(schema.depositRates).values({
      ratePct: '2.52',
      fromDate: W[0]!,
      currency: 'XXX',
      actor: 't',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await db.insert(schema.sourceRoles).values([
      { dataKind: 'fx', pluginKey: o.source ?? 'fp', role: 'primary', position: 0 },
      ...(o.secondaries ?? ['fs1', 'fs2']).map((pluginKey, i) => ({
        dataKind: 'fx',
        pluginKey,
        role: 'secondary' as const,
        position: i + 1,
      })),
    ]);
    await store(db, o.source ?? 'fp', rates);
    return db;
  }
  /** Rates published long before the dates they are for (known at every read). */
  const store = (db: Db, source: string, rates: Record<string, number>) =>
    storeFx(db, {
      source,
      kind: 'valuation',
      rates: Object.entries(rates).map(([date, rate]) => ({
        pair: 'USDXXX',
        date,
        rate,
        publishedAt: '2026-01-01T00:00:00Z',
      })),
      fetchedAt: '2026-01-02T00:00:00Z',
    });
  /** A cross-check of `date`'s value (`expected`: the primary's rate it compared). */
  const checked = async (
    db: Db,
    rows: { date: string; source: string; status: 'green' | 'red'; expected: number }[],
  ) => {
    const runId = await startRun(db, 'daily');
    await db.insert(schema.checkResults).values(
      rows.map((r) => ({
        runId,
        layer: 'B' as const,
        checkName: 'fx_match',
        symbolId: null,
        source: r.source,
        date: r.date,
        status: r.status,
        expected: r.expected,
      })),
    );
  };
  /** Every date green: checked by fs1 against the primary's 150. */
  const allChecked = (db: Db, dates: readonly string[]) =>
    checked(
      db,
      dates.map((date) => ({ date, source: 'fs1', status: 'green', expected: 150 })),
    );
  const guarded = (db: Db) => baseCurrencyInputs(db, { pointInTime: true, guard: { sessions } });
  const longBars = { AAA: W.map((d) => bar(d, 100, 100)) };
  const held = (upTo: number) => W.slice(0, upTo + 1).map((d) => day(d, 'CASH_BASE'));
  /** The forward entry of W[n], from the bars up to it (as the forward step reads them). */
  const entry = (base: Awaited<ReturnType<typeof guarded>>, n: number) => {
    const unknown: string[] = [];
    const warnings: string[] = [];
    const days = held(n);
    const upTo = { AAA: longBars.AAA.slice(0, n + 1) };
    const equity = forwardEquity(
      strategy('CASH_BASE'),
      days.slice(0, -1),
      upTo,
      () => 0,
      days.at(-1)!,
      false,
      (r) => unknown.push(r),
      base,
      (r) => warnings.push(r),
    );
    return { equity, unknown, warnings };
  };

  it('a source down 6 sessions while CASH_BASE is held: W[7] has no value, W[8] has one again', async () => {
    // Rates for W[0] and from W[8] on; W[1] to W[7] read W[0]'s (1 to 7 sessions behind).
    const rates = { [W[0]!]: 150, [W[8]!]: 160, [W[9]!]: 160 };
    const db = await withFx(rates);
    await allChecked(db, [W[0]!]);
    await checked(
      db,
      [W[8]!, W[9]!].map((date) => ({ date, source: 'fs1', status: 'green', expected: 160 })),
    );
    const base = await guarded(db);
    // Sessions strictly between the value and the read: 0 or 1 green (the normal lag); 2 to 5
    // used, with a warning; 6 refused.
    expect(base.fxProblem!(W[1]!)).toBeUndefined();
    expect(base.fxProblem!(W[2]!)).toBeUndefined();
    expect(base.fxProblem!(W[3]!)).toEqual({
      level: 'yellow',
      reason: `USDXXX is 2 sessions behind ${W[3]} (last value ${W[0]})`,
    });
    expect(base.fxRate!(W[6]!)).toBe(150);
    expect(base.fxRate!(W[7]!)).toBeUndefined();
    expect(base.fxProblem!(W[7]!)).toEqual({
      level: 'red',
      reason: `USDXXX is stale: its last value (${W[0]}) is 6 sessions behind ${W[7]}`,
    });
    const w3 = entry(base, 3);
    expect(w3.equity).not.toBeNull();
    expect(w3.warnings).toEqual([`USDXXX is 2 sessions behind ${W[3]} (last value ${W[0]})`]);
    const w7 = entry(base, 7);
    expect(w7.equity).toBeNull();
    expect(w7.unknown).toEqual([
      `no FX rate (USDXXX) known for ${W[7]}: USDXXX is stale: its last value (${W[0]}) is 6 sessions behind ${W[7]}`,
    ]);
    // Recovered: W[8] is valued (the yen amount from W[1]'s open, 7 days of deposit, at 160).
    const w8 = entry(base, 8);
    expect(w8.unknown).toEqual([]);
    expect(w8.warnings).toEqual([]);
    expect(w8.equity).toBeCloseTo((0.995 * 150 * 1.0001 ** 7) / 160, 14);
  });

  it('a conversion on a refused day leaves every later entry unknown', async () => {
    const db = await withFx({ [W[0]!]: 150, [W[9]!]: 160 });
    await allChecked(db, [W[0]!]);
    await checked(db, [{ date: W[9]!, source: 'fs1', status: 'green', expected: 160 }]);
    const base = await guarded(db);
    // AAA through W[5], CASH_BASE decided on W[6]'s close: the entry at W[7]'s open reads W[7]'s
    // FX, refused (6 sessions behind). W[9]'s FX is good, but what the entry bought is unknown.
    const days = [
      ...W.slice(0, 6).map((d) => day(d, 'AAA')),
      ...W.slice(6, 10).map((d) => day(d, 'CASH_BASE')),
    ];
    const at = (n: number) => {
      const unknown: string[] = [];
      const e = forwardEquity(
        strategy('CASH_BASE'),
        days.slice(0, n),
        { AAA: longBars.AAA.slice(0, n + 1) },
        () => 0,
        days[n]!,
        false,
        (r) => unknown.push(r),
        base,
      );
      return { e, unknown };
    };
    expect(at(6).e).toBeCloseTo(1, 14);
    for (const n of [7, 8, 9]) {
      expect(at(n).e).toBeNull();
      expect(at(n).unknown[0]).toMatch(
        new RegExp(
          `a trade with CASH_BASE on ${W[7]} could not be priced .*: USDXXX is stale: its last value \\(${W[0]}\\) is 6 sessions behind ${W[7]}`,
        ),
      );
    }
  });

  it('a rate a current secondary graded red: refused; a later green from it clears it', async () => {
    const rates = Object.fromEntries(W.map((d) => [d, 150]));
    const db = await withFx(rates);
    await allChecked(db, W);
    await checked(db, [{ date: W[2]!, source: 'fs2', status: 'red', expected: 150 }]);
    const base = await guarded(db);
    expect(base.fxRate!(W[1]!)).toBe(150);
    expect(base.fxRate!(W[2]!)).toBeUndefined();
    expect(base.fxProblem!(W[2]!)).toEqual({
      level: 'red',
      reason: `USDXXX of ${W[2]} disagrees with fs2 (fx_match red)`,
    });
    expect(entry(base, 2).equity).toBeNull();
    // W[3] has its own good rate: valued again.
    expect(entry(base, 3).equity).not.toBeNull();
    await checked(db, [{ date: W[2]!, source: 'fs2', status: 'green', expected: 150 }]);
    expect((await guarded(db)).fxRate!(W[2]!)).toBe(150);
  });

  it('only current secondaries checking the current primary count: a primary switch', async () => {
    const db = await withFx(Object.fromEntries(W.map((d) => [d, 150])));
    // fs2 disputed the old primary's 150 on W[2]; a former secondary disputed it too.
    await checked(db, [
      { date: W[2]!, source: 'fs2', status: 'red', expected: 150 },
      { date: W[2]!, source: 'gone', status: 'red', expected: 150 },
    ]);
    expect((await guarded(db)).fxRate!(W[2]!)).toBeUndefined();
    // The primary is now fq (151 on every date): fs2's check was of another value.
    await store(db, 'fq', Object.fromEntries(W.map((d) => [d, 151])));
    await db.delete(schema.sourceRoles);
    await db.insert(schema.sourceRoles).values([
      { dataKind: 'fx', pluginKey: 'fq', role: 'primary', position: 0 },
      { dataKind: 'fx', pluginKey: 'fs2', role: 'secondary', position: 1 },
    ]);
    const base = await guarded(db);
    expect(base.fxRate!(W[2]!)).toBe(151);
    // Nothing checked fq's value: single source, used with a warning.
    expect(base.fxProblem!(W[2]!)).toEqual({
      level: 'yellow',
      reason: `USDXXX of ${W[2]} is from fq alone: no current secondary checked it`,
    });
    const w2 = entry(base, 2);
    expect(w2.equity).not.toBeNull();
    expect(w2.warnings).toEqual([
      `USDXXX of ${W[2]} is from fq alone: no current secondary checked it`,
    ]);
    // A version holding AAA that day reads no FX: no warning.
  });

  it('a USD-only version reads no FX at all', async () => {
    const db = await withFx({ [W[0]!]: 150 });
    const base = await guarded(db);
    const usd = strategy('CASH_USD');
    const plain = W.slice(0, 8).map((d) => day(d, 'AAA'));
    const warnings: string[] = [];
    expect(
      forwardEquity(
        usd,
        plain.slice(0, -1),
        { AAA: longBars.AAA.slice(0, 8) },
        () => 0,
        plain.at(-1)!,
        false,
        undefined,
        base,
        (r) => warnings.push(r),
      ),
    ).toBe(1);
    expect(warnings).toEqual([]);
  });
});
