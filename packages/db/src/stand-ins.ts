// Stand-ins an admin closed (requirements 04 stand-in rule 5): what the jobs and the list read.
// The close itself is `closeStandIn` in the plug-in SDK (admin, reason, jobs lock, refetch
// window). Every close is kept: `stand_in_closes` (0012, append-only); a close made before 0012
// only in the `stand_ins` close columns (0011, set once, the row's values then frozen).
import type { TradingDate } from '@saku/core';
import { and, asc, eq, isNotNull, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { bars, standInCloses, standIns, symbols, users } from './schema';

/** One admin close of a stand-in: the price it accepted, by whom, when and why. */
export interface StandInClose {
  source: string;
  close: number;
  band: number;
  basis: string;
  /** The admin's user id. */
  closedBy: string | null;
  reason: string;
  closedAt: string;
  /** Made before 0012: read from the `stand_ins` close columns. */
  legacy: boolean;
}

/**
 * Whether a canonical bar is the price a close accepted: a stand-in bar from its source with its
 * close (exactly: verify writes both from the same bar). A closed stand-in counts as settled only
 * while its latest close matches (decisions log 2026-11-01, review of rule 5): once a later run
 * builds the day from another secondary or a revised value, or refuses it, the price the signals
 * read is not the one the admin closed, so it is open again for every rule that reads stand-ins
 * (the decision-margin test, corrections waiting) until an admin closes the new price.
 */
export function standInMatchesBar(
  closed: { source: string; close: number },
  bar: { standIn: boolean; source: string; close: number } | null | undefined,
): boolean {
  return !!bar && bar.standIn && bar.source === closed.source && bar.close === closed.close;
}

/**
 * Whether a stored stand-in still waits for the primary (requirements 04 stand-in rule): not
 * resolved (the primary's bar replaced it) and not settled by its latest close (rule 5,
 * `standInMatchesBar`). `latest`: its latest close (`latestClose`), null if never closed;
 * `bar`: the canonical bar on its date (none: refused by a later run).
 */
export function isOpenStandIn(
  row: { resolvedAt: string | null },
  latest: { source: string; close: number } | null,
  bar: { standIn: boolean; source: string; close: number } | null | undefined,
): boolean {
  if (row.resolvedAt !== null) return false;
  return latest === null || !standInMatchesBar(latest, bar);
}

/** `${symbolId} ${date}`, the key of `closeEvents`. */
export const closeKey = (symbolId: number, date: string) => `${symbolId} ${date}`;

/**
 * Every close per stand-in, oldest first: a close made before 0012 (the `stand_ins` close columns
 * with the row's values, which the 0011 triggers froze at the close) unless `stand_in_closes`
 * holds the same close (a close since 0012 writes both), then the `stand_in_closes` rows in order.
 */
export async function closeEvents(
  db: Db,
  o: { symbolId?: number; date?: string } = {},
): Promise<Map<string, StandInClose[]>> {
  const where = (sym: SQL | undefined, day: SQL | undefined) => and(sym, day);
  const history = await db
    .select()
    .from(standInCloses)
    .where(
      where(
        o.symbolId === undefined ? undefined : eq(standInCloses.symbolId, o.symbolId),
        o.date === undefined ? undefined : eq(standInCloses.date, o.date),
      ),
    )
    .orderBy(asc(standInCloses.id));
  const legacy = await db
    .select()
    .from(standIns)
    .where(
      and(
        isNotNull(standIns.closedAt),
        o.symbolId === undefined ? undefined : eq(standIns.symbolId, o.symbolId),
        o.date === undefined ? undefined : eq(standIns.date, o.date),
      ),
    );
  const out = new Map<string, StandInClose[]>();
  for (const r of legacy) {
    const k = closeKey(r.symbolId, r.date);
    if (history.some((h) => closeKey(h.symbolId, h.date) === k && h.closedAt === r.closedAt)) {
      continue;
    }
    out.set(k, [
      {
        source: r.source,
        close: r.close,
        band: r.band,
        basis: r.basis,
        closedBy: r.closedBy,
        reason: r.closeReason ?? '',
        closedAt: r.closedAt!,
        legacy: true,
      },
    ]);
  }
  for (const h of history) {
    const k = closeKey(h.symbolId, h.date);
    out.set(k, [
      ...(out.get(k) ?? []),
      {
        source: h.source,
        close: h.close,
        band: h.band,
        basis: h.basis,
        closedBy: h.closedBy,
        reason: h.reason,
        closedAt: h.closedAt,
        legacy: false,
      },
    ]);
  }
  return out;
}

/** A stand-in's latest close, or null if never closed. */
export async function latestCloseOf(
  db: Db,
  symbolId: number,
  date: string,
): Promise<StandInClose | null> {
  return (await closeEvents(db, { symbolId, date })).get(closeKey(symbolId, date))?.at(-1) ?? null;
}

/**
 * Every stored stand-in (or only the open ones, `isOpenStandIn`: a closed one whose canonical bar
 * changed is open again), oldest date first, with its closes (the latest's time, admin's name and
 * reason as `closedAt`, `closedBy`, `closeReason`) and its canonical bar on that date if any
 * (source, whether a stand-in, close, distribution: a stand-in on a distribution day is read at
 * any age by a total-return signal; the band and basis this build computed). No canonical bar on
 * an open stand-in's date: a later run refused it (the day reads as missing, red in the lookback),
 * yet it still holds corrections back.
 */
export async function standInList(db: Db, o: { open?: boolean } = {}) {
  const rows = await db
    .select({
      symbolId: standIns.symbolId,
      ticker: symbols.ticker,
      date: standIns.date,
      source: standIns.source,
      close: standIns.close,
      band: standIns.band,
      basis: standIns.basis,
      createdAt: standIns.createdAt,
      runId: standIns.runId,
      primaryClose: standIns.primaryClose,
      deviation: standIns.deviation,
      resolvedAt: standIns.resolvedAt,
      barSource: bars.source,
      barStandIn: bars.standIn,
      barClose: bars.close,
      barDivCash: bars.divCash,
      barBand: bars.standInBand,
      barBasis: bars.standInBasis,
    })
    .from(standIns)
    .innerJoin(symbols, eq(symbols.id, standIns.symbolId))
    .leftJoin(bars, and(eq(bars.symbolId, standIns.symbolId), eq(bars.date, standIns.date)))
    .orderBy(asc(standIns.date), asc(symbols.ticker));
  const events = await closeEvents(db);
  const names = new Map(
    (await db.select({ id: users.id, username: users.username }).from(users)).map((u) => [
      u.id,
      u.username,
    ]),
  );
  const list = rows.map(
    ({ barSource, barStandIn, barClose, barDivCash, barBand, barBasis, ...r }) => {
      const closes = events.get(closeKey(r.symbolId, r.date)) ?? [];
      const latest = closes.at(-1) ?? null;
      return {
        ...r,
        date: r.date as TradingDate,
        closes,
        latestClose: latest,
        closedAt: latest?.closedAt ?? null,
        closedBy: latest?.closedBy ? (names.get(latest.closedBy) ?? null) : null,
        closeReason: latest?.reason ?? null,
        canonical:
          barSource === null || barClose === null
            ? null
            : {
                source: barSource,
                standIn: barStandIn === true,
                close: barClose,
                divCash: barDivCash ?? 0,
                band: barBand,
                basis: barBasis,
              },
      };
    },
  );
  return o.open ? list.filter((r) => isOpenStandIn(r, r.latestClose, r.canonical)) : list;
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

/** One close event as the closing step reads it (`closedStandIns`). */
export interface CloseEvent {
  ticker: string;
  date: TradingDate;
  /** The run that first recorded the stand-in (null for rows stored outside a run). */
  runId: string | null;
  createdAt: string;
  closedAt: string;
  closeReason: string;
  /** The close before this one (null for the first): a re-close covers the entries since it. */
  previousClosedAt: string | null;
  resolvedAt: string | null;
}

/**
 * Every close of every stand-in, by stand-in date, ticker and close order: what the closing step
 * annotates (`stand_in_closed`, one set per close). `runId` and `createdAt` as in
 * `resolvedStandIns`; `resolvedAt` set when the primary arrived after all.
 */
export async function closedStandIns(db: Db): Promise<CloseEvent[]> {
  const out: CloseEvent[] = [];
  for (const r of await standInList(db)) {
    r.closes.forEach((c, i) => {
      out.push({
        ticker: r.ticker,
        date: r.date,
        runId: r.runId,
        createdAt: r.createdAt,
        closedAt: c.closedAt,
        closeReason: c.reason,
        previousClosedAt: i === 0 ? null : r.closes[i - 1]!.closedAt,
        resolvedAt: r.resolvedAt,
      });
    });
  }
  return out;
}
