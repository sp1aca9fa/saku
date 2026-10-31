// The monthly job (spec 2026-11-01 monthly-audit): the report stored once per text in the
// activity log, its short form sent once per month and admin channel after the A1 gate only, a
// month missed caught up, a failed delivery leaving the run failed without a heartbeat.
import { Sessions } from '@saku/data';
import {
  addChannel,
  createUser,
  finishRun,
  schema,
  setSetting,
  startRun,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CATCH_UP, monthsDue, runMonthly, storedAudits } from './monthly';
import { fakeNotifier, quiet } from './testkit';
import type { ProviderLimits } from '../types';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const TZ = 'Asia/Tokyo';
const NOW = new Date('2026-04-01T03:00:00.000Z');
const SECRET = 'test-secret-test-secret-test-secret';

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  const aaa = (await symbolId(db, 'AAA'))!;
  const admin = await createUser(db, {
    username: 'ada',
    passwordHash: 'x',
    totpSecretEnc: 'x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  await addChannel(db, admin, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
  // March graded green by a full run (started April 1 in Tokyo, so not one of March's runs).
  const march = sessions.between('2026-03-01', '2026-03-31');
  const run = await startRun(db, 'checks', new Date('2026-04-01T00:00:00.000Z'));
  await db.insert(schema.bars).values({ symbolId: aaa, date: march[0]!, close: 1, source: 'p' });
  await db
    .insert(schema.healthCoverage)
    .values({ runId: run, symbolId: aaa, fromDate: march[0]!, toDate: march.at(-1)! });
  for (const date of march) {
    await db
      .insert(schema.dataHealth)
      .values({ runId: run, date, symbolId: null, status: 'green', reasons: [] });
  }
  await finishRun(db, run, { ok: true, datesProcessed: [march.at(-1)!] });
  // A complete daily run has processed March 31 (started April 1 in Tokyo).
  const daily = await startRun(db, 'daily', new Date('2026-04-01T00:30:00.000Z'), march.at(-1));
  await finishRun(db, daily, { ok: true, datesProcessed: [march.at(-1)!] });
  return { db };
}

function options(down: string[] = [], now = NOW) {
  const { notifier, sent } = fakeNotifier(down);
  let beats = 0;
  return {
    sent,
    beats: () => beats,
    o: {
      now,
      timeZone: TZ,
      sessions,
      finalAfter: '20:00',
      limits: new Map<string, ProviderLimits | undefined>(),
      caFile: '/none',
      token: async () => true,
      alerting: {
        notifiers: [notifier],
        authSecret: SECRET,
        context: () => ({ http: null as never, now, log: quiet }),
        log: quiet,
      },
      log: quiet,
      onComplete: async () => {
        beats++;
        return true;
      },
    },
  };
}

describe('the monthly job', () => {
  it('before the A1 gate: stores the report, sends nothing, completes with the heartbeat', async () => {
    const { db } = await setup();
    const { o, sent, beats } = options();
    const r = await runMonthly(db, o);
    expect(r).toMatchObject({ ok: true, months: ['2026-03'] });
    expect(sent).toEqual([]);
    expect(beats()).toBe(1);
    const stored = await storedAudits(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      month: '2026-03',
      verdict: 'Verdict: all clear.',
      clear: true,
      runId: r.runId,
    });
    expect(stored[0]!.text).toMatch(/^Audit report for 2026-03 \(Asia\/Tokyo: /);
    const [run] = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, r.runId));
    expect(run).toMatchObject({
      jobType: 'monthly',
      status: 'success',
      datesProcessed: ['2026-03'],
      heartbeatSent: true,
    });
  });

  it('after the gate: sent once per month and channel; a rerun stores no copy and sends nothing', async () => {
    const { db } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    const first = options();
    expect((await runMonthly(db, first.o)).ok).toBe(true);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]!.text.split('\n').slice(0, 2)).toEqual([
      'Saku: audit report for 2026-03',
      'Verdict: all clear.',
    ]);
    expect(first.sent[0]!.text).toContain(
      'The full report is on the server: pnpm audit-report --month 2026-03',
    );
    // The health line closes it, as in every admin alert.
    expect(first.sent[0]!.text.split('\n').at(-1)).toMatch(/^Data health: green\./);

    const again = options();
    expect((await runMonthly(db, again.o)).ok).toBe(true);
    expect(again.sent).toEqual([]);
    expect(await storedAudits(db)).toHaveLength(1);
    expect(
      (await db.select().from(schema.alertsSent)).filter((a) => a.type === 'monthly_audit'),
    ).toHaveLength(1);
  });

  it('a month produced again with another text is stored beside the earlier one, never over it', async () => {
    const { db } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    expect((await runMonthly(db, options(['ops']).o)).ok).toBe(false);
    // A run of March that failed, found later (the report now says it).
    const failed = await startRun(db, 'daily', new Date('2026-03-10T12:00:00.000Z'), '2026-03-09');
    await finishRun(db, failed, { ok: false, error: 'source down' });
    const up = options();
    expect((await runMonthly(db, up.o)).ok).toBe(true);
    const stored = await storedAudits(db);
    expect(stored.map((s) => s.verdict)).toEqual([
      'Verdict: all clear.',
      'Verdict: needs attention (1 run failed or unfinished).',
    ]);
    expect(up.sent[0]!.text).toContain('Verdict: needs attention.');
  });

  it('an undelivered alert leaves the run failed, without the heartbeat, and is sent next time', async () => {
    const { db } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    const down = options(['ops']);
    const r = await runMonthly(db, down.o);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^2026-03: alert not delivered: fake channel .*Fake: HTTP 500/);
    expect(down.beats()).toBe(0);
    const [run] = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, r.runId));
    expect(run).toMatchObject({ status: 'failed', heartbeatSent: false });
    // The report itself was stored; the next run delivers the alert.
    expect(await storedAudits(db)).toHaveLength(1);
    const up = options();
    expect((await runMonthly(db, up.o)).ok).toBe(true);
    expect(up.sent.filter((m) => m.text.startsWith('Saku: audit report'))).toHaveLength(1);
  });

  it('catches up the months without a stored report since the first run', async () => {
    const { db } = await setup();
    await startRun(db, 'daily', new Date('2026-01-15T00:00:00.000Z'));
    // A monthly run that never finished (it names its target from the start) did nothing.
    await startRun(db, 'monthly', new Date('2026-04-01T02:00:00.000Z'), '2026-03');
    const o = { now: NOW, timeZone: TZ, sessions, finalAfter: '20:00' };
    expect(await monthsDue(db, o)).toEqual({ months: ['2026-01', '2026-02', '2026-03'] });
    const r = await runMonthly(db, options().o);
    expect(r.months).toEqual(['2026-01', '2026-02', '2026-03']);
    // Done: the timer's retry days and a rerun change nothing.
    expect(await monthsDue(db, o)).toEqual({ months: [] });
    const rerun = options();
    expect(await runMonthly(db, rerun.o)).toMatchObject({ ok: true, months: [] });
    expect(await storedAudits(db)).toHaveLength(3);
  });

  it('catches up at most CATCH_UP earlier months, plus the latest due', async () => {
    const { db } = await setup();
    // The first run 14 months before March 2026: January 2025.
    await startRun(db, 'daily', new Date('2025-01-15T00:00:00.000Z'));
    const o = { now: NOW, timeZone: TZ, sessions, finalAfter: '20:00' };
    const due = await monthsDue(db, o);
    expect(due.months).toHaveLength(CATCH_UP + 1);
    expect(due.months[0]).toBe('2025-03');
    expect(due.months.at(-1)).toBe('2026-03');
  });

  it('a month done before the gate is not sent once the gate is set', async () => {
    const { db } = await setup();
    const before = options();
    expect(await runMonthly(db, before.o)).toMatchObject({ ok: true, months: ['2026-03'] });
    expect(before.sent).toEqual([]);
    await setSetting(db, 'forward_records_from', '2026-03-02');
    const after = options();
    expect(await runMonthly(db, after.o)).toMatchObject({ ok: true, months: [] });
    expect(after.sent).toEqual([]);
  });

  it('a catch-up after the gate stores pre-gate months without sending them', async () => {
    const { db } = await setup();
    await startRun(db, 'daily', new Date('2026-01-15T00:00:00.000Z'));
    // The gate on March 2: January and February ended before it; March did not.
    await setSetting(db, 'forward_records_from', '2026-03-02');
    const { o, sent } = options();
    const r = await runMonthly(db, o);
    expect(r).toMatchObject({ ok: true, months: ['2026-01', '2026-02', '2026-03'] });
    expect((await storedAudits(db)).map((a) => a.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(sent.map((m) => m.text.split('\n')[0])).toEqual(['Saku: audit report for 2026-03']);
    expect(
      (await db.select().from(schema.alertsSent))
        .filter((a) => a.type === 'monthly_audit')
        .map((a) => a.subject),
    ).toEqual(['audit:2026-03']);
  });

  it('a month the latest daily run has not processed waits for the retry days', async () => {
    const db = (await setup()).db;
    // The latest complete daily run is for March 30 (the setup's March 31 run removed).
    await db.delete(schema.jobRuns).where(eq(schema.jobRuns.jobType, 'daily'));
    const d = await startRun(db, 'daily', new Date('2026-04-01T00:30:00.000Z'), '2026-03-30');
    await finishRun(db, d, { ok: true, datesProcessed: ['2026-03-30'] });
    const o = { now: NOW, timeZone: TZ, sessions, finalAfter: '20:00' };
    const due = await monthsDue(db, o);
    expect(due.months).toEqual(['2026-02']);
    expect(due.why).toMatch(/No complete daily run has processed 2026-03-31/);
    expect(due.waiting).toBe('daily');
    // A month was done in this run: it completes with the heartbeat.
    const run = options();
    expect(await runMonthly(db, run.o)).toMatchObject({ ok: true, months: ['2026-02'] });
    expect(run.beats()).toBe(1);
  });

  it('no month done and the latest waits for a daily run: complete without the heartbeat, a warning', async () => {
    const { db } = await setup();
    expect((await runMonthly(db, options().o)).months).toEqual(['2026-03']);
    // May 1, 12:00 in Tokyo: April is over and final, but the latest complete daily run is
    // still March 31 (the daily job is stuck); March is done.
    const now = new Date('2026-05-01T03:00:00.000Z');
    const due = await monthsDue(db, { now, timeZone: TZ, sessions, finalAfter: '20:00' });
    expect(due).toMatchObject({ months: [], waiting: 'daily' });
    const run = options([], now);
    const warns: string[] = [];
    const r = await runMonthly(db, {
      ...run.o,
      log: { info() {}, warn: (m: string) => void warns.push(m) },
    });
    expect(r).toMatchObject({ ok: true, months: [] });
    expect(run.beats()).toBe(0);
    expect(warns[0]).toMatch(/No complete daily run has processed 2026-04-30/);
    const row = (await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, r.runId)))[0]!;
    expect(row).toMatchObject({ status: 'success', heartbeatSent: false, error: null });
    expect(row.finishedAt).not.toBeNull();
  });

  it('no month done and the latest waits only for the clock: complete with the heartbeat', async () => {
    const { db } = await setup();
    expect((await runMonthly(db, options().o)).months).toEqual(['2026-03']);
    // May 1, 01:00 in Tokyo: April 30 is 12:00 in New York, not final yet (the normal wait).
    const now = new Date('2026-04-30T16:00:00.000Z');
    const due = await monthsDue(db, { now, timeZone: TZ, sessions, finalAfter: '20:00' });
    expect(due).toMatchObject({ months: [], waiting: 'clock' });
    const run = options([], now);
    const warns: string[] = [];
    const r = await runMonthly(db, {
      ...run.o,
      log: { info() {}, warn: (m: string) => void warns.push(m) },
    });
    expect(r).toMatchObject({ ok: true, months: [] });
    expect(run.beats()).toBe(1);
    expect(warns).toEqual([]);
  });

  it('the latest month waits on the clock and the one before on a daily run: waiting daily, both reasons, no heartbeat', async () => {
    const { db } = await setup();
    await db.delete(schema.jobRuns).where(eq(schema.jobRuns.jobType, 'daily'));
    const d = await startRun(db, 'daily', new Date('2026-10-01T00:30:00.000Z'), '2026-09-29');
    await finishRun(db, d, { ok: true, datesProcessed: ['2026-09-29'] });
    // Nov 1, 11:47 in Auckland: October is over there, but October 30 is 18:47 in New York.
    const now = new Date('2026-10-31T22:47:00.000Z');
    const tz = 'Pacific/Auckland';
    const due = await monthsDue(db, { now, timeZone: tz, sessions, finalAfter: '20:00' });
    expect(due).toMatchObject({ months: [], waiting: 'daily' });
    expect(due.why).toMatch(/2026-10 is not over yet in UTC/);
    expect(due.why).toMatch(/No complete daily run has processed 2026-09-30/);
    const run = options([], now);
    const r = await runMonthly(db, { ...run.o, timeZone: tz });
    expect(r).toMatchObject({ ok: true, months: [] });
    expect(run.beats()).toBe(0);
  });

  it('a month whose last trading day is not final yet waits; the one before is audited', async () => {
    const { db } = await setup();
    // April 1, 01:00 in Tokyo: March is over there, but March 31 is 12:00 in New York.
    const o = {
      now: new Date('2026-03-31T16:00:00.000Z'),
      timeZone: TZ,
      sessions,
      finalAfter: '20:00',
    };
    const due = await monthsDue(db, o);
    expect(due.months).toEqual(['2026-02']);
    expect(due.why).toMatch(/2026-03-31.*not final/);
  });
});
