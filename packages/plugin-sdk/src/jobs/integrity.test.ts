// Layer E on stored data: core vs reference and incremental vs full over the canonical bars.
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import { createUser, registerVersion, schema, setSetting, storeFx, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyPlugins } from '../registry';
import type { BarSource } from '../types';
import { integrity } from './integrity';
import { runJob } from './run';
import { cashRates, fakeNotifier, quiet, testInfo } from './testkit';

const reference = vi.hoisted(() => ({ flip: false }));
vi.mock('@saku/reference', async (load) => {
  const actual = await load<typeof import('@saku/reference')>();
  return {
    ...actual,
    // A reference that disagrees on one day, to see the check fail.
    refEvaluate: (...args: Parameters<typeof actual.refEvaluate>) => {
      const days = actual.refEvaluate(...args);
      if (reference.flip) days[days.length - 5]!.allocation = 'Flipped';
      return days;
    },
  };
});
afterEach(() => void (reference.flip = false));

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2024-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const TARGET = '2026-01-16';
const DATES = sessions.between('2024-06-03', TARGET);

/** A wavy walk, so the trend signal switches several times. */
const closes = DATES.map((_, i) => 100 * (1 + 0.15 * Math.sin(i / 15)) * 1.0003 ** i);
/** A day whose bars come without a low (a range volatility has no value over it). */
const NO_LOW = DATES[DATES.length - 8]!;
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
              ...(date !== NO_LOW && {
                low: Math.min(closes[i]!, closes[i - 1] ?? Infinity) * 0.999,
              }),
              close: closes[i]!,
              closeIsSplitAdjusted: false,
              volume: 1000,
              divCash: i % 63 === 62 ? 0.4 : 0,
              splitFactor: 1,
            },
          ]
        : [],
    );
  },
});

async function setup(o: { cash?: boolean } = {}) {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
    { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
  ]);
  const owner = await createUser(db, {
    username: 'alex',
    passwordHash: 'x',
    totpSecretEnc: 'x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  await setSetting(db, 'forward_records_from', '2026-01-02');
  await registerVersion(db, {
    ownerId: owner,
    name: 'Trend',
    strategy: {
      name: 'Trend',
      account: 'taxable',
      costs: { slippageBps: 5 },
      safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [
        {
          id: 'A',
          type: 'compare',
          left: { indicator: 'price', ticker: 'AAA', totalReturn: true },
          op: '>',
          right: { indicator: 'sma', ticker: 'AAA', length: 20, totalReturn: true },
        },
      ],
      allocations: [
        { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'AAA?L=2', weight: 100 }] },
        { name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      ],
    },
  });
  const ctx = () => ({ http: null as never, now: new Date('2026-01-17T01:30:00Z'), log: quiet });
  const r = await runJob(
    db,
    {
      ...emptyPlugins(),
      bars: [source('p'), source('s')],
      series: o.cash === false ? [] : [cashRates(sessions, DATES, TARGET)],
    },
    {
      job: 'bootstrap',
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
    },
  );
  return { db, ok: r.ok, owner };
}

