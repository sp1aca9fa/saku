import type { JobType, SourceRole } from '@saku/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { activityLog, jobRuns, sourceRoles } from './schema';

export async function startRun(db: Db, jobType: JobType, now = new Date()): Promise<string> {
  const [row] = await db
    .insert(jobRuns)
    .values({ jobType, startedAt: now.toISOString(), status: 'running' })
    .returning({ id: jobRuns.id });
  return row!.id;
}

export async function finishRun(
  db: Db,
  id: string,
  outcome: { ok: boolean; datesProcessed?: string[]; error?: string; heartbeatSent?: boolean },
  now = new Date(),
): Promise<void> {
  await db
    .update(jobRuns)
    .set({
      finishedAt: now.toISOString(),
      status: outcome.ok ? 'success' : 'failed',
      datesProcessed: outcome.datesProcessed ?? null,
      error: outcome.error ?? null,
      heartbeatSent: outcome.heartbeatSent ?? false,
    })
    .where(eq(jobRuns.id, id));
}

export interface SourceSuggestion {
  key: string;
  dataKind: string;
  suggestedRole: 'primary' | 'secondary' | 'check';
}

/**
 * Plug-ins suggest, the admin decides: a data kind with no roles yet gets the suggested ones
 * (logged, so the admin can review them); a data kind already set is never touched.
 */
export async function seedSourceRoles(db: Db, suggestions: SourceSuggestion[]): Promise<number> {
  let added = 0;
  for (const kind of [...new Set(suggestions.map((s) => s.dataKind))]) {
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)` })
      .from(sourceRoles)
      .where(eq(sourceRoles.dataKind, kind))) as [{ n: number }];
    if (n > 0) continue;
    const list = suggestions.filter((s) => s.dataKind === kind);
    // Exactly one primary: the first suggested; other suggested primaries start as secondary.
    const primary = list.find((s) => s.suggestedRole === 'primary');
    const values = list.map((s, position) => ({
      dataKind: kind,
      pluginKey: s.key,
      role:
        s === primary ? 'primary' : s.suggestedRole === 'primary' ? 'secondary' : s.suggestedRole,
      position,
    })) as (typeof sourceRoles.$inferInsert)[];
    await db.insert(sourceRoles).values(values);
    await db.insert(activityLog).values({
      actor: 'system',
      action: 'source_roles.seed',
      detail: { dataKind: kind, roles: values.map((v) => `${v.pluginKey}:${v.role}`) },
    });
    added += values.length;
  }
  return added;
}

/** Every assigned source, by data kind and position. */
export function sourceRolesOf(db: Db) {
  return db
    .select()
    .from(sourceRoles)
    .orderBy(asc(sourceRoles.dataKind), asc(sourceRoles.position));
}

/**
 * The admin assigns a source's role for a data kind (an unassigned source is not used). A new
 * primary turns the previous one into a secondary: there is exactly one, so the primary itself
 * cannot be demoted (name its successor instead). A new source goes last.
 */
export async function setSourceRole(
  db: Db,
  o: { dataKind: string; key: string; role: SourceRole; actor: string },
): Promise<{ demoted?: string }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(sourceRoles).where(eq(sourceRoles.dataKind, o.dataKind));
    const current = rows.find((r) => r.pluginKey === o.key);
    if (current?.role === 'primary' && o.role !== 'primary') {
      throw new Error(
        `${o.key} is the ${o.dataKind} primary: set another source as primary first.`,
      );
    }
    const old = rows.find((r) => r.role === 'primary' && r.pluginKey !== o.key);
    if (o.role === 'primary' && old) {
      await tx
        .update(sourceRoles)
        .set({ role: 'secondary' })
        .where(and(eq(sourceRoles.dataKind, o.dataKind), eq(sourceRoles.pluginKey, old.pluginKey)));
    }
    const position = current?.position ?? Math.max(-1, ...rows.map((r) => r.position)) + 1;
    await tx
      .insert(sourceRoles)
      .values({ dataKind: o.dataKind, pluginKey: o.key, role: o.role, position })
      .onConflictDoUpdate({
        target: [sourceRoles.dataKind, sourceRoles.pluginKey],
        set: { role: o.role },
      });
    const demoted = o.role === 'primary' ? old?.pluginKey : undefined;
    await tx.insert(activityLog).values({
      actor: o.actor,
      action: 'source_roles.set',
      detail: { dataKind: o.dataKind, key: o.key, role: o.role, ...(demoted && { demoted }) },
    });
    return demoted ? { demoted } : {};
  });
}

/**
 * Stops using a source for a data kind (its stored data stays). The primary stays until another
 * source is primary, so a data kind keeps its roles (and is never seeded again).
 */
export async function removeSourceRole(
  db: Db,
  o: { dataKind: string; key: string; actor: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sourceRoles)
      .where(and(eq(sourceRoles.dataKind, o.dataKind), eq(sourceRoles.pluginKey, o.key)));
    if (row?.role === 'primary') {
      throw new Error(
        `${o.key} is the ${o.dataKind} primary: set another source as primary first.`,
      );
    }
    const gone = await tx
      .delete(sourceRoles)
      .where(and(eq(sourceRoles.dataKind, o.dataKind), eq(sourceRoles.pluginKey, o.key)))
      .returning();
    if (gone.length) {
      await tx.insert(activityLog).values({
        actor: o.actor,
        action: 'source_roles.remove',
        detail: { dataKind: o.dataKind, key: o.key, role: gone[0]!.role },
      });
    }
    return gone.length > 0;
  });
}
