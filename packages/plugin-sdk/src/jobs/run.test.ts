// A whole daily run with in-memory plug-ins (no network): ingest, checks, forward record,
// alerts, and how an incomplete run is reported.
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  addChannel,
  createUser,
  forwardRecord,
  registerVersion,
  schema,
  setSetting,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { emptyPlugins } from '../registry';
import type { BarSource, Notifier } from '../types';
import { type RunOptions, runJob } from './run';
import { cashRates, fakeNotifier, quiet, testInfo } from './testkit';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-12-01',
  validTo: '2026-12-31',
  holidays: [],
});
const TARGET = '2026-01-16';
const DATES = sessions.between('2025-12-29', TARGET);
const SECRET = 'r'.repeat(32);
const closes = DATES.map((_, i) => 100 * 1.002 ** i);
const barSource = (
  key: string,
  broken = false,
  /** A close the source now reports differently (a late correction). */
  revise?: { date: string; factor: number },
): BarSource & { calls: number } => {
  const s = {
    info: testInfo(key, 'bar'),
    calls: 0,
    async fetchBars(_ticker: string, from: string, to: string): Promise<RawBar[]> {
      s.calls++;
      if (broken) throw new Error(`${key}: HTTP 500`);
      const at = (i: number) => closes[i]! * (DATES[i] === revise?.date ? revise!.factor : 1);
      return DATES.flatMap((date, i) =>
        date >= from && date <= to
          ? [
              {
                date,
                open: at(i),
                high: at(i),
                low: at(i),
                close: at(i),
                closeIsSplitAdjusted: false,
                volume: 1000,
                divCash: 0,
                splitFactor: 1,
              },
            ]
          : [],
      );
    },
  };
  return s;
};
const rates = cashRates(sessions, DATES, TARGET);