describe('integrity (layer E)', () => {
  it('core and reference agree, and each sampled day equals the full pass', async () => {
    const { db, ok } = await setup();
    expect(ok).toBe(true);
    const results = await integrity(db, { to: TARGET, sessions });
    expect(results.map((r) => [r.check, r.status])).toEqual([
      ['core_vs_reference', 'green'],
      ['incremental_vs_full', 'green'],
    ]);
    expect(results[0]!.deviation).toBeLessThanOrEqual(1e-9);
  });

  it('a disagreement is red and names the day', async () => {
    const { db } = await setup();
    reference.flip = true;
    const [ref] = await integrity(db, { to: TARGET, sessions });
    expect(ref).toMatchObject({ check: 'core_vs_reference', status: 'red' });
    expect(ref!.message).toMatch(/allocation .* vs Flipped/);
  });

  // docs/indicators.md "Costs": a version registered after C2's cost freeze with a cost omitted
  // is a fault (red, named), never run as 0; one registered before still reads it as 0.
  it('a post-C2 version with an omitted cost is red for that reason; a pre-C2 one is not', async () => {
    const { db, owner } = await setup();
    const definition = {
      name: 'Frozen',
      account: 'taxable',
      costs: { slippageBps: 5 },
      safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [],
      allocations: [{ name: 'All', holdings: [{ ticker: 'AAA', weight: 100 }] }],
    };
    await registerVersion(db, {
      ownerId: owner,
      name: 'Frozen',
      strategy: definition,
      costsResolved: true,
    });
    const results = await integrity(db, { to: TARGET, sessions });
    expect(results.map((r) => [r.message!.split(' (')[0], r.check, r.status])).toEqual([
      ['Trend', 'core_vs_reference', 'green'],
      ['Trend', 'incremental_vs_full', 'green'],
      ['Frozen', 'core_vs_reference', 'red'],
      ['Frozen', 'incremental_vs_full', 'red'],
    ]);
    expect(results[2]!.message).toMatch(
      /core could not evaluate: Error: costs not resolved: feePct/,
    );
  });

  it('without a cash rate: a 1x strategy still agrees; one that needs cash is red alone', async () => {
    const { db, owner } = await setup({ cash: false });
    await registerVersion(db, {
      ownerId: owner,
      name: 'Always in',
      strategy: {
        name: 'Always in',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [
          {
            id: 'A',
            type: 'compare',
            left: { indicator: 'price', ticker: 'AAA' },
            op: '>',
            right: { indicator: 'sma', ticker: 'AAA', length: 20 },
          },
        ],
        allocations: [
          { name: 'Up', when: { all: ['A'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
          { name: 'Down', holdings: [{ ticker: 'AAA', weight: 100 }] },
        ],
      },
    });
    const results = await integrity(db, { to: TARGET, sessions });
    expect(results.map((r) => [r.message!.split(' (')[0], r.check, r.status])).toEqual([
      ['Trend', 'core_vs_reference', 'red'],
      ['Trend', 'incremental_vs_full', 'red'],
      ['Always in', 'core_vs_reference', 'green'],
      ['Always in', 'incremental_vs_full', 'green'],
    ]);
    expect(results[0]!.message).toMatch(/core could not evaluate/);
  });

  // docs/indicators.md "Days without a decision": a session without a decision holds the safe
  // state, here a ticker no allocation holds; its bars are loaded (no "No bars for BBB").
  it('a version holding CASH_BASE: core and reference get the same base inputs and agree', async () => {
    const { db, owner } = await setup();
    await setSetting(db, 'base_currency', 'XXX');
    await db
      .insert(schema.sourceRoles)
      .values({ dataKind: 'fx', pluginKey: 'fp', role: 'primary', position: 0 });
    // A rate for each session, published the evening before (known before its open).
    await storeFx(db, {
      source: 'fp',
      kind: 'valuation',
      rates: DATES.map((date, i) => ({
        pair: 'USDXXX',
        date,
        rate: 150 * (1 + 0.05 * Math.sin(i / 7)),
        publishedAt: `${sessions.between('2024-01-01', date).at(-2) ?? '2024-01-01'}T22:00:00Z`,
      })),
      fetchedAt: '2026-01-17T00:00:00Z',
    });
    await registerVersion(db, {
      ownerId: owner,
      name: 'Deposit',
      costsResolved: true,
      strategy: {
        name: 'Deposit',
        account: 'taxable',
        costs: { slippageBps: 5, feePct: 0.1, fxSpreadPct: 0.3 },
        safeState: { holdings: [{ ticker: 'CASH_BASE', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [
          {
            id: 'A',
            type: 'compare',
            left: { indicator: 'price', ticker: 'AAA', totalReturn: true },
            op: '>',
            right: { indicator: 'sma', ticker: 'AAA', length: 20, totalReturn: true },
          },
        ],
        allocations: [
          { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
          {
            name: 'Out',
            holdings: [
              { ticker: 'CASH_BASE', weight: 70 },
              { ticker: 'CASH_USD', weight: 30 },
            ],
          },
        ],
      },
    });
    const statuses = async () =>
      (await integrity(db, { to: TARGET, sessions }))
        .filter((r) => r.message!.startsWith('Deposit'))
        .map((r) => [r.check, r.status, r.message]);
    // No deposit rate yet: core cannot value CASH_BASE (never 0), so both checks are red.
    expect(await statuses()).toEqual([
      ['core_vs_reference', 'red', expect.stringMatching(/No deposit rate known/)],
      ['incremental_vs_full', 'red', expect.stringMatching(/No deposit rate known/)],
    ]);
    // Entered before the history it covers (point in time: a rate added later is not known on
    // earlier dates, so this test writes it as if entered then).
    await db.insert(schema.depositRates).values({
      ratePct: '0.4',
      fromDate: DATES[0]!,
      currency: 'XXX',
      actor: 't',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    expect(await statuses()).toEqual([
      ['core_vs_reference', 'green', expect.any(String)],
      ['incremental_vs_full', 'green', expect.any(String)],
    ]);
  }, 30_000);

  it('a safe state no allocation holds, over a session without a decision', async () => {
    const { db, owner } = await setup();
    await registerVersion(db, {
      ownerId: owner,
      name: 'Range',
      strategy: {
        name: 'Range',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'BBB', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [
          {
            id: 'A',
            type: 'compare',
            left: { indicator: 'volatility', method: 'parkinson', ticker: 'AAA', length: 1 },
            op: '<',
            right: { threshold: 1e6 },
          },
        ],
        allocations: [
          { name: 'In', when: { all: ['A'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
          { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        ],
      },
    });
    const results = await integrity(db, { to: TARGET, sessions });
    const range = results.filter((r) => r.message!.startsWith('Range'));
    expect(range.map((r) => [r.check, r.status, r.message])).toEqual([
      ['core_vs_reference', 'green', expect.not.stringMatching(/No bars/)],
      ['incremental_vs_full', 'green', expect.not.stringMatching(/No bars/)],
    ]);
  });
});
