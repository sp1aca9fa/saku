// The red re-check before execution (requirements 04 "Red re-check before execution", 11 "Red
// re-check"; decisions log 2026-11-01, C16; spec 2026-11-01 red-recheck): the deadline, the
// grading rules, and the forward step and alerts on a synthetic database (no network).
import type { RawBar } from '@saku/core';
import { Sessions, TOLERANCE } from '@saku/data';
import {
  addChannel,
  annotationsOf,
  createUser,
  forwardRecord,
  openRechecks,
  recheckOf,
  registerVersion,
  schema,
  seedSourceRoles,
  setSetting,
  startRun,
  storeRawBars,
  symbolId,
  upsertSymbols,
  verifyChain,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendRecheckAlerts, sendStrategyAlerts } from './alerts';
import { forward } from './forward';
import {
  RECHECK_PERIOD_MINUTES,
  dailyAction,
  firstGrading,
  openRecheckNote,
  recheckDeadline,
  regrade,
  shownDeadline,
} from './recheck';
import { fakeNotifier, quiet } from './testkit';
import { verify } from './verify';

const calendar = (holidays: string[] = []) =>
  new Sessions({ id: 't', version: 't', validFrom: '2026-01-01', validTo: '2026-12-31', holidays });
const sessions = calendar();
const MIN = 60_000;

describe('the re-check deadline', () => {
  it('the next session’s 09:30 New York open less the setting, over a weekend', () => {
    // Friday 2026-01-09: Monday's open, 09:30 EST = 14:30 UTC; default 60 minutes before.
    expect(recheckDeadline('2026-01-09', sessions, 60)).toBe('2026-01-12T13:30:00.000Z');
    // A weekday: the next morning.
    expect(recheckDeadline('2026-01-07', sessions, 60)).toBe('2026-01-08T13:30:00.000Z');
    // 0: the open itself; 600: 23:30 New York the evening before (Sunday here).
    expect(recheckDeadline('2026-01-09', sessions, 0)).toBe('2026-01-12T14:30:00.000Z');
    expect(recheckDeadline('2026-01-09', sessions, 600)).toBe('2026-01-12T04:30:00.000Z');
  });

  it('skips a holiday: the next session from the calendar', () => {
    // Monday 2026-01-19 a holiday: Friday's deadline is Tuesday's open.
    expect(recheckDeadline('2026-01-16', calendar(['2026-01-19']), 60)).toBe(
      '2026-01-20T13:30:00.000Z',
    );
  });

  it('follows US daylight saving (never a fixed UTC offset)', () => {
    // DST starts Sunday 2026-03-08: Friday 03-06's deadline is Monday 08:30 EDT = 12:30 UTC.
    expect(recheckDeadline('2026-03-06', sessions, 60)).toBe('2026-03-09T12:30:00.000Z');
    expect(recheckDeadline('2026-03-05', sessions, 60)).toBe('2026-03-06T13:30:00.000Z');
    // DST ends Sunday 2026-11-01: Friday 10-30's deadline is Monday 08:30 EST = 13:30 UTC.
    expect(recheckDeadline('2026-10-30', sessions, 60)).toBe('2026-11-02T13:30:00.000Z');
    expect(recheckDeadline('2026-10-29', sessions, 60)).toBe('2026-10-30T12:30:00.000Z');
    // A deadline 10 hours before Monday's open falls before the change back (Sunday 23:30 EST).
    expect(recheckDeadline('2026-10-30', sessions, 600)).toBe('2026-11-02T04:30:00.000Z');
  });

  it('unknown when the calendar does not cover the next session', () => {
    expect(recheckDeadline('2026-12-31', sessions, 60)).toBeUndefined();
  });

  it('is shown in the install time zone, as stored when not an instant', () => {
    expect(shownDeadline('2026-01-12T13:30:00.000Z', 'Asia/Tokyo')).toBe(
      '2026-01-12 22:30 (Asia/Tokyo)',
    );
    expect(shownDeadline('2026-03-09T12:30:00.000Z', 'America/New_York')).toBe(
      '2026-03-09 08:30 (America/New_York)',
    );
    expect(shownDeadline('soon', 'UTC')).toBe('soon');
  });
});

