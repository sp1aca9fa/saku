// The base currency's deposit rate as a dated, append-only series (requirements 05 `CASH_BASE`,
// 01 "Bank deposits", 12; CLAUDE.md: rates are read only through `asOf`).
//
// Each entry applies from its `from` date until the next entry's. The rules:
// - `ratePct` is decimal text (core `decimal-text`), percent a year, >= 0 and below
//   DEPOSIT_RATE_BELOW, at most 15 significant digits (float64 analytics read it exactly).
// - `currency` is the base currency (`base_currency` must be set): the entry states it, so a rate
//   in another currency is refused rather than read as the base currency's.
// - `from` is a real date, not after today's New York trading date (a rate not yet in force is
//   not known), and after every earlier entry's `from`: an entry is never edited, removed or
//   slipped in before a later one (triggers in migration 0018 enforce the same), so what a past
//   date reads never changes.
// - Reading (`depositRateAsOf`): the entry in force on the date, the latest `from` on or before
//   it. Before the first entry the rate is unknown, never a guess (not 0, not the first rate).
//   `knownBy` also leaves out entries added after that instant (for a reader that must not see
//   what was entered later).
import {
  type TradingDate,
  compareDecimalText,
  floatDecimalTextProblem,
  isTradingDate,
  tradingDateOf,
} from '@saku/core';
import { and, asc, desc, lte } from 'drizzle-orm';
import type { Db } from './client';
import { activityLog, depositRates } from './schema';
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
    const [latest] = await tx
      .select({ from: depositRates.fromDate })
      .from(depositRates)
      .orderBy(desc(depositRates.fromDate))
      .limit(1);
    if (latest && isTradingDate(entry.from) && entry.from <= latest.from) {
      problems.push(
        `the start date must be after the latest entry's (${latest.from}): entries are never edited or inserted before a later one`,
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

/** Every entry in date order (for listing). */
export async function depositRateEntries(db: Db): Promise<DepositRateEntry[]> {
  const rows = await db.select().from(depositRates).orderBy(asc(depositRates.fromDate));
  return rows.map((r) => ({ ratePct: r.ratePct, from: r.fromDate, currency: r.currency }));
}

/**
 * The deposit rate in force on `date`: the entry with the latest `from` on or before it, among
 * those added by `knownBy` when given. `unknown` before the first entry (never a guess);
 * `invalid` when that entry's values do not pass the rules (only a direct database write can do
 * that), never read anyway. Throws on a `date` that is not a date (a caller error).
 */
export async function depositRateAsOf(
  db: Db,
  date: TradingDate,
  o: { knownBy?: Date } = {},
): Promise<{ entry: DepositRateEntry } | { unknown: true } | { invalid: string[] }> {
  if (!isTradingDate(date)) throw new Error(`Not a date: ${JSON.stringify(date)}.`);
  const [row] = await db
    .select()
    .from(depositRates)
    .where(
      and(
        lte(depositRates.fromDate, date),
        o.knownBy ? lte(depositRates.createdAt, o.knownBy.toISOString()) : undefined,
      ),
    )
    .orderBy(desc(depositRates.fromDate))
    .limit(1);
  if (!row) return { unknown: true };
  const entry = { ratePct: row.ratePct, from: row.fromDate, currency: row.currency };
  const problems = valueProblems(entry, await getSetting(db, 'base_currency'));
  return problems.length > 0 ? { invalid: problems } : { entry };
}
