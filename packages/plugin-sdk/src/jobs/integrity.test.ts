// Layer E on stored data: core vs reference and incremental vs full over the canonical bars.
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import { createUser, registerVersion, setSetting, upsertSymbols } from '@saku/db';
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
  await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
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
    const results = await integrity(db, { to: TARGET });
    expect(results.map((r) => [r.check, r.status])).toEqual([
      ['core_vs_reference', 'green'],
      ['incremental_vs_full', 'green'],
    ]);
    expect(results[0]!.deviation).toBeLessThanOrEqual(1e-9);
  });

  it('a disagreement is red and names the day', async () => {
    const { db } = await setup();
    reference.flip = true;
    const [ref] = await integrity(db, { to: TARGET });
    expect(ref).toMatchObject({ check: 'core_vs_reference', status: 'red' });
    expect(ref!.message).toMatch(/allocation .* vs Flipped/);
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
    const results = await integrity(db, { to: TARGET });
    expect(results.map((r) => [r.message!.split(' (')[0], r.check, r.status])).toEqual([
      ['Trend', 'core_vs_reference', 'red'],
      ['Trend', 'incremental_vs_full', 'red'],
      ['Always in', 'core_vs_reference', 'green'],
      ['Always in', 'incremental_vs_full', 'green'],
    ]);
    expect(results[0]!.message).toMatch(/core could not evaluate/);
  });
});
