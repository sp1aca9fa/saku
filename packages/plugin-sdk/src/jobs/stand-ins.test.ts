// Closing a stand-in (requirements 04 stand-in rule 5) and the stand-in list.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sessions } from '@saku/data';
import {
  type StandInListRow,
  createUser,
  finishRun,
  schema,
  startRun,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { lock } from './lock';
import {
  ageInSessions,
  closeStandIn,
  latestDailyTarget,
  outsideRefetchWindow,
  standInListText,
} from './stand-ins';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-01-19'],
});
const D = '2026-01-07';
/** 11 sessions after D (01-19 is a holiday): just outside the daily refetch window. */
const PAST = '2026-01-23';

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' },
    { ticker: 'CCC', tier: 0, assetClass: 'equity', currency: 'USD' },
  ]);
  const ids = Object.fromEntries(
    (await db.select().from(schema.symbols)).map((s) => [s.ticker, s.id] as const),
  ) as Record<string, number>;
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
  const row = (
    ticker: string,
    date: string,
    over: Partial<typeof schema.standIns.$inferInsert> = {},
  ) => ({
    symbolId: ids[ticker]!,
    date,
    source: 's',
    close: 100,
    band: 0.001,
    basis: 'index',
    createdAt: '2026-01-07T21:30:00.000Z',
    ...over,
  });
  await db.insert(schema.standIns).values([
    row('AAA', D),
    row('AAA', '2026-01-08', { resolvedAt: '2026-01-09T21:30:00.000Z', deviation: 0.002 }),
    // Refused by a later run: no canonical bar.
    row('BBB', D),
    // Its canonical bar is another secondary's.
    row('CCC', D),
    // Older than the calendar.
    row('AAA', '2019-03-04'),
  ]);
  const bar = (ticker: string, date: string, source = 's') => ({
    symbolId: ids[ticker]!,
    date,
    close: 100,
    source,
    standIn: true,
  });
  await db
    .insert(schema.bars)
    .values([bar('AAA', D), bar('CCC', D, 's2'), bar('AAA', '2019-03-04')]);
  const daily = async (target: string, ok = true) =>
    finishRun(db, await startRun(db, 'daily', new Date(), target), {
      ok,
      datesProcessed: [target],
    });
  const lockDir = mkdtempSync(join(tmpdir(), 'saku-stand-in-lock-'));
  const close = (over: Partial<Parameters<typeof closeStandIn>[1]> = {}) =>
    closeStandIn(db, {
      ticker: 'AAA',
      date: D,
      username: 'ada',
      reason: 'primary will not deliver',
      sessions,
      now: new Date('2026-02-01T10:00:00Z'),
      lockDir,
      ...over,
    });
  return { db, ids, admin, daily, close, lockDir };
}

const closes = async (db: Awaited<ReturnType<typeof setup>>['db']) =>
  db.select().from(schema.activityLog).where(eq(schema.activityLog.action, 'stand_in.close'));

describe('closing a stand-in', () => {
  it('refuses, writing nothing: the wrong user, no reason, inside the refetch window, a stand-in it does not apply to', async () => {
    const { db, daily, close, lockDir } = await setup();
    const refused = async (over: Parameters<typeof close>[0], error: RegExp) => {
      const r = await close(over);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(error);
    };
    // Wrong user: not an admin, refused before anything else is read.
    await refused({ username: 'bo' }, /bo is not an admin/);
    await refused({ username: 'nobody' }, /No account nobody/);
    await refused({ reason: '  ' }, /Give the reason/);
    await refused({ date: '2026-02-30' }, /not a date/);
    // No complete daily run yet; then one inside the window (10 sessions after D), a failed one
    // later does not count.
    await refused({}, /no daily run has completed yet/);
    await daily('2026-01-22');
    await daily(PAST, false);
    expect(await latestDailyTarget(db)).toBe('2026-01-22');
    await refused({}, /10 sessions before .* inside the 10-session window/);
    await daily(PAST);
    // Age unknown (outside the calendar): fails closed.
    await refused({ date: '2019-03-04' }, /unknown \(outside the calendar\)/);
    // A job running.
    const held = lock('jobs', lockDir, 1);
    expect('release' in held).toBe(true);
    await refused({}, /A job is running \(process 1\)/);
    (held as { release: () => void }).release();
    await refused({ ticker: 'ZZZ' }, /No stand-in for ZZZ on 2026-01-07/);
    await refused({ date: '2026-01-08' }, /the primary replaced it at 2026-01-09T21:30:00.000Z/);
    await refused({ ticker: 'BBB' }, /a later run refused this stand-in \(no canonical bar\)/);
    await refused({ ticker: 'CCC' }, /the canonical bar is a stand-in from s2 at 100, not this/);
    expect(await closes(db)).toEqual([]);
    const disabled = await db
      .update(schema.users)
      .set({ disabledAt: '2026-01-01T00:00:00Z' })
      .where(eq(schema.users.username, 'ada'))
      .returning();
    expect(disabled).toHaveLength(1);
    await refused({}, /ada is disabled/);
  });

  it('records the close once, logged, the values unchanged', async () => {
    const { db, ids, admin, daily, close } = await setup();
    await daily(PAST);
    const where = and(eq(schema.standIns.symbolId, ids.AAA!), eq(schema.standIns.date, D));
    const [before] = await db.select().from(schema.standIns).where(where);
    expect(await close({ reason: '  primary will not deliver  ' })).toEqual({
      ok: true,
      closedAt: '2026-02-01T10:00:00.000Z',
      userId: admin,
    });
    expect((await db.select().from(schema.standIns).where(where))[0]).toEqual({
      ...before,
      closedAt: '2026-02-01T10:00:00.000Z',
      closedBy: admin,
      closeReason: 'primary will not deliver',
    });
    expect(await closes(db)).toMatchObject([
      {
        actor: admin,
        detail: {
          username: 'ada',
          ticker: 'AAA',
          date: D,
          source: 's',
          close: 100,
          reason: 'primary will not deliver',
        },
      },
    ]);
    const again = await close({ reason: 'other' });
    expect(!again.ok && again.error).toMatch(/already closed at 2026-02-01T10:00:00.000Z/);
    expect(await closes(db)).toHaveLength(1);
  });

  it('the refetch window: more than DAILY_OVERLAP sessions after the date', () => {
    expect(outsideRefetchWindow(sessions, D, '2026-01-22').ok).toBe(false);
    expect(outsideRefetchWindow(sessions, D, PAST).ok).toBe(true);
    expect(outsideRefetchWindow(sessions, D, undefined).ok).toBe(false);
    expect(outsideRefetchWindow(sessions, '2019-03-04', PAST).ok).toBe(false);
  });
});

