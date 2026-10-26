import { type TradingDate, tradingDateOf, zonedInstant } from '@saku/core';
import type { Sessions } from '@saku/data';

/** New York time after which a day's data counts as final (until A1 measures it per source). */
export const DEFAULT_DAILY_AFTER = '20:00';

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