describe('the grading rules', () => {
  const deadline = Date.parse('2026-01-12T13:30:00.000Z');
  const at = (minutes: number) => deadline + minutes * MIN;
  it('opens a re-check only when the run’s next hourly check still comes before the deadline', () => {
    expect(RECHECK_PERIOD_MINUTES).toBe(60);
    expect(firstGrading({ start: at(-60), clock: at(-50), deadline })).toBe('open');
    expect(firstGrading({ start: at(-59), clock: at(-59), deadline })).toBe('not_rechecked');
    expect(firstGrading({ start: at(1), clock: at(1), deadline })).toBe('not_rechecked');
    // A step that ends past the deadline opens nothing, whenever the run started.
    expect(firstGrading({ start: at(-120), clock: at(1), deadline })).toBe('not_rechecked');
  });

  it('the last check is decided by the run’s start; past the deadline by the step’s clock', () => {
    const grade = (red: boolean, start: number, clock = start) =>
      regrade({ red, start: at(start), clock: at(clock), deadline });
    expect(grade(false, -70)).toBe('cleared');
    expect(grade(false, 0)).toBe('cleared'); // at the deadline: data known by then counts
    expect(grade(true, -70)).toBe('pending');
    expect(grade(true, -60)).toBe('pending');
    // 07:20 start, the step at 07:35: the 08:20 check still comes, so not final yet.
    expect(grade(true, -70, -55)).toBe('pending');
    expect(grade(true, -59)).toBe('safe_state'); // the next check would come after the deadline
    expect(grade(true, 0)).toBe('safe_state');
    // 08:20 start, the step at 08:31: the last check, not late.
    expect(grade(true, -10, 1)).toBe('safe_state');
    // A run started past the deadline: late whatever the day grades now (no look-ahead).
    expect(grade(true, 1)).toBe('late');
    expect(grade(false, 1)).toBe('late');
    // Cleared only on a grading at or before the deadline.
    expect(grade(false, -10, 1)).toBe('late');
    // A run that took over an hour: past the deadline, not pending.
    expect(grade(true, -70, 1)).toBe('late');
  });

  it('the hourly check: a daily run, a re-check run, or nothing', () => {
    const open = [{ versionId: 'v1', deadline: '2026-01-12T13:30:00.000Z' }];
    const now = new Date('2026-01-12T15:20:00Z');
    const stuck = {
      startedAt: '2026-01-12T14:20:00.000Z',
      status: 'failed',
      error: 'incomplete: forward; Trend (v1): definition does not parse: x',
    };
    expect(dailyAction({ stamped: false, force: false, open, now })).toEqual({ action: 'daily' });
    expect(dailyAction({ stamped: true, force: true, open, now })).toEqual({ action: 'daily' });
    expect(dailyAction({ stamped: true, force: false, open: [], now })).toEqual({
      action: 'exit',
      why: 'done',
    });
    // Open and before the deadline, or past it with no re-check run since: a re-check run.
    const before = new Date('2026-01-12T12:20:00Z');
    expect(
      dailyAction({ stamped: true, force: false, open, now: before, lastRecheck: stuck }),
    ).toEqual({ action: 'recheck' });
    expect(dailyAction({ stamped: true, force: false, open, now })).toEqual({ action: 'recheck' });
    // Past the deadline, the latest re-check run (after it) failed naming the version: nothing.
    expect(dailyAction({ stamped: true, force: false, open, now, lastRecheck: stuck })).toEqual({
      action: 'exit',
      why: 'stuck',
    });
    // Not when that run started before the deadline, succeeded, or did not name every version.
    for (const last of [
      { ...stuck, startedAt: '2026-01-12T13:20:00.000Z' },
      { ...stuck, status: 'success' },
      { ...stuck, error: 'incomplete: alerts' },
      { ...stuck, error: null },
    ]) {
      expect(dailyAction({ stamped: true, force: false, open, now, lastRecheck: last })).toEqual({
        action: 'recheck',
      });
    }
    const two = [...open, { versionId: 'v2', deadline: '2026-01-12T13:30:00.000Z' }];
    expect(
      dailyAction({ stamped: true, force: false, open: two, now, lastRecheck: stuck }),
    ).toEqual({ action: 'recheck' });
    // A deadline that is not an instant is never taken as passed.
    expect(
      dailyAction({
        stamped: true,
        force: false,
        open: [{ versionId: 'v1', deadline: 'x' }],
        now,
        lastRecheck: stuck,
      }),
    ).toEqual({ action: 'recheck' });
  });

  it('an open re-check on the strategy list', () => {
    expect(
      openRecheckNote({ date: '2026-01-09', deadline: '2026-01-12T13:30:00.000Z' }, 'Asia/Tokyo'),
    ).toBe('2026-01-09 red, re-check open until 2026-01-12 22:30 (Asia/Tokyo)');
  });
});

