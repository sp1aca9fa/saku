// Stand-ins an admin closed (requirements 04 stand-in rule 5): what the jobs and the list read.
// The close itself is `closeStandIn` in the plug-in SDK (admin, reason, jobs lock, refetch
// window). Triggers (migration 0011) refuse a close without its admin or reason and any later
// change of a closed row's values.
import type { TradingDate } from '@saku/core';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from './client';
import { bars, standIns, symbols, users } from './schema';

/**
 * Whether a canonical bar is the stored stand-in itself: a stand-in bar from the row's source
 * with the row's close (exactly: verify writes both from the same bar). A closed stand-in counts
 * as settled only while this holds (decisions log 2026-11-01, review of rule 5): once a later
 * run builds the day from another secondary or a revised value, or refuses it, the price the
 * signals read is not the one the admin closed, so it is open again for every rule that reads
 * stand-ins (the decision-margin test, corrections waiting), though the close stays on record.
 */
export function standInMatchesBar(
  row: { source: string; close: number },
  bar: { standIn: boolean; source: string; close: number } | null | undefined,
): boolean {
  return !!bar && bar.standIn && bar.source === row.source && bar.close === row.close;
}

/**
 * Whether a stored stand-in still waits for the primary (requirements 04 stand-in rule): not
 * resolved (the primary's bar replaced it) and not settled by an admin's close (rule 5) whose
 * canonical bar is still that stand-in (`standInMatchesBar`). `bar`: the canonical bar on its
 * date (none: refused by a later run).
 */
export function isOpenStandIn(
  row: { resolvedAt: string | null; closedAt: string | null; source: string; close: number },
  bar: { standIn: boolean; source: string; close: number } | null | undefined,
): boolean {
  if (row.resolvedAt !== null) return false;
  return row.closedAt === null || !standInMatchesBar(row, bar);
}

/**
 * Every stored stand-in (or only the open ones, `isOpenStandIn`: a closed one whose canonical bar
 * changed is open again), oldest date first, with its canonical bar on that date if any (source,
 * whether a stand-in, close, distribution: a stand-in on a distribution day is read at any age by
 * a total-return signal). No canonical bar on an open stand-in's date: a later run refused it
 * (the day reads as missing, red in the lookback), yet it still holds corrections back.
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
      barClose: bars.close,
      barDivCash: bars.divCash,
    })
    .from(standIns)
    .innerJoin(symbols, eq(symbols.id, standIns.symbolId))
    .leftJoin(bars, and(eq(bars.symbolId, standIns.symbolId), eq(bars.date, standIns.date)))
    .leftJoin(users, eq(users.id, standIns.closedBy))
    .orderBy(asc(standIns.date), asc(symbols.ticker));
  const list = rows.map(({ barSource, barStandIn, barClose, barDivCash, ...r }) => ({
    ...r,
    date: r.date as TradingDate,
    canonical:
      barSource === null || barClose === null
        ? null
        : {
            source: barSource,
            standIn: barStandIn === true,
            close: barClose,
            divCash: barDivCash ?? 0,
          },
  }));
  return o.open ? list.filter((r) => isOpenStandIn(r, r.canonical)) : list;
}

export type StandInListRow = Awaited<ReturnType<typeof standInList>>[number];

/**
 * Every stand-in the primary has not replaced and no admin's close settles, as its ticker and
 * date, oldest first (`isOpenStandIn`): a correction that would decide on such a price waits
 * (the stand-in correction step).
 */
export async function unsettledStandIns(db: Db): Promise<{ ticker: string; date: TradingDate }[]> {
  return (await standInList(db, { open: true })).map((r) => ({ ticker: r.ticker, date: r.date }));
}

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
