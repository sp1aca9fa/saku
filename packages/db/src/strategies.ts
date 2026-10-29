// Registration and the forward record (requirements 05): registered versions are immutable, the
// forward record is append-only and hash-chained per version over RFC 8785 canonical JSON (the
// hashed text is stored). Recomputations are annotations, never edits. User-owned rows are read
// and written only for their owner (library versions, owner null, are readable by everyone).
import { type Json, canonicalJson } from '@saku/core';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import type { Db } from './client';
import { forwardAnnotations, forwardEntries, journalEntries, strategyVersions } from './schema';

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export type Version = typeof strategyVersions.$inferSelect;
export type ForwardEntry = typeof forwardEntries.$inferSelect;

/** Registers a strategy: an immutable version whose hash starts its forward chain. */
export async function registerVersion(
  db: Db,
  o: {
    ownerId: string | null;
    name: string;
    strategy: Json;
    strategyId?: string;
    at?: Date;
  },
): Promise<Version> {
  const registeredAt = (o.at ?? new Date()).toISOString();
  const text = canonicalJson({
    kind: 'registration',
    owner: o.ownerId,
    name: o.name,
    registeredAt,
    strategy: o.strategy,
  });
  const [row] = await db
    .insert(strategyVersions)
    .values({
      ownerId: o.ownerId,
      strategyId: o.strategyId ?? null,
      name: o.name,
      canonicalJson: text,
      registeredAt,
      hash: sha256(text),
    })
    .returning();
  return row!;
}

/** Versions the user may read: their own and the library's. */
export async function visibleVersions(db: Db, ownerId: string): Promise<Version[]> {
  return db
    .select()
    .from(strategyVersions)
    .where(or(eq(strategyVersions.ownerId, ownerId), isNull(strategyVersions.ownerId)))
    .orderBy(asc(strategyVersions.registeredAt));
}

/** One version, only when the user may read it. */
export async function visibleVersion(
  db: Db,
  ownerId: string,
  versionId: string,
): Promise<Version | undefined> {
  const [row] = await db
    .select()
    .from(strategyVersions)
    .where(
      and(
        eq(strategyVersions.id, versionId),
        or(eq(strategyVersions.ownerId, ownerId), isNull(strategyVersions.ownerId)),
      ),
    );
  return row;
}

/** Every registered version (jobs only: they run for all users). */
export async function allVersions(db: Db): Promise<Version[]> {
  return db.select().from(strategyVersions).orderBy(asc(strategyVersions.registeredAt));
}

export async function lastEntry(db: Db, versionId: string): Promise<ForwardEntry | undefined> {
  const [row] = await db
    .select()
    .from(forwardEntries)
    .where(eq(forwardEntries.versionId, versionId))
    .orderBy(desc(forwardEntries.date))
    .limit(1);
  return row;
}

export interface ForwardInput {
  date: string;
  allocation: string;
  holdings: Json;
  safeStateApplied: boolean;
  dataStatus: 'green' | 'yellow' | 'red';
  equity: number | null;
  /** Everything else recorded that day (signals, reasons, ties, execution). */
  detail: { [key: string]: Json };
}

/** Appends the next day of a version's forward record, chained to the previous hash. */
export async function appendForward(
  db: Db,
  version: Version,
  e: ForwardInput,
  runId: string | null,
): Promise<ForwardEntry> {
  const last = await lastEntry(db, version.id);
  if (last && last.date >= e.date) {
    throw new Error(`${version.name}: the record already has ${last.date}; it only grows.`);
  }
  const prevHash = last?.hash ?? version.hash;
  const payload = canonicalJson({
    kind: 'forward',
    version: version.id,
    date: e.date,
    allocation: e.allocation,
    holdings: e.holdings,
    safeStateApplied: e.safeStateApplied,
    dataStatus: e.dataStatus,
    equity: e.equity,
    ...e.detail,
    prevHash,
  });
  const [row] = await db
    .insert(forwardEntries)
    .values({
      versionId: version.id,
      date: e.date,
      payload,
      allocation: e.allocation,
      holdings: e.holdings,
      safeStateApplied: e.safeStateApplied,
      dataStatus: e.dataStatus,
      equity: e.equity,
      prevHash,
      hash: sha256(payload),
      runId,
    })
    .returning();
  return row!;
}

export async function forwardRecord(db: Db, versionId: string): Promise<ForwardEntry[]> {
  return db
    .select()
    .from(forwardEntries)
    .where(eq(forwardEntries.versionId, versionId))
    .orderBy(asc(forwardEntries.date));
}

/** Checks a version's chain: every hash recomputes, links, and matches its stored columns. */
export async function verifyChain(db: Db, version: Version): Promise<string[]> {
  const problems: string[] = [];
  if (sha256(version.canonicalJson) !== version.hash) problems.push('registration hash');
  let prev = version.hash;
  for (const e of await forwardRecord(db, version.id)) {
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    if (sha256(e.payload) !== e.hash) problems.push(`${e.date}: hash`);
    if (e.prevHash !== prev || p.prevHash !== prev) problems.push(`${e.date}: link`);
    if (canonicalJson(p as Json) !== e.payload) problems.push(`${e.date}: not canonical`);
    if (
      p.date !== e.date ||
      p.allocation !== e.allocation ||
      p.safeStateApplied !== e.safeStateApplied ||
      p.dataStatus !== e.dataStatus ||
      p.version !== version.id
    ) {
      problems.push(`${e.date}: columns differ from the hashed text`);
    }
    prev = e.hash;
  }
  return problems;
}

export async function annotate(
  db: Db,
  o: { versionId: string; date: string; kind: string; detail: Json; runId: string | null },
): Promise<void> {
  await db.insert(forwardAnnotations).values(o);
}

/** A version's annotations of one kind, oldest first (with the detail's fingerprint, if any). */
export async function annotationsOf(db: Db, versionId: string, kind: string) {
  const rows = await db
    .select()
    .from(forwardAnnotations)
    .where(and(eq(forwardAnnotations.versionId, versionId), eq(forwardAnnotations.kind, kind)))
    .orderBy(asc(forwardAnnotations.id));
  return rows.map((r) => ({
    ...r,
    fingerprint: (r.detail as { fingerprint?: string }).fingerprint ?? '',
  }));
}

/** A journal entry (done / skipped / delayed) on a version the user may read. */
export async function addJournalEntry(
  db: Db,
  ownerId: string,
  o: {
    versionId: string;
    signalDate: string;
    action: 'done' | 'skipped' | 'delayed';
    actionDate?: string;
    note?: string;
  },
): Promise<void> {
  if (!(await visibleVersion(db, ownerId, o.versionId))) {
    throw new Error('No such strategy version for this user.');
  }
  await db.insert(journalEntries).values({
    ownerId,
    versionId: o.versionId,
    signalDate: o.signalDate,
    action: o.action,
    actionDate: o.actionDate ?? null,
    note: o.note ?? null,
  });
}

export async function journalOf(db: Db, ownerId: string, versionId: string) {
  return db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.versionId, versionId)))
    .orderBy(asc(journalEntries.signalDate));
}
