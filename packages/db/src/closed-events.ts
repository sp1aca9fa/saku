// Resolutions of dividends and splits dated on a closed market day (requirements 04 "Closed-day
// bars", decisions log 2026-11-01, C19): what the checks and the list read. The resolution itself
// is `resolveClosedEvent` in the plug-in SDK (admin, reason, jobs lock). Every resolution is kept:
// `closed_event_resolutions` (0013, append-only).
import { asc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { closedEventResolutions, users } from './schema';

/** One admin resolution of a closed-day event: the event as stored then, by whom, when, why. */
export interface ClosedEventResolution {
  symbolId: number;
  date: string;
  source: string;
  divCash: number;
  splitFactor: number;
  /** The admin's user id. */
  resolvedBy: string;
  /** The admin's username now (null: the account no longer reads). */
  username: string | null;
  reason: string;
  resolvedAt: string;
}

/** Every resolution (or a symbol's), oldest first. */
export async function closedEventResolutionsOf(
  db: Db,
  o: { symbolId?: number } = {},
): Promise<ClosedEventResolution[]> {
  const r = closedEventResolutions;
  const rows = await db
    .select({
      symbolId: r.symbolId,
      date: r.date,
      source: r.source,
      divCash: r.divCash,
      splitFactor: r.splitFactor,
      resolvedBy: r.resolvedBy,
      username: users.username,
      reason: r.reason,
      resolvedAt: r.resolvedAt,
    })
    .from(r)
    .leftJoin(users, eq(users.id, r.resolvedBy))
    .where(o.symbolId === undefined ? undefined : eq(r.symbolId, o.symbolId))
    .orderBy(asc(r.id));
  return rows;
}

/**
 * The latest resolution that covers a closed-day event as stored now, or undefined: one for the
 * same symbol, date and source, made for exactly these values (the raw bar's dividend and split
 * factor). An event the source changed since is a different event: not covered, red again until
 * corrected or resolved anew.
 */
export function resolutionOf(
  resolutions: ClosedEventResolution[],
  event: { symbolId: number; date: string; source: string; divCash: number; splitFactor: number },
): ClosedEventResolution | undefined {
  return resolutions.findLast(
    (r) =>
      r.symbolId === event.symbolId &&
      r.date === event.date &&
      r.source === event.source &&
      r.divCash === event.divCash &&
      r.splitFactor === event.splitFactor,
  );
}
