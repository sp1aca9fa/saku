// The base currency's deposit rate as a dated, append-only series (requirements 05 `CASH_BASE`,
// 01 "Bank deposits", 12; CLAUDE.md: rates are read only through `asOf`).
//
// Each entry applies from its `from` date until the next entry's. The rules:
// - `ratePct` is decimal text (core `decimal-text`), percent a year, >= 0 and below
//   DEPOSIT_RATE_BELOW, at most 15 significant digits (float64 analytics read it exactly).
// - `currency` is the base currency (`base_currency` must be set): the entry states it, so a rate
//   in another currency is refused rather than read as the base currency's.
// - `from` is a real date, not after today's New York trading date (a rate not yet in force is
//   not known), and either after the latest entry's `from` or before the earliest (a backfill:
//   every reader saw unknown there). On or between existing dates is refused: it would change
//   what a date already read. An entry is never edited or removed (triggers in migrations 0018,
//   0020 enforce the same).
// - A wrong rate is corrected, never overwritten (data rule: the revision log): a row in
//   `deposit_rate_revisions` names the entry, the rate it replaces, the new rate, a reason, who
//   and when (`correctDepositRate`).
// - Reading (`depositRateAsOf`): the entry in force on the date, the latest `from` on or before
//   it, with its latest correction. Before the first entry the rate is unknown, never a guess
//   (not 0, not the first rate). `knownBy` reads what was known at that instant: entries and
//   corrections added after it are left out (for a reader that must not see later input).
import {
  type TradingDate,
  compareDecimalText,
  floatDecimalTextProblem,
  isTradingDate,
  tradingDateOf,
} from '@saku/core';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { Db } from './client';
import { activityLog, depositRateRevisions, depositRates } from './schema';
import { getSetting } from './settings';

/**
 * The deposit rate's ceiling (below 1000% a year): only a guard against an absurd value; it
 * catches no unit mistake (a rate in basis points or as a fraction), which the admin checks.
 */
export const DEPOSIT_RATE_BELOW = '1000';

/** One entry: the rate in percent a year (decimal text), from a date on, in the base currency. */
export interface DepositRateEntry {
  ratePct: string;
  from: TradingDate;
  currency: string;
}

/** Problems with a stored or new entry's values (not its order). */
function valueProblems(e: DepositRateEntry, base: string | undefined): string[] {
  const problems: string[] = [];
  const rate = floatDecimalTextProblem(e.ratePct);
  if (rate !== undefined) problems.push(`the rate ${rate}`);
  else if (compareDecimalText(e.ratePct, DEPOSIT_RATE_BELOW) >= 0) {
    problems.push(`the rate must be below ${DEPOSIT_RATE_BELOW} (got ${e.ratePct})`);
  }
  if (!isTradingDate(e.from)) {
    problems.push(`the start date must be a date like 2026-10-01 (got ${JSON.stringify(e.from)})`);
  }
  if (base === undefined) {
    problems.push("base_currency is not set: the deposit rate is the base currency's");
  } else if (e.currency !== base) {
    problems.push(`the currency must be the base currency ${base} (got ${e.currency})`);
  }
  return problems;
}

/**
 * Adds an entry, or throws with every reason it is refused (see the rules above). `now` decides
 * today's New York trading date.
 */