// The forward step's setup (forward.test.ts): AAA2's secondary disagrees on Friday 2026-01-09
// (red there); the day's deadline is Monday 2026-01-12 13:30 UTC (08:30 New York).
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12'];
const RED = D[4]!;
const DEADLINE = '2026-01-12T13:30:00.000Z';
const FIRST = new Date('2026-01-10T01:30:00Z'); // Friday 20:30 New York, the day's own run
const bars = (closes: number[]): RawBar[] =>
  closes.map((close, i) => ({
    date: D[i]!,
    open: close,
    high: close,
    low: close,
    close,
    closeIsSplitAdjusted: false,
    volume: 1000,
    divCash: 0,
    splitFactor: 1,
  }));
const strategy = {
  name: 'Trend',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'A',
      type: 'compare',
      left: { indicator: 'price', ticker: 'AAA' },
      op: '>',
      right: { indicator: 'sma', ticker: 'AAA', length: 2 },
    },
  ],
  allocations: [
    { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'AAA2', weight: 100 }] },
    { name: 'Calm', holdings: [{ ticker: 'AAA', weight: 100 }] },
  ],
};
const SECRET = 'k'.repeat(32);
const AAA = [100, 101, 102, 103, 104, 105];
const AAA2 = [50, 51, 52.0198, 53.0398, 54.0594, 55.0786];

