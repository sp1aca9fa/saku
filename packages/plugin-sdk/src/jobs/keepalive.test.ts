import { Sessions } from '@saku/data';
import { type Db, finishRun, startRun } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../types';
import { sendHeartbeat } from './heartbeat';
import { type KeepAliveCheck, keepAlive, keepAliveDecision } from './keepalive';
import { readStamp, writeStamp } from './lock';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-11-26'],
});
const done: KeepAliveCheck = { action: 'exit', why: 'done' };

// Saturday 2026-11-07: the target is Friday 2026-11-06, done, pinged, its run a success.
type Input = Parameters<typeof keepAliveDecision>[0];
const healthy: Input = {
  target: '2026-11-06',
  today: '2026-11-07',
  todayIsSession: false,
  dailyStamp: '2026-11-06',
  heartbeatStamp: '2026-11-06',
  keepAliveStamp: '2026-11-06',
  latestDaily: { status: 'success', datesProcessed: ['2026-11-06'] },
  check: done,
};
const why = (o: Partial<Input>) => {
  const d = keepAliveDecision({ ...healthy, ...o });
  return d.send ? 'send' : d.why;
};

describe('keepAliveDecision (requirements 04 row H)', () => {
  it('sends when every rule holds, after a done exit or a complete re-check run', () => {
    expect(why({})).toBe('send');
    expect(why({ check: { action: 'recheck', ok: true } })).toBe('send');
  });

  it('never counts a missing, empty, unreal or earlier daily stamp as done', () => {
    for (const dailyStamp of [null, '', 'pending', '2026-11-31', '2026-11-05']) {
      expect(why({ dailyStamp })).toBe('not_done');
    }
  });

  it('stops after 7 calendar days on the same target', () => {
    expect(why({ today: '2026-11-13' })).toBe('send');
    expect(why({ today: '2026-11-14' })).toBe('target_old');
  });

  it('waits for the session ping of the target', () => {
    for (const heartbeatStamp of [null, '', 'x', '2026-11-05']) {
      expect(why({ heartbeatStamp })).toBe('session_ping_pending');
    }
  });

  it('stops while a re-check is stuck or after a failed re-check run', () => {
    expect(why({ check: { action: 'exit', why: 'stuck' } })).toBe('stuck');
    // The run could not record itself: the latest row is still the older success.
    expect(why({ check: { action: 'recheck', ok: false } })).toBe('recheck_failed');
  });

  it('needs the latest daily-kind run to be a success for the target', () => {
    expect(why({ latestDaily: undefined })).toBe('no_run');
    expect(why({ latestDaily: { status: 'failed', datesProcessed: ['2026-11-06'] } })).toBe(
      'run_failed',
    );
    for (const status of ['running', 'other']) {
      expect(why({ latestDaily: { status, datesProcessed: ['2026-11-06'] } })).toBe(
        'run_unfinished',
      );
    }
    // A stamp ahead of the database (a restored older copy, an edited stamp).
    expect(why({ latestDaily: { status: 'success', datesProcessed: ['2026-11-05'] } })).toBe(
      'run_other_day',
    );
    expect(why({ latestDaily: { status: 'success', datesProcessed: null } })).toBe('run_other_day');
  });

  it('leaves a session date to its session ping, up to 1 calendar day after the target', () => {
    // Friday 2026-11-06 evening after its ping; Friday morning with Thursday the target.
    expect(why({ today: '2026-11-06', todayIsSession: true })).toBe('session_due');
    const thu = { dailyStamp: '2026-11-05', heartbeatStamp: '2026-11-05' };
    const thuRun = { status: 'success', datesProcessed: ['2026-11-05'] };
    expect(
      why({
        ...thu,
        target: '2026-11-05',
        today: '2026-11-06',
        todayIsSession: true,
        latestDaily: thuRun,
      }),
    ).toBe('session_due');
    // Monday after the weekend (3 days), Friday after Thanksgiving (2 days), Thanksgiving itself.
    expect(why({ today: '2026-11-09', todayIsSession: true })).toBe('send');
    const wed = { dailyStamp: '2026-11-25', heartbeatStamp: '2026-11-25', target: '2026-11-25' };
    const wedRun = { status: 'success', datesProcessed: ['2026-11-25'] };
    expect(why({ ...wed, today: '2026-11-27', todayIsSession: true, latestDaily: wedRun })).toBe(
      'send',
    );
    expect(why({ ...wed, today: '2026-11-26', todayIsSession: false, latestDaily: wedRun })).toBe(
      'send',
    );
    // A failing rule is still the reason on a session date (it is the one logged).
    expect(
      why({ today: '2026-11-06', todayIsSession: true, check: { action: 'exit', why: 'stuck' } }),
    ).toBe('stuck');
    expect(
      why({
        today: '2026-11-06',
        todayIsSession: true,
        latestDaily: { status: 'failed', datesProcessed: ['2026-11-06'] },
      }),
    ).toBe('run_failed');
  });

  it('sends once per date: only an equal stamp counts as sent', () => {
    expect(why({ keepAliveStamp: '2026-11-07' })).toBe('sent_today');
    for (const keepAliveStamp of [null, 'pending 2026-11-07', '2026-11-08', '2026-11-06']) {
      expect(why({ keepAliveStamp })).toBe('send');
    }
  });

  it('gives the first failing rule', () => {
    expect(why({ dailyStamp: null, check: { action: 'exit', why: 'stuck' } })).toBe('not_done');
    expect(why({ heartbeatStamp: null, latestDaily: undefined })).toBe('session_ping_pending');
  });
});