export async function addDepositRate(
  db: Db,
  entry: DepositRateEntry,
  o: { actor?: string; now?: Date } = {},
): Promise<void> {
  const base = await getSetting(db, 'base_currency');
  const today = tradingDateOf(o.now ?? new Date());
  await db.transaction(async (tx) => {
    const problems = valueProblems(entry, base);
    if (isTradingDate(entry.from) && entry.from > today) {
      problems.push(`the start date ${entry.from} is after today (${today}, New York)`);
    }
    const dates = (await tx.select({ from: depositRates.fromDate }).from(depositRates)).map(
      (r) => r.from,
    );
    const earliest = dates.reduce<string | undefined>(
      (a, d) => (a === undefined || d < a ? d : a),
      undefined,
    );
    const latest = dates.reduce<string | undefined>(
      (a, d) => (a === undefined || d > a ? d : a),
      undefined,
    );
    if (
      earliest !== undefined &&
      latest !== undefined &&
      isTradingDate(entry.from) &&
      entry.from >= earliest &&
      entry.from <= latest
    ) {
      problems.push(
        `the start date must be after the latest entry's (${latest}) or before the earliest (${earliest}): ` +
          'an entry on or between existing dates would change what those dates already read (correct an entry instead: deposit-rate correct)',
      );
    }
    if (problems.length > 0) {
      throw new Error(`Deposit rate not added:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    }
    await tx.insert(depositRates).values({
      ratePct: entry.ratePct,
      fromDate: entry.from,
      currency: entry.currency,
      actor: o.actor ?? 'cli',
    });
    await tx
      .insert(activityLog)
      .values({ actor: o.actor ?? 'cli', action: 'deposit_rate.add', detail: { ...entry } });
  });
}

/** A correction of an entry's rate, as stored. */
export interface DepositRateRevision {
  oldRatePct: string;
  newRatePct: string;
  reason: string;
  actor: string;
  at: string;
}

/** An entry with its rate in force now (`ratePct`, after its corrections) and its corrections. */
export interface DepositRateListing extends DepositRateEntry {
  /** The rate as first entered. */
  enteredRatePct: string;
  revisions: DepositRateRevision[];
}

/** Every entry in date order, with its corrections in order (for listing). */
export async function depositRateEntries(db: Db): Promise<DepositRateListing[]> {
  const rows = await db.select().from(depositRates).orderBy(asc(depositRates.fromDate));
  const revisions = await db
    .select()
    .from(depositRateRevisions)
    .orderBy(asc(depositRateRevisions.id));
  return rows.map((r) => {
    const own = revisions
      .filter((v) => v.entryId === r.id)
      .map((v) => ({
        oldRatePct: v.oldRatePct,
        newRatePct: v.newRatePct,
        reason: v.reason,
        actor: v.actor,
        at: v.createdAt,
      }));
    return {
      ratePct: own.at(-1)?.newRatePct ?? r.ratePct,
      from: r.fromDate,
      currency: r.currency,
      enteredRatePct: r.ratePct,
      revisions: own,
    };
  });
}

/**
 * Corrects the rate of the entry starting on `from` (a revision row; the entry is never edited),
 * or throws with every reason it is refused: no such entry, a new rate that does not pass the
 * rules or equals the rate in force, or no reason.
 */
export async function correctDepositRate(
  db: Db,
  c: { from: TradingDate; ratePct: string; reason: string },
  o: { actor?: string } = {},
): Promise<{ oldRatePct: string }> {
  return db.transaction(async (tx) => {
    const problems: string[] = [];
    const [row] = await tx.select().from(depositRates).where(eq(depositRates.fromDate, c.from));
    if (!row) problems.push(`no entry starts on ${JSON.stringify(c.from)} (deposit-rate list)`);
    const rate = floatDecimalTextProblem(c.ratePct);
    if (rate !== undefined) problems.push(`the rate ${rate}`);
    else if (compareDecimalText(c.ratePct, DEPOSIT_RATE_BELOW) >= 0) {
      problems.push(`the rate must be below ${DEPOSIT_RATE_BELOW} (got ${c.ratePct})`);
    }
    if (c.reason.trim() === '') problems.push('a correction states its reason (--reason "...")');
    let current: string | undefined;
    if (row) {
      const [last] = await tx
        .select({ rate: depositRateRevisions.newRatePct })
        .from(depositRateRevisions)
        .where(eq(depositRateRevisions.entryId, row.id))
        .orderBy(desc(depositRateRevisions.id))
        .limit(1);
      current = last?.rate ?? row.ratePct;
      if (rate === undefined && compareDecimalText(c.ratePct, current) === 0) {
        problems.push(`the rate in force is already ${current}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`Deposit rate not corrected:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    }
    const actor = o.actor ?? 'cli';
    await tx.insert(depositRateRevisions).values({
      entryId: row!.id,
      oldRatePct: current!,
      newRatePct: c.ratePct,
      reason: c.reason.trim(),
      actor,
    });
    await tx.insert(activityLog).values({
      actor,
      action: 'deposit_rate.correct',
      detail: {
        from: c.from,
        oldRatePct: current!,
        newRatePct: c.ratePct,
        reason: c.reason.trim(),
      },
    });
    return { oldRatePct: current! };
  });
}

/**
 * The deposit rate in force on `date`: the entry with the latest `from` on or before it, with
 * its latest correction; with `knownBy`, only entries and corrections added by that instant
 * (without it: the latest). `unknown` before the first entry (never a guess); `invalid` when the
 * value read does not pass the rules (only a direct database write can do that), never read
 * anyway. Throws on a `date` that is not a date (a caller error).
 */
export async function depositRateAsOf(
  db: Db,
  date: TradingDate,
  o: { knownBy?: Date } = {},
): Promise<{ entry: DepositRateEntry } | { unknown: true } | { invalid: string[] }> {
  if (!isTradingDate(date)) throw new Error(`Not a date: ${JSON.stringify(date)}.`);
  const knownBy = o.knownBy?.toISOString();
  const [row] = await db
    .select()
    .from(depositRates)
    .where(
      and(
        lte(depositRates.fromDate, date),
        knownBy ? lte(depositRates.createdAt, knownBy) : undefined,
      ),
    )
    .orderBy(desc(depositRates.fromDate))
    .limit(1);
  if (!row) return { unknown: true };
  const [revision] = await db
    .select({ rate: depositRateRevisions.newRatePct })
    .from(depositRateRevisions)
    .where(
      and(
        eq(depositRateRevisions.entryId, row.id),
        knownBy ? lte(depositRateRevisions.createdAt, knownBy) : undefined,
      ),
    )
    .orderBy(desc(depositRateRevisions.id))
    .limit(1);
  const entry = {
    ratePct: revision?.rate ?? row.ratePct,
    from: row.fromDate,
    currency: row.currency,
  };
  const problems = valueProblems(entry, await getSetting(db, 'base_currency'));
  return problems.length > 0 ? { invalid: problems } : { entry };
}

/** What `depositRateAsOf` returns for a date. */
export type DepositRateRead = Awaited<ReturnType<typeof depositRateAsOf>>;

/**
 * `depositRateAsOf` for many dates, read once and answered in memory, for a backtest that reads a
 * date at a time (docs/indicators.md "Base-currency cash"). Each answer equals `depositRateAsOf`'s
 * with the same `knownBy` (an ISO 8601 instant; without it the latest entries and corrections):
 * the entry with the latest `from` on or before the date among those added by then, with its
 * latest correction made by then; unknown before the first such entry; invalid when the value read
 * does not pass the rules. Throws on a `date` that is not a date (a caller error).
 */
export async function depositRateReader(
  db: Db,
): Promise<(date: TradingDate, o?: { knownBy?: string }) => DepositRateRead> {
  const rows = await db.select().from(depositRates).orderBy(asc(depositRates.fromDate));
  const revisions = await db
    .select()
    .from(depositRateRevisions)
    .orderBy(asc(depositRateRevisions.id));
  /** Each entry's corrections in id order (the last one made by an instant is in force then). */
  const byEntry = new Map<number, { rate: string; at: string }[]>();
  for (const v of revisions) {
    byEntry.set(v.entryId, [
      ...(byEntry.get(v.entryId) ?? []),
      { rate: v.newRatePct, at: v.createdAt },
    ]);
  }
  const base = await getSetting(db, 'base_currency');
  return (date, o = {}) => {
    if (!isTradingDate(date)) throw new Error(`Not a date: ${JSON.stringify(date)}.`);
    // The last entry starting on or before the date (from dates are unique and sorted)...
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]!.fromDate <= date) lo = mid + 1;
      else hi = mid;
    }
    // ...among those added by `knownBy`.
    let k = lo - 1;
    while (k >= 0 && o.knownBy !== undefined && rows[k]!.createdAt > o.knownBy) k--;
    if (k < 0) return { unknown: true };
    const row = rows[k]!;
    const made = (byEntry.get(row.id) ?? []).filter(
      (v) => o.knownBy === undefined || v.at <= o.knownBy,
    );
    const entry = {
      ratePct: made.at(-1)?.rate ?? row.ratePct,
      from: row.fromDate,
      currency: row.currency,
    };
    const problems = valueProblems(entry, base);
    return problems.length > 0 ? { invalid: problems } : { entry };
  };
}
