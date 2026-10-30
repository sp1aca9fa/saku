// Reading stored health reason codes (requirements 04 "Severity rules" and "health status"):
// shared by the per-date report (`pnpm health`, jobs/health.ts) and the run summary
// (`pnpm health --summary`, jobs/health-summary.ts). Read-only: stored rows are never rewritten.
import type { CheckLayer, TradingDate } from '@saku/core';
import { checkAsRead } from '@saku/data';
import { type Db, schema } from '@saku/db';
import { and, eq } from 'drizzle-orm';

/** The reason code of a check result, as the health rows name it (`B.close_match@source`). */
export function reasonCode(g: { layer: CheckLayer; check: string; source: string | null }) {
  return `${g.layer}.${g.check}${g.source ? `@${g.source}` : ''}`;
}

/**
 * A stored reason code as shown: a `B.close_match@s` (on an overall row `X:B.close_match@s`) whose
 * every result of the run with that date, symbol (none on an overall row) and source is a missing
 * secondary bar stored before `secondary_missing` existed (`checkAsRead`) reads as
 * `B.secondary_missing@s`, so it is worded as a source without a bar, not a disagreement. Any
 * real close comparison among them, or no result at all, keeps the stored code. Stored rows are
 * never rewritten.
 */
export async function reasonsAsRead(db: Db, runId: string) {
  const r = schema.checkResults;
  // Per key: whether every result is the old missing-bar form (any status: a daily run stores the
  // green comparisons too).
  const allMissing = new Map<string, boolean>();
  for (const x of await db
    .select({
      date: r.date,
      symbolId: r.symbolId,
      layer: r.layer,
      checkName: r.checkName,
      source: r.source,
      message: r.message,
    })
    .from(r)
    .where(and(eq(r.runId, runId), eq(r.layer, 'B'), eq(r.checkName, 'close_match')))) {
    const key = JSON.stringify([x.date, x.symbolId, reasonCode({ ...x, check: x.checkName })]);
    const missing = checkAsRead(x) === 'secondary_missing';
    allMissing.set(key, (allMissing.get(key) ?? true) && missing);
  }
  return (row: { date: TradingDate; symbolId: number | null }, code: string): string => {
    const m = /^((?:[^:@\s]+:)?)(B\.close_match@.+)$/.exec(code);
    if (!m) return code;
    // A prefix only on an overall row; a symbol row's code has none.
    if ((m[1] !== '') !== (row.symbolId === null)) return code;
    const key = JSON.stringify([row.date, row.symbolId, m[2]]);
    return allMissing.get(key) === true
      ? `${m[1]}${m[2]!.replace('B.close_match@', 'B.secondary_missing@')}`
      : code;
  };
}