const row = (over: Partial<StandInListRow> = {}): StandInListRow => ({
  ticker: 'AAA',
  date: D,
  source: 's',
  close: 100.5,
  band: 0.001,
  basis: 'index',
  createdAt: '2026-01-07T21:30:00.000Z',
  primaryClose: null,
  deviation: null,
  resolvedAt: null,
  closedAt: null,
  closedBy: null,
  closeReason: null,
  canonical: { source: 's', standIn: true, close: 100.5, divCash: 0 },
  ...over,
});

describe('pnpm sources stand-in list', () => {
  it('ages in sessions, unknown outside the calendar', () => {
    expect(ageInSessions(sessions, D, D)).toBe(0);
    expect(ageInSessions(sessions, D, '2026-01-08')).toBe(1);
    // A weekend and a holiday are not sessions.
    expect(ageInSessions(sessions, '2026-01-16', '2026-01-20')).toBe(1);
    expect(ageInSessions(sessions, '2019-03-04', '2026-01-08')).toBeUndefined();
  });

  it('says whether a canonical bar uses it, whether it can be closed, and what a refused one means', () => {
    const closed = {
      closedAt: '2026-02-01T10:00:00.000Z',
      closedBy: 'ada',
      closeReason: 'primary will not deliver',
    };
    const lines = standInListText(
      [
        row(),
        row({
          ticker: 'BBB',
          canonical: { source: 's', standIn: true, close: 100.5, divCash: 0.25 },
        }),
        row({ ticker: 'CCC', canonical: null }),
        row({ ticker: 'DDD', ...closed }),
        row({
          ticker: 'EEE',
          canonical: { source: 'p', standIn: false, close: 100.6, divCash: 0 },
          resolvedAt: '2026-01-08T21:30:00.000Z',
          deviation: 0.0012,
        }),
        row({ ticker: 'FFF', date: '2019-03-04' }),
        row({
          ticker: 'GGG',
          ...closed,
          canonical: { source: 's2', standIn: true, close: 100.7, divCash: 0 },
        }),
      ],
      { sessions, today: '2026-01-23', open: false, latestDaily: PAST },
    );
    expect(lines).toEqual([
      'ticker  date  source  close  band  age (sessions to 2026-01-23)  state  canonical bar',
      'AAA  2026-01-07  s  100.5  0.100%  11  open  canonical bar uses it (from s); closable',
      'BBB  2026-01-07  s  100.5  0.100%  11  open  canonical bar uses it (from s), distribution ' +
        'day (0.25: total-return signals read it at any age); closable',
      'CCC  2026-01-07  s  100.5  0.100%  11  open  refused, no canonical bar: the day reads as ' +
        'missing (red in the lookback); it cannot be closed and waits for the primary, holding ' +
        'corrections back until then (see docs/troubleshooting.md)',
      'DDD  2026-01-07  s  100.5  0.100%  11  closed 2026-02-01T10:00:00.000Z by ada: primary ' +
        'will not deliver  canonical bar uses it (from s)',
      'EEE  2026-01-07  s  100.5  0.100%  11  resolved 2026-01-08T21:30:00.000Z (primary off by ' +
        '0.120%)  canonical bar from p (not a stand-in)',
      'FFF  2019-03-04  s  100.5  0.100%  unknown (outside the calendar)  open  canonical bar ' +
        'uses it (from s); not closable yet: its age at the latest complete daily run ' +
        `(${PAST}) is unknown (outside the calendar)`,
      'GGG  2026-01-07  s  100.5  0.100%  11  closed 2026-02-01T10:00:00.000Z by ada: primary ' +
        'will not deliver; open again: its canonical bar is no longer this stand-in  canonical ' +
        'bar has another price (100.7 from s2)',
    ]);
    // Inside the refetch window: not yet.
    expect(
      standInListText([row()], { sessions, today: D, open: false, latestDaily: '2026-01-22' })[1],
    ).toContain('not closable yet: it is 10 sessions before');
  });

  it('the open list says which can be closed; an empty list says so', () => {
    const o = { sessions, today: '2026-01-23', latestDaily: PAST };
    expect(standInListText([], { ...o, open: true })).toEqual(['No open stand-ins.']);
    expect(standInListText([], { ...o, open: false })).toEqual(['No stand-ins stored.']);
    const last = standInListText([row()], { ...o, open: true }).at(-1)!;
    expect(last).toContain('pnpm sources stand-in close <TICKER> <YYYY-MM-DD> --reason');
    expect(last).toContain('A refused one cannot be closed: it waits for the primary.');
  });
});
