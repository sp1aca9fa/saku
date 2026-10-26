import type { JobType } from '@saku/core';
import { eq, sql } from 'drizzle-orm';
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
