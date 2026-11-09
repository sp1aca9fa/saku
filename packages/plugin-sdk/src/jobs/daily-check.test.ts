import { Sessions } from '@saku/data';
import { finishRun, startRun } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../types';
import { type DailyCheckDeps, dailyCheck, dailyPings } from './daily-check';
import { readStamp } from './lock';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-11-26'],
});
// New York (EST) times as instants. Thursday 2026-11-05 20:20: the target is 2026-11-05.
const THU_2020 = '2026-11-06T01:20:00Z';
const THU_2120 = '2026-11-06T02:20:00Z';
const FRI_0020 = '2026-11-06T05:20:00Z';
const FRI_2020 = '2026-11-07T01:20:00Z';
const FRI_2120 = '2026-11-07T02:20:00Z';
const SAT_0020 = '2026-11-07T05:20:00Z';
const SAT_0120 = '2026-11-07T06:20:00Z';
const SAT_0220 = '2026-11-07T07:20:00Z';
const SAT_1000 = '2026-11-07T15:00:00Z';
const SAT_1120 = '2026-11-07T16:20:00Z';
const SUN_0020 = '2026-11-08T05:20:00Z';
const MON_0020 = '2026-11-09T05:20:00Z';
const MON_1020 = '2026-11-09T15:20:00Z';
const MON_2020 = '2026-11-10T01:20:00Z';
const TUE_0020 = '2026-11-10T05:20:00Z';
// Friday's red day, re-checked until Monday's open less an hour.
const OPEN = [{ date: '2026-11-06', versionId: 'v-demo-1', deadline: '2026-11-09T13:30:00.000Z' }];

type Outcome = 'ok' | 'fail' | 'throw' | 'no_row';

