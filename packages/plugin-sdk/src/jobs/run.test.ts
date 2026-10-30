// A whole daily run with in-memory plug-ins (no network): ingest, checks, forward record,
// alerts, and how an incomplete run is reported.
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  addChannel,
  annotationsOf,
  appendForward,
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
import type { BarSource, IssuerSource, Notifier, PluginInfo, SeriesSource } from '../types';
import { type RunOptions, runJob } from './run';
import { eq, sql } from 'drizzle-orm';
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
  /** A session the source has no bar for (yet). */
  omit?: string,
): BarSource & { calls: number } => {
  const s = {
    info: testInfo(key, 'bar'),
    calls: 0,
    async fetchBars(_ticker: string, from: string, to: string): Promise<RawBar[]> {
      s.calls++;
      if (broken) throw new Error(`${key}: HTTP 500`);
      const at = (i: number) => closes[i]! * (DATES[i] === revise?.date ? revise!.factor : 1);
      return DATES.flatMap((date, i) =>
        date >= from && date <= to && date !== omit
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
    onComplete: async (job) => {
      hooks.push(`heartbeat:${job}`);
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
    expect(o.hooks).toEqual(['backup', 'heartbeat:daily']);
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

  it('keeps what failed before a throw; the alert names the thrown error right after "incomplete:"', async () => {
    const { db, version } = await setup();
    // A version that does not parse adds a per-item failure line before the throw.
    const broken = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Old',
      at: new Date('2026-01-13T22:00:00Z'),
      strategy: {
        name: 'Old',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [],
        allocations: [
          {
            name: 'Calm',
            holdings: [
              { ticker: 'AAA', weight: 50 },
              { ticker: 'AAA', weight: 50 },
            ],
          },
        ],
      },
    });
    const { notifier, sent } = fakeNotifier();
    const o = options(notifier, {
      afterDaily: async () => {
        throw new Error('disk full');
      },
    });
    const r = await runJob(db, plugins([barSource('p', true), barSource('s')]), o);
    expect(r.ok).toBe(false);
    const old = `Old (${broken.id}): definition does not parse`;
    // job_runs.error: run order, the thrown error last and in full.
    const [run] = await db.select().from(schema.jobRuns);
    for (const error of [r.error!, run!.error!]) {
      expect(error).toMatch(/^incomplete: p\b/);
      expect(error).toContain(old);
      expect(error.indexOf(old)).toBeLessThan(error.indexOf('Error: disk full'));
    }
    expect(run).toMatchObject({ status: 'failed', heartbeatSent: false });
    const failure = sent.find((m) => m.target === 'ops' && m.text.includes('did not finish'));
    const lines = failure!.text.split('\n');
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    expect(at('- incomplete: p')).toBeGreaterThan(0);
    expect(at('- Error: disk full')).toBe(at('- incomplete: p') + 1);
    expect(at(`- ${old}`)).toBe(at('- Error: disk full') + 1);
  });

  /** A database error as the driver wraps it: the SQL text first, the reason in `cause`. */
  const queryError = (reason: string) =>
    new Error('Failed query: insert into "backups" ("at") values (?)\nparams: 1', {
      cause: new Error(reason),
    });

  it('a run that cannot be recorded still tells the admins, the reason right after "incomplete:"', async () => {
    const { db, version } = await setup();
    // A version that does not parse adds a per-item failure line, listed after the run's own.
    const broken = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Old',
      at: new Date('2026-01-13T22:00:00Z'),
      strategy: {
        name: 'Old',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [],
        allocations: [
          {
            name: 'Calm',
            holdings: [
              { ticker: 'AAA', weight: 50 },
              { ticker: 'AAA', weight: 50 },
            ],
          },
        ],
      },
    });
    // finishRun fails (the run row stays as started).
    await db.run(
      sql`CREATE TRIGGER job_runs_locked BEFORE UPDATE ON job_runs BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    const { notifier, sent } = fakeNotifier();
    const o = options(notifier, {
      afterDaily: async () => {
        throw queryError('disk I/O error');
      },
    });
    const r = await runJob(db, plugins([barSource('p', true), barSource('s')]), o);
    expect(r.ok).toBe(false);
    const failure = sent.find((m) => m.target === 'ops' && m.text.includes('did not finish'));
    const lines = failure!.text.split('\n');
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    expect(at('- incomplete: p')).toBeGreaterThan(0);
    // The reasons, not the SQL text.
    expect(lines[at('- incomplete: p') + 1]).toBe('- Error: disk I/O error');
    expect(lines[at('- incomplete: p') + 2]).toMatch(/^- run not recorded: .*database is locked$/);
    expect(at(`- Old (${broken.id}): definition does not parse`)).toBe(at('- incomplete: p') + 3);
    expect(failure!.text).not.toContain('Failed query');
    const [run] = await db.select().from(schema.jobRuns);
    expect(run).toMatchObject({ status: 'running', finishedAt: null });
  });

  it('a complete run that cannot be recorded is reported to the admins as not finished', async () => {
    const { db } = await setup();
    await db.run(
      sql`CREATE TRIGGER job_runs_locked BEFORE UPDATE ON job_runs BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    const { notifier, sent } = fakeNotifier();
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(r.ok).toBe(false);
    const failure = sent.find((m) => m.target === 'ops' && m.text.includes('did not finish'));
    expect(failure!.text).toMatch(/\n- run not recorded: .*database is locked\n/);
    expect(failure!.text).not.toContain('Failed query');
  });

  it('a database error is told by its reason; job_runs.error keeps the SQL text and the cause', async () => {
    const { db } = await setup();
    const { notifier, sent } = fakeNotifier();
    const o = options(notifier, {
      afterDaily: async () => {
        throw queryError('disk I/O error');
      },
    });
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), o);
    expect(r.ok).toBe(false);
    const [run] = await db.select().from(schema.jobRuns);
    for (const error of [r.error!, run!.error!]) {
      expect(error).toContain('Failed query: insert into "backups"');
      expect(error).toContain('Caused by: Error: disk I/O error');
    }
    const failure = sent.find((m) => m.target === 'ops' && m.text.includes('did not finish'));
    expect(failure!.text).toContain('\n- Error: disk I/O error\n');
    expect(failure!.text).not.toContain('Failed query');
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

  it('a version that no longer parses fails the run, named to the admins; the others still run', async () => {
    const { db, version } = await setup();
    // Stored directly with a rule added after registration (a ticker twice), as an old version.
    const broken = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Old',
      at: new Date('2026-01-13T22:00:00Z'),
      strategy: {
        name: 'Old',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [],
        allocations: [
          {
            name: 'Calm',
            holdings: [
              { ticker: 'AAA', weight: 50 },
              { ticker: 'AAA', weight: 50 },
            ],
          },
        ],
      },
    });
    const { notifier, sent } = fakeNotifier();
    const o = options(notifier);
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), o);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('incomplete: forward');
    expect(r.error).toContain(`Old (${broken.id}): definition does not parse:`);
    expect(r.error).toContain('"AAA" is listed twice');
    expect(o.hooks).toEqual(['backup']);
    const failure = sent.find((m) => m.target === 'ops' && m.text.includes('did not finish'));
    expect(failure?.text).toContain(`Old (${broken.id}): definition does not parse`);
    // Named once: recompute meets the same version and does not repeat it.
    const once = `Old (${broken.id}): definition does not parse`;
    expect(r.error!.split(once)).toHaveLength(2);
    expect(failure!.text.split(once)).toHaveLength(2);
    // Nothing is guessed for it; the good version is still recorded.
    expect(await forwardRecord(db, broken.id)).toEqual([]);
    expect((await forwardRecord(db, version.id)).map((e) => e.date)).toEqual([
      '2026-01-15',
      '2026-01-16',
    ]);
    const [run] = await db.select().from(schema.jobRuns);
    expect(run).toMatchObject({ status: 'failed', heartbeatSent: false });
    expect(run!.error).toContain(`Old (${broken.id})`);
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
    // No backup (the daily run's); the weekly heartbeat after full success.
    expect(o.hooks).toEqual(['heartbeat:weekly']);
    const runs = await db.select().from(schema.jobRuns);
    expect(runs.find((x) => x.jobType === 'weekly')).toMatchObject({ heartbeatSent: true });
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

