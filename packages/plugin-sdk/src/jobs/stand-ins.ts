// Closing a stand-in the primary will never replace (requirements 04 stand-in rule 5): only by an
// admin, with a written reason, never automatically, and what `pnpm sources stand-in list` prints
// so an admin finds the open ones (old ones included: one on a distribution day is read at any age
// by a total-return signal). The stand-in's values stay as they are; from then on nothing waits
// on it while its canonical bar is still that stand-in (`isOpenStandIn`).
import { type TradingDate, isTradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import {
  type Db,
  type StandInListRow,
  isOpenStandIn,
  latestCloseOf,
  schema,
  standInMatchesBar,
} from '@saku/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DAILY_OVERLAP } from './ingest';
import { lock } from './lock';

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

/** The target of the latest daily run that finished complete, or undefined without one. */
export async function latestDailyTarget(db: Db): Promise<TradingDate | undefined> {
  const runs = await db
    .select({ dates: schema.jobRuns.datesProcessed })
    .from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.jobType, 'daily'), eq(schema.jobRuns.status, 'success')))
    .orderBy(desc(schema.jobRuns.startedAt));
  const targets = runs.map((r) => r.dates?.[0]).filter((d): d is string => !!d && isTradingDate(d));
  return targets.sort().at(-1);
}

/**
 * Whether the daily runs still ask the primary for `date` (requirements 04 stand-in rule 5 with
 * the daily refetch window): closable only when the latest complete daily run's target is more
 * than DAILY_OVERLAP sessions after it. Fails closed: no complete daily run, or an age the
 * calendar cannot give, is "not yet".
 */
export function outsideRefetchWindow(
  sessions: Sessions,
  date: TradingDate,
  latestDaily: TradingDate | undefined,
): { ok: true } | { ok: false; why: string } {
  if (latestDaily === undefined) {
    return {
      ok: false,
      why: 'no daily run has completed yet, so the primary may still deliver it',
    };
  }
  const age = ageInSessions(sessions, date, latestDaily);
  if (age === undefined) {
    return {
      ok: false,
      why: `its age at the latest complete daily run (${latestDaily}) is unknown (outside the calendar)`,
    };
  }
  if (age <= DAILY_OVERLAP) {
    return {
      ok: false,
      why:
        `it is ${age} sessions before the latest complete daily run's date (${latestDaily}), ` +
        `inside the ${DAILY_OVERLAP}-session window the daily runs still fetch from the primary; ` +
        'wait until it is older',
    };
  }
  return { ok: true };
}

export type CloseStandInResult =
  { ok: true; closedAt: string; userId: string } | { ok: false; error: string };

/**
 * Closes the open stand-in of `ticker` on `date` as `username`, with `reason`: appends the close
 * to `stand_in_closes` (the first close also sets the `stand_ins` close columns, freezing the row)
 * and logs it (`stand_in.close`, actor the admin's user id). A stand-in closed before whose price
 * changed since (its latest close no longer matches the canonical bar) may be closed again: the
 * new close accepts the canonical stand-in bar now, with the band and basis that build computed.
 * Refused, with nothing written:
 * - an account that does not exist, is disabled or is not an admin (checked first, before
 *   anything else is read). `username` names the acting admin: the CLI runs on a server only
 *   admins can reach, so shell access is the authentication; a web action (D1) must pass the
 *   signed-in user, never a name from the request;
 * - an empty reason or a date that is not one;
 * - a job running (it takes the jobs lock itself: a run reads `stand_ins` throughout);
 * - no such stand-in, one already resolved, or one whose latest close still matches its bar;
 * - a date still inside the daily refetch window (`outsideRefetchWindow`);
 * - no canonical bar on that date (a later run refused it: nothing reads its price, so there is
 *   nothing to keep; it waits for the primary), or a canonical bar that is not this stand-in
 *   (`standInMatchesBar`): the admin would close a price the signals do not read.
 */
