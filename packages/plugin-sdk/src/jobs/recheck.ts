// The red re-check before execution (requirements 04 "Fail-closed behavior and safe state", bullet
// "Red re-check before execution"; 11 "Red re-check"; decisions log 2026-11-01, C16). A day red at
// its first grading gets a provisional message at once and is graded again by every hourly check
// until its deadline; one final instruction follows: the normal signal once the day is not red
// (under the yellow rules if yellow), or the safe state at the deadline. The rules here are pure;
// the forward step (`forward.ts`) applies them and the alerts (`alerts.ts`) tell them.
import { type TradingDate, zonedInstant } from '@saku/core';
import type { Sessions } from '@saku/data';
import { type Db, getSetting } from '@saku/db';

/**
 * The hourly check's period in minutes (ops/systemd/saku-daily.timer runs `pnpm daily` at :20 every
 * hour). A run is the last one before a deadline when the next one would come after it.
 */
export const RECHECK_PERIOD_MINUTES = 60;

/** The regular US open in New York time: the execution point of `next_open` (requirements 05). */
export const REGULAR_OPEN = '09:30';

/**
 * The re-check deadline of `date` (ISO 8601 instant): the regular open (09:30 New York) of the next
 * session after it, from the trading calendar (weekends and holidays skipped), less `minutesBefore`.
 * The open is converted in America/New_York, so US daylight saving is followed (never a fixed UTC
 * offset). Undefined when the calendar does not cover the next session: the deadline is unknown,
 * and an unknown deadline never opens a re-check (the safe state applies at once, as before C16).
 */
export function recheckDeadline(
  date: TradingDate,
  sessions: Sessions,
  minutesBefore: number,
): string | undefined {
  let next: TradingDate;
  try {
    next = sessions.after(date);
  } catch {
    return undefined;
  }
  const open = Date.parse(zonedInstant(next, REGULAR_OPEN, 'America/New_York'));
  return new Date(open - minutesBefore * 60_000).toISOString();
}

/**
 * At the first grading of a red day: `open` when the run's next hourly check still comes before the
 * deadline (`start` + period <= deadline, `start` when the run started its work, after the jobs lock;
 * never earlier than its timer's tick, so start + period is at or after the next tick) and the
 * forward step itself is not past it (`clock` <= deadline); else `not_rechecked` (a late run, or
 * one so close to the deadline that no re-grading can follow): the safe state is recorded at once,
 * with no provisional message.
 */
export function firstGrading(o: {
  start: number;
  clock: number;
  deadline: number;
}): 'open' | 'not_rechecked' {
  return o.start + RECHECK_PERIOD_MINUTES * 60_000 <= o.deadline && o.clock <= o.deadline
    ? 'open'
    : 'not_rechecked';
}

/**
 * A re-grading of an open re-check. `start`: when the run started its work (`firstGrading`),
 * which decides whether this is the last hourly check before the deadline (no later check is
 * counted before start + period); `clock`: the forward step's own clock, which decides only whether the grading is past
 * the deadline (no look-ahead):
 * - not red: `cleared` (the normal decision, yellow rules if yellow) when the forward step grades
 *   at or before the deadline; `late` when after it (data known after the deadline never clears);
 * - red, the run started after the deadline (the machine missed the last check): `late`, the safe
 *   state as the provisional message gave it;
 * - red, the last check (start + period > deadline): `safe_state`, also when the step itself ends
 *   a few minutes after the deadline (the check began before it);
 * - red, a later check comes before the deadline: `pending` (nothing recorded yet), unless the
 *   step is past the deadline already (a run that took over an hour): `late`.
 * A time exactly at the deadline is before it (data known by then counts).
 */
export function regrade(o: {
  red: boolean;
  start: number;
  clock: number;
  deadline: number;
}): 'pending' | 'cleared' | 'safe_state' | 'late' {
  if (!o.red) return o.clock > o.deadline ? 'late' : 'cleared';
  if (o.start > o.deadline) return 'late';
  if (o.start + RECHECK_PERIOD_MINUTES * 60_000 > o.deadline) return 'safe_state';
  return o.clock > o.deadline ? 'late' : 'pending';
}

/**
 * The install's display time zone (requirements 12 admin setting `time_zone`; unset: the server's),
 * as the audit report reads it.
 */
export async function recheckTimeZone(db: Db): Promise<string> {
  return (await getSetting(db, 'time_zone')) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A re-check deadline as the alerts show it: in the install's time zone (trading dates stay New
 * York), `YYYY-MM-DD HH:MM (zone)`, the same in every language. Not an instant: shown as stored.
 */
export function shownDeadline(deadline: string, timeZone: string): string {
  const t = Date.parse(deadline);
  if (!Number.isFinite(t)) return deadline;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (${timeZone})`;
}

/** What the hourly `pnpm daily` does (`cli/jobs.ts`). */
export type DailyAction =
  { action: 'daily' } | { action: 'recheck' } | { action: 'exit'; why: 'done' | 'stuck' };

/**
 * The hourly check's decision (requirements 04 "Red re-check before execution"), pure:
 * - the day not stamped yet, or `--force`: the daily run;
 * - stamped, no open re-check: exit (the day is done);
 * - stamped with open re-checks: a re-check run, except when every open re-check is past its
 *   deadline and the latest re-check run, started after all those deadlines, failed naming every
 *   such version (`job_runs.error`): the forward step cannot close them (a definition that does not
 *   parse, a provisional decision that does not read back, rows out of order), so another full run
 *   every hour would only repeat that; exit (`stuck`) and let that run's job-failure alert stand
 *   until an admin acts (a fix, then `pnpm daily --force`).
 */
export function dailyAction(o: {
  stamped: boolean;
  force: boolean;
  open: { versionId: string; deadline: string }[];
  now: Date;
  lastRecheck?: { startedAt: string; status: string; error: string | null };
}): DailyAction {
  if (o.force || !o.stamped) return { action: 'daily' };
  if (o.open.length === 0) return { action: 'exit', why: 'done' };
  const deadlines = o.open.map((r) => Date.parse(r.deadline));
  // A deadline that is not an instant is never taken as passed: the re-check run is tried.
  const allPast = deadlines.every((d) => Number.isFinite(d) && o.now.getTime() > d);
  const last = o.lastRecheck;
  if (
    allPast &&
    last !== undefined &&
    Date.parse(last.startedAt) > Math.max(...deadlines) &&
    last.status === 'failed' &&
    o.open.every((r) => (last.error ?? '').includes(r.versionId))
  ) {
    return { action: 'exit', why: 'stuck' };
  }
  return { action: 'recheck' };
}

/**
 * An open re-check on a version's line (`pnpm strategy list`): its day is not recorded yet, so
 * the list says why and until when (the install's time zone).
 */
export function openRecheckNote(r: { date: string; deadline: string }, timeZone: string): string {
  return `${r.date} red, re-check open until ${shownDeadline(r.deadline, timeZone)}`;
}