describe('a weekly run whose recompute cannot evaluate a version', () => {
  it('names the version, its id and the reason once, in job_runs.error and the alert', async () => {
    const { db, version } = await setup();
    // A recorded version whose ticker has no bars any more: the engine throws on it.
    const gone = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Gone',
      at: new Date('2026-01-12T22:00:00Z'),
      strategy: {
        name: 'Gone',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [
          {
            id: 'A',
            type: 'compare',
            left: { indicator: 'price', ticker: 'ZZZ' },
            op: '>',
            right: { indicator: 'sma', ticker: 'ZZZ', length: 3 },
          },
        ],
        allocations: [
          { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'ZZZ', weight: 100 }] },
          { name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        ],
      },
    });
    await appendForward(
      db,
      gone,
      {
        date: '2026-01-13',
        allocation: 'Calm',
        holdings: [{ ticker: 'CASH_USD', weight: 100 }],
        safeStateApplied: false,
        dataStatus: 'green',
        equity: 1,
        detail: { reasons: [], signals: { A: false } },
      },
      null,
    );
    const { notifier, sent } = fakeNotifier();
    const r = await runJob(
      db,
      plugins([barSource('p'), barSource('s')]),
      options(notifier, { job: 'weekly' }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('incomplete: recompute');
    const line = `Gone (${gone.id}): recompute could not evaluate: No bars for ZZZ.`;
    expect(r.error!.split(line)).toHaveLength(2);
    const [run] = await db
      .select()
      .from(schema.jobRuns)
      .where(eq(schema.jobRuns.jobType, 'weekly'));
    expect(run!.error).toContain(line);
    const failure = sent.find((m) => m.target === 'ops' && m.text.includes('did not finish'));
    expect(failure!.text.split('\n').filter((l) => l === `- ${line}`)).toHaveLength(1);
  });
});

