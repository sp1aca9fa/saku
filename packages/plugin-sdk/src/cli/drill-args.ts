// The arguments of `pnpm drill` (cli/drill.ts), parsed without side effects so they can be tested.
// Anything not understood is refused with a message, never ignored.
import type { TradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import { isRealDate } from '../jobs/probe-report';

export const DRILL_USAGE = 'Usage: pnpm drill red [--date <YYYY-MM-DD>]';

export interface DrillArgs {
  kind: 'red';
  /** As given (checked against the calendar by `drillDate`). */
  date?: string;
}

/** `argv`: the arguments after `drill` (`process.argv.slice(2)`). */
export function parseDrillArgs(argv: string[]): DrillArgs | { error: string } {
  const [kind, ...rest] = argv;
  if (kind !== 'red') {
    return { error: kind ? `Unknown drill ${kind}.\n${DRILL_USAGE}` : DRILL_USAGE };
  }
  let date: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--date') {
      if (date !== undefined) return { error: 'Give --date once.' };
      const value = rest[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: 'Give a date for --date, like --date 2026-10-30.' };
      }
      date = value;
      i++;
      continue;
    }
    return { error: `Unknown argument ${arg} for pnpm drill.\n${DRILL_USAGE}` };
  }
  if (date !== undefined && !isRealDate(date)) return { error: 'Give --date as YYYY-MM-DD.' };
  return { kind, ...(date !== undefined && { date }) };
}

/**
 * The drill's date: the given one, a session on or before the latest completed one (`latest`,
 * the daily run's target), or else that one.
 */
export function drillDate(
  sessions: Sessions,
  given: string | undefined,
  latest: TradingDate,
): { date: TradingDate } | { error: string } {
  if (given === undefined) return { date: latest };
  if (!sessions.isSession(given)) return { error: `${given} is not a trading session.` };
  if (given > latest) {
    return { error: `${given} is not completed yet (the latest completed session is ${latest}).` };
  }
  return { date: given };
}
