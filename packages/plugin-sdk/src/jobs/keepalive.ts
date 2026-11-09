// The heartbeat keep-alive (requirements 04 "Failure handling" row H; 12 "Outside watch"; decisions
// log 2026-11-09). The session ping follows a complete daily run, which exists only on trading
// sessions, so a healthchecks.io check with period 1 day read every weekend and holiday as an
// outage. The hourly check also pings once per New York calendar date with no session ping due (a
// date with no session, or the first session after such dates), but only while everything the
// session ping vouches for still holds: the latest final session is done and pinged, the latest
// daily run (re-check and forced runs included) succeeded for it, no red re-check is stuck, and the
// target is not implausibly old. Anything else sends nothing, so the outside alarm still rings.
import { isTradingDate, tradingDateOf } from '@saku/core';
import type { Sessions } from '@saku/data';
import { type Db, latestDailyRun } from '@saku/db';
import type { Logger } from '../types';
import { readStamp, writeStamp } from './lock';
import { dailyTarget } from './target';

/**
 * The longest a target may stay the latest final session, in calendar days, while the keep-alive
 * pings. Since 1933 the longest gap between NYSE sessions is 7 days (2001-09-10 to 09-17); a
 * calendar that wrongly lists sessions as holidays would otherwise keep the day "done" forever.
 */
export const KEEPALIVE_MAX_TARGET_AGE_DAYS = 7;

/** What the hourly check did on a day already done: exited, or ran a re-check run. */
export type KeepAliveCheck =
  { action: 'exit'; why: 'done' | 'stuck' } | { action: 'recheck'; ok: boolean };

export type KeepAliveWhy =
  | 'not_done'
  | 'target_old'
  | 'session_ping_pending'
  | 'stuck'
  | 'recheck_failed'
  | 'no_run'
  | 'run_failed'
  | 'run_unfinished'
  | 'run_other_day'
  | 'session_due'
  | 'sent_today';

/** Why the latest daily-kind run does not vouch for the target. */
export type LatestRunWhy = 'no_run' | 'run_failed' | 'run_unfinished' | 'run_other_day';

const realDate = (s: string | null): s is string => s !== null && isTradingDate(s);
const daysFrom = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/**
 * Whether the latest daily-kind run (`latestDailyRun`: scheduled, `--force` and re-check runs)
 * vouches for `target`: undefined when it succeeded and worked for it, else why not. Both pings
 * rest on it: the keep-alive and the retry of a failed session ping (decisions log 2026-11-09).
 */
export function latestRunWhy(
  run: { status: string; datesProcessed: string[] | null } | undefined,
  target: string,
): LatestRunWhy | undefined {
  if (run === undefined) return 'no_run';
  if (run.status === 'failed') return 'run_failed';
  // `running`: killed, or its end never recorded (the check holds the jobs lock, so none runs now).
  if (run.status !== 'success') return 'run_unfinished';
  if (!(run.datesProcessed ?? []).includes(target)) return 'run_other_day';
  return undefined;
}

/**
 * Whether the keep-alive is sent now, pure. The first rule that fails is the reason (only the
 * logged reason depends on the order). `today`: the New York calendar date of the clock;
 * `todayIsSession` from the trading calendar. The stamps as read (`null`: missing or empty); a
 * stamp that is not a real date never counts as done. `session_due` (04 row H): on a session date
 * at most one calendar day after the target (the target's own evening after its ping, or the next
 * session, whose ping comes that evening) the session ping alone carries the check, as before the
 * keep-alive, so a missed weekday run still alerts about 6 hours after it (30 hours after the
 * previous session ping); dates with no session and the first session after them (2 days or more)
 * keep theirs. `sent_today` is an equality test: a `pending` or future-dated stamp sends again,
 * never silence.
 */
export function keepAliveDecision(o: {
  target: string;
  today: string;
  todayIsSession: boolean;
  dailyStamp: string | null;
  heartbeatStamp: string | null;
  keepAliveStamp: string | null;
  latestDaily?: { status: string; datesProcessed: string[] | null };
  check: KeepAliveCheck;
}): { send: true } | { send: false; why: KeepAliveWhy } {
  const no = (why: KeepAliveWhy) => ({ send: false as const, why });
  if (!realDate(o.dailyStamp) || o.dailyStamp < o.target) return no('not_done');
  if (daysFrom(o.target, o.today) > KEEPALIVE_MAX_TARGET_AGE_DAYS) return no('target_old');
  if (!realDate(o.heartbeatStamp) || o.heartbeatStamp < o.target) {
    return no('session_ping_pending');
  }
  if (o.check.action === 'exit' && o.check.why === 'stuck') return no('stuck');
  if (o.check.action === 'recheck' && !o.check.ok) return no('recheck_failed');
  const runWhy = latestRunWhy(o.latestDaily, o.target);
  if (runWhy) return no(runWhy);
  if (o.todayIsSession && daysFrom(o.target, o.today) <= 1) return no('session_due');
  if (o.keepAliveStamp === o.today) return no('sent_today');
  return { send: true };
}

/**
 * Decides and sends the keep-alive; never throws and never changes the job's outcome. `ping`:
 * the session ping's URL (`sendHeartbeat`, which never logs it); absent when unset: nothing at all.
 * The `keepalive` stamp is written `pending <today>` before the ping (a write that fails sends
 * nothing, so an unwritable folder never pings every hour) and `<today>` once answered; an
 * unanswered ping leaves it pending, so the next hourly check tries again. Only that stamp is
 * written: never `daily` or `heartbeat`.
 */
export async function keepAlive(
  db: Db,
  o: {
    sessions: Sessions;
    finalAfter: string;
    check: KeepAliveCheck;
    log: Logger;
    ping?: () => Promise<boolean>;
    stampsDir?: string;
    clock?: () => Date;
  },
): Promise<KeepAliveWhy | 'no_url' | 'sent' | 'not_answered' | 'error'> {
  const { log, ping, stampsDir } = o;
  if (!ping) return 'no_url';
  try {
    const now = (o.clock ?? (() => new Date()))();
    const target = dailyTarget(o.sessions, now, o.finalAfter);
    const today = tradingDateOf(now);
    const run = await latestDailyRun(db);
    const decision = keepAliveDecision({
      target,
      today,
      // Outside the calendar this throws (never a guess): nothing is sent.
      todayIsSession: o.sessions.isSession(today),
      dailyStamp: readStamp('daily', stampsDir),
      heartbeatStamp: readStamp('heartbeat', stampsDir),
      keepAliveStamp: readStamp('keepalive', stampsDir),
      ...(run && { latestDaily: run }),
      check: o.check,
    });
    if (!decision.send) {
      // Not due or already sent: the normal state on most hours, an hourly line would be noise.
      if (decision.why !== 'sent_today' && decision.why !== 'session_due')
        log.info('No heartbeat keep-alive', { why: decision.why, target });
      return decision.why;
    }
    try {
      writeStamp('keepalive', `pending ${today}`, stampsDir);
    } catch (e) {
      log.warn('Heartbeat keep-alive not sent: its stamp cannot be written', { error: String(e) });
      return 'error';
    }
    if (!(await ping())) return 'not_answered';
    writeStamp('keepalive', today, stampsDir);
    log.info('Heartbeat keep-alive sent', { date: today, target });
    return 'sent';
  } catch (e) {
    log.warn('Heartbeat keep-alive not decided', { error: String(e) });
    return 'error';
  }
}