async function setup(
  o: {
    days?: number;
    /** `library`: a version with no owner; `no_channel`: an owner with no channel. */
    owner?: 'library' | 'no_channel';
  } = {},
) {
  const n = o.days ?? 5;
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
    {
      ticker: 'AAA2',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      leverageFactor: 2,
      underlying: 'AAA',
    },
  ]);
  await seedSourceRoles(db, [
    { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
    { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
  ]);
  const store = async (ticker: string, source: string, list: RawBar[]) =>
    storeRawBars(db, {
      symbolId: (await symbolId(db, ticker))!,
      source,
      bars: list,
      runId: null,
      fetchedAt: 't',
    });
  await store('AAA', 'p', bars(AAA.slice(0, n)));
  await store('AAA', 's', bars(AAA.slice(0, n)));
  await store('AAA2', 'p', bars(AAA2.slice(0, n)));
  // The secondary disagrees on the red day: AAA2 is red there.
  await store('AAA2', 's', bars(AAA2.slice(0, n).map((c, i) => (i === 4 ? c * 1.01 : c))));
  const owner = await createUser(db, {
    username: 'alex',
    passwordHash: 'scrypt:x',
    totpSecretEnc: 'v1.x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  await setSetting(db, 'time_zone', 'America/New_York');
  if (o.owner === undefined) {
    await addChannel(db, owner, { type: 'fake', target: 'me', authSecret: SECRET });
  }
  // Registered after 01-08's close: the record starts with 01-09, the red day.
  const version = await registerVersion(db, {
    ownerId: o.owner === 'library' ? null : owner,
    name: 'Trend',
    strategy,
    at: new Date('2026-01-08T22:00:00Z'),
  });
  const check = async () => {
    const runId = await startRun(db, 'daily');
    await verify(db, { runId, sessions, mode: 'full', to: D[n - 1]! });
    return runId;
  };
  await check();
  await setSetting(db, 'forward_records_from', '2026-01-05');
  const { notifier, sent } = fakeNotifier();
  const alerting = (date = RED, clock?: Date) => ({
    date,
    sessions,
    notifiers: [notifier],
    authSecret: SECRET,
    context: () => ({ http: null as never, now: new Date(), log: quiet }),
    log: quiet,
    ...(clock && { clock }),
  });
  /**
   * A run's forward step and alerts, as the daily run does them: started at `start` (the timer's
   * tick), the forward step and the alerts at `now`.
   */
  const run = async (now: Date, to = RED, start = now) => {
    const runId = await check();
    const f = await forward(db, { runId, sessions, to, now, start });
    const r = await sendRecheckAlerts(db, { ...alerting(to, now), runId });
    const s = await sendStrategyAlerts(db, alerting(to, now));
    return { f, runId, failed: [...r.failed, ...s.failed] };
  };
  /** The secondary corrected: AAA2 agrees again on the red day. */
  const correct = () => store('AAA2', 's', bars(AAA2.slice(0, n)));
  return { db, version, store, run, correct, sent, check };
}

const payload = (e: { payload: string }) => JSON.parse(e.payload) as Record<string, unknown>;

describe('the forward step and the alerts', () => {
  it('red at the first grading: a provisional message, no entry; cleared later: the normal decision, its sent time, the first red as a note', async () => {
    const { db, version, run, correct, sent } = await setup();
    const first = await run(FIRST);
    expect(first.failed).toEqual([]);
    expect(first.f).toMatchObject({
      appended: 0,
      rechecks: [{ date: RED, deadline: DEADLINE, opened: true }],
    });
    expect(await forwardRecord(db, version.id)).toEqual([]);
    const [open] = await openRechecks(db);
    expect(open).toMatchObject({
      date: RED,
      firstRedAt: FIRST.toISOString(),
      deadline: DEADLINE,
      reasons: ['AAA2:B.close_match@s'],
      outcome: null,
    });
    expect(open!.provisionalSentAt).not.toBeNull();
    expect(open!.provisionalChannels).toBe(1);
    // The provisional: the data problem in words, hourly until the deadline (install time zone),
    // the fallback safe state with exact holdings, the data health.
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.text.split('\n');
    expect(lines[0]).toBe(`Trend: data problem for ${RED}, re-checking`);
    expect(lines).toContain(
      'Data is not reliable enough for a normal signal yet. Saku checks it again every hour until ' +
        '2026-01-12 08:30 (America/New_York) and then sends one final instruction.',
    );
    expect(lines).toContain(
      "If it is still not reliable then, the strategy's safe state applies. Safe-state target: AAA 100%.",
    );
    expect(lines).toContain('Trade at the US open on 2026-01-12.');
    expect(lines).toContain('Data health: red (no normal signal).');
    expect(lines.at(-1)).toBe('Details: AAA2: closes differ between sources (s).');

    // Monday 07:20 New York, the source corrected: cleared.
    await correct();
    const at = new Date('2026-01-12T12:20:00Z');
    const later = await run(at);
    expect(later.failed).toEqual([]);
    expect(later.f.finals).toEqual([
      { version: `Trend (${version.id})`, date: RED, outcome: 'cleared' },
    ]);
    const record = await forwardRecord(db, version.id);
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({
      date: RED,
      allocation: 'Risk on',
      dataStatus: 'green',
      safeStateApplied: false,
    });
    // What was finally signaled, with when, in the hashed text; the chain verifies.
    expect(payload(record[0]!).finalDecidedAt).toBe(at.toISOString());
    expect(await verifyChain(db, version)).toEqual([]);
    const [note] = await annotationsOf(db, version.id, 'red_recheck');
    expect(note).toMatchObject({
      date: RED,
      detail: {
        firstRedAt: FIRST.toISOString(),
        reasons: ['AAA2:B.close_match@s'],
        deadline: DEADLINE,
        outcome: 'cleared',
        finalDecidedAt: at.toISOString(),
      },
    });
    expect(await recheckOf(db, version.id, RED)).toMatchObject({
      outcome: 'cleared',
      finalAt: at.toISOString(),
      finalRunId: later.runId,
    });
    // One final instruction: the normal one; no second day alert.
    expect(sent).toHaveLength(2);
    const final = sent[1]!.text.split('\n');
    expect(final[0]).toBe(`Trend: data cleared for ${RED}`);
    expect(final).toContain(`First recorded allocation: Risk on (signal of ${RED}).`);
    expect(final).toContain('Target: AAA2 100%.');
    expect(final).toContain('Data health: green.');
    expect(final).toContain('Trade at the US open on 2026-01-12.');
    // The time it was sent: an annotation (the hashed field is when it was decided).
    const sentNotes = await annotationsOf(db, version.id, 'red_recheck_sent');
    expect(sentNotes).toEqual([
      expect.objectContaining({
        date: RED,
        runId: later.runId,
        detail: {
          sentAt: expect.any(String),
          outcome: 'cleared',
          finalDecidedAt: at.toISOString(),
        },
      }),
    ]);
    expect(await recheckOf(db, version.id, RED)).toMatchObject({
      finalSentAt: (sentNotes[0]!.detail as { sentAt: string }).sentAt,
      finalChannels: 1,
    });
    // Later runs: nothing more (idempotent), nothing appended again.
    const again = await run(new Date('2026-01-12T13:20:00Z'));
    expect(again.f.appended).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('still red at the last check before the deadline: the safe state, one final; corrections later annotate only', async () => {
    const { db, version, run, correct, sent } = await setup();
    await run(FIRST);
    // Sunday 20:20 and Monday 07:20 New York: still red, a later check comes before 08:30.
    for (const at of ['2026-01-12T01:20:00Z', '2026-01-12T12:20:00Z']) {
      const r = await run(new Date(at));
      expect(r.f).toMatchObject({ appended: 0, rechecks: [{ date: RED, opened: false }] });
    }
    // Started 07:20, the forward step at 07:35: the 08:20 check still comes, not final yet.
    const slow = await run(new Date('2026-01-12T12:35:00Z'), RED, new Date('2026-01-12T12:20:00Z'));
    expect(slow.f).toMatchObject({ appended: 0, rechecks: [{ date: RED, opened: false }] });
    expect(sent).toHaveLength(1);
    // Monday 08:20 New York: the last check before the deadline (its forward step at 08:31, a
    // minute past the deadline: still the last check, the safe state, not late).
    const at = new Date('2026-01-12T13:31:00Z');
    const last = await run(at, RED, new Date('2026-01-12T13:20:00Z'));
    expect(last.f.finals).toEqual([
      { version: `Trend (${version.id})`, date: RED, outcome: 'safe_state' },
    ]);
    const [entry] = await forwardRecord(db, version.id);
    expect(entry).toMatchObject({
      date: RED,
      allocation: 'Safe state',
      safeStateApplied: true,
      dataStatus: 'red',
      holdings: [{ ticker: 'AAA', weight: 100 }],
    });
    expect(payload(entry!).finalDecidedAt).toBe(at.toISOString());
    expect(await verifyChain(db, version)).toEqual([]);
    expect(sent).toHaveLength(2);
    const final = sent[1]!.text.split('\n');
    expect(final[0]).toBe(`Trend: safe state for ${RED}`);
    expect(final).toContain(
      'The data was still not reliable at the last re-check before 2026-01-12 08:30 ' +
        `(America/New_York), so the safe state stands. This is the final instruction for ${RED}.`,
    );
    expect(final).toContain('Target: AAA 100%.');
    // A correction after the deadline: no second final, the entry unchanged.
    await correct();
    const after = await run(new Date('2026-01-12T14:20:00Z'));
    expect(after.f.appended).toBe(0);
    expect(sent).toHaveLength(2);
    expect(await forwardRecord(db, version.id)).toEqual([entry]);
    // The re-check row is closed for good: its recorded values are never changed or deleted.
    await expect(
      db
        .update(schema.redRechecks)
        .set({ outcome: 'cleared' })
        .where(sql`1 = 1`),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.redRechecks)
        .set({ finalAt: 'x' })
        .where(sql`1 = 1`),
    ).rejects.toThrow();
    await expect(db.delete(schema.redRechecks)).rejects.toThrow();
  });

  it('a machine down past the deadline: the next run records the safe state as the provisional gave it, late', async () => {
    const { db, version, run, correct, sent } = await setup({ days: 6 });
    await run(FIRST);
    // The source corrected meanwhile; the next run comes after the deadline, after Monday's
    // close: the day stays in the safe state (no data known after the deadline is used), then
    // Monday is recorded after it (the chain order).
    await correct();
    const at = new Date('2026-01-13T01:30:00Z');
    const r = await run(at, D[5]);
    expect(r.failed).toEqual([]);
    expect(r.f.finals).toEqual([{ version: `Trend (${version.id})`, date: RED, outcome: 'late' }]);
    const record = await forwardRecord(db, version.id);
    expect(record.map((e) => [e.date, e.allocation, e.dataStatus])).toEqual([
      [RED, 'Safe state', 'red'],
      [D[5], 'Risk on', 'green'],
    ]);
    expect(payload(record[0]!)).toMatchObject({
      reasons: ['AAA2:B.close_match@s'],
      finalDecidedAt: at.toISOString(),
    });
    expect(payload(record[1]!).finalDecidedAt).toBeUndefined();
    expect(await verifyChain(db, version)).toEqual([]);
    // The late final says so; then Monday's own alert, against the final.
    const titles = sent.map((m) => m.text.split('\n')[0]);
    expect(titles).toEqual([
      `Trend: data problem for ${RED}, re-checking`,
      `Trend: safe state for ${RED}`,
      'Trend: new allocation',
    ]);
    expect(sent[1]!.text).toContain(
      'Saku could not re-check the data before the deadline (2026-01-12 08:30 ' +
        '(America/New_York)), so the safe state stands, as the provisional message said.',
    );
    // Sent after Monday's open: it applied then, never "trade at" a time already past.
    expect(sent[1]!.text).toContain(
      'This applied at the US open on 2026-01-12, which has already passed.',
    );
    expect(sent[1]!.text).not.toContain('Trade at the US open on 2026-01-12.');
    expect(sent[2]!.text).toContain(`Safe state → Risk on (signal of ${D[5]}).`);
    expect(sent[2]!.text).toContain(`Trade at the US open on ${sessions.after(D[5]!)}.`);
  });

  it('clears to yellow: the normal decision under the yellow rules, the warning in the final', async () => {
    const { db, version, run, store, sent } = await setup();
    await run(FIRST);
    // The secondary corrected to within twice the close tolerance: yellow, not red.
    await store(
      'AAA2',
      's',
      bars(AAA2.slice(0, 5).map((c, i) => (i === 4 ? c * (1 + 1.5 * TOLERANCE.close) : c))),
    );
    const at = new Date('2026-01-12T12:20:00Z');
    const r = await run(at);
    expect(r.f.finals).toEqual([
      { version: `Trend (${version.id})`, date: RED, outcome: 'cleared' },
    ]);
    const [entry] = await forwardRecord(db, version.id);
    expect(entry).toMatchObject({
      date: RED,
      allocation: 'Risk on',
      dataStatus: 'yellow',
      safeStateApplied: false,
    });
    expect(payload(entry!).reasons).toEqual(['AAA2:B.close_match@s']);
    expect(sent).toHaveLength(2);
    const final = sent[1]!.text.split('\n');
    expect(final[0]).toBe(`Trend: data cleared for ${RED}`);
    expect(final).toContain('Data health: yellow (computed with a warning).');
    expect(final.at(-1)).toBe('Details: AAA2: closes differ between sources (s).');
  });

  it('the next day waits while the day before is open (the chain order)', async () => {
    const { db, version, run } = await setup({ days: 6 });
    await run(FIRST);
    // A run for Monday before the deadline (not a real schedule, the rule): nothing after the
    // open day is recorded.
    const r = await run(new Date('2026-01-12T01:20:00Z'), D[5]);
    expect(r.f).toMatchObject({ appended: 0, rechecks: [{ date: RED, opened: false }] });
    expect(await forwardRecord(db, version.id)).toEqual([]);
  });

  it('a late first grading: the safe state at once, no provisional, its alert says so', async () => {
    const { db, version, run, sent } = await setup();
    // Monday 08:00 New York: within the hour before the deadline (no later check before it).
    const r = await run(new Date('2026-01-12T13:00:00Z'));
    expect(r.failed).toEqual([]);
    expect(r.f).toMatchObject({ appended: 1, rechecks: [], finals: [] });
    const [entry] = await forwardRecord(db, version.id);
    expect(entry).toMatchObject({ date: RED, safeStateApplied: true });
    // Recorded as before C16 (no sent time in the hashed text).
    expect(payload(entry!).finalDecidedAt).toBeUndefined();
    expect(await recheckOf(db, version.id, RED)).toMatchObject({ outcome: 'not_rechecked' });
    expect(await openRechecks(db)).toEqual([]);
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.text.split('\n');
    expect(lines[0]).toBe(`Trend: safe state for ${RED}`);
    expect(lines).toContain(
      'This day was graded too close to its re-check deadline (2026-01-12 08:30 ' +
        '(America/New_York)) or after it, so it is not re-checked: this is the final instruction.',
    );
  });

  it('a first grading after the next open: the safe state, said to have applied at that open', async () => {
    const { db, version, run, sent } = await setup();
    // Monday 10:00 New York, past the deadline and the open (a catch-up run).
    const r = await run(new Date('2026-01-12T15:00:00Z'));
    expect(r.failed).toEqual([]);
    expect(await recheckOf(db, version.id, RED)).toMatchObject({ outcome: 'not_rechecked' });
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.text.split('\n');
    expect(lines[0]).toBe(`Trend: safe state for ${RED}`);
    expect(lines).toContain('This applied at the US open on 2026-01-12, which has already passed.');
    expect(lines).not.toContain('Trade at the US open on 2026-01-12.');
  });

  it('an undelivered message is tried again at the next run, never sent twice', async () => {
    const { db, version } = await setup();
    const down = fakeNotifier(['me']);
    const up = fakeNotifier();
    const alerting = (n: ReturnType<typeof fakeNotifier>) => ({
      date: RED,
      sessions,
      notifiers: [n.notifier],
      authSecret: SECRET,
      context: () => ({ http: null as never, now: new Date(), log: quiet }),
      log: quiet,
    });
    const runId = await startRun(db, 'daily');
    await forward(db, { runId, sessions, to: RED, now: FIRST });
    expect((await sendRecheckAlerts(db, alerting(down))).failed).toHaveLength(1);
    expect(await recheckOf(db, version.id, RED)).toMatchObject({
      provisionalSentAt: null,
      provisionalChannels: null,
    });
    expect((await sendRecheckAlerts(db, alerting(up))).sent).toBe(1);
    expect((await sendRecheckAlerts(db, alerting(up))).sent).toBe(0);
    expect(up.sent).toHaveLength(1);
    expect((await recheckOf(db, version.id, RED))!.provisionalSentAt).not.toBeNull();
  });

  it.each([
    ['a library version', 'library'],
    ['an owner with no channel', 'no_channel'],
  ] as const)(
    '%s: the re-check runs and closes, but no message is said to be sent',
    async (_, owner) => {
      const { db, version, run, correct, sent } = await setup({ owner });
      expect((await run(FIRST)).failed).toEqual([]);
      expect(await recheckOf(db, version.id, RED)).toMatchObject({
        outcome: null,
        provisionalSentAt: null,
        provisionalChannels: 0,
      });
      await correct();
      const at = new Date('2026-01-12T12:20:00Z');
      expect((await run(at)).failed).toEqual([]);
      expect((await forwardRecord(db, version.id))[0]).toMatchObject({
        date: RED,
        allocation: 'Risk on',
      });
      // Told to no channel: no sending time and no `red_recheck_sent` annotation; marked with 0
      // so it is not looked at again.
      expect(await recheckOf(db, version.id, RED)).toMatchObject({
        outcome: 'cleared',
        finalSentAt: null,
        finalChannels: 0,
      });
      expect(await annotationsOf(db, version.id, 'red_recheck_sent')).toEqual([]);
      expect((await run(new Date('2026-01-12T13:20:00Z'))).failed).toEqual([]);
      expect(await annotationsOf(db, version.id, 'red_recheck_sent')).toEqual([]);
      expect(sent).toEqual([]);
    },
  );

  it('a day alert that is not a late safe state keeps "trade at", even when sent after the open', async () => {
    const { run, correct, sent } = await setup();
    // No red day (corrected before the first run); a catch-up run after Monday's open.
    await correct();
    expect((await run(new Date('2026-01-12T15:00:00Z'))).failed).toEqual([]);
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.text.split('\n');
    expect(lines).toContain('Trade at the US open on 2026-01-12.');
    expect(sent[0]!.text).not.toContain('already passed');
  });

  it('nothing before the A1 gate (no forward records, no re-check)', async () => {
    const { db, check, sent } = await setup();
    await db.delete(schema.appSettings).where(eq(schema.appSettings.key, 'forward_records_from'));
    const runId = await check();
    const f = await forward(db, { runId, sessions, to: RED, now: FIRST });
    expect(f.skipped).toBeDefined();
    expect(await openRechecks(db)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a stored setting that does not parse: no re-check, the safe state at once, the run told', async () => {
    const { db, version, run } = await setup();
    await db
      .insert(schema.appSettings)
      .values({ key: 'red_recheck_minutes_before_open', value: 'x' });
    const r = await run(FIRST);
    expect(r.f.problems).toEqual([expect.stringMatching(/red_recheck_minutes_before_open is x/)]);
    expect(r.f.appended).toBe(1);
    expect((await forwardRecord(db, version.id))[0]).toMatchObject({ safeStateApplied: true });
    expect(await recheckOf(db, version.id, RED)).toBeUndefined();
  });

  it('the setting moves the deadline (stored with the re-check when it opens)', async () => {
    const { db, run } = await setup();
    await setSetting(db, 'red_recheck_minutes_before_open', '0');
    await run(FIRST);
    const [open] = await openRechecks(db);
    expect(open!.deadline).toBe('2026-01-12T14:30:00.000Z');
  });
});
