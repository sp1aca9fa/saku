// `pnpm drill red` (spec 2026-10-31 red-drill): a simulated red day on a copy of a synthetic
// database (no network): the safe-state alert is sent, marked as a drill; the live database file
// is unchanged; the temporary copy is removed; it refuses without a registered strategy, on CI
// and while another job holds the lock.
import { type RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  type Db,
  addChannel,
  createDb,
  createUser,
  forwardRecord,
  registerVersion,
  setSetting,
  upsertSymbols,
} from '@saku/db';
import { migrateDb } from '@saku/db/migrate';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drillDate, parseDrillArgs } from '../cli/drill-args';
import { emptyPlugins } from '../registry';
import type { BarSource } from '../types';
import { type DrillOptions, type DrillReport, drillSummary, redDrill } from './drill';
import { lock } from './lock';
import { runJob } from './run';
import { cashRates, fakeNotifier, quiet, testInfo } from './testkit';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-11-01',
  validTo: '2026-12-31',
  holidays: [],
});
const TARGET = '2026-01-16';
const DATES = sessions.between('2025-12-01', TARGET);
const SECRET = 'f'.repeat(32);

/** SPY rising 0.3-0.7% a day, the same from every source. */
const history: RawBar[] = DATES.map((date, i) => {
  const close = 500 * 1.005 ** i * (1 + 0.002 * Math.sin(i));
  return {
    date,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    closeIsSplitAdjusted: false,
    volume: 1e6,
    divCash: 0,
    splitFactor: 1,
  };
});
const source = (key: string): BarSource => ({
  info: testInfo(key, 'bar'),
  async fetchBars(_ticker, from, to) {
    return history.filter((b) => b.date >= from && b.date <= to).map((b) => ({ ...b }));
  },
});
const plugins = () => ({
  ...emptyPlugins(),
  bars: [source('p'), source('s1'), source('s2')],
  series: [cashRates(sessions, DATES, TARGET)],
});
const strategy = {
  name: 'Trend',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'A',
      type: 'compare',
      left: { indicator: 'price', ticker: 'SPY' },
      op: '>',
      right: { indicator: 'sma', ticker: 'SPY', length: 3 },
    },
  ],
  allocations: [
    { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'SPY', weight: 100 }] },
    { name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  ],
};

/**
 * A live database file as the server holds it after the daily run for the target day (green, the
 * day recorded), the owner with a channel and an admin channel; `registered`: whether a strategy
 * is registered. Closed afterwards, as the drill finds it.
 */