describe('a stand-in the primary later corrects', () => {
  const DAY = '2026-01-15';
  const run1 = (notifier: Notifier) =>
    options(notifier, {
      target: DAY,
      now: new Date('2026-01-16T01:30:00Z'),
      clock: () => new Date('2026-01-16T01:30:00Z'),
      alerting: { ...options(notifier).alerting, date: DAY },
    });
  // Run 1: the primary lacks 01-15; the secondary's bar, 1% low, stands in. With it, AAA is
  // below its 3-day average (Calm); on the primary's bar it is above (Risk on).
  const withStandIn = () =>
    plugins([
      barSource('p', false, undefined, DAY),
      barSource('s', false, { date: DAY, factor: 0.99 }),
    ]);
  type TestDb = Awaited<ReturnType<typeof setup>>['db'];
  const notes = (db: TestDb, kind: string) =>
    db.select().from(schema.forwardAnnotations).where(eq(schema.forwardAnnotations.kind, kind));

  it('daily: annotates the entry that used it once, not the entry appended in the resolving run', async () => {
    const { db, version } = await setup();
    const { notifier, sent } = fakeNotifier();
    await runJob(db, withStandIn(), run1(notifier));
    const [stood] = await forwardRecord(db, version.id);
    expect(stood).toMatchObject({ date: DAY, allocation: 'Calm', dataStatus: 'yellow' });
    // Registered after run 1 (as of before 01-15's close): run 2, which resolves the stand-in,
    // catches up 01-15 on the primary's bar.
    const late = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Late',
      at: new Date('2026-01-14T22:00:00Z'),
      strategy: (JSON.parse(version.canonicalJson) as { strategy: unknown }).strategy as never,
    });
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(r).toMatchObject({ ok: true });
    expect((await forwardRecord(db, late.id)).map((e) => [e.date, e.allocation])).toEqual([
      [DAY, 'Risk on'],
      ['2026-01-16', 'Risk on'],
    ]);
    const corrected = await notes(db, 'stand_in_corrected');
    expect(corrected.map((n) => [n.versionId, n.date])).toEqual([[version.id, DAY]]);
    expect(corrected[0]!.detail).toMatchObject({
      ticker: 'AAA',
      recordedAllocation: 'Calm',
      correctedAllocation: 'Risk on',
      differs: true,
    });
    expect((corrected[0]!.detail as { deviation: number }).deviation).toBeCloseTo(1 / 0.99 - 1, 9);
    // Explained by the correction, not told as an engine difference.
    expect(await notes(db, 'recomputed')).toEqual([]);
    expect(sent.some((m) => m.text.includes('decides'))).toBe(false);
    // The owner is told on each of their channels, in the run that annotated it.
    const told = () => sent.filter((m) => m.text.startsWith(`Trend: correction to the signal`));
    expect(told().map((m) => m.target)).toEqual(['me', 'ops']);
    expect(told()[0]!.text).toContain('it would have been Risk on');
    // The record itself is untouched; a third run adds nothing and tells nothing again.
    expect((await forwardRecord(db, version.id))[0]).toEqual(stood);
    await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(await notes(db, 'stand_in_corrected')).toHaveLength(1);
    expect(told()).toHaveLength(2);
  });

  it('weekly: the refetch resolves it; the correction is annotated before recompute', async () => {
    const { db, version } = await setup();
    const { notifier, sent } = fakeNotifier();
    await runJob(db, withStandIn(), run1(notifier));
    const r = await runJob(
      db,
      plugins([barSource('p'), barSource('s')]),
      options(notifier, { job: 'weekly' }),
    );
    expect(r).toMatchObject({ ok: true });
    const corrected = await notes(db, 'stand_in_corrected');
    expect(
      corrected.map((n) => [n.versionId, n.date, (n.detail as { differs: boolean }).differs]),
    ).toEqual([[version.id, DAY, true]]);
    // Without the correction first, recompute would annotate 01-15 and alert the admins.
    expect(await notes(db, 'recomputed')).toEqual([]);
    expect(sent.some((m) => m.text.includes('decides'))).toBe(false);
    expect(
      sent.filter((m) => m.text.startsWith('Trend: correction to the signal of 2026-01-15')),
    ).toHaveLength(2);
  });

  it('an undelivered correction alert leaves the run incomplete; the next run tells it', async () => {
    const { db } = await setup();
    await runJob(db, withStandIn(), run1(fakeNotifier().notifier));
    const down = fakeNotifier(['me']);
    const warned: string[] = [];
    const log = { info() {}, warn: (m: string) => void warned.push(m) };
    const r = await runJob(
      db,
      plugins([barSource('p'), barSource('s')]),
      options(down.notifier, { log }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('incomplete: alerts');
    expect(warned).toContain('Stand-in correction alerts not delivered');
    expect(down.sent.filter((m) => m.text.includes('correction to')).map((m) => m.target)).toEqual([
      'ops',
    ]);
    const { notifier, sent } = fakeNotifier();
    await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(
      sent.filter((m) => m.text.startsWith('Trend: correction to the signal')).map((m) => m.target),
    ).toEqual(['me']);
  });

  it('D and D+1 both read it: each annotated and told, neither an engine difference', async () => {
    const { db, version } = await setup();
    // Its signal reads the last two returns, so the day after the stand-in reads it too.
    const quiet = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Quiet',
      at: new Date('2026-01-14T22:00:00Z'),
      strategy: {
        name: 'Quiet',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [
          {
            id: 'V',
            type: 'compare',
            left: { indicator: 'volatility', ticker: 'AAA', length: 2 },
            op: '<',
            right: { threshold: 0.005 },
          },
        ],
        allocations: [
          { name: 'Still', when: { all: ['V'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
          { name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        ],
      },
    });
    // A hole the primary never fills, years before the record: it holds nothing back.
    const [aaa] = await db.select().from(schema.symbols).where(eq(schema.symbols.ticker, 'AAA'));
    await db.insert(schema.standIns).values({
      symbolId: aaa!.id,
      date: '2019-03-04',
      source: 's',
      close: 50,
      band: 0.005,
      basis: 'unchecked',
      createdAt: '2019-03-05T01:30:00.000Z',
    });
    const { notifier, sent } = fakeNotifier();
    await runJob(db, withStandIn(), run1(notifier));
    // D+1: the primary still lacks D (the stand-in stays unresolved), has D+1.
    await runJob(db, withStandIn(), options(notifier));
    const recorded = await forwardRecord(db, quiet.id);
    expect(recorded.map((e) => [e.date, e.allocation])).toEqual([
      [DAY, 'Calm'],
      ['2026-01-16', 'Calm'],
    ]);
    // The primary's bar for D arrives.
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(r).toMatchObject({ ok: true });
    const corrected = (await notes(db, 'stand_in_corrected')).filter(
      (n) => n.versionId === quiet.id,
    );
    expect(
      corrected.map((n) => {
        const d = n.detail as { standInDate: string; correctedAllocation: string };
        return [n.date, d.standInDate, d.correctedAllocation];
      }),
    ).toEqual([
      [DAY, DAY, 'Still'],
      ['2026-01-16', DAY, 'Still'],
    ]);
    // Both days are explained: no "the engine decides differently".
    expect(await notes(db, 'recomputed')).toEqual([]);
    expect(sent.some((m) => m.text.includes('decides'))).toBe(false);
    // One message per channel and version: the newest day in full, the other on its own line.
    const told = sent.filter((m) => m.text.startsWith('Quiet: correction'));
    expect(told.map((m) => m.target)).toEqual(['me', 'ops']);
    expect(told[0]!.text.split('\n').slice(0, 5)).toEqual([
      'Quiet: correction to the signal of 2026-01-16',
      expect.stringMatching(
        /^The signal of 2026-01-16 read a secondary price for AAA on 2026-01-15; the primary's price, which arrived later, differed from it by 1\.01%\.$/,
      ),
      'Recorded allocation: Calm. With the corrected price it would have been Still. The record is annotated, not changed.',
      'Other days the corrected price would have changed:',
      '2026-01-15 AAA: Calm → Still',
    ]);
  });

  it("waits while another dependency's stand-in is unresolved: no engine difference meanwhile", async () => {
    const { db, version } = await setup();
    await upsertSymbols(db, [{ ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    // Reads AAA's last two returns (so D+1 reads D), holds BBB.
    const quiet = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Quiet',
      at: new Date('2026-01-12T22:00:00Z'),
      strategy: {
        name: 'Quiet',
        account: 'taxable',
        safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        evaluation: { frequency: 'daily' },
        signals: [
          {
            id: 'V',
            type: 'compare',
            left: { indicator: 'volatility', ticker: 'AAA', length: 2 },
            op: '<',
            right: { threshold: 0.005 },
          },
        ],
        allocations: [
          { name: 'Still', when: { all: ['V'] }, holdings: [{ ticker: 'BBB', weight: 100 }] },
          { name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
        ],
      },
    });
    const [D, D1, D2] = ['2026-01-13', '2026-01-14', '2026-01-15'];
    /** A source without the listed `ticker date` bars, and with closes scaled for others. */
    const source = (key: string, omit: string[] = [], scale: Record<string, number> = {}) => {
      const base = barSource(key);
      const out: BarSource = {
        info: base.info,
        async fetchBars(ticker, from, to, ctx) {
          return (await base.fetchBars(ticker, from, to, ctx))
            .filter((b) => !omit.includes(`${ticker} ${b.date}`))
            .map((b) => {
              // The test source's bars are flat (open = high = low = close).
              const close = b.close * (scale[`${ticker} ${b.date}`] ?? 1);
              return { ...b, open: close, high: close, low: close, close };
            });
        },
      };
      return out;
    };
    const at = (notifier: Notifier, target: string, now: string, over: Partial<RunOptions> = {}) =>
      options(notifier, {
        target,
        now: new Date(now),
        clock: () => new Date(now),
        alerting: { ...options(notifier).alerting, date: target },
        ...over,
      });
    const off = source('s', [], { [`AAA ${D}`]: 0.99 });
    const { notifier, sent } = fakeNotifier();
    // D: AAA stands in (1% low). D+1: still, and BBB stands in too. D+2: AAA resolved, BBB not.
    await runJob(
      db,
      plugins([source('p', [`AAA ${D}`]), off]),
      at(notifier, D, '2026-01-14T01:30:00Z'),
    );
    await runJob(
      db,
      plugins([source('p', [`AAA ${D}`, `BBB ${D1}`]), off]),
      at(notifier, D1, '2026-01-15T01:30:00Z'),
    );
    const c = await runJob(
      db,
      plugins([source('p', [`BBB ${D1}`]), source('s')]),
      at(notifier, D2, '2026-01-16T01:30:00Z'),
    );
    expect(c).toMatchObject({ ok: true });
    expect((await forwardRecord(db, quiet.id)).map((e) => [e.date, e.allocation])).toEqual([
      [D, 'Calm'],
      [D1, 'Calm'],
      [D2, 'Still'],
    ]);
    const corrections = async () =>
      (await annotationsOf(db, quiet.id, 'stand_in_corrected')).map((n) => [
        n.date,
        (n.detail as { correctedAllocation: string }).correctedAllocation,
      ]);
    // D is annotated; D+1 waits for BBB's stand-in, and is not compared meanwhile.
    expect(await corrections()).toEqual([[D, 'Still']]);
    expect(await notes(db, 'recomputed')).toEqual([]);
    expect(sent.some((m) => m.text.includes('decides'))).toBe(false);
    // The weekly full refetch still lacks BBB's bar: the admins hear which stand-in holds what.
    const w = await runJob(
      db,
      plugins([source('p', [`BBB ${D1}`]), source('s')]),
      at(notifier, D2, '2026-01-16T02:30:00Z', { job: 'weekly' }),
    );
    expect(w.ok).toBe(false);
    expect(w.error).toContain('stand-in corrections waiting');
    expect(w.error).toContain(
      `BBB ${D1}: stand-in still unresolved after the full refetch; corrections wait for it (Quiet (${quiet.id}) ${D1})`,
    );
    expect(await notes(db, 'recomputed')).toEqual([]);
    // BBB's primary bar arrives: D+1 is annotated, still no engine difference.
    const d = await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(d).toMatchObject({ ok: true });
    expect(await corrections()).toEqual([
      [D, 'Still'],
      [D1, 'Still'],
    ]);
    expect(await notes(db, 'recomputed')).toEqual([]);
    expect(sent.some((m) => m.text.includes('decides'))).toBe(false);
  });

  it('an unreadable correction annotation: incomplete until the admins are told which', async () => {
    const { db, version } = await setup();
    await db.insert(schema.forwardAnnotations).values({
      versionId: version.id,
      date: '2026-01-15',
      kind: 'stand_in_corrected',
      detail: { ticker: 'AAA' },
      runId: null,
    });
    const [bad] = await notes(db, 'stand_in_corrected');
    const down = fakeNotifier(['ops']);
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), options(down.notifier));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('incomplete: alerts, stand-in alerts');
    expect(r.error).toContain(
      `Trend (${version.id}) 2026-01-15: stand-in correction annotation ${bad!.id} does not read back`,
    );
    const { notifier, sent } = fakeNotifier();
    const again = await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(again).toMatchObject({ ok: true });
    const told = sent.filter((m) => m.text.startsWith('Saku: a stand-in correction annotation'));
    expect(told.map((m) => m.target)).toEqual(['ops']);
    expect(told[0]!.text).toContain(`annotation ${bad!.id} does not read back`);
  });

  it('a stand-in timestamp that is not an instant: the run is incomplete, the admins told which', async () => {
    const { db, version } = await setup();
    const [aaa] = await db.select().from(schema.symbols).where(eq(schema.symbols.ticker, 'AAA'));
    // Stored outside a run, resolved 1% off, its resolution time without a zone.
    await db.insert(schema.standIns).values({
      symbolId: aaa!.id,
      date: DAY,
      source: 's',
      close: 99,
      band: 0.005,
      basis: 'unchecked',
      createdAt: '2026-01-15T21:30:00.000Z',
      primaryClose: 100,
      deviation: 100 / 99 - 1,
      resolvedAt: '2026-01-08 21:30:00',
    });
    const { notifier, sent } = fakeNotifier();
    const r = await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('incomplete: stand-in corrections');
    const line =
      "AAA 2026-01-15: the stand-in's timestamps are not instants (created " +
      '2026-01-15T21:30:00.000Z, resolved 2026-01-08 21:30:00); its correction is not annotated';
    expect(r.error).toContain(line);
    const failure = sent.find((m) => m.target === 'ops' && m.text.includes('did not finish'));
    expect(failure!.text.split('\n')).toContain(`- ${line}`);
    // Nothing annotated on a guess; the entries are recorded.
    expect(await notes(db, 'stand_in_corrected')).toEqual([]);
    expect((await forwardRecord(db, version.id)).map((e) => e.date)).toEqual([DAY, '2026-01-16']);
  });
});

describe('an issuer source declaring what it publishes', () => {
  // The primary pays 0.5 on the 15th; the issuer publishes daily NAVs (the close) and no events.
  const EX = '2026-01-15';
  const paying = (key: string): BarSource => {
    const s = barSource(key);
    return {
      info: s.info,
      async fetchBars(ticker, from, to, ctx) {
        return (await s.fetchBars(ticker, from, to, ctx)).map((b) =>
          b.date === EX ? { ...b, divCash: 0.5 } : b,
        );
      },
    };
  };
  const issuer = (publishes?: PluginInfo['publishes']): IssuerSource => ({
    info: testInfo('iss', 'issuer', { suggestedRole: 'check', ...(publishes && { publishes }) }),
    supports: (ticker) => ticker === 'AAA',
    async fetchRecords(_ticker, from, to) {
      return DATES.flatMap((date, i) =>
        date >= from && date <= to ? [{ date, nav: closes[i]!, currency: 'USD' }] : [],
      );
    },
  });
  const layerD = async (publishes?: PluginInfo['publishes']) => {
    const { db } = await setup();
    const { notifier } = fakeNotifier();
    await runJob(
      db,
      { ...plugins([paying('p'), paying('s')]), issuers: [issuer(publishes)] },
      options(notifier),
    );
    const rows = await db
      .select()
      .from(schema.checkResults)
      .where(eq(schema.checkResults.layer, 'D'));
    return (check: string) => rows.filter((r) => r.source === 'iss' && r.checkName === check);
  };

  it('NAV only: the primary distribution is not compared (no distribution_match stored)', async () => {
    const declared = await layerD({ nav: true });
    expect(declared('nav_premium').length).toBeGreaterThan(0);
    expect(declared('distribution_match')).toEqual([]);
    // Undeclared, inferred: the NAV source's missing distribution reads as a mismatch.
    const inferred = await layerD();
    expect(inferred('distribution_match')).toEqual([
      expect.objectContaining({ date: EX, message: 'event missing in issuer data' }),
    ]);
  });
});

describe('a weekly run that does not finish', () => {
  it('sends no heartbeat', async () => {
    const { db } = await setup();
    const { notifier } = fakeNotifier();
    expect(
      (await runJob(db, plugins([barSource('p'), barSource('s')]), options(notifier))).ok,
    ).toBe(true);
    const o = options(notifier, { job: 'weekly' });
    const r = await runJob(db, plugins([barSource('p'), barSource('s', true)]), o);
    expect(r.ok).toBe(false);
    expect(o.hooks).toEqual([]);
    const runs = await db.select().from(schema.jobRuns);
    expect(runs.find((x) => x.jobType === 'weekly')).toMatchObject({ heartbeatSent: false });
  });
});

describe('an index without publication times (known from the fetch)', () => {
  /**
   * The cash rate as the testkit gives it, plus an index `IDX` that follows the bars' closes and
   * has no `publishedAt` (like FRED's SP500, known from the run that fetched it). `revise`: the
   * index now reports another value for a date.
   */
  const withIndex = (revise?: { date: string; factor: number }): SeriesSource => ({
    info: testInfo('rates', 'series', {
      suggestedRole: 'primary',
      provides: { series: ['CASH', 'IDX'], cashRates: { USD: 'CASH' } },
    }),
    async fetchSeries(id, from, to, ctx) {
      if (id === 'CASH') return rates.fetchSeries(id, from, to, ctx);
      return DATES.flatMap((date, i) =>
        date >= from && date <= to
          ? [{ date, value: 50 * closes[i]! * (date === revise?.date ? revise.factor : 1) }]
          : [],
      );
    },
  });
  /** A clock that moves on at each reading, so the order of readings matters. */
  const ticking = () => {
    let t = Date.parse('2026-01-17T01:30:00Z');
    return () => new Date((t += 1000));
  };
  const indexResults = async (db: Awaited<ReturnType<typeof testDb>>, runId: string) =>
    (await db.select().from(schema.checkResults).where(eq(schema.checkResults.runId, runId)))
      .filter((r) => r.checkName.startsWith('index_'))
      .map((r) => `${r.checkName} ${r.status}`);

  it("the run's own index check reads the values it fetched (no index_unavailable)", async () => {
    const { db } = await setup();
    await upsertSymbols(db, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', indexSeries: 'IDX' },
    ]);
    const { notifier } = fakeNotifier();
    const r = await runJob(
      db,
      { ...emptyPlugins(), bars: [barSource('p'), barSource('s')], series: [withIndex()] },
      options(notifier, { clock: ticking() }),
    );
    expect(r).toMatchObject({ ok: true });
    const stored = await db.select().from(schema.series).where(eq(schema.series.series, 'IDX'));
    expect(stored.length).toBeGreaterThan(0);
    // Known from the run's fetch (no publication time), never earlier.
    expect(stored.every((x) => x.publishedAt === null && x.knownAt > '2026-01-17T01:30:00')).toBe(
      true,
    );
    const index = await indexResults(db, r.runId);
    expect(index.length).toBeGreaterThan(0);
    expect(index.every((x) => x === 'index_match green')).toBe(true);
  });

  it('weekly: a refetched index value reported differently is a revision, told with the bars', async () => {
    const { db } = await setup();
    await upsertSymbols(db, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', indexSeries: 'IDX' },
    ]);
    const { notifier, sent } = fakeNotifier();
    const clock = ticking();
    const bars = [barSource('p'), barSource('s')];
    expect(
      (
        await runJob(
          db,
          { ...emptyPlugins(), bars, series: [withIndex()] },
          options(notifier, { clock }),
        )
      ).ok,
    ).toBe(true);
    const r = await runJob(
      db,
      {
        ...emptyPlugins(),
        bars,
        series: [withIndex({ date: '2026-01-05', factor: 1.0001 })],
      },
      options(notifier, { job: 'weekly', clock }),
    );
    expect(r).toMatchObject({ ok: true });
    const ops = sent.filter((m) => m.target === 'ops').map((m) => m.text);
    expect(
      ops.find((t) => t.startsWith('Saku: the weekly refetch changed 1 stored values')),
    ).toContain('IDX value@rates 1 (2026-01-05)');
    // A new row known from the refetch; the old value kept.
    const rows = await db.select().from(schema.series).where(eq(schema.series.date, '2026-01-05'));
    expect(rows.filter((x) => x.series === 'IDX')).toHaveLength(2);
  });
});
