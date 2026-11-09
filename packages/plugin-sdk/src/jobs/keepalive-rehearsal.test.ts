// The heartbeat keep-alive rehearsal (requirements 04 row H): synthetic hourly checks over a
// weekend across the DST change, a holiday, a failed --force run, a failed and a stuck re-check,
// failed pings, a weekday outage and unfinished runs, each through `dailyCheck` itself (the real
// stamps, job_runs rows, re-check action and `sendHeartbeat`; only the run's work is scripted),
// against a model of the healthchecks.io check (period 1 day, grace 6 hours: down 30 hours after
// the last ping). Every printed line is asserted; `SAKU_REHEARSAL=1` also prints them.
import { tradingDateOf, zonedInstant } from '@saku/core';
import { Sessions } from '@saku/data';
import { finishRun, startRun } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Logger } from '../types';
import { dailyCheck } from './daily-check';
import { sendHeartbeat } from './heartbeat';
import { writeStamp } from './lock';
import { dailyTarget } from './target';

const HOUR = 3_600_000;
const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const URL_ = `https://ping.example.test/${ID}`;
const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-11-26'],
});
/** A New York wall time `YYYY-MM-DD HH:MM` as an instant. */
const at = (ny: string) =>
  Date.parse(zonedInstant(ny.slice(0, 10), ny.slice(11), 'America/New_York'));
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});
const shown = (t: number) => {
  const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
};

type Outcome = 'ok' | 'fail' | 'unrecorded' | 'killed';
interface Scenario {
  title: (s: { rechecks: number; stuck: number }) => string;
  seed: string;
  from: string;
  to: string;
  forced?: string[];
  outcome?: (t: number, o: { recheck: boolean; forced: boolean }) => Outcome;
  open?: (t: number) => { date: string; versionId: string; deadline: string }[];
  fails?: (t: number) => boolean;
  /** The checks expected to exit 1. */
  exits: number;
}

const between = (t: number, a: string, b: string) => t >= at(a) && t <= at(b);
const SCENARIOS: Record<string, Scenario> = {
  A: {
    title: () => 'weekend over the DST change, every run complete',
    seed: '2026-10-29',
    from: '2026-10-30 00:20',
    to: '2026-11-03 00:20',
    exits: 0,
  },
  B: {
    title: () => 'Thanksgiving and the weekend after it',
    seed: '2026-11-24',
    from: '2026-11-25 00:20',
    to: '2026-12-01 00:20',
    exits: 0,
  },
  C: {
    title: () => 'failed --force run',
    seed: '2026-11-06',
    from: '2026-11-07 00:20',
    to: '2026-11-10 00:20',
    forced: ['2026-11-07 10:00'],
    outcome: (_, o) => (o.forced ? 'fail' : 'ok'),
    exits: 1,
  },
  D: {
    title: (s) => `failed re-check run (${s.rechecks} re-check runs)`,
    seed: '2026-11-13',
    from: '2026-11-13 21:20',
    to: '2026-11-17 00:20',
    open: (t) =>
      t <= at('2026-11-16 08:20')
        ? [{ date: '2026-11-13', versionId: 'v-demo-1', deadline: '2026-11-16T13:30:00.000Z' }]
        : [],
    outcome: (t, o) => (o.recheck && t === at('2026-11-15 00:20') ? 'fail' : 'ok'),
    exits: 1,
  },
  E: {
    title: (s) => `stuck re-check (${s.stuck} stuck checks; then every daily run fails on it)`,
    seed: '2026-11-19',
    from: '2026-11-20 00:20',
    to: '2026-11-24 00:20',
    open: () => [
      { date: '2026-11-19', versionId: 'v-demo-1', deadline: '2026-11-20T13:30:00.000Z' },
    ],
    // From the last re-check before the deadline every run fails, the regular ones too: each
    // daily run's forward step grades the open re-check again (forward.ts) and meets the same error.
    outcome: (t) => (t >= at('2026-11-20 08:20') ? 'fail' : 'ok'),
    exits: 79,
  },
  F: {
    title: () => 'failed pings',
    seed: '2026-12-03',
    from: '2026-12-04 00:20',
    to: '2026-12-07 00:20',
    fails: (t) =>
      between(t, '2026-12-04 20:20', '2026-12-05 00:20') || t === at('2026-12-06 00:20'),
    exits: 0,
  },
  G: {
    title: () => 'weekday outage',
    seed: '2026-12-07',
    from: '2026-12-08 00:20',
    to: '2026-12-10 00:20',
    outcome: (t) => (t >= at('2026-12-08 20:20') ? 'fail' : 'ok'),
    exits: 29,
  },
  H: {
    title: () => 'unfinished runs',
    seed: '2026-12-10',
    from: '2026-12-11 00:20',
    to: '2026-12-15 00:20',
    forced: ['2026-12-12 10:00'],
    outcome: (t, o) => (o.forced ? 'killed' : t === at('2026-12-11 20:20') ? 'unrecorded' : 'ok'),
    exits: 2,
  },
};

