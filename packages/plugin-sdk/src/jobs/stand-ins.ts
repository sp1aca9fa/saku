// What `pnpm sources stand-in list` prints (requirements 04 stand-in rule 5): each stand-in with
// its state and whether a canonical bar still uses it, so an admin finds the open ones the primary
// will never replace (old ones included: one on a distribution day is read at any age by a
// total-return signal) and closes them with `pnpm sources stand-in close`.
import type { TradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import type { StandInListRow } from '@saku/db';

/**
 * Sessions after `date` up to `today` (0 on the day itself), or undefined when the calendar does
 * not cover the span (never guessed).
 */
export function ageInSessions(
  sessions: Sessions,
  date: TradingDate,
  today: TradingDate,
): number | undefined {
  if (date > today) return 0;
  try {
    return sessions.between(sessions.after(date), today).length;
  } catch {
    return undefined;
  }
}

const pct = (v: number) => `${(100 * v).toFixed(3)}%`;

/** The row's state: open, resolved (with the primary's difference) or closed (with its reason). */
function stateOf(r: StandInListRow): string {
  const resolved =
    r.resolvedAt === null
      ? undefined
      : `resolved ${r.resolvedAt}${r.deviation === null ? '' : ` (primary off by ${pct(r.deviation)})`}`;
  if (r.closedAt !== null) {
    const closed = `closed ${r.closedAt} by ${r.closedBy ?? 'unknown'}: ${r.closeReason ?? ''}`;
    return resolved ? `${closed}; then ${resolved} (primary arrived after the close)` : closed;
  }
  return resolved ?? 'open';
}

/** Whether a canonical bar still uses it, and what an open one without a bar means. */
function canonicalOf(r: StandInListRow): string {
  const open = r.resolvedAt === null && r.closedAt === null;
  const c = r.canonical;
  if (!c) {
    return open
      ? 'refused, no canonical bar (the day reads as missing; still holds corrections back ' +
          'until resolved or closed)'
      : 'no canonical bar';
  }
  if (!c.standIn) return `canonical bar from ${c.source} (not a stand-in)`;
  const distribution =
    c.divCash !== 0
      ? `, distribution day (${c.divCash}: total-return signals read it at any age)`
      : '';
  return `canonical bar uses it (from ${c.source})${distribution}`;
}

/** The list's lines: a header, then one line per stand-in (oldest first), or a line for none. */
export function standInListText(
  rows: StandInListRow[],
  o: { sessions: Sessions; today: TradingDate; open: boolean },
): string[] {
  if (rows.length === 0) return [o.open ? 'No open stand-ins.' : 'No stand-ins stored.'];
  const lines = [
    `ticker  date  source  close  band  age (sessions to ${o.today})  state  canonical bar`,
  ];
  for (const r of rows) {
    const age = ageInSessions(o.sessions, r.date, o.today);
    lines.push(
      `${r.ticker}  ${r.date}  ${r.source}  ${r.close}  ${pct(r.band)}  ` +
        `${age === undefined ? 'unknown (outside the calendar)' : age}  ${stateOf(r)}  ` +
        canonicalOf(r),
    );
  }
  if (o.open) {
    lines.push(
      'Close one the primary will never deliver (an admin, with the reason): pnpm sources ' +
        'stand-in close <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin>',
    );
  }
  return lines;
}
