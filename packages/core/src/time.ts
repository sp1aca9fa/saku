import type { TradingDate } from './domain';

const NEW_YORK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The trading date (America/New_York) of an instant. */
export function tradingDateOf(instant: Date | number): TradingDate {
  return NEW_YORK.format(instant);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isTradingDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The UTC offset of `timeZone` at an instant, in minutes (e.g. 60 for Frankfurt in winter). */
function offsetMinutes(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((local - instant) / 60_000);
}

/** ISO 8601 UTC instant of a wall-clock time (`HH:MM`) on a date in a time zone. */
export function zonedInstant(date: string, time: string, timeZone: string): string {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const first = guess - offsetMinutes(timeZone, guess) * 60_000;
  // Recheck at the result, in case the guess fell on the other side of a clock change.
  const utc = guess - offsetMinutes(timeZone, first) * 60_000;
  return new Date(utc).toISOString();
}