interface Event {
  t: number;
  key: string;
  unit?: 'runs' | 'checks';
}

async function rehearse(s: Scenario) {
  const db = await testDb();
  const dir = mkdtempSync(join(tmpdir(), 'saku-rehearsal-'));
  for (const name of ['daily', 'heartbeat', 'keepalive']) writeStamp(name, s.seed, dir);
  const seedAt = at(`${s.seed} 20:20`);
  const id = await startRun(db, 'daily', new Date(seedAt), s.seed);
  await finishRun(db, id, { ok: true, datesProcessed: [s.seed] }, new Date(seedAt + 60_000));

  const events: Event[] = [];
  const pings: { t: number; kind: 'session' | 'keep-alive' }[] = [{ t: seedAt, kind: 'session' }];
  const logged: string[] = [];
  const kaSent = new Set<string>();
  const kaTold = new Set<string>();
  let t = 0;
  let kind: 'session' | 'keep-alive' = 'session';
  let rechecks = 0;
  let stuck = 0;
  const log: Logger = {
    info: (m, d) => {
      logged.push(`${m} ${JSON.stringify(d ?? {})}`);
      const day = tradingDateOf(t);
      // A date's first suppression before its keep-alive went out (later ones only delay it).
      if (m === 'No heartbeat keep-alive' && !kaSent.has(day) && !kaTold.has(day)) {
        kaTold.add(day);
        events.push({ t, key: `no keep-alive: ${String(d?.why)}` });
      }
    },
    warn: (m, d) => {
      logged.push(`${m} ${JSON.stringify(d ?? {})}`);
      if (m.startsWith('Red re-checks past their deadline cannot close')) stuck++;
      if (m === 'Heartbeat ping failed') {
        events.push({ t, key: `${kind} ping failed: ${String(d?.error)}`, unit: 'checks' });
      }
    },
  };
  const fetchImpl = (async () => {
    if (s.fails?.(t)) return new Response('', { status: 503 });
    pings.push({ t, kind });
    if (kind === 'keep-alive') kaSent.add(tradingDateOf(t));
    const target = dailyTarget(sessions, new Date(t), '20:00');
    events.push({ t, key: kind === 'session' ? `session ping ${target}` : 'keep-alive' });
    return new Response('OK', { status: 200 });
  }) as unknown as typeof fetch;
  const ping = (k: typeof kind, check: string) => () => {
    kind = k;
    return sendHeartbeat(URL_, check, log, { fetchImpl, sleep: async () => {} });
  };

  const checks = [...(s.forced ?? []).map((f) => ({ t: at(f), forced: true }))];
  for (let c = at(s.from); c <= at(s.to); c += HOUR) checks.push({ t: c, forced: false });
  checks.sort((a, b) => a.t - b.t);
  let exits = 0;
  for (const c of checks) {
    t = c.t;
    const code = await dailyCheck(db, {
      sessions,
      finalAfter: '20:00',
      force: c.forced,
      now: new Date(t),
      clock: () => new Date(t + 60_000),
      stampsDir: dir,
      log,
      heartbeat: ping('session', 'HEALTHCHECK_URL'),
      keepAlivePing: ping('keep-alive', 'HEALTHCHECK_URL keep-alive'),
      openRechecks: async () => s.open?.(t) ?? [],
      run: async (o) => {
        if (o.recheck) rechecks++;
        const outcome = s.outcome?.(t, { recheck: o.recheck, forced: c.forced }) ?? 'ok';
        const what = c.forced ? 'forced daily' : o.recheck ? 're-check' : 'daily';
        const runId = await startRun(db, 'daily', new Date(t), o.target, { recheck: o.recheck });
        const told = (how: string) =>
          events.push({ t, key: `${what} run ${how} ${o.target}`, unit: 'runs' });
        if (outcome === 'killed') {
          told('killed');
          throw new Error('killed');
        }
        // As runJob: onComplete on a complete run that is no re-check, before finishRun.
        if (outcome !== 'fail' && !o.recheck) await o.onComplete('daily');
        if (outcome === 'unrecorded') {
          told('not recorded');
          return { ok: false };
        }
        const ok = outcome === 'ok';
        if (!ok) told('failed');
        const error = ok ? undefined : 'forward: v-demo-1 provisional decision does not read back';
        await finishRun(db, runId, { ok, datesProcessed: [o.target], error }, new Date(t + 60_000));
        return { ok };
      },
    });
    if (code !== 0) exits++;
  }

  // Consecutive equal events collapse into one line with a count.
  const lines: string[] = [];
  for (let i = 0; i < events.length;) {
    let j = i;
    while (j + 1 < events.length && events[j + 1]!.key === events[i]!.key && events[i]!.unit) j++;
    const n = j - i + 1;
    const more = n > 1 ? ` (${n} ${events[i]!.unit}, to ${shown(events[j]!.t)})` : '';
    lines.push(`  ${shown(events[i]!.t)} ${events[i]!.key}${more}`);
    i = j + 1;
  }
  const end = checks.at(-1)!.t;
  let longest = 0;
  const down: string[] = [];
  pings.forEach((p, i) => {
    const next = pings[i + 1]?.t;
    longest = Math.max(longest, (next ?? end) - p.t);
    if ((next ?? end) - p.t > 30 * HOUR) {
      down.push(`${shown(p.t + 30 * HOUR)} to ${next === undefined ? 'the end' : shown(next)}`);
    }
  });
  lines.push(
    `  longest gap ${longest / HOUR}h; ${down.length ? `down ${down.join(', ')}` : 'never down'}`,
  );
  return { lines, pings: pings.slice(1), rechecks, stuck, exits, down, longest, logged };
}

