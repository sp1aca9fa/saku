// Dividends and splits the primary dated on a closed market day (requirements 04 "Closed-day
// bars", decisions log 2026-11-01, C19). Such an event is in no bar the signals read, so verify
// keeps the fund red on every session from the next one on (`closed_day_event@<date>`) until the
// source's stored raw bar on that day no longer carries it (a corrected refetch, logged as a
// revision), or an admin resolves it here because the event is not real. A resolution only lifts
// the red: the event is never moved to a session (which one is a guess), so it stays out of the
// canonical series. A real event the source misdated waits for the source to correct it.
import { type TradingDate, isTradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import {
  type ClosedEventResolution,
  type Db,
  closedEventResolutionsOf,
  resolutionOf,
  schema,
} from '@saku/db';
import { and, asc, eq } from 'drizzle-orm';
import { lock } from './lock';
import { roles } from './verify';

/** A raw bar's event on a closed day, as stored now. */
export interface ClosedDayEvent {
  ticker: string;
  symbolId: number;
  /** The closed day it is dated on. */
  date: TradingDate;
  /** The first session after it (undefined: past the calendar's end). */
  next: TradingDate | undefined;
  source: string;
  divCash: number;
  splitFactor: number;
  /** The resolution that covers it (`resolutionOf`), if any. */
  resolution: ClosedEventResolution | undefined;
}

/**
 * Every dividend or split the bars primary (as set now) has stored on a closed day of `sessions`,
 * oldest first, with the resolution that covers it. A day the calendar does not cover is unknown,
 * never closed: not listed (verify refuses such a bar). No primary set: none.
 */
export async function closedDayEvents(db: Db, sessions: Sessions): Promise<ClosedDayEvent[]> {
  const { primary } = await roles(db, 'bars');
  if (!primary) return [];
  const rows = await db
    .select({
      symbolId: schema.barsRaw.symbolId,
      ticker: schema.symbols.ticker,
      date: schema.barsRaw.date,
      divCash: schema.barsRaw.divCash,
      splitFactor: schema.barsRaw.splitFactor,
    })
    .from(schema.barsRaw)
    .innerJoin(schema.symbols, eq(schema.symbols.id, schema.barsRaw.symbolId))
    .where(eq(schema.barsRaw.source, primary))
    .orderBy(asc(schema.barsRaw.date), asc(schema.symbols.ticker));
  const resolutions = await closedEventResolutionsOf(db);
  const out: ClosedDayEvent[] = [];
  for (const r of rows) {
    if (r.divCash === 0 && r.splitFactor === 1) continue;
    if (!sessions.closedOn(r.date)) continue;
    let next: TradingDate | undefined;
    try {
      next = sessions.after(r.date);
    } catch {
      next = undefined;
    }
    const event = { ...r, source: primary };
    out.push({ ...event, next, resolution: resolutionOf(resolutions, event) });
  }
  return out;
}

/** The list's lines: a header, then one line per event (oldest first), or a line for none. */
export function closedDayEventText(events: ClosedDayEvent[], o: { open: boolean }): string[] {
  const shown = o.open ? events.filter((e) => !e.resolution) : events;
  if (shown.length === 0) {
    return [o.open ? 'No open closed-day events.' : 'No dividend or split on a closed day.'];
  }
  const lines = ['ticker  date (closed)  red from  source  dividend  split  state'];
  for (const e of shown) {
    const r = e.resolution;
    const state = r
      ? `resolved ${r.resolvedAt} by ${r.username ?? 'unknown'}: ${r.reason}`
      : 'open: the fund is red from the next session on';
    lines.push(
      `${e.ticker}  ${e.date}  ${e.next ?? 'unknown (past the calendar)'}  ${e.source}  ` +
        `${e.divCash}  ${e.splitFactor}  ${state}`,
    );
  }
  if (shown.some((e) => !e.resolution)) {
    lines.push(
      'An open one clears by itself once the source no longer dates the event on that day (the ' +
        'next run reads the corrected bar). Only when the event is not real (no such dividend or ' +
        'split), an admin resolves it: pnpm sources closed-event resolve <TICKER> <YYYY-MM-DD> ' +
        '--reason "<text>" --user <admin>. A real event the source misdated waits for the source ' +
        '(docs/troubleshooting.md).',
    );
  }
  return lines;
}

export type ResolveClosedEventResult =
  { ok: true; resolvedAt: string; userId: string } | { ok: false; error: string };

/**
 * Resolves the dividend or split the bars primary dated on the closed day `date` for `ticker`, as
 * `username`, with `reason`: appends it to `closed_event_resolutions` with the event's values as
 * stored now, and logs it (`closed_event.resolve`, actor the admin's user id). From the next run
 * on, the fund is no longer red for it; the event stays out of the canonical series. Refused, with
 * nothing written:
 * - an account that does not exist, is disabled or is not an admin (checked first). `username`
 *   names the acting admin: the CLI runs on a server only admins can reach, so shell access is
 *   the authentication; a web action (D1) must pass the signed-in user, never a name from the
 *   request;
 * - an empty reason, or a date that is not one;
 * - a job running (it takes the jobs lock itself: a run reads the raw bars and resolutions);
 * - no bars primary set, no such symbol, no primary raw bar on that date, a date that is not a
 *   closed day of the calendar (or one it does not cover), a bar there without a dividend or
 *   split, or one already resolved with these values.
 */
export async function resolveClosedEvent(
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
): Promise<ResolveClosedEventResult> {
  const refuse = (error: string): ResolveClosedEventResult => ({ ok: false, error });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.username, o.username));
  if (!user) return refuse(`No account ${o.username}.`);
  if (user.disabledAt) return refuse(`${o.username} is disabled.`);
  if (!user.isAdmin) {
    return refuse(`${o.username} is not an admin: only an admin resolves a closed-day event.`);
  }
  const reason = o.reason.trim();
  if (reason === '') {
    return refuse('Give the reason: --reason "<text>" (why the event is not real).');
  }
  if (!isTradingDate(o.date)) return refuse(`${o.date} is not a date (YYYY-MM-DD).`);
  const held = o.lockDir ? lock('jobs', o.lockDir) : lock('jobs');
  if ('heldBy' in held) {
    return refuse(`A job is running (process ${held.heldBy}); try again when it is done.`);
  }
  try {
    const { primary } = await roles(db, 'bars');
    if (!primary) return refuse('No primary bar source is set (pnpm sources set bars ...).');
    const [symbol] = await db
      .select({ id: schema.symbols.id })
      .from(schema.symbols)
      .where(eq(schema.symbols.ticker, o.ticker));
    if (!symbol) return refuse(`No symbol ${o.ticker}.`);
    let closed: boolean;
    try {
      closed = !o.sessions.isSession(o.date);
    } catch {
      return refuse(`${o.date} is outside the market calendar: whether it is closed is unknown.`);
    }
    if (!closed) {
      return refuse(
        `${o.date} is a trading day: an event on it is in the series, nothing to resolve.`,
      );
    }
    const [bar] = await db
      .select({ divCash: schema.barsRaw.divCash, splitFactor: schema.barsRaw.splitFactor })
      .from(schema.barsRaw)
      .where(
        and(
          eq(schema.barsRaw.symbolId, symbol.id),
          eq(schema.barsRaw.source, primary),
          eq(schema.barsRaw.date, o.date),
        ),
      );
    if (!bar) {
      return refuse(`${o.ticker} has no bar from ${primary} on ${o.date}: nothing to resolve.`);
    }
    if (bar.divCash === 0 && bar.splitFactor === 1) {
      return refuse(
        `${o.ticker} ${o.date}: the bar from ${primary} carries no dividend or split (the source ` +
          'corrected it, or there never was one): nothing to resolve.',
      );
    }
    const event = { symbolId: symbol.id, date: o.date, source: primary, ...bar };
    const done = resolutionOf(await closedEventResolutionsOf(db, { symbolId: symbol.id }), event);
    if (done) {
      return refuse(
        `${o.ticker} ${o.date}: already resolved at ${done.resolvedAt} by ` +
          `${done.username ?? 'unknown'} (${done.reason}).`,
      );
    }
    const resolvedAt = (o.now ?? new Date()).toISOString();
    await db.transaction(async (tx) => {
      await tx.insert(schema.closedEventResolutions).values({
        ...event,
        resolvedBy: user.id,
        reason,
        resolvedAt,
      });
      await tx.insert(schema.activityLog).values({
        actor: user.id,
        action: 'closed_event.resolve',
        detail: {
          username: user.username,
          ticker: o.ticker,
          date: o.date,
          source: primary,
          divCash: bar.divCash,
          splitFactor: bar.splitFactor,
          reason,
        },
      });
    });
    return { ok: true, resolvedAt, userId: user.id };
  } finally {
    held.release();
  }
}