async function setup() {
  const db = await testDb();
  const dir = mkdtempSync(join(tmpdir(), 'saku-daily-check-'));
  const lines: string[] = [];
  const log: Logger = {
    info: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`),
    warn: (m, d) => lines.push(`WARN ${m} ${JSON.stringify(d ?? {})}`),
  };
  const calls: string[] = [];
  let outcome: Outcome = 'ok';
  let answer = true;
  let open: typeof OPEN = [];
  const check = (now: string, extra: Partial<DailyCheckDeps> = {}) =>
    dailyCheck(db, {
      sessions,
      finalAfter: '20:00',
      force: false,
      now: new Date(now),
      clock: () => new Date(now),
      log,
      stampsDir: dir,
      heartbeat: async () => (calls.push('session ping'), answer),
      keepAlivePing: async () => (calls.push('keep-alive'), true),
      openRechecks: async () => open,
      run: async (o) => {
        calls.push(`${o.recheck ? 're-check' : 'daily'} run ${o.target}`);
        if (outcome === 'throw') throw new Error('could not start');
        if (outcome === 'no_row') return { ok: false };
        const id = await startRun(db, 'daily', new Date(now), o.target, { recheck: o.recheck });
        if (outcome === 'ok' && !o.recheck) await o.onComplete('daily');
        await finishRun(db, id, { ok: outcome === 'ok', datesProcessed: [o.target] });
        return { ok: outcome === 'ok' };
      },
      ...extra,
    });
  return {
    db,
    dir,
    lines,
    calls,
    check,
    set: (o: { outcome?: Outcome; answer?: boolean; open?: typeof OPEN }) => {
      outcome = o.outcome ?? outcome;
      answer = o.answer ?? answer;
      open = o.open ?? open;
    },
  };
}

describe('dailyCheck', () => {
  it('runs the day once final, stamps it and pings; keeps alive once a date with no session ping due', async () => {
    const t = await setup();
    expect(await t.check(THU_2020)).toBe(0);
    expect(t.calls).toEqual(['daily run 2026-11-05', 'session ping']);
    expect([readStamp('daily', t.dir), readStamp('heartbeat', t.dir)]).toEqual([
      '2026-11-05',
      '2026-11-05',
    ]);
    // Thursday evening and Friday until its run: the session ping is due, so no keep-alive.
    for (const now of [THU_2120, FRI_0020, FRI_2020, FRI_2120]) expect(await t.check(now)).toBe(0);
    // Saturday, Sunday and Monday (the first session after them): one each date.
    for (const now of [SAT_0020, SAT_0120, SUN_0020, MON_0020]) expect(await t.check(now)).toBe(0);
    for (const now of [MON_2020, TUE_0020]) expect(await t.check(now)).toBe(0);
    expect(t.calls.slice(2)).toEqual([
      'daily run 2026-11-06',
      'session ping',
      'keep-alive',
      'keep-alive',
      'keep-alive',
      'daily run 2026-11-09',
      'session ping',
    ]);
    expect(readStamp('keepalive', t.dir)).toBe('2026-11-09');
    // A date not due or already sent logs nothing.
    expect(t.lines.filter((l) => l.startsWith('No heartbeat keep-alive'))).toEqual([]);
  });

  it('never keeps alive on a day not done: the failed run is all', async () => {
    const t = await setup();
    await t.check(FRI_2020);
    t.set({ outcome: 'fail' });
    // Monday 20:20: the target moves to 2026-11-09; its run fails, every hour.
    expect(await t.check(MON_2020)).toBe(1);
    expect(await t.check(TUE_0020)).toBe(1);
    expect(t.calls.slice(2)).toEqual(['daily run 2026-11-09', 'daily run 2026-11-09']);
    expect(t.lines.filter((l) => l.includes('keep-alive'))).toEqual([]);
  });

  it('tries a failed session ping again, then keeps alive in the same check', async () => {
    const t = await setup();
    t.set({ answer: false });
    expect(await t.check(FRI_2020)).toBe(0);
    expect(readStamp('heartbeat', t.dir)).toBeNull();
    expect(await t.check(FRI_2120)).toBe(0);
    expect(t.lines).toContain(
      'No heartbeat keep-alive {"why":"session_ping_pending","target":"2026-11-06"}',
    );
    t.set({ answer: true });
    expect(await t.check(SAT_0020)).toBe(0);
    expect(t.calls).toEqual([
      'daily run 2026-11-06',
      'session ping',
      'session ping',
      'session ping',
      'keep-alive',
    ]);
    expect(readStamp('heartbeat', t.dir)).toBe('2026-11-06');
  });

  it('tries the session ping again only while the latest daily run succeeded: a failed --force', async () => {
    const t = await setup();
    t.set({ answer: false });
    expect(await t.check(FRI_2020)).toBe(0);
    t.set({ outcome: 'fail', answer: true });
    expect(await t.check(SAT_1000, { force: true })).toBe(1);
    expect(await t.check(SAT_1120)).toBe(0);
    expect(t.calls).toEqual(['daily run 2026-11-06', 'session ping', 'daily run 2026-11-06']);
    expect(t.lines).toContain('No session ping retry {"why":"run_failed","target":"2026-11-06"}');
    expect(readStamp('heartbeat', t.dir)).toBeNull();
  });

  it('a failed re-check run after a failed session ping blocks its retry until a run succeeds', async () => {
    const t = await setup();
    t.set({ answer: false });
    await t.check(FRI_2020);
    // Saturday 00:20: the retry (latest run Friday's success) is not answered; the re-check fails.
    t.set({ open: OPEN, outcome: 'fail' });
    expect(await t.check(SAT_0020)).toBe(1);
    // 01:20: the latest run failed, so no retry; this re-check run completes.
    t.set({ answer: true, outcome: 'ok' });
    expect(await t.check(SAT_0120)).toBe(0);
    expect(t.lines).toContain('No session ping retry {"why":"run_failed","target":"2026-11-06"}');
    // 02:20: the latest run (that re-check) succeeded: the retry, then the keep-alive.
    expect(await t.check(SAT_0220)).toBe(0);
    expect(t.calls).toEqual([
      'daily run 2026-11-06',
      'session ping',
      'session ping',
      're-check run 2026-11-06',
      're-check run 2026-11-06',
      'session ping',
      're-check run 2026-11-06',
      'keep-alive',
    ]);
  });

  it('--force runs again and never keeps alive', async () => {
    const t = await setup();
    await t.check(FRI_2020);
    expect(await t.check(SAT_0020, { force: true })).toBe(0);
    expect(t.calls.slice(2)).toEqual(['daily run 2026-11-06', 'session ping']);
    // The next hourly check sends Saturday's.
    expect(await t.check(SAT_0120)).toBe(0);
    expect(t.calls.slice(4)).toEqual(['keep-alive']);
  });

  it('after a re-check run, its outcome decides', async () => {
    const t = await setup();
    await t.check(FRI_2020);
    // Not recorded: the latest row is still the day's own success, but the run failed.
    t.set({ open: OPEN, outcome: 'no_row' });
    expect(await t.check(SAT_0020)).toBe(1);
    t.set({ outcome: 'fail' });
    expect(await t.check(SAT_0120)).toBe(1);
    t.set({ outcome: 'ok' });
    expect(await t.check(SAT_0220)).toBe(0);
    expect(t.calls.slice(2)).toEqual([
      're-check run 2026-11-06',
      're-check run 2026-11-06',
      're-check run 2026-11-06',
      'keep-alive',
    ]);
    expect(t.lines.filter((l) => l.includes('recheck_failed'))).toHaveLength(2);
  });

  it('a run that cannot start exits 1 with no keep-alive', async () => {
    const t = await setup();
    await t.check(FRI_2020);
    t.set({ open: OPEN, outcome: 'throw' });
    expect(await t.check(SAT_0020)).toBe(1);
    expect(t.calls.slice(2)).toEqual(['re-check run 2026-11-06']);
    expect(t.lines.at(-1)).toMatch(/^WARN Run could not start or finish .*could not start/);
  });

  it('a stuck re-check exits 0 with its warning and no keep-alive', async () => {
    const t = await setup();
    await t.check(FRI_2020);
    // Monday 09:20, after the deadline: the re-check run fails naming the version.
    const id = await startRun(t.db, 'daily', new Date('2026-11-09T14:20:00Z'), '2026-11-06', {
      recheck: true,
    });
    await finishRun(t.db, id, { ok: false, error: 'forward: v-demo-1 does not read back' });
    t.set({ open: OPEN });
    expect(await t.check(MON_1020)).toBe(0);
    expect(t.calls.slice(2)).toEqual([]);
    expect(t.lines.slice(-2)).toEqual([
      expect.stringMatching(/^WARN Red re-checks past their deadline cannot close/),
      'No heartbeat keep-alive {"why":"stuck","target":"2026-11-06"}',
    ]);
  });
});

describe('dailyPings', () => {
  const sent: string[] = [];
  const send = async (url: string, check: string) => (sent.push(`${check} ${url}`), true);
  const URL_ = 'https://ping.example.test/daily';
  const WEEKLY = 'https://ping.example.test/weekly';

  it('sends both to HEALTHCHECK_URL, the keep-alive under its own label; never the weekly URL', async () => {
    sent.length = 0;
    const p = dailyPings({ HEALTHCHECK_URL: ` ${URL_} `, HEALTHCHECK_WEEKLY_URL: WEEKLY }, send);
    expect(await p.heartbeat()).toBe(true);
    expect(await p.keepAlivePing?.()).toBe(true);
    expect(sent).toEqual([`HEALTHCHECK_URL ${URL_}`, `HEALTHCHECK_URL keep-alive ${URL_}`]);
  });

  it('has no keep-alive, and the session ping sends nothing, when the URL is unset or blank', async () => {
    sent.length = 0;
    for (const env of [{}, { HEALTHCHECK_URL: '' }, { HEALTHCHECK_URL: '  ' }]) {
      const p = dailyPings({ ...env, HEALTHCHECK_WEEKLY_URL: WEEKLY }, send);
      expect(p.keepAlivePing).toBeUndefined();
      expect(await p.heartbeat()).toBe(false);
    }
    expect(sent).toEqual([]);
  });
});