async function setup() {
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
  const version = await registerVersion(db, {
    ownerId: owner,
    name: 'Trend',
    at: new Date('2026-01-14T22:00:00Z'),
    strategy: {
      name: 'Trend',
      account: 'taxable',
      safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [
        {
          id: 'A',
          type: 'compare',
          left: { indicator: 'price', ticker: 'AAA' },
          op: '>',
          right: { indicator: 'sma', ticker: 'AAA', length: 3 },
        },
      ],
      allocations: [
        { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
        { name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      ],
    },
  });
  await addChannel(db, owner, { type: 'fake', target: 'me', authSecret: SECRET });
  await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
  return { db, version };
}

function options(
  notifier: Notifier,
  over: Partial<RunOptions> = {},
): RunOptions & {
  hooks: string[];
} {
  const hooks: string[] = [];
  return {
    job: 'daily',
    target: TARGET,
    sessions,
    seriesSessions: sessions,
    now: new Date('2026-01-17T01:30:00Z'),
    clock: () => new Date('2026-01-17T01:30:00Z'),
    log: quiet,
    context: () => ({ http: null as never, now: new Date(), log: quiet }),
    alerting: {
      date: TARGET,
      notifiers: [notifier],
      authSecret: SECRET,
      context: () => ({ http: null as never, now: new Date(), log: quiet }),
      log: quiet,
    },
    tsa: { authorities: [] },
    code: 'test',
    afterDaily: async () => void hooks.push('backup'),
    onComplete: async () => {
      hooks.push('heartbeat');
      return true;
    },
    hooks,
    ...over,
  };
}

const plugins = (bars: BarSource[]) => ({ ...emptyPlugins(), bars, series: [rates] });

describe('a daily run', () => {
  it('completes: records the days since registration and tells the owner', async () => {
    const { db, version } = await setup();
    const { notifier, sent } = fakeNotifier();
    const o = options(notifier);
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), o);
    expect(r).toMatchObject({ ok: true });
    expect(o.hooks).toEqual(['backup', 'heartbeat']);
    const record = await forwardRecord(db, version.id);
    expect(record.map((e) => [e.date, e.allocation, e.dataStatus])).toEqual([
      ['2026-01-15', 'Risk on', 'green'],
      ['2026-01-16', 'Risk on', 'green'],
    ]);
    expect(record.every((e) => e.equity !== null)).toBe(true);
    // Both of the owner's channels (the admin one also gets operational alerts).
    expect(sent.map((m) => m.target)).toEqual(['me', 'ops']);
    expect(sent[0]!.text).toContain('First recorded allocation: Risk on (signal of 2026-01-16).');
    const [run] = await db.select().from(schema.jobRuns);
    expect(run).toMatchObject({ status: 'success', heartbeatSent: true });
  });

  it('a failing source leaves it incomplete: no heartbeat, the admins are told', async () => {
    const { db } = await setup();
    const { notifier, sent } = fakeNotifier();
    const o = options(notifier);
    const r = await runJob(db, plugins([barSource('p'), barSource('s', true)]), o);
    expect(r).toMatchObject({ ok: false, error: 'incomplete: s' });
    expect(o.hooks).toEqual(['backup']);
    const ops = sent.filter((m) => m.target === 'ops').map((m) => m.text);
    expect(ops.some((t) => t.startsWith('Saku: data for 2026-01-16 is not green'))).toBe(true);
    expect(ops.some((t) => t.startsWith('Saku: the daily run for 2026-01-16 did not finish'))).toBe(
      true,
    );
    const [run] = await db.select().from(schema.jobRuns);
    expect(run).toMatchObject({ status: 'failed', heartbeatSent: false });
  });

  it('a failed backup fails the run, even when every step finished', async () => {
    const { db } = await setup();
    const { notifier, sent } = fakeNotifier();
    const o = options(notifier, {
      afterDaily: async () => {
        throw new Error('disk full');
      },
    });
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), o);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disk full');
    expect(o.hooks).toEqual([]);
    expect(sent.some((m) => m.target === 'ops' && m.text.includes('did not finish'))).toBe(true);
  });

  it('an undelivered alert leaves the run incomplete (tried again at the next check)', async () => {
    const { db } = await setup();
    const { notifier } = fakeNotifier(['me']);
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(r).toMatchObject({ ok: false, error: 'incomplete: alerts' });
    const again = fakeNotifier();
    const second = await runJob(
      db,
      plugins([barSource('p'), barSource('s')]),
      options(again.notifier),
    );
    expect(second.ok).toBe(true);
    // Only what was not delivered before.
    expect(again.sent.map((m) => m.target)).toEqual(['me']);
  });

  it('without the cash calendar it fails before any request', async () => {
    const { db } = await setup();
    const { notifier } = fakeNotifier();
    const primary = barSource('p');
    const r = await runJob(
      db,
      plugins([primary, barSource('s')]),
      options(notifier, { seriesSessions: undefined }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('No us-fed calendar');
    expect(primary.calls).toBe(0);
  });

  it('weekly: the full refetch reports what changed, recomputes, and runs layer E', async () => {
    const { db } = await setup();
    const { notifier, sent } = fakeNotifier();
    expect(
      (await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier))).ok,
    ).toBe(true);
    // Both sources now report a corrected bar for an early day (open, high, low and close).
    const fix = { date: '2026-01-05', factor: 1.0001 };
    const o = options(notifier, { job: 'weekly' });
    const r = await runJob(
      db,
      plugins([barSource('p', false, fix), barSource('s', false, fix)]),
      o,
    );
    expect(r).toMatchObject({ ok: true });
    // No backup or heartbeat (the daily run's).
    expect(o.hooks).toEqual([]);
    const ops = sent.filter((m) => m.target === 'ops').map((m) => m.text);
    expect(
      ops.find((t) => t.startsWith('Saku: the weekly refetch changed 8 stored values')),
    ).toContain('AAA close@p 1 (2026-01-05), AAA high@p 1 (2026-01-05)');
    const e = await db.select().from(schema.checkSummaries);
    expect(e.filter((x) => x.layer === 'E').map((x) => [x.checkName, x.passed])).toEqual([
      ['core_vs_reference', 1],
      ['incremental_vs_full', 1],
    ]);
  });
});
