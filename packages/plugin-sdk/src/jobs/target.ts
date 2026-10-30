import { type TradingDate, tradingDateOf, zonedInstant } from '@saku/core';
import type { Sessions } from '@saku/data';

/** New York time after which a day's data counts as final (until A1 measures it per source). */
export const DEFAULT_DAILY_AFTER = '20:00';

/**
 * The run's final time from the setting (`SAKU_DAILY_AFTER`, `HH:MM` New York), or the default.
 * A value that is not a time is refused: read as no time, it would take a day still trading as
 * final.
 */
export function dailyAfterOf(setting: string | undefined): string {
  const value = setting?.trim();
  if (!value) return DEFAULT_DAILY_AFTER;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`SAKU_DAILY_AFTER is ${value}; it is a New York time HH:MM, e.g. 20:00.`);
  }
  return value;
}

/** The latest session whose data is final at `now`: on or before today, after `after` NY time. */
export function dailyTarget(
  sessions: Sessions,
  now: Date,
  after = DEFAULT_DAILY_AFTER,
): TradingDate {
  let day = sessions.onOrBefore(tradingDateOf(now));
  if (now.getTime() < Date.parse(zonedInstant(day, after, 'America/New_York'))) {
    day = sessions.before(day);
  }
  return day;
}
