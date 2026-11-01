// The red re-check before execution (requirements 04 "Red re-check before execution", 11 "Red
// re-check"; decisions log 2026-11-01, C16; spec 2026-11-01 red-recheck): the deadline, the
// grading rules, and the forward step and alerts on a synthetic database (no network).
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
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
  firstGrading,
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
  it('opens a re-check only when a later hourly check still comes before the deadline', () => {
    expect(RECHECK_PERIOD_MINUTES).toBe(60);
    expect(firstGrading({ clock: deadline - 60 * MIN, deadline })).toBe('open');
    expect(firstGrading({ clock: deadline - 59 * MIN, deadline })).toBe('not_rechecked');
    expect(firstGrading({ clock: deadline + MIN, deadline })).toBe('not_rechecked');
  });

  it('re-grades: cleared, pending, the safe state at the last check, late past the deadline', () => {
    const at = (minutes: number, red: boolean) =>
      regrade({ red, clock: deadline + minutes * MIN, deadline });
    expect(at(-70, false)).toBe('cleared');
    expect(at(0, false)).toBe('cleared'); // at the deadline: data known by then counts
    expect(at(-70, true)).toBe('pending');
    expect(at(-60, true)).toBe('pending');
    expect(at(-59, true)).toBe('safe_state'); // the next check would come after the deadline
    expect(at(0, true)).toBe('safe_state');
    // Past the deadline: late whatever the day grades now (no look-ahead).
    expect(at(1, true)).toBe('late');
    expect(at(1, false)).toBe('late');
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

async function setup(o: { days?: number } = {}) {
  const n = o.days ?? 5;
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
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
  await addChannel(db, owner, { type: 'fake', target: 'me', authSecret: SECRET });
  // Registered after 01-08's close: the record starts with 01-09, the red day.
  const version = await registerVersion(db, {
    ownerId: owner,
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
  const alerting = (date = RED) => ({
    date,
    sessions,
    notifiers: [notifier],
    authSecret: SECRET,
    context: () => ({ http: null as never, now: new Date(), log: quiet }),
    log: quiet,
  });
  /** A run's forward step and alerts, as the daily run does them, at `now`. */
  const run = async (now: Date, to = RED) => {
    const runId = await check();
    const f = await forward(db, { runId, sessions, to, now });
    const r = await sendRecheckAlerts(db, alerting(to));
    const s = await sendStrategyAlerts(db, alerting(to));
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
    expect(payload(record[0]!).signaledAt).toBe(at.toISOString());
    expect(await verifyChain(db, version)).toEqual([]);
    const [note] = await annotationsOf(db, version.id, 'red_recheck');
    expect(note).toMatchObject({
      date: RED,
      detail: {
        firstRedAt: FIRST.toISOString(),
        reasons: ['AAA2:B.close_match@s'],
        deadline: DEADLINE,
        outcome: 'cleared',
        signaledAt: at.toISOString(),
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
    expect(sent).toHaveLength(1);
    // Monday 08:20 New York: the last check before the deadline.
    const at = new Date('2026-01-12T13:20:00Z');
    const last = await run(at);
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
    expect(payload(entry!).signaledAt).toBe(at.toISOString());
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
      signaledAt: at.toISOString(),
    });
    expect(payload(record[1]!).signaledAt).toBeUndefined();
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
    expect(sent[2]!.text).toContain(`Safe state → Risk on (signal of ${D[5]}).`);
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
    expect(payload(entry!).signaledAt).toBeUndefined();
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
    expect((await recheckOf(db, version.id, RED))!.provisionalSentAt).toBeNull();
    expect((await sendRecheckAlerts(db, alerting(up))).sent).toBe(1);
    expect((await sendRecheckAlerts(db, alerting(up))).sent).toBe(0);
    expect(up.sent).toHaveLength(1);
    expect((await recheckOf(db, version.id, RED))!.provisionalSentAt).not.toBeNull();
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