const EXPECTED = `A. weekend over the DST change, every run complete
  2026-10-30 20:20 EDT session ping 2026-10-30
  2026-10-31 00:20 EDT keep-alive
  2026-11-01 00:20 EDT keep-alive
  2026-11-02 00:20 EST keep-alive
  2026-11-02 20:20 EST session ping 2026-11-02
  longest gap 25h; never down
B. Thanksgiving and the weekend after it
  2026-11-25 20:20 EST session ping 2026-11-25
  2026-11-26 00:20 EST keep-alive
  2026-11-27 00:20 EST keep-alive
  2026-11-27 20:20 EST session ping 2026-11-27
  2026-11-28 00:20 EST keep-alive
  2026-11-29 00:20 EST keep-alive
  2026-11-30 00:20 EST keep-alive
  2026-11-30 20:20 EST session ping 2026-11-30
  longest gap 24h; never down
C. failed --force run
  2026-11-07 00:20 EST keep-alive
  2026-11-07 10:00 EST forced daily run failed 2026-11-06
  2026-11-08 00:20 EST no keep-alive: run_failed
  2026-11-09 00:20 EST no keep-alive: run_failed
  2026-11-09 20:20 EST session ping 2026-11-09
  longest gap 68h; down 2026-11-08 06:20 EST to 2026-11-09 20:20 EST
D. failed re-check run (60 re-check runs)
  2026-11-14 00:20 EST keep-alive
  2026-11-15 00:20 EST re-check run failed 2026-11-13
  2026-11-15 00:20 EST no keep-alive: recheck_failed
  2026-11-15 01:20 EST keep-alive
  2026-11-16 00:20 EST keep-alive
  2026-11-16 20:20 EST session ping 2026-11-16
  longest gap 25h; never down
E. stuck re-check (10 stuck checks; then every daily run fails on it)
  2026-11-20 08:20 EST re-check run failed 2026-11-19
  2026-11-20 08:20 EST no keep-alive: recheck_failed
  2026-11-20 09:20 EST re-check run failed 2026-11-19
  2026-11-20 20:20 EST daily run failed 2026-11-20 (72 runs, to 2026-11-23 19:20 EST)
  2026-11-23 20:20 EST daily run failed 2026-11-23 (5 runs, to 2026-11-24 00:20 EST)
  longest gap 100h; down 2026-11-21 02:20 EST to the end
F. failed pings
  2026-12-04 20:20 EST session ping failed: HTTP 503 (2 checks, to 2026-12-04 21:20 EST)
  2026-12-04 21:20 EST no keep-alive: session_ping_pending
  2026-12-04 22:20 EST session ping failed: HTTP 503 (3 checks, to 2026-12-05 00:20 EST)
  2026-12-05 00:20 EST no keep-alive: session_ping_pending
  2026-12-05 01:20 EST session ping 2026-12-04
  2026-12-05 01:20 EST keep-alive
  2026-12-06 00:20 EST keep-alive ping failed: HTTP 503
  2026-12-06 01:20 EST keep-alive
  2026-12-07 00:20 EST keep-alive
  longest gap 29h; never down
G. weekday outage
  2026-12-08 20:20 EST daily run failed 2026-12-08 (24 runs, to 2026-12-09 19:20 EST)
  2026-12-09 20:20 EST daily run failed 2026-12-09 (5 runs, to 2026-12-10 00:20 EST)
  longest gap 52h; down 2026-12-09 02:20 EST to the end
H. unfinished runs
  2026-12-11 20:20 EST session ping 2026-12-11
  2026-12-11 20:20 EST daily run not recorded 2026-12-11
  2026-12-11 21:20 EST no keep-alive: run_unfinished
  2026-12-12 00:20 EST no keep-alive: run_unfinished
  2026-12-12 10:00 EST forced daily run killed 2026-12-11
  2026-12-13 00:20 EST no keep-alive: run_unfinished
  2026-12-14 00:20 EST no keep-alive: run_unfinished
  2026-12-14 20:20 EST session ping 2026-12-14
  longest gap 72h; down 2026-12-13 02:20 EST to 2026-12-14 20:20 EST
Keep-alive rehearsal PASS: 8 scenarios, 25 pings (15 keep-alives, 10 session pings), at most one keep-alive per New York date, longest gap while healthy 25h (F 29h while healthchecks.io did not answer), C, E, G and H down 30h after their last ping, exit codes as expected, no URL in the log`;

