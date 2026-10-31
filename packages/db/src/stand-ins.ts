// Closing a stand-in the primary will never replace (requirements 04 stand-in rule 5): only by an
// admin, with a written reason, never automatically. The stand-in's values stay as they are (the
// canonical bar keeps its price); from then on nothing waits on it. Triggers (migration 0011)
// refuse a close without its admin or reason and any later change of a closed row's values.
import { type TradingDate, isTradingDate } from '@saku/core';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from './client';
import { activityLog, bars, standIns, symbols, users } from './schema';

export type CloseStandInResult =
  { ok: true; closedAt: string; userId: string } | { ok: false; error: string };

/**
 * Closes the open stand-in of `ticker` on `date` as `username`, with `reason`, and logs it
 * (`stand_in.close`, actor the admin's user id). Refused, with nothing written: an account that
 * does not exist, is disabled or is not an admin (checked first, before anything is read); an
 * empty reason; an unknown ticker or date; a stand-in already resolved (the primary replaced it)
 * or already closed. Run under the jobs lock (a run reads `stand_ins` throughout).
 */
export async function closeStandIn(
  db: Db,
  o: { ticker: string; date: string; username: string; reason: string; now?: Date },
): Promise<CloseStandInResult> {
  const refuse = (error: string): CloseStandInResult => ({ ok: false, error });
  const [user] = await db.select().from(users).where(eq(users.username, o.username));
  if (!user) return refuse(`No account ${o.username}.`);
  if (user.disabledAt) return refuse(`${o.username} is disabled.`);
  if (!user.isAdmin)
    return refuse(`${o.username} is not an admin: only an admin closes a stand-in.`);
  const reason = o.reason.trim();
  if (reason === '')
    return refuse('Give the reason: --reason "<text>" (e.g. primary will not deliver).');
  if (!isTradingDate(o.date)) return refuse(`${o.date} is not a date (YYYY-MM-DD).`);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        symbolId: standIns.symbolId,
        source: standIns.source,
        close: standIns.close,
        resolvedAt: standIns.resolvedAt,
        closedAt: standIns.closedAt,
        closeReason: standIns.closeReason,
      })
      .from(standIns)
      .innerJoin(symbols, eq(symbols.id, standIns.symbolId))
      .where(and(eq(symbols.ticker, o.ticker), eq(standIns.date, o.date)));
    if (!row) {
      return refuse(`No stand-in for ${o.ticker} on ${o.date} (pnpm sources stand-in list).`);
    }
    if (row.closedAt !== null) {
      return refuse(
        `${o.ticker} ${o.date}: already closed at ${row.closedAt} (${row.closeReason ?? ''}).`,
      );
    }
    if (row.resolvedAt !== null) {
      return refuse(
        `${o.ticker} ${o.date}: the primary replaced it at ${row.resolvedAt}; nothing to close.`,
      );
    }
    const closedAt = (o.now ?? new Date()).toISOString();
    const done = await tx
      .update(standIns)
      .set({ closedAt, closedBy: user.id, closeReason: reason })
      .where(
        and(
          eq(standIns.symbolId, row.symbolId),
          eq(standIns.date, o.date),
          isNull(standIns.resolvedAt),
          isNull(standIns.closedAt),
        ),
      )
      .returning({ date: standIns.date });
    if (done.length !== 1) return refuse(`${o.ticker} ${o.date}: changed meanwhile; try again.`);
    await tx.insert(activityLog).values({
      actor: user.id,
      action: 'stand_in.close',
      detail: {
        username: user.username,
        ticker: o.ticker,
        date: o.date,
        source: row.source,
        close: row.close,
        reason,
      },
    });
    return { ok: true, closedAt, userId: user.id };
  });
}

/**
 * Every stored stand-in (or only the open ones: neither resolved nor closed), oldest date first,
 * with its canonical bar on that date if any: whether it still stands in there (`standIn`), and
 * its distribution (a stand-in on a distribution day is read at any age by a total-return
 * signal). No canonical bar on an open stand-in's date: a later run refused it (the day reads as
 * missing, red in the lookback), yet it still holds corrections back until resolved or closed.
 */
export async function standInList(db: Db, o: { open?: boolean } = {}) {
  const rows = await db
    .select({
      ticker: symbols.ticker,
      date: standIns.date,
      source: standIns.source,
      close: standIns.close,
      band: standIns.band,
      basis: standIns.basis,
      createdAt: standIns.createdAt,
      primaryClose: standIns.primaryClose,
      deviation: standIns.deviation,
      resolvedAt: standIns.resolvedAt,
      closedAt: standIns.closedAt,
      closedBy: users.username,
      closeReason: standIns.closeReason,
      barSource: bars.source,
      barStandIn: bars.standIn,
      barDivCash: bars.divCash,
    })
    .from(standIns)
    .innerJoin(symbols, eq(symbols.id, standIns.symbolId))
    .leftJoin(bars, and(eq(bars.symbolId, standIns.symbolId), eq(bars.date, standIns.date)))
    .leftJoin(users, eq(users.id, standIns.closedBy))
    .where(o.open ? and(isNull(standIns.resolvedAt), isNull(standIns.closedAt)) : undefined)
    .orderBy(asc(standIns.date), asc(symbols.ticker));
  return rows.map(({ barSource, barStandIn, barDivCash, ...r }) => ({
    ...r,
    date: r.date as TradingDate,
    canonical:
      barSource === null
        ? null
        : { source: barSource, standIn: barStandIn === true, divCash: barDivCash ?? 0 },
  }));
}

export type StandInListRow = Awaited<ReturnType<typeof standInList>>[number];

/**
 * Every closed stand-in with its ticker, oldest date first: what the closing step annotates
 * (`stand_in_closed`). `runId` and `createdAt` as in `resolvedStandIns`; `closedAt` the close's
 * instant; `resolvedAt` set when the primary arrived after all.
 */
export async function closedStandIns(db: Db) {
  return db
    .select({
      ticker: symbols.ticker,
      date: standIns.date,
      runId: standIns.runId,
      createdAt: standIns.createdAt,
      closedAt: standIns.closedAt,
      closeReason: standIns.closeReason,
      resolvedAt: standIns.resolvedAt,
    })
    .from(standIns)
    .innerJoin(symbols, eq(symbols.id, standIns.symbolId))
    .where(isNotNull(standIns.closedAt))
    .orderBy(asc(standIns.date), asc(symbols.ticker));
}