async function live(o: { registered?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'saku-drill-test-'));
  const url = `file:${join(dir, 'live.db')}`;
  const db: Db = createDb({ url });
  await migrateDb(db);
  await upsertSymbols(db, [{ ticker: 'SPY', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  const owner = await createUser(db, {
    username: 'alex',
    passwordHash: 'x',
    totpSecretEnc: 'x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  await setSetting(db, 'forward_records_from', '2026-01-02');
  const version =
    o.registered === false
      ? undefined
      : await registerVersion(db, {
          ownerId: owner,
          name: 'Trend',
          at: new Date('2026-01-14T22:00:00Z'),
          strategy,
        });
  await addChannel(db, owner, { type: 'fake', target: 'me', authSecret: SECRET });
  await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
  const { notifier } = fakeNotifier();
  const job = (job: 'bootstrap' | 'daily', target: string, now: string) =>
    runJob(db, plugins(), {
      job,
      target,
      sessions,
      seriesSessions: sessions,
      now: new Date(now),
      clock: () => new Date(now),
      log: quiet,
      context: () => ({ http: null as never, now: new Date(now), log: quiet }),
      alerting: {
        date: target,
        notifiers: [notifier],
        authSecret: SECRET,
        context: () => ({ http: null as never, now: new Date(now), log: quiet }),
        log: quiet,
      },
      tsa: { authorities: [] },
      code: 'test',
    });
  expect((await job('bootstrap', sessions.before(TARGET), '2026-01-16T01:30:00Z')).ok).toBe(true);
  expect((await job('daily', TARGET, '2026-01-17T01:30:00Z')).ok).toBe(true);
  if (version) {
    // The real record for the day: green, the normal allocation.
    expect((await forwardRecord(db, version.id)).at(-1)).toMatchObject({
      date: TARGET,
      dataStatus: 'green',
      safeStateApplied: false,
    });
  }
  db.$client.close();
  return { dir, url, file: join(dir, 'live.db') };
}

const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function drill(url: string, dir: string, extra: Partial<DrillOptions> = {}) {
  const { notifier, sent } = fakeNotifier();
  const work = mkdtempSync(join(dir, 'work-'));
  const run = redDrill({
    url,
    plugins: plugins(),
    sessions,
    seriesSessions: sessions,
    target: TARGET,
    now: new Date('2026-01-17T03:00:00Z'),
    log: quiet,
    alerting: {
      notifiers: [notifier],
      authSecret: SECRET,
      context: () => () => ({ http: null as never, now: new Date(), log: quiet }),
    },
    env: {},
    lockDir: join(dir, 'locks'),
    workDir: work,
    ...extra,
  });
  return { run, sent, work };
}

describe('pnpm drill red', () => {
  it('sends the safe-state alert marked as a drill; the live database is not written', async () => {
    const { dir, url, file } = await live();
    const before = digest(file);
    const { run, sent, work } = drill(url, dir);
    const r = (await run) as DrillReport;

    expect(r.ok).toBe(true);
    expect(r.grade).toBe('red');
    expect(r.faults).toEqual([
      {
        ticker: 'SPY',
        source: 'p',
        close: history.at(-1)!.close,
        faulted: history.at(-1)!.close * 10,
      },
    ]);
    expect(r.reasons).toEqual(['SPY']);
    // Caught by layers A and B, as the fault suite's decimal shift is.
    expect(r.versions).toEqual([
      expect.objectContaining({
        name: 'Trend',
        allocation: 'Safe state',
        safeStateApplied: true,
        dataStatus: 'red',
        reasons: ['SPY:A.large_move@p', 'SPY:B.close_match@s1', 'SPY:B.close_match@s2'],
        // The owner's channel and their admin channel (an admin's channels get both).
        delivered: 2,
      }),
    ]);
    expect(r.problems).toEqual([]);

    // The owner's alert: marked in its title, nothing recorded, then the real safe-state text.
    const owner = sent.find((m) => m.target === 'me')!.text.split('\n');
    expect(owner[0]).toBe(`[DRILL] Trend: safe state for ${TARGET}`);
    expect(owner[1]).toMatch(/^This is a drill \(pnpm drill\): nothing was recorded/);
    expect(owner).toContain('Target: Cash (USD) 100%.');
    // The admins' data alert is marked too; every message the drill sent is.
    expect(sent.filter((m) => m.text.startsWith('[DRILL] Saku: data for'))).toHaveLength(1);
    expect(sent.every((m) => m.text.startsWith('[DRILL] '))).toBe(true);
    expect(r.alerts.map((a) => a.title)).toEqual(sent.map((m) => m.text.split('\n')[0]));

    expect(digest(file)).toBe(before);
    expect(readdirSync(work)).toEqual([]);
    // The lock was released: the next job can run.
    const next = lock('jobs', join(dir, 'locks'));
    expect('release' in next).toBe(true);
    if ('release' in next) next.release();
    expect(drillSummary(r)).toMatch(/Drill passed/);
  });

  it('a second drill sends the alert again (the first recorded nothing)', async () => {
    const { dir, url, file } = await live();
    const before = digest(file);
    expect(((await drill(url, dir).run) as DrillReport).ok).toBe(true);
    const again = drill(url, dir);
    expect(((await again.run) as DrillReport).ok).toBe(true);
    expect(again.sent.filter((m) => m.target === 'me')).toHaveLength(1);
    expect(again.sent.filter((m) => m.text.includes('Saku: data for'))).toHaveLength(1);
    expect(digest(file)).toBe(before);
  });

  it('refuses without a registered strategy, saying what to do; the copy is removed', async () => {
    const { dir, url, file } = await live({ registered: false });
    const before = digest(file);
    const { run, sent, work } = drill(url, dir);
    const r = await run;
    expect(r).toEqual({ refused: expect.stringMatching(/No strategy is registered/) });
    expect(drillSummary(r)).toMatch(/pnpm strategy register/);
    expect(sent).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
    expect(digest(file)).toBe(before);
  });

  it('refuses on CI or Vercel, before copying anything', async () => {
    const { dir, url } = await live();
    for (const env of [{ CI: 'true' }, { VERCEL: '1' }]) {
      const { run, work } = drill(url, dir, { env });
      expect(await run).toEqual({ refused: expect.stringMatching(/only on the server/) });
      expect(readdirSync(work)).toEqual([]);
    }
  });

  it('refuses while another job holds the lock', async () => {
    const { dir, url } = await live();
    // A live process other than this one holds it (the test runner's parent).
    const held = lock('jobs', join(dir, 'locks'), process.ppid);
    expect('release' in held).toBe(true);
    const { run, sent, work } = drill(url, dir);
    expect(await run).toEqual({ refused: expect.stringMatching(/Another job is running/) });
    expect(sent).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });

  it('fails (and cleans up) when the primary has no bar stored for the date', async () => {
    const { dir, url, file } = await live();
    const before = digest(file);
    const { run, sent, work } = drill(url, dir, { target: '2026-01-19' });
    const r = await run;
    expect(r).toEqual({ failed: expect.stringMatching(/No SPY bar from the primary \(p\)/) });
    expect(sent).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
    expect(digest(file)).toBe(before);
  });

  it('fails when no channel takes the alert', async () => {
    const { dir, url } = await live();
    const { notifier } = fakeNotifier(['me', 'ops']);
    const { run } = drill(url, dir, {
      alerting: {
        notifiers: [notifier],
        authSecret: SECRET,
        context: () => () => ({ http: null as never, now: new Date(), log: quiet }),
      },
    });
    const r = (await run) as DrillReport;
    expect(r.ok).toBe(false);
    expect(r.versions[0]).toMatchObject({ safeStateApplied: true, delivered: 0 });
    expect(r.problems.length).toBeGreaterThan(0);
    expect(drillSummary(r)).toMatch(/Drill FAILED: .*no channel got Trend's alert/);
  });
});

describe('pnpm drill arguments', () => {
  it('takes red and an optional --date, refusing anything else', () => {
    expect(parseDrillArgs(['red'])).toEqual({ kind: 'red' });
    expect(parseDrillArgs(['red', '--date', '2026-01-15'])).toEqual({
      kind: 'red',
      date: '2026-01-15',
    });
    expect(parseDrillArgs([])).toHaveProperty('error');
    expect(parseDrillArgs(['yellow'])).toHaveProperty('error');
    expect(parseDrillArgs(['red', '--date'])).toHaveProperty('error');
    expect(parseDrillArgs(['red', '--date', '2026-02-30'])).toHaveProperty('error');
    expect(parseDrillArgs(['red', '--date=2026-01-15'])).toHaveProperty('error');
    expect(parseDrillArgs(['red', '--date', '2026-01-15', '--date', '2026-01-14'])).toHaveProperty(
      'error',
    );
  });

  it('the date is a completed session (default: the latest completed one)', () => {
    expect(drillDate(sessions, undefined, TARGET)).toEqual({ date: TARGET });
    expect(drillDate(sessions, '2026-01-15', TARGET)).toEqual({ date: '2026-01-15' });
    expect(drillDate(sessions, '2026-01-17', TARGET)).toHaveProperty('error'); // a Saturday
    expect(drillDate(sessions, '2026-01-19', TARGET)).toHaveProperty('error'); // not completed
  });
});