it('rehearses the keep-alive over weekends, a holiday and every failure', async () => {
  const out: string[] = [];
  const problems: string[] = [];
  const all: Awaited<ReturnType<typeof rehearse>>[] = [];
  for (const [name, s] of Object.entries(SCENARIOS)) {
    const r = await rehearse(s);
    all.push(r);
    out.push(`${name}. ${s.title(r)}`, ...r.lines);
    const days = r.pings.filter((p) => p.kind === 'keep-alive').map((p) => tradingDateOf(p.t));
    if (new Set(days).size !== days.length) problems.push(`${name}: two keep-alives on one date`);
    if (r.exits !== s.exits) problems.push(`${name}: ${r.exits} checks exited 1, not ${s.exits}`);
    if (r.logged.some((l) => l.includes(ID) || l.includes('ping.example.test'))) {
      problems.push(`${name}: the URL in the log`);
    }
  }
  const pings = all.flatMap((r) => r.pings);
  const ka = pings.filter((p) => p.kind === 'keep-alive').length;
  // Healthy: never down and every ping answered; a scenario whose pings went unanswered (F)
  // stays up but its gap is longer, and is given on its own.
  const up = Object.entries(SCENARIOS).flatMap(([n, s], i) =>
    all[i]!.down.length === 0 ? [{ n, unanswered: !!s.fails, h: all[i]!.longest / HOUR }] : [],
  );
  const healthy = Math.max(...up.filter((u) => !u.unanswered).map((u) => u.h));
  const unanswered = up.filter((u) => u.unanswered).map((u) => `${u.n} ${u.h}h`);
  const downNames = Object.keys(SCENARIOS).filter((_, i) => all[i]!.down.length > 0);
  const names = `${downNames.slice(0, -1).join(', ')} and ${downNames.at(-1)}`;
  const expected = EXPECTED.split('\n');
  const mismatch = out.findIndex((l, i) => l !== expected[i]);
  if (mismatch >= 0) problems.push(`line ${mismatch + 1}: ${out[mismatch]}`);
  else if (out.length !== expected.length - 1) problems.push(`${out.length} lines`);
  out.push(
    problems.length
      ? `Keep-alive rehearsal FAIL: ${problems[0]}`
      : `Keep-alive rehearsal PASS: ${all.length} scenarios, ${pings.length} pings (${ka} keep-alives, ${pings.length - ka} session pings), at most one keep-alive per New York date, longest gap while healthy ${healthy}h (${unanswered.join(', ')} while healthchecks.io did not answer), ${names} down 30h after their last ping, exit codes as expected, no URL in the log`,
  );
  if (process.env.SAKU_REHEARSAL) console.log(out.join('\n'));
  expect(out.join('\n')).toBe(EXPECTED);
});
