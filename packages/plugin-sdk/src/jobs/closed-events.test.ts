// A dividend or split dated on a closed market day (requirements 04 "Closed-day bars", decisions
// log 2026-11-01, C19): the fund stays red on every session from the next one on, in every run
// that grades them, until the source's stored bar no longer carries the event or an admin
// resolves it (recorded); the event never enters the canonical series.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  createUser,
  schema,
  seedSourceRoles,
  startRun,
  storeRawBars,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { and, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closedDayEventText, closedDayEvents, resolveClosedEvent } from './closed-events';
import { lock } from './lock';
import { verify } from './verify';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
/** 45 sessions from Friday 2026-01-09; the event is dated Saturday 2026-01-10. */
const DAYS = sessions.between('2026-01-09', '2026-03-12');
const SATURDAY = '2026-01-10';
const NEXT = '2026-01-12';
const LAST = DAYS.at(-1)!;
/** 31 sessions after NEXT: well past the 10-session re-check window. */
const LATE = DAYS[31]!;

const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  closeIsSplitAdjusted: false,
  volume: 1000,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
/** AAA +0.1% a session, both sources alike. */
const closes = DAYS.map((date, i) => bar(date, 100 * 1.001 ** i));
/** The primary's Saturday bar: Friday's close with a dividend. */
const dividend = bar(SATURDAY, 100, { divCash: 0.5 });

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' },
  ]);
  await seedSourceRoles(db, [
    { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
    { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
  ]);
  const store = async (ticker: string, source: string, list: RawBar[], at = 't') =>
    storeRawBars(db, {
      symbolId: (await symbolId(db, ticker))!,
      source,
      bars: [...list].sort((a, b) => (a.date < b.date ? -1 : 1)),
      runId: null,
      fetchedAt: at,
    });
  await store('AAA', 'p', [...closes, dividend]);
  await store('AAA', 's', closes);
  await store('BBB', 'p', closes);
  await store('BBB', 's', closes);
  const account = (username: string, isAdmin: boolean) =>
    createUser(db, {
      username,
      passwordHash: 'x',
      totpSecretEnc: 'x',
      totpLastStep: 1,
      backupCodeHashes: [username],
      isAdmin,
    });
  const admin = await account('ada', true);
  await account('bo', false);
  const aaa = (await symbolId(db, 'AAA'))!;
  /** AAA's grade per session as one run stored it (`daily`: the window before `to`). */
  const graded = async (mode: 'full' | 'daily', to = LAST) => {
    const runId = await startRun(db, mode === 'full' ? 'weekly' : 'daily');
    const summary = await verify(db, {
      runId,
      sessions,
      mode,
      to,
      ...(mode === 'daily' && { from: sessions.before(to, 10) }),
    });
    const rows = await db
      .select()
      .from(schema.dataHealth)
      .where(and(eq(schema.dataHealth.runId, runId), eq(schema.dataHealth.symbolId, aaa)));
    const canonical = await db.select().from(schema.bars).where(eq(schema.bars.symbolId, aaa));
    return {
      summary,
      status: new Map(rows.map((h) => [h.date, `${h.status} ${h.reasons.join(',')}`])),
      bars: new Map(canonical.map((b) => [b.date, b.status])),
    };
  };
  const lockDir = mkdtempSync(join(tmpdir(), 'saku-closed-event-'));
  const resolve = (o: { username?: string; reason?: string; date?: string; ticker?: string }) =>
    resolveClosedEvent(db, {
      ticker: o.ticker ?? 'AAA',
      date: o.date ?? SATURDAY,
      username: o.username ?? 'ada',
      reason: o.reason ?? 'no such dividend (issuer site lists none)',
      sessions,
      now: new Date('2026-03-13T00:00:00Z'),
      lockDir,
    });
  return { db, store, admin, aaa, graded, resolve, lockDir };
}

const RED = /^red .*closed_day_event@2026-01-10/;

describe('a dividend or split dated on a closed day (C19)', () => {
  it('keeps the fund red on every session from the next one on, well past 10, daily and full', async () => {
    const { graded } = await setup();
    const full = await graded('full');
    for (const date of DAYS.filter((d) => d >= NEXT)) {
      expect(full.status.get(date)).toMatch(RED);
      expect(full.bars.get(date)).toBe('red');
    }
    // Friday, before it, keeps its own grade (full passes store only non-green symbol rows).
    expect(full.status.get('2026-01-09')).toBeUndefined();
    expect(full.bars.get('2026-01-09')).toBe('green');
    expect(full.bars.has(SATURDAY)).toBe(false);
    // A daily run 31 sessions later: its own window red, the run's date included.
    const daily = await graded('daily', LATE);
    expect(daily.status.get(LATE)).toMatch(RED);
    expect(daily.summary.health).toBe('red');
    expect(daily.summary.reasons).toEqual(['AAA']);
  });

  it('an admin resolution lifts the red from the next run on, recorded; the event stays out', async () => {
    const { db, graded, resolve, admin } = await setup();
    expect(await resolve({ username: 'bo' })).toEqual({
      ok: false,
      error: 'bo is not an admin: only an admin resolves a closed-day event.',
    });
    expect(await resolve({ username: 'nobody' })).toMatchObject({ ok: false });
    expect(await resolve({ reason: '  ' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Give the reason/),
    });
    expect(await resolve({ date: '2026-02-30' })).toMatchObject({ ok: false });
    expect(await resolve({ date: NEXT })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is a trading day/),
    });
    expect(await resolve({ date: '2026-01-11' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no bar from p on 2026-01-11/),
    });
    expect(await resolve({ ticker: 'BBB' })).toMatchObject({ ok: false });
    expect(await resolve({ ticker: 'ZZZ' })).toMatchObject({ ok: false, error: 'No symbol ZZZ.' });
    expect(await db.select().from(schema.closedEventResolutions)).toEqual([]);

    const done = await resolve({});
    expect(done).toEqual({ ok: true, resolvedAt: '2026-03-13T00:00:00.000Z', userId: admin });
    expect(await resolve({})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already resolved at 2026-03-13T00:00:00.000Z by ada/),
    });
    const [row] = await db.select().from(schema.closedEventResolutions);
    expect(row).toMatchObject({
      date: SATURDAY,
      source: 'p',
      divCash: 0.5,
      splitFactor: 1,
      resolvedBy: admin,
      reason: 'no such dividend (issuer site lists none)',
    });
    const [logged] = await db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.action, 'closed_event.resolve'));
    expect(logged).toMatchObject({
      actor: admin,
      detail: { username: 'ada', ticker: 'AAA', date: SATURDAY, divCash: 0.5, reason: row!.reason },
    });
    // Append-only.
    await expect(db.update(schema.closedEventResolutions).set({ reason: 'x' })).rejects.toThrow();
    await expect(db.delete(schema.closedEventResolutions)).rejects.toThrow();

    const full = await graded('full');
    expect([...full.status.values()].join()).not.toMatch(/closed_day_event/);
    expect(full.bars.get(LATE)).toBe('green');
    // Only the red is lifted: the Saturday bar stays out of the series, its own grade red.
    expect(full.bars.has(SATURDAY)).toBe(false);
    expect(full.status.get(SATURDAY)).toMatch(/^red A\.bar_valid@p/);
  });

  it('a corrected raw bar (logged as a revision) clears it with no resolution', async () => {
    const { db, store, graded } = await setup();
    expect((await graded('full')).status.get(LATE)).toMatch(RED);
    await store('AAA', 'p', [{ ...dividend, divCash: 0 }], 't2');
    const revisions = await db
      .select()
      .from(schema.barRevisions)
      .where(eq(schema.barRevisions.date, SATURDAY));
    expect(revisions.length).toBeGreaterThan(0);
    const daily = await graded('daily', LATE);
    expect(daily.status.get(LATE)).toBe('green ');
    // Every canonical bar it rebuilt (up to its date) is no longer red.
    expect([...daily.bars].filter(([d, s]) => d <= LATE && s === 'red')).toEqual([]);
  });

  it('a resolution covers the event as stored: one the source changes later is red again', async () => {
    const { store, graded, resolve } = await setup();
    expect((await resolve({})).ok).toBe(true);
    await store('AAA', 'p', [{ ...dividend, divCash: 0.6 }], 't2');
    expect((await graded('full')).status.get(LATE)).toMatch(RED);
  });

  it('refused while a job runs; nothing written', async () => {
    const { db, resolve, lockDir } = await setup();
    // Held by another live process (pid 1).
    const held = lock('jobs', lockDir, 1);
    if ('heldBy' in held) throw new Error('lock not taken');
    try {
      expect(await resolve({})).toMatchObject({
        ok: false,
        error: expect.stringMatching(/A job is running \(process 1\)/),
      });
    } finally {
      held.release();
    }
    expect(
      await db
        .select()
        .from(schema.activityLog)
        .where(isNotNull(schema.activityLog.detail))
        .then((rows) => rows.filter((r) => r.action === 'closed_event.resolve')),
    ).toEqual([]);
  });

  it('lists the events of the primary, open or resolved', async () => {
    const { db, resolve } = await setup();
    const open = await closedDayEvents(db, sessions);
    expect(open).toMatchObject([
      { ticker: 'AAA', date: SATURDAY, next: NEXT, source: 'p', divCash: 0.5, splitFactor: 1 },
    ]);
    expect(open[0]!.resolution).toBeUndefined();
    const text = closedDayEventText(open, { open: true });
    expect(text[1]).toBe(
      'AAA  2026-01-10  2026-01-12  p  0.5  1  open: the fund is red from the next session on',
    );
    expect(text.at(-1)).toMatch(/pnpm sources closed-event resolve <TICKER> <YYYY-MM-DD>/);
    await resolve({});
    const after = await closedDayEvents(db, sessions);
    expect(closedDayEventText(after, { open: true })).toEqual(['No open closed-day events.']);
    expect(closedDayEventText(after, { open: false })[1]).toBe(
      'AAA  2026-01-10  2026-01-12  p  0.5  1  resolved 2026-03-13T00:00:00.000Z by ada: ' +
        'no such dividend (issuer site lists none)',
    );
  });
});
