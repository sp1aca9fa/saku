// What the stored re-adjustment events of one run look like (`pnpm sources readjustments`), to
// confirm or refute a source's declared adjusted-close rounding (`PluginInfo.adjCloseRounding`)
// on real data. Read-only.
//
// - Unit: one run's `readjustments` rows (default: the latest bootstrap or weekly run, the runs
//   that refetch the full history, that stored any; optionally one source's).
// - Per source: the number of events and the 50/90/99th percentiles and maximum of |factor - 1|
//   (type 7 quantiles), how many are within each of a few tolerances, and the same split by the
//   level of the stored adjusted close on the event's first date (latest snapshot): < 10,
//   10 to 100, >= 100, or unknown when no adjusted close is stored for that date. A rounding that
//   is relative (floats) shows the same spread at every level; one in fixed decimals shows a
//   larger spread at low levels.
// - Events stored before a source declared its rounding include its noise; events stored after
//   only what is above it (smaller changes make no event), so only the first show the noise.
import type { JobType } from '@saku/core';
import { quantile } from '@saku/data';
import { DEFAULT_ADJ_CLOSE_ROUNDING, type Db, schema } from '@saku/db';
import { and, desc, eq, inArray } from 'drizzle-orm';

const FULL: JobType[] = ['bootstrap', 'weekly'];

/** Tolerances the events are counted against (|factor - 1| at most each). */
export const WITHIN = [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4] as const;

export const LEVELS = ['<10', '10-100', '>=100', 'unknown'] as const;
export type Level = (typeof LEVELS)[number];

export interface Spread {
  count: number;
  p50?: number;
  p90?: number;
  p99?: number;
  max?: number;
  /** Events with |factor - 1| at most each of WITHIN, in that order. */
  within: number[];
}

export interface SourceReadjustments extends Spread {
  source: string;
  byLevel: ({ level: Level } & Spread)[];
}

export interface ReadjustmentRun {
  id: string;
  jobType: JobType;
  startedAt: string;
  status: string;
}

export const READJUSTMENTS_USAGE =
  'Usage: pnpm sources readjustments [--source <key>] [--run <id>] ' +
  '(default: the latest bootstrap or weekly run that stored any)';

/** The parsed arguments, or the message to refuse them with. */
export function parseReadjustmentArgs(
  args: string[],
): { source?: string; run?: string } | { error: string } {
  const out: { source?: string; run?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    if (name !== '--source' && name !== '--run') {
      return { error: `Unknown argument ${name}.\n${READJUSTMENTS_USAGE}` };
    }
    const key = name.slice(2) as 'source' | 'run';
    if (out[key] !== undefined) return { error: `Give ${name} once.` };
    const value = args[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { error: `Give a value for ${name}.` };
    }
    out[key] = value;
  }
  return out;
}

const toRun = (r: typeof schema.jobRuns.$inferSelect): ReadjustmentRun => ({
  id: r.id,
  jobType: r.jobType,
  startedAt: r.startedAt,
  status: r.status,
});

/** The latest full-history run (by start) that stored a re-adjustment (of `source`, if given). */
export async function defaultReadjustmentRun(
  db: Db,
  source?: string,
): Promise<ReadjustmentRun | undefined> {
  const runs = await db
    .select()
    .from(schema.jobRuns)
    .where(inArray(schema.jobRuns.jobType, FULL))
    .orderBy(desc(schema.jobRuns.startedAt));
  for (const r of runs) {
    const [row] = await db
      .select({ id: schema.readjustments.id })
      .from(schema.readjustments)
      .where(
        and(
          eq(schema.readjustments.runId, r.id),
          ...(source === undefined ? [] : [eq(schema.readjustments.source, source)]),
        ),
      )
      .limit(1);
    if (row) return toRun(r);
  }
  return undefined;
}

/** A run by id (any type or state), or none. */
export async function readjustmentRun(db: Db, id: string): Promise<ReadjustmentRun | undefined> {
  const [row] = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, id));
  return row && toRun(row);
}

export function levelOf(adjClose: number | null): Level {
  if (adjClose === null || !Number.isFinite(adjClose)) return 'unknown';
  return adjClose < 10 ? '<10' : adjClose < 100 ? '10-100' : '>=100';
}

/** The spread of |factor - 1| values (any order). */
export function spreadOf(deviations: number[]): Spread {
  const sorted = [...deviations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    ...(sorted.length > 0 && {
      p50: quantile(sorted, 0.5)!,
      p90: quantile(sorted, 0.9)!,
      p99: quantile(sorted, 0.99)!,
      max: sorted.at(-1)!,
    }),
    within: WITHIN.map((t) => sorted.filter((d) => d <= t).length),
  };
}

/** One run's re-adjustment events per source (sorted by key), with their level split. */
export async function readjustmentStats(
  db: Db,
  o: { runId: string; source?: string },
): Promise<SourceReadjustments[]> {
  const ra = schema.readjustments;
  const rows = await db
    .select({ source: ra.source, factor: ra.factor, adjClose: schema.barsRaw.providerAdjClose })
    .from(ra)
    .leftJoin(
      schema.barsRaw,
      and(
        eq(schema.barsRaw.symbolId, ra.symbolId),
        eq(schema.barsRaw.source, ra.source),
        eq(schema.barsRaw.date, ra.fromDate),
      ),
    )
    .where(
      and(eq(ra.runId, o.runId), ...(o.source === undefined ? [] : [eq(ra.source, o.source)])),
    );
  const sources = [...new Set(rows.map((r) => r.source))].sort();
  return sources.map((source) => {
    const mine = rows.filter((r) => r.source === source);
    const deviation = (r: (typeof mine)[number]) => Math.abs(r.factor - 1);
    return {
      source,
      ...spreadOf(mine.map(deviation)),
      byLevel: LEVELS.map((level) => ({
        level,
        ...spreadOf(mine.filter((r) => levelOf(r.adjClose) === level).map(deviation)),
      })).filter((l) => l.count > 0),
    };
  });
}

const sci = (v: number | undefined) => (v === undefined ? '-' : v.toExponential(2));

/** The command's text: per source, overall then per level. */
export function readjustmentText(
  run: ReadjustmentRun,
  stats: SourceReadjustments[],
  declared: (source: string) => number | undefined,
): string {
  const lines = [
    `Re-adjustment events of run ${run.id} (${run.jobType}, started ${run.startedAt}, ` +
      `${run.status}): |factor - 1|; level = the stored adjusted close on the event's first date.`,
  ];
  if (stats.length === 0) lines.push('No re-adjustment events.');
  const head = `count  p50  p90  p99  max  ${WITHIN.map((t) => `<=${sci(t)}`).join('  ')}`;
  const row = (label: string, s: Spread) =>
    `${label}  ${s.count}  ${sci(s.p50)}  ${sci(s.p90)}  ${sci(s.p99)}  ${sci(s.max)}  ` +
    s.within.join('  ');
  for (const s of stats) {
    const rounding = declared(s.source);
    lines.push(
      '',
      `${s.source} (rounding: ${
        rounding === undefined
          ? `none declared, default ${sci(DEFAULT_ADJ_CLOSE_ROUNDING)}`
          : `declared ${sci(rounding)}`
      })`,
      `level  ${head}`,
      row('all', s),
      ...s.byLevel.map((l) => row(l.level, l)),
    );
  }
  return lines.join('\n');
}
