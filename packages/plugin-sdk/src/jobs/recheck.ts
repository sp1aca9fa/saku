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
 * At the first grading of a red day: `open` when a later hourly check still comes before the
 * deadline (clock + period <= deadline), else `not_rechecked` (a late run, or one so close to the
 * deadline that no re-grading can follow): the safe state is recorded at once, with no
 * provisional message.
 */
export function firstGrading(o: { clock: number; deadline: number }): 'open' | 'not_rechecked' {
  return o.clock + RECHECK_PERIOD_MINUTES * 60_000 <= o.deadline ? 'open' : 'not_rechecked';
}

/**
 * A re-grading of an open re-check, at the run's clock:
 * - `late`: the clock is past the deadline (the machine missed the last check): the safe state
 *   stands, recorded as the provisional message gave it, whatever the day grades now (data known
 *   after the deadline is never used: no look-ahead relative to the execution);
 * - `cleared`: the day is no longer red: the normal decision (yellow rules if yellow);
 * - `safe_state`: still red at the last check before the deadline (clock + period > deadline);
 * - `pending`: still red, a later check comes before the deadline: nothing recorded yet.
 * A clock exactly at the deadline is before it (data known by then counts).
 */
export function regrade(o: {
  red: boolean;
  clock: number;
  deadline: number;
}): 'pending' | 'cleared' | 'safe_state' | 'late' {
  if (o.clock > o.deadline) return 'late';
  if (!o.red) return 'cleared';
  if (o.clock + RECHECK_PERIOD_MINUTES * 60_000 > o.deadline) return 'safe_state';
  return 'pending';
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
