// Red re-checks (requirements 04 "Red re-check before execution", decisions log 2026-11-01, C16;
// migration 0014). One row per version and date red at its first grading: opened by the forward
// step, closed once when the day's entry is appended. What a row records is never changed; the
// later columns are each set once (triggers refuse anything else), so these writes only fill
// columns still empty.
import type { Json } from '@saku/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db, Tx } from './client';
import { type RecheckOutcome, forwardAnnotations, redRechecks } from './schema';

export type Recheck = typeof redRechecks.$inferSelect;

/** The first red grading's decision, as the provisional message's fallback and the late final. */
export interface RecheckDecision {
  allocation: string;
  holdings: { ticker: string; weight: number }[];
  dataStatus: 'green' | 'yellow' | 'red';
  reasons: string[];
  signals: Record<string, boolean | number> | null;
  ties: string[];
}

/** Opens a re-check (no final yet), or records one closed at once (`not_rechecked`). */
export async function insertRecheck(
  db: Db | Tx,
  o: {
    versionId: string;
    date: string;
    firstRedAt: string;
    firstRunId: string | null;
    deadline: string;
    provisional: RecheckDecision;
    /** Closed at once: the safe state was appended with no re-check (a late first grading). */
    notRechecked?: { finalRunId: string | null };
  },
): Promise<Recheck> {
  const [row] = await db
    .insert(redRechecks)
    .values({
      versionId: o.versionId,
      date: o.date,
      firstRedAt: o.firstRedAt,
      firstRunId: o.firstRunId,
      reasons: o.provisional.reasons,
      deadline: o.deadline,
      provisional: o.provisional as unknown as Json,
      ...(o.notRechecked && {
        finalAt: o.firstRedAt,
        finalRunId: o.notRechecked.finalRunId,
        outcome: 'not_rechecked' as const,
      }),
    })
    .returning();
  return row!;
}

/** Re-checks still open (no final yet), oldest first. */
export async function openRechecks(db: Db, versionId?: string): Promise<Recheck[]> {
  return db
    .select()
    .from(redRechecks)
    .where(
      versionId === undefined
        ? isNull(redRechecks.outcome)
        : and(isNull(redRechecks.outcome), eq(redRechecks.versionId, versionId)),
    )
    .orderBy(asc(redRechecks.date), asc(redRechecks.id));
}

/** The re-check of a version's day, if the day was red at its first grading. */
export async function recheckOf(
  db: Db,
  versionId: string,
  date: string,
): Promise<Recheck | undefined> {
  const [row] = await db
    .select()
    .from(redRechecks)
    .where(and(eq(redRechecks.versionId, versionId), eq(redRechecks.date, date)));
  return row;
}

/** Every re-check, oldest first (for the senders, which pick those not told yet). */
export async function allRechecks(db: Db): Promise<Recheck[]> {
  return db.select().from(redRechecks).orderBy(asc(redRechecks.date), asc(redRechecks.id));
}

/** Closes an open re-check once; throws when it is not open (never overwrites a final). */
export async function closeRecheck(
  db: Db | Tx,
  id: number,
  o: {
    finalAt: string;
    finalRunId: string | null;
    outcome: Exclude<RecheckOutcome, 'not_rechecked'>;
  },
): Promise<void> {
  const done = await db
    .update(redRechecks)
    .set({ finalAt: o.finalAt, finalRunId: o.finalRunId, outcome: o.outcome })
    .where(and(eq(redRechecks.id, id), isNull(redRechecks.outcome)))
    .returning({ id: redRechecks.id });
  if (done.length === 0) throw new Error(`Re-check ${id} is not open; its final is not changed.`);
}

/**
 * Marks the provisional or the final message as told (once; returns whether this call marked it),
 * with the number of channels it reached (`channels`) and, when it reached at least one, the time
 * it had reached them all (`at`). A message that reached no channel (a library version, an owner
 * with no channel) records 0 and no sending time: nothing was sent, and the re-check is not looked
 * at again. The final's sending time also becomes a `red_recheck_sent` annotation on the day's
 * entry (requirements 04: the record keeps the final instruction with the time it was sent; the
 * entry's hashed `finalDecidedAt` is when it was decided), in the same transaction, so a sending
 * time is annotated exactly once and never for a final sent nowhere.
 */
export async function markRecheckSent(
  db: Db,
  id: number,
  which: 'provisional' | 'final',
  told: { channels: number; at: string | null },
  runId: string | null = null,
): Promise<boolean> {
  const { channels } = told;
  if (!Number.isInteger(channels) || channels < 0) {
    throw new Error(`Re-check ${id}: channel count ${channels} is not a whole number >= 0.`);
  }
  if (channels > 0 !== (told.at !== null)) {
    throw new Error(`Re-check ${id}: a sending time goes with at least one channel reached.`);
  }
  const at = channels > 0 ? told.at : null;
  const done =
    which === 'provisional' ? redRechecks.provisionalChannels : redRechecks.finalChannels;
  const sent = which === 'provisional' ? redRechecks.provisionalSentAt : redRechecks.finalSentAt;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(redRechecks)
      .set(
        which === 'provisional'
          ? { provisionalSentAt: at, provisionalChannels: channels }
          : { finalSentAt: at, finalChannels: channels },
      )
      // Not marked yet (a row from before 0015 may carry a sending time without a count).
      .where(and(eq(redRechecks.id, id), isNull(done), isNull(sent)))
      .returning();
    if (!row) return false;
    if (which === 'final' && at !== null) {
      await tx.insert(forwardAnnotations).values({
        versionId: row.versionId,
        date: row.date,
        kind: 'red_recheck_sent',
        detail: { sentAt: at, outcome: row.outcome, finalDecidedAt: row.finalAt },
        runId,
      });
    }
    return true;
  });
}

/** Whether a re-check's provisional or final message is marked as told (sent, or to no channel). */
export function recheckTold(r: Recheck, which: 'provisional' | 'final'): boolean {
  return which === 'provisional'
    ? r.provisionalChannels !== null || r.provisionalSentAt !== null
    : r.finalChannels !== null || r.finalSentAt !== null;
}
