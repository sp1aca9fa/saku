import type { CheckLayer, HealthStatus } from '@saku/core';
import { Sessions } from '@saku/data';
import { finishRun, schema, startRun, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type DayReport, daysVerdict } from './health';
import {
  type DateRow,
  findRun,
  groupDates,
  runSummary,
  summaryGroupDates,
  summaryGroupRows,
  summaryVerdict,
} from './health-summary';
import { ValuesReader, family, fmt, resultLine, sampleDates } from './health-values';
import { verify } from './verify';

const NOW = '2026-01-10T00:00:00.000Z';
const FETCHED = '2026-01-08T00:00:00.000Z';

/**
 * A fund LEV (2x its underlying UND, index series IDX) split 2:1 on 2026-01-07, where both pay a
 * dividend (UND 1, LEV 0.25: the layer C blocks read total returns); the primary `p`
 * sends raw closes, the secondary `s2` split-adjusted ones (with provider adjusted closes); `s3`
 * has a role but no bar. Index values from `idx` (primary, two vintages on 01-07) and `idx2`
 * (withdrawn on 01-07); FX rates of two pairs from `fp` (primary) and `fs`.
 */
async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [{ ticker: 'UND', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  await upsertSymbols(db, [
    {
      ticker: 'LEV',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      leverageFactor: 2,
      underlying: 'UND',
      indexSeries: 'IDX',
    },
  ]);
  const ids = { UND: (await symbolId(db, 'UND'))!, LEV: (await symbolId(db, 'LEV'))! };
  await db.insert(schema.sourceRoles).values([
    { dataKind: 'bars', pluginKey: 'p', role: 'primary', position: 0 },
    { dataKind: 'bars', pluginKey: 's2', role: 'secondary', position: 1 },
    { dataKind: 'bars', pluginKey: 's3', role: 'secondary', position: 2 },
    { dataKind: 'series', pluginKey: 'idx', role: 'primary', position: 0 },
    { dataKind: 'series', pluginKey: 'idx2', role: 'secondary', position: 1 },
    { dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 },
    { dataKind: 'fx', pluginKey: 'fs', role: 'secondary', position: 1 },
  ]);
  const raw = (
    symbol: number,
    source: string,
    date: string,
    close: number,
    o: { split?: number; adjusted?: boolean; adj?: number; div?: number } = {},
  ) => ({
    symbolId: symbol,
    source,
    date,
    close,
    splitFactor: o.split ?? 1,
    divCash: o.div ?? 0,
    closeIsSplitAdjusted: o.adjusted ?? false,
    providerAdjClose: o.adj ?? null,
    fetchedAt: FETCHED,
  });
  await db.insert(schema.barsRaw).values([
    raw(ids.UND, 'p', '2026-01-05', 100),
    raw(ids.UND, 'p', '2026-01-06', 102),
    raw(ids.UND, 'p', '2026-01-07', 101, { div: 1 }),
    raw(ids.LEV, 'p', '2026-01-05', 100),
    raw(ids.LEV, 'p', '2026-01-06', 104),
    raw(ids.LEV, 'p', '2026-01-07', 51, { split: 2, div: 0.25 }),
    raw(ids.LEV, 's2', '2026-01-05', 50, { adjusted: true }),
    raw(ids.LEV, 's2', '2026-01-06', 52.05, { adjusted: true, adj: 52.05 }),
    raw(ids.LEV, 's2', '2026-01-07', 51, { adjusted: true, split: 2, adj: 51.2 }),
    // After the run's target: left out, as verify left them out. The s2 split after the target
    // must not un-split the earlier s2 closes (it would double them).
    raw(ids.LEV, 'p', '2026-01-08', 60),
    raw(ids.LEV, 's2', '2026-01-08', 30, { adjusted: true, split: 2, adj: 30 }),
  ]);
  await db.insert(schema.bars).values({
    symbolId: ids.LEV,
    date: '2026-01-06',
    close: 104,
    adjClose: 1.04,
    source: 'p',
    standIn: false,
    status: 'yellow',
  });
  await db.insert(schema.barRevisions).values({
    symbolId: ids.LEV,
    date: '2026-01-07',
    source: 's2',
    field: 'close',
    oldValue: 51.1,
    newValue: 51,
    detectedAt: '2026-01-09T00:00:00.000Z',
  });
  const at = (d: string) => `${d}T22:00:00.000Z`;
  await db.insert(schema.series).values([
    {
      series: 'IDX',
      source: 'idx',
      date: '2026-01-06',
      value: 1000,
      publishedAt: at('2026-01-06'),
      fetchedAt: at('2026-01-06'),
      knownAt: at('2026-01-06'),
    },
    {
      series: 'IDX',
      source: 'idx',
      date: '2026-01-07',
      value: 990,
      publishedAt: at('2026-01-07'),
      fetchedAt: at('2026-01-07'),
      knownAt: at('2026-01-07'),
    },
    {
      series: 'IDX',
      source: 'idx',
      date: '2026-01-07',
      value: 985,
      publishedAt: at('2026-01-08'),
      fetchedAt: at('2026-01-08'),
      knownAt: at('2026-01-08'),
    },
    {
      series: 'IDX',
      source: 'idx2',
      date: '2026-01-06',
      value: 1000.5,
      publishedAt: null,
      fetchedAt: at('2026-01-06'),
      knownAt: at('2026-01-06'),
    },
    {
      series: 'IDX',
      source: 'idx2',
      date: '2026-01-07',
      value: 990,
      publishedAt: null,
      fetchedAt: at('2026-01-07'),
      knownAt: at('2026-01-07'),
    },
  ]);
  await db.insert(schema.seriesWithdrawals).values({
    series: 'IDX',
    source: 'idx2',
    date: '2026-01-07',
    publishedAt: null,
    fetchedAt: at('2026-01-08'),
    knownAt: at('2026-01-08'),
  });
  const fx = (pair: string, source: string, date: string, rate: number) => ({
    pair,
    source,
    date,
    rate,
    kind: 'valuation' as const,
    publishedAt: null,
    fetchedAt: at(date),
    knownAt: at(date),
  });
  await db
    .insert(schema.fxRates)
    .values([
      fx('USDEUR', 'fp', '2026-01-07', 0.9),
      fx('USDEUR', 'fs', '2026-01-07', 0.95),
      fx('USDGBP', 'fp', '2026-01-07', 0.8),
      fx('USDGBP', 'fs', '2026-01-07', 0.8),
      fx('USDGBP', 'fs', '2026-01-06', 0.79),
    ]);

  const run = await startRun(db, 'bootstrap', new Date('2026-01-09T00:00:00Z'));
  await finishRun(db, run, { ok: true, datesProcessed: ['2026-01-07'] });
  const result = (o: {
    date: string;
    layer: CheckLayer;
    check: string;
    status: HealthStatus;
    symbol: number | null;
    source: string | null;
    observed?: number;
  }) =>
    db.insert(schema.checkResults).values({
      runId: run,
      layer: o.layer,
      checkName: o.check,
      symbolId: o.symbol,
      source: o.source,
      date: o.date,
      status: o.status,
      observed: o.observed ?? null,
      expected: null,
      tolerance: null,
      message: null,
    });
  await result({
    date: '2026-01-06',
    layer: 'B',
    check: 'close_match',
    status: 'yellow',
    symbol: ids.LEV,
    source: 's2',
    observed: 104.10000000000001,
  });
  await result({
    date: '2026-01-07',
    layer: 'B',
    check: 'adj_return_match',
    status: 'red',
    symbol: ids.LEV,
    source: 's2',
  });
  await result({
    date: '2026-01-07',
    layer: 'C',
    check: 'leverage_track',
    status: 'yellow',
    symbol: ids.LEV,
    source: null,
  });
  await result({
    date: '2026-01-07',
    layer: 'C',
    check: 'index_match',
    status: 'red',
    symbol: ids.LEV,
    source: 'idx',
  });
  await result({
    date: '2026-01-07',
    layer: 'B',
    check: 'fx_match',
    status: 'red',
    symbol: null,
    source: 'fs',
  });
  await result({
    date: '2026-01-06',
    layer: 'B',
    check: 'fx_unavailable',
    status: 'yellow',
    symbol: null,
    source: 'fs',
  });
  await result({
    date: '2026-01-07',
    layer: 'A',
    check: 'missing_day',
    status: 'yellow',
    symbol: ids.LEV,
    source: 's3',
  });
  await result({
    date: '2026-01-07',
    layer: 'D',
    check: 'nav_match',
    status: 'yellow',
    symbol: ids.LEV,
    source: 'issuer',
  });
  await db.insert(schema.dataHealth).values([
    {
      runId: run,
      date: '2026-01-07',
      symbolId: null,
      status: 'red',
      reasons: ['USDEUR:B.fx_match@fs', 'LEV'],
    },
    { runId: run, date: '2026-01-06', symbolId: null, status: 'yellow', reasons: ['LEV'] },
  ]);
  const reader = new ValuesReader(db, { runId: run, to: '2026-01-07', now: NOW });
  const values = async (check: string) => {
    const { rows } = await groupDates(db, run, { check });
    return (await reader.lines(rows[0]!)).join('\n');
  };
  return { db, ids, run, reader, values };
}

describe('sampleDates', () => {
  const dates = Array.from({ length: 11 }, (_, i) => `d${i}`);
  it('takes every date when there are no more than N', () => {
    expect(sampleDates(['a', 'b'], 5)).toEqual(['a', 'b']);
    expect(sampleDates(['a', 'b', 'c'], 3)).toEqual(['a', 'b', 'c']);
    expect(sampleDates([], 5)).toEqual([]);
  });
  it('always keeps the first and the last, evenly spread, never repeated', () => {
    expect(sampleDates(dates, 2)).toEqual(['d0', 'd10']);
    expect(sampleDates(dates, 3)).toEqual(['d0', 'd5', 'd10']);
    expect(sampleDates(dates, 5)).toEqual(['d0', 'd3', 'd5', 'd8', 'd10']);
    const ten = sampleDates(dates, 10);
    expect(new Set(ten).size).toBe(10);
    expect([ten[0], ten.at(-1)]).toEqual(['d0', 'd10']);
  });
  it('one date is the first; a size that is no whole number from 1 is refused', () => {
    expect(sampleDates(dates, 1)).toEqual(['d0']);
    expect(() => sampleDates(dates, 0)).toThrow();
    expect(() => sampleDates(dates, 2.5)).toThrow();
  });
});

describe('fmt', () => {
  it('prints up to 10 significant digits without float noise, missing as -', () => {
    expect(fmt(1.2300000000000002)).toBe('1.23');
    expect(fmt(0.1 + 0.2)).toBe('0.3');
    expect(fmt(-0.019230769230769273)).toBe('-0.01923076923');
    expect(fmt(0)).toBe('0');
    expect(fmt(null)).toBe('-');
    expect(fmt(undefined)).toBe('-');
    expect(fmt(Infinity)).toBe('Infinity');
  });
});

describe('family', () => {
  it('knows what each check compares, and nothing it does not', () => {
    const f = (layer: CheckLayer, check: string, symbolId: number | null = 1) =>
      family({ layer, check, symbolId });
    expect(f('A', 'large_move')).toBe('bars');
    expect(f('B', 'secondary_missing')).toBe('bars');
    expect(f('B', 'dividend_match')).toBe('bars');
    expect(f('B', 'dividend_pending')).toBe('bars');
    expect(f('B', 'adj_return_match')).toBe('adj_return');
    expect(f('C', 'leverage_track')).toBe('leverage');
    expect(f('C', 'index_unavailable')).toBe('index');
    expect(f('B', 'fx_match', null)).toBe('fx');
    expect(f('B', 'fx_match')).toBe('other');
    expect(f('B', 'close_match', null)).toBe('other');
    expect(f('D', 'nav_match')).toBe('other');
    expect(f('C', 'close_match')).toBe('other');
  });
});

describe('ValuesReader', () => {
  it('bar checks: every source on the date and the primary previous one, as stored and compared', async () => {
    const { values } = await setup();
    const text = await values('close_match');
    const lines = text.split('\n');
    const row = (date: string, source: string) =>
      lines
        .find((l) => l.includes(date) && l.includes(source))!
        .trim()
        .split(/\s{2,}/);
    // p: raw closes; s2 split-adjusted, un-split for the comparison (the split after 01-06).
    expect(row('2026-01-05', 'p (primary)')).toEqual([
      '2026-01-05',
      'p (primary)',
      '100',
      'no',
      '1',
      '0',
      '-',
      '100',
      '0',
    ]);
    expect(row('2026-01-06', 's2')).toEqual([
      '2026-01-06',
      's2',
      '52.05',
      'yes',
      '1',
      '0',
      '52.05',
      '104.1',
      '0',
    ]);
    // A source with a role but no bar is shown, never left out.
    expect(row('2026-01-06', 's3')).toEqual(['2026-01-06', 's3', 'no bar']);
    // Not the date after (01-07) nor the bar after the run's target.
    expect(text).not.toContain('2026-01-07');
    expect(text).not.toContain('2026-01-08');
    expect(text).toMatch(/2026-01-06\s+104\s+1\s+0\s+1\.04\s+p\s+no\s+yellow/);
    expect(text).toMatch(/2026-01-05\s+no canonical bar/);
  });

  it('un-splits only up to the run target: a split after it leaves the compared closes as they were', async () => {
    const { values } = await setup();
    const text = await values('close_match');
    // s2 01-05 50 and 01-06 52.05, times the 01-07 split (2) only; with the 01-08 split (2) too
    // they would read 200 and 208.2.
    expect(text).toMatch(/2026-01-05\s+s2\s+50\s+yes\s+1\s+0\s+-\s+100\s+0/);
    expect(text).toMatch(/2026-01-06\s+s2\s+52\.05\s+yes\s+1\s+0\s+52\.05\s+104\.1\s+0/);
  });

  it('layer A: the date, the primary previous one; revisions on a shown date are listed', async () => {
    const { values } = await setup();
    const text = await values('missing_day');
    expect(text).toMatch(/2026-01-07\s+s3\s+no bar/);
    expect(text).toMatch(/2026-01-06\s+p \(primary\)\s+104/);
    expect(text).toMatch(/revised\s+date\s+source\s+field\s+old\s+new\s+detected/);
    expect(text).toMatch(/2026-01-07\s+s2\s+close\s+51\.1\s+51\s+2026-01-09T00:00:00\.000Z/);
  });

  it('adj_return_match: our return and the provider return as the check computes them', async () => {
    const { values } = await setup();
    const text = await values('adj_return_match');
    // Ours: ((51 + 0.25) * 2) / 104 - 1; theirs: 51.2 / 52.05 - 1.
    expect(text).toContain(
      'returns 2026-01-06 to 2026-01-07: ours -0.01442307692; s2 adjusted 52.05 to 51.2, ' +
        'return -0.01633045149; difference 0.001907374566; tolerance 0.0002; status now red',
    );
  });

  it('leverage_track: both symbols on both dates, the returns, expected and tolerance', async () => {
    const { values } = await setup();
    const text = await values('leverage_track');
    expect(text).toMatch(/LEV\s+2026-01-07\s+51\s+2\s+0\.25/);
    expect(text).toMatch(/UND\s+2026-01-06\s+102\s+1\s+0/);
    expect(text).toMatch(/UND\s+2026-01-07\s+101\s+1\s+1/);
    // As leverageCheck compares now, total returns on both sides (spec layer-c-dividends): fund
    // ((51 + 0.25) * 2) / 104 - 1; expected 2 * ((101 + 1) / 102 - 1) = 0 (with the underlying's
    // price return it would be -0.0196); tolerance 0.005 + 0.1 * |expected|.
    expect(text).toContain(
      'fund total return -0.01442307692; underlying total return 0; leverage 2; ' +
        'expected 0; difference 0.01442307692; tolerance 0.005; status now yellow',
    );
    // One day outside tolerance: no streak.
    expect(text).not.toContain('streak');
    expect(text).toMatch(/revised\s+date\s+symbol/);
  });

  it('index_match: every source as read now (vintages, withdrawals) and the two returns', async () => {
    const { values } = await setup();
    const text = await values('index_match');
    // The newer vintage holds; two stored.
    expect(text).toMatch(
      /2026-01-07\s+idx \(primary\)\s+985\s+2026-01-08T22:00:00\.000Z\s+2026-01-08T22:00:00\.000Z\s+2/,
    );
    // Withdrawn now: no value, never the old one.
    expect(text).toMatch(/2026-01-07\s+idx2\s+- \(withdrawn\)\s+-\s+-\s+2/);
    expect(text).toMatch(/2026-01-06\s+idx2\s+1000\.5\s+2026-01-06T22:00:00\.000Z\s+-\s+1/);
    // The fund's total return, as indexCheck compares now: ((51 + 0.25) * 2) / 104 - 1.
    expect(text).toContain(
      'fund total return -0.01442307692; index return (idx) -0.015; difference 0.0005769230769; ' +
        'tolerance 0.001; status now green',
    );
    // The result names the series primary read now: no note.
    expect(text).not.toContain('the run compared');
  });

  it('index: a result from another series source than the primary now says so', async () => {
    const { db, run } = await setup();
    await db
      .update(schema.sourceRoles)
      .set({ pluginKey: 'idx3' })
      .where(
        and(eq(schema.sourceRoles.dataKind, 'series'), eq(schema.sourceRoles.role, 'primary')),
      );
    const fresh = new ValuesReader(db, { runId: run, to: '2026-01-07', now: NOW });
    const idx = (await groupDates(db, run, { check: 'index_match' })).rows[0]!;
    const text = (await fresh.lines(idx)).join('\n');
    expect(text).toContain('the run compared idx; read here: idx3 (the series primary now)');
    // idx3 has no value: no index return, never a guess.
    expect(text).toContain('returns: not comparable now (no idx3 value as read now)');
  });

  it('fx_match: the pair named by the run reason; without one, every pair that day', async () => {
    const { values } = await setup();
    const matched = await values('fx_match');
    expect(matched).toContain('the pair from the run');
    // verify compares only the valuation kind.
    expect(matched).toContain('compared: valuation');
    expect(matched).toMatch(/USDEUR\s+fp \(primary\)\s+valuation\s+0\.9\s/);
    expect(matched).toMatch(/USDEUR\s+fs\s+valuation\s+0\.95\s/);
    expect(matched).not.toContain('USDGBP');
    const unavailable = await values('fx_unavailable');
    expect(unavailable).toContain('every pair stored');
    expect(unavailable).toContain('compared: valuation');
    // The primary has no rate that day: listed as such.
    expect(unavailable).toMatch(/USDGBP\s+fp \(primary\)\s+-\s+none stored/);
    expect(unavailable).toMatch(/USDGBP\s+fs\s+valuation\s+0\.79\s/);
  });

  it('any other check: no values (the result line only)', async () => {
    const { values } = await setup();
    expect(await values('nav_match')).toBe('');
  });

  it('missing data stays unknown: no primary, no underlying, no index', async () => {
    const { db, run } = await setup();
    await db.update(schema.symbols).set({ underlyingSymbolId: null, indexSeries: null });
    const fresh = new ValuesReader(db, { runId: run, to: '2026-01-07', now: NOW });
    const lev = (await groupDates(db, run, { check: 'leverage_track' })).rows[0]!;
    const text = (await fresh.lines(lev)).join('\n');
    expect(text).toContain('no underlying is set now');
    expect(text).toContain('returns: not comparable now');
    const idx = (await groupDates(db, run, { check: 'index_match' })).rows[0]!;
    expect((await fresh.lines(idx)).join('\n')).toContain('no index series is set now');
  });
});

describe('ValuesReader against verify', () => {
  it('shows the same numbers verify stored for adj_return, leverage and index (full mode)', async () => {
    const { db } = await setup();
    const sessions = new Sessions({
      id: 't',
      version: 't',
      validFrom: '2025-01-01',
      validTo: '2026-12-31',
      holidays: [],
    });
    // A full pass stores only results not green: a later IDX vintage for 01-07 makes the index
    // comparison red (known before the run looks).
    await db.insert(schema.series).values({
      series: 'IDX',
      source: 'idx',
      date: '2026-01-07',
      value: 950,
      publishedAt: '2026-01-09T22:00:00.000Z',
      fetchedAt: '2026-01-09T22:00:00.000Z',
      knownAt: '2026-01-09T22:00:00.000Z',
    });
    const runId = await startRun(db, 'weekly', new Date('2026-01-09T12:00:00Z'));
    await verify(db, { runId, sessions, mode: 'full', to: '2026-01-07', now: new Date(NOW) });
    await finishRun(db, runId, { ok: true, datesProcessed: ['2026-01-07'] });
    const reader = new ValuesReader(db, { runId, to: '2026-01-07', now: NOW });
    const stored = await db
      .select()
      .from(schema.checkResults)
      .where(eq(schema.checkResults.runId, runId));
    const row = (check: string, date: string): DateRow => {
      const x = stored.find((s) => s.checkName === check && s.date === date);
      if (!x) throw new Error(`verify stored no ${check} on ${date}`);
      return {
        date: x.date,
        status: x.status,
        layer: x.layer,
        check,
        symbol: 'LEV',
        symbolId: x.symbolId,
        source: x.source,
        observed: x.observed,
        expected: x.expected,
        tolerance: x.tolerance,
        message: x.message,
      };
    };
    const adj = row('adj_return_match', '2026-01-07');
    const idx = row('index_match', '2026-01-07');
    expect((await reader.lines(adj)).join('\n')).toContain(
      `ours ${fmt(adj.expected)}; s2 adjusted 52.05 to 51.2, return ${fmt(adj.observed)}; ` +
        `difference ${fmt(Math.abs(adj.observed! - adj.expected!))}; tolerance ${fmt(adj.tolerance)}; ` +
        `status now ${adj.status}`,
    );
    const lev = row('leverage_track', '2026-01-07');
    expect((await reader.lines(lev)).join('\n')).toContain(
      `fund total return ${fmt(lev.observed)}; underlying total return ` +
        `${fmt(lev.expected! / 2)}; leverage 2; expected ${fmt(lev.expected)}; ` +
        `difference ${fmt(Math.abs(lev.observed! - lev.expected!))}; ` +
        `tolerance ${fmt(lev.tolerance)}; status now ${lev.status}`,
    );
    // Every number compared is stored (none of them unknown).
    for (const r of [adj, lev, idx]) {
      expect([r.observed, r.expected, r.tolerance].every((v) => typeof v === 'number')).toBe(true);
    }
    expect([idx.source, idx.status]).toEqual(['idx', 'red']);
    expect((await reader.lines(idx)).join('\n')).toContain(
      `fund total return ${fmt(idx.observed)}; index return (idx) ${fmt(idx.expected)}; ` +
        `difference ${fmt(Math.abs(idx.observed! - idx.expected!))}; tolerance ${fmt(idx.tolerance)}; ` +
        `status now ${idx.status}`,
    );
  });
});

describe('ValuesReader, a leverage streak', () => {
  it('shows the two days before a red streak day as compared now', async () => {
    const db = await testDb();
    await upsertSymbols(db, [{ ticker: 'UUU', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await upsertSymbols(db, [
      {
        ticker: 'FFF',
        tier: 0,
        assetClass: 'equity',
        currency: 'USD',
        leverageFactor: 2,
        underlying: 'UUU',
      },
    ]);
    const u = (await symbolId(db, 'UUU'))!;
    const f = (await symbolId(db, 'FFF'))!;
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'bars', pluginKey: 'p', role: 'primary', position: 0 });
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
    const bar = (symbol: number, date: string, close: number) => ({
      symbolId: symbol,
      source: 'p',
      date,
      close,
      splitFactor: 1,
      divCash: 0,
      closeIsSplitAdjusted: false,
      providerAdjClose: null,
      fetchedAt: FETCHED,
    });
    // The underlying flat, the fund up 2% a day: outside the 0.005 tolerance three days in a row.
    await db
      .insert(schema.barsRaw)
      .values([
        ...dates.map((d) => bar(u, d, 100)),
        ...dates.map((d, i) => bar(f, d, 100 * 1.02 ** i)),
      ]);
    const run = await startRun(db, 'bootstrap', new Date('2026-01-09T00:00:00Z'));
    await db.insert(schema.checkResults).values({
      runId: run,
      layer: 'C',
      checkName: 'leverage_track',
      symbolId: f,
      source: null,
      date: '2026-01-08',
      status: 'red',
      observed: 0.02,
      expected: 0,
      tolerance: 0.005,
      message: 'outside tolerance 3 days in a row',
    });
    const reader = new ValuesReader(db, { runId: run, to: '2026-01-08', now: NOW });
    const r = (await groupDates(db, run, { check: 'leverage_track' })).rows[0]!;
    const text = (await reader.lines(r)).join('\n');
    expect(text).toContain('status now red (outside tolerance 3 days in a row)');
    expect(text).toContain(
      'streak, the days before as compared now: 2026-01-06 difference 0.02, tolerance 0.005, red; ' +
        '2026-01-07 difference 0.02, tolerance 0.005, red',
    );
  });
});

describe('the run summary with values', () => {
  it('lists a group dates and its rows on sampled dates, and the result line in full', async () => {
    const { db, run } = await setup();
    const s = await runSummary(db, (await findRun(db, run))!);
    const g = s.groups.find((x) => x.check === 'close_match')!;
    expect(g.symbolId).not.toBeNull();
    expect(await summaryGroupDates(db, run, g)).toEqual(['2026-01-06']);
    const rows = await summaryGroupRows(db, run, g, ['2026-01-06']);
    expect(rows.map((r) => resultLine(r))).toEqual([
      '2026-01-06  yellow  observed 104.1  expected -  tolerance -  -',
    ]);
    expect(resultLine(rows[0]!, { full: true })).toBe(
      '2026-01-06  yellow  B  close_match  LEV  s2  observed 104.1  expected -  tolerance -  -',
    );
    const fx = s.groups.find((x) => x.check === 'fx_match')!;
    expect(await summaryGroupDates(db, run, fx)).toEqual(['2026-01-07']);
    expect(await summaryGroupRows(db, run, fx, [])).toEqual([]);
  });
});

describe('verdicts', () => {
  it('the summary: incomplete, all green or not', () => {
    expect(summaryVerdict({ complete: false, allGreen: false })).toBe('Verdict: incomplete run.');
    expect(summaryVerdict({ complete: true, allGreen: true })).toBe('Verdict: all green.');
    expect(summaryVerdict({ complete: true, allGreen: false })).toBe('Verdict: not all green.');
  });

  it('the days: counts red, yellow and not graded dates; never green without a date', () => {
    const day = (
      overall: DayReport['overall']['status'],
      symbols: DayReport['overall']['status'][] = [],
    ): DayReport => ({
      date: '2026-01-05',
      overall:
        overall === 'not_graded'
          ? { status: 'not_graded', reasons: [] }
          : { status: overall, reasons: [] },
      symbols: symbols.map((s, i) => ({
        ticker: `S${i}`,
        grade:
          s === 'not_graded' ? { status: 'not_graded', reasons: [] } : { status: s, reasons: [] },
      })),
      green: overall === 'green' && symbols.length === 0,
    });
    expect(daysVerdict([day('green'), day('green')])).toBe('Verdict: all green.');
    expect(daysVerdict([day('red'), day('yellow'), day('green'), day('yellow', ['red'])])).toBe(
      'Verdict: not all green (2 dates red, 1 yellow).',
    );
    expect(daysVerdict([day('red'), day('not_graded'), day('green', ['not_graded'])])).toBe(
      'Verdict: not all green (1 date red, 0 yellow, 2 not graded).',
    );
    expect(daysVerdict([])).toBe('Verdict: no date shown.');
  });
});