function capture() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`),
    warn: (m, d) => lines.push(`WARN ${m} ${JSON.stringify(d ?? {})}`),
  };
  return { lines, log };
}

/** A healthy Saturday: stamps and a successful run for Friday 2026-11-06. */
async function setup(clock = '2026-11-07T05:20:00Z') {
  const db = await testDb();
  const dir = mkdtempSync(join(tmpdir(), 'saku-keepalive-'));
  for (const name of ['daily', 'heartbeat', 'keepalive']) writeStamp(name, '2026-11-06', dir);
  const id = await startRun(db, 'daily', new Date('2026-11-07T01:20:00Z'), '2026-11-06');
  await finishRun(db, id, { ok: true, datesProcessed: ['2026-11-06'] });
  const { lines, log } = capture();
  const pings: string[] = [];
  let answer = true;
  const o = {
    sessions,
    finalAfter: '20:00',
    check: done,
    log,
    stampsDir: dir,
    clock: () => new Date(clock),
    ping: async () => {
      pings.push(clock);
      return answer;
    },
  };
  return { db, dir, lines, pings, o, answer: (a: boolean) => (answer = a) };
}

describe('keepAlive', () => {
  it('sends once per New York date and stamps it; daily and heartbeat stamps untouched', async () => {
    const t = await setup();
    const before = ['daily', 'heartbeat'].map((n) => readFileSync(join(t.dir, n), 'utf8'));
    expect(await keepAlive(t.db, t.o)).toBe('sent');
    expect(readStamp('keepalive', t.dir)).toBe('2026-11-07');
    expect(await keepAlive(t.db, t.o)).toBe('sent_today');
    expect(t.pings).toHaveLength(1);
    expect(['daily', 'heartbeat'].map((n) => readFileSync(join(t.dir, n), 'utf8'))).toEqual(before);
    // The second call logs nothing: an hourly "already sent" line would only be noise.
    expect(t.lines).toEqual([
      'Heartbeat keep-alive sent {"date":"2026-11-07","target":"2026-11-06"}',
    ]);
  });

  it('takes the New York date: 23:30 New York is still that date', async () => {
    const t = await setup('2026-11-08T04:30:00Z');
    writeStamp('keepalive', '2026-11-07', t.dir);
    expect(await keepAlive(t.db, t.o)).toBe('sent_today');
    expect(t.pings).toEqual([]);
  });

  it('sends and logs nothing on a session date with its session ping due', async () => {
    // Friday 2026-11-06 21:20 New York, after that session's ping.
    const t = await setup('2026-11-07T02:20:00Z');
    expect(await keepAlive(t.db, t.o)).toBe('session_due');
    expect(t.pings).toEqual([]);
    expect(t.lines).toEqual([]);
    expect(readStamp('keepalive', t.dir)).toBe('2026-11-06');
  });

  it('does nothing, and logs nothing, without a URL', async () => {
    const t = await setup();
    const { ping: _, ...noUrl } = t.o;
    expect(await keepAlive(t.db, noUrl)).toBe('no_url');
    expect(t.lines).toEqual([]);
    expect(readStamp('keepalive', t.dir)).toBe('2026-11-06');
  });

  it('logs why it sent none, and sends nothing', async () => {
    const t = await setup();
    expect(await keepAlive(t.db, { ...t.o, check: { action: 'exit', why: 'stuck' } })).toBe(
      'stuck',
    );
    expect(t.pings).toEqual([]);
    expect(t.lines).toEqual(['No heartbeat keep-alive {"why":"stuck","target":"2026-11-06"}']);
  });

  it('leaves an unanswered ping pending, and the next hourly check tries again', async () => {
    const t = await setup();
    t.answer(false);
    expect(await keepAlive(t.db, t.o)).toBe('not_answered');
    expect(readStamp('keepalive', t.dir)).toBe('pending 2026-11-07');
    t.answer(true);
    expect(await keepAlive(t.db, t.o)).toBe('sent');
    expect(t.pings).toHaveLength(2);
    expect(readStamp('keepalive', t.dir)).toBe('2026-11-07');
  });

  it('sends nothing when its stamp cannot be written (no ping every hour)', async () => {
    const t = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'saku-keepalive-'));
    for (const name of ['daily', 'heartbeat']) writeStamp(name, '2026-11-06', dir);
    mkdirSync(join(dir, 'keepalive'));
    expect(await keepAlive(t.db, { ...t.o, stampsDir: dir })).toBe('error');
    expect(t.pings).toEqual([]);
    expect(t.lines[0]).toMatch(/^WARN Heartbeat keep-alive not sent: its stamp cannot be written/);
  });

  it('never throws: a ping that throws or a database that fails resolves with a warning', async () => {
    const t = await setup();
    const throwing = async (): Promise<boolean> => {
      throw new Error('boom');
    };
    expect(await keepAlive(t.db, { ...t.o, ping: throwing })).toBe('error');
    const broken = {
      select: () => {
        throw new Error('database closed');
      },
    } as unknown as Db;
    expect(await keepAlive(broken, t.o)).toBe('error');
    expect(t.pings).toEqual([]);
    expect(t.lines.every((l) => l.startsWith('WARN Heartbeat keep-alive not decided'))).toBe(true);
    expect(t.lines).toHaveLength(2);
  });

  it('never logs the URL when the ping fails', async () => {
    const t = await setup();
    const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    const url = `https://ping.example.test/${ID}`;
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const ping = () =>
      sendHeartbeat(url, 'HEALTHCHECK_URL keep-alive', t.o.log, {
        fetchImpl,
        sleep: async () => {},
      });
    expect(await keepAlive(t.db, { ...t.o, ping })).toBe('not_answered');
    expect(t.lines).toEqual([
      'WARN Heartbeat ping failed {"check":"HEALTHCHECK_URL keep-alive","error":"HTTP 503"}',
    ]);
  });
});