export async function closeStandIn(
  db: Db,
  o: {
    ticker: string;
    date: string;
    username: string;
    reason: string;
    sessions: Sessions;
    now?: Date;
    /** For tests: the lock directory (default: the state directory's). */
    lockDir?: string;
  },
): Promise<CloseStandInResult> {
  const refuse = (error: string): CloseStandInResult => ({ ok: false, error });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.username, o.username));
  if (!user) return refuse(`No account ${o.username}.`);
  if (user.disabledAt) return refuse(`${o.username} is disabled.`);
  if (!user.isAdmin) {
    return refuse(`${o.username} is not an admin: only an admin closes a stand-in.`);
  }
  const reason = o.reason.trim();
  if (reason === '') {
    return refuse('Give the reason: --reason "<text>" (e.g. primary will not deliver).');
  }
  if (!isTradingDate(o.date)) return refuse(`${o.date} is not a date (YYYY-MM-DD).`);
  const held = o.lockDir ? lock('jobs', o.lockDir) : lock('jobs');
  if ('heldBy' in held) {
    return refuse(`A job is running (process ${held.heldBy}); try again when it is done.`);
  }
  try {
    const latestDaily = await latestDailyTarget(db);
    const [row] = await db
      .select({
        symbolId: schema.standIns.symbolId,
        source: schema.standIns.source,
        close: schema.standIns.close,
        band: schema.standIns.band,
        basis: schema.standIns.basis,
        resolvedAt: schema.standIns.resolvedAt,
        closedAt: schema.standIns.closedAt,
      })
      .from(schema.standIns)
      .innerJoin(schema.symbols, eq(schema.symbols.id, schema.standIns.symbolId))
      .where(and(eq(schema.symbols.ticker, o.ticker), eq(schema.standIns.date, o.date)));
    if (!row) {
      return refuse(`No stand-in for ${o.ticker} on ${o.date} (pnpm sources stand-in list).`);
    }
    if (row.resolvedAt !== null) {
      return refuse(
        `${o.ticker} ${o.date}: the primary replaced it at ${row.resolvedAt}; nothing to close.`,
      );
    }
    // Read under the jobs lock (no run and no other close meanwhile).
    const latest = row.closedAt === null ? null : await latestCloseOf(db, row.symbolId, o.date);
    if (row.closedAt !== null && latest === null) {
      return refuse(`${o.ticker} ${o.date}: its close does not read back; not closed again.`);
    }
    const [bar] = await db
      .select({
        standIn: schema.bars.standIn,
        source: schema.bars.source,
        close: schema.bars.close,
        band: schema.bars.standInBand,
        basis: schema.bars.standInBasis,
      })
      .from(schema.bars)
      .where(and(eq(schema.bars.symbolId, row.symbolId), eq(schema.bars.date, o.date)));
    if (latest && standInMatchesBar(latest, bar)) {
      return refuse(
        `${o.ticker} ${o.date}: already closed at ${latest.closedAt} (${latest.reason}).`,
      );
    }
    const window = outsideRefetchWindow(o.sessions, o.date, latestDaily);
    if (!window.ok) return refuse(`${o.ticker} ${o.date}: not closed: ${window.why}.`);
    if (!bar) {
      return refuse(
        `${o.ticker} ${o.date}: a later run refused this stand-in (no canonical bar): nothing ` +
          'reads its price, so it is not closed. It waits for the primary (see ' +
          'docs/troubleshooting.md).',
      );
    }
    // The first close accepts the stand-in as stored (its row and canonical bar agree); a
    // re-close (its closed price changed since) accepts the canonical stand-in bar now, with the
    // band and basis this build computed.
    let closed: { source: string; close: number; band: number; basis: string };
    if (latest === null) {
      if (!standInMatchesBar(row, bar)) {
        return refuse(
          `${o.ticker} ${o.date}: the canonical bar is ${bar.standIn ? 'a stand-in' : 'a bar'} ` +
            `from ${bar.source} at ${bar.close}, not this stand-in (${row.source} at ` +
            `${row.close}); not closed. The next run records what it uses.`,
        );
      }
      closed = { source: row.source, close: row.close, band: row.band, basis: row.basis };
    } else {
      if (!bar.standIn || bar.band === null || bar.basis === null) {
        return refuse(
          `${o.ticker} ${o.date}: the canonical bar is ${bar.standIn ? 'a stand-in without its band (checked before 0012; the next run records it)' : `not a stand-in (from ${bar.source})`}; not closed again.`,
        );
      }
      closed = { source: bar.source, close: bar.close, band: bar.band, basis: bar.basis };
    }
    const closedAt = (o.now ?? new Date()).toISOString();
    return await db.transaction(async (tx) => {
      if (latest === null) {
        const done = await tx
          .update(schema.standIns)
          .set({ closedAt, closedBy: user.id, closeReason: reason })
          .where(
            and(
              eq(schema.standIns.symbolId, row.symbolId),
              eq(schema.standIns.date, o.date),
              isNull(schema.standIns.resolvedAt),
              isNull(schema.standIns.closedAt),
            ),
          )
          .returning({ date: schema.standIns.date });
        if (done.length !== 1) {
          return refuse(`${o.ticker} ${o.date}: changed meanwhile; try again.`);
        }
      }
      await tx.insert(schema.standInCloses).values({
        symbolId: row.symbolId,
        date: o.date,
        ...closed,
        closedBy: user.id,
        reason,
        closedAt,
      });
      await tx.insert(schema.activityLog).values({
        actor: user.id,
        action: 'stand_in.close',
        detail: {
          username: user.username,
          ticker: o.ticker,
          date: o.date,
          source: closed.source,
          close: closed.close,
          reason,
          ...(latest && {
            reclose: { source: latest.source, close: latest.close, closedAt: latest.closedAt },
          }),
        },
      });
      return { ok: true as const, closedAt, userId: user.id };
    });
  } finally {
    held.release();
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
    const times = r.closes.length > 1 ? ` (close ${r.closes.length})` : '';
    const closed = `closed ${r.closedAt}${times} by ${r.closedBy ?? 'unknown'}: ${r.closeReason ?? ''}`;
    if (resolved) return `${closed}; then ${resolved} (primary arrived after the close)`;
    return isOpenStandIn(r, r.latestClose, r.canonical)
      ? `${closed}; open again: the closed price changed (closed ${r.latestClose?.close} from ` +
          `${r.latestClose?.source})`
      : closed;
  }
  return resolved ?? 'open';
}

/**
 * Whether a canonical bar uses it, and for an open one what to do: closable (outside the daily
 * refetch window, its canonical bar this stand-in), not yet, or refused (no canonical bar: it
 * cannot be closed and waits for the primary).
 */
function canonicalOf(
  r: StandInListRow,
  o: { sessions: Sessions; latestDaily: TradingDate | undefined },
): string {
  const open = isOpenStandIn(r, r.latestClose, r.canonical);
  const c = r.canonical;
  if (!c) {
    return open
      ? 'refused, no canonical bar: the day reads as missing (red in the lookback); it cannot be ' +
          'closed and waits for the primary, holding corrections back until then (see ' +
          'docs/troubleshooting.md)'
      : 'no canonical bar';
  }
  if (!c.standIn) return `canonical bar from ${c.source} (not a stand-in)`;
  const distribution =
    c.divCash !== 0
      ? `, distribution day (${c.divCash}: total-return signals read it at any age)`
      : '';
  const window = outsideRefetchWindow(o.sessions, r.date, o.latestDaily);
  const closable = window.ok ? 'closable' : `not closable yet: ${window.why}`;
  if (r.latestClose !== null && open) {
    // Closed before, its price changed since: the admin checks the new price first.
    return (
      `canonical bar has another price (${c.close} from ${c.source})${distribution}: closed ` +
      `price changed, check the new price, then close again (${closable})`
    );
  }
  if (!standInMatchesBar(r.latestClose ?? r, c)) {
    return `canonical bar has another price (${c.close} from ${c.source})${distribution}`;
  }
  const uses = `canonical bar uses it (from ${c.source})${distribution}`;
  if (!open) return uses;
  return `${uses}; ${closable}`;
}

/** The list's lines: a header, then one line per stand-in (oldest first), or a line for none. */
export function standInListText(
  rows: StandInListRow[],
  o: {
    sessions: Sessions;
    today: TradingDate;
    open: boolean;
    /** The latest complete daily run's target (`latestDailyTarget`). */
    latestDaily: TradingDate | undefined;
  },
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
        canonicalOf(r, o),
    );
  }
  if (o.open) {
    lines.push(
      'One marked closable that the primary will never deliver: an admin closes it with the ' +
        'reason, pnpm sources stand-in close <TICKER> <YYYY-MM-DD> --reason "<text>" --user ' +
        '<admin>. A refused one cannot be closed: it waits for the primary.',
    );
  }
  return lines;
}
