// Requests each provider received, kept across runs for the quota guard (requirements 04 "Quota
// guard": never above 80% of any declared limit). Stored in `provider_usage` as buckets, never as
// URLs, keys or bodies: per provider a `minute` row (UTC minute start, request count) and a `day`
// row (UTC day, request count, distinct symbols requested that day). The request windows (minute,
// hour, day) are read from the minute rows only; a day row's request count is informational (for
// an admin view), never what a limit is checked against.
//
// Buckets lose exact times, so reads are conservative: each request counts as sent at the last
// millisecond of its bucket (never earlier than it was sent), so a window never sees fewer
// requests or symbols than were sent in it; it may see some for up to one bucket longer.
import { and, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { providerUsage } from './schema';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The longest request window the guard checks (a day). */
export const USAGE_REQUEST_WINDOW_MS = DAY_MS;
/** The symbols-per-month window: a rolling 31 days (stricter than any calendar month). */
export const USAGE_SYMBOL_WINDOW_MS = 31 * DAY_MS;

const minuteStart = (ms: number) => new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
const dayStart = (ms: number) =>
  new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

/** One provider's earlier requests, each at a time no earlier than it was sent. */
export interface ProviderUsageHistory {
  /** One time (ms since epoch) per request in the last day, oldest first. */
  requests: number[];
  /** Each symbol requested in the last 31 days, with the latest time it counts from. */
  symbols: Map<string, number>;
}

/**
 * Records one request as it is sent (before the answer), so a run that crashes keeps what it
 * sent. Both buckets are written in one transaction. `symbol`: the ticker the request is for, or
 * null (a series, a pair, a request for no symbol).
 */
export async function recordProviderRequest(
  db: Db,
  o: { provider: string; at: number; symbol: string | null },
): Promise<void> {
  if (!Number.isFinite(o.at)) throw new Error(`invalid request time for ${o.provider}`);
  await db.transaction(async (tx) => {
    await tx
      .insert(providerUsage)
      .values({
        provider: o.provider,
        windowType: 'minute',
        windowStart: minuteStart(o.at),
        requestCount: 1,
        symbols: [],
      })
      .onConflictDoUpdate({
        target: [providerUsage.provider, providerUsage.windowType, providerUsage.windowStart],
        set: { requestCount: sql`${providerUsage.requestCount} + 1` },
      });
    // The symbol joins the day's distinct list once (json_each / json_insert, in one statement).
    const symbol = o.symbol;
    await tx
      .insert(providerUsage)
      .values({
        provider: o.provider,
        windowType: 'day',
        windowStart: dayStart(o.at),
        requestCount: 1,
        symbols: symbol === null ? [] : [symbol],
      })
      .onConflictDoUpdate({
        target: [providerUsage.provider, providerUsage.windowType, providerUsage.windowStart],
        set: {
          requestCount: sql`${providerUsage.requestCount} + 1`,
          ...(symbol !== null && {
            symbols: sql`CASE WHEN EXISTS (SELECT 1 FROM json_each(${providerUsage.symbols}) WHERE value = ${symbol}) THEN ${providerUsage.symbols} ELSE json_insert(${providerUsage.symbols}, '$[#]', ${symbol}) END`,
          }),
        },
      });
  });
}

/**
 * A provider's requests in the last day and symbols in the last 31 days, as seen at `now` (ms).
 * Rows starting after `now` (a clock set back) are included: counted, never dropped.
 * `before` (ms): only buckets starting no later than the bucket holding it, for an id another
 * plug-in may still use after `before` (a former provider id). The bucket holding `before` is
 * kept whole, so a request sent before it is never left out (some after it may count).
 */
export async function providerUsageSince(
  db: Db,
  provider: string,
  now: number,
  before?: number,
): Promise<ProviderUsageHistory> {
  if (before !== undefined && !Number.isFinite(before)) {
    throw new Error(`invalid usage bound for ${provider}`);
  }
  // Every minute bucket whose last millisecond can still be inside the day window.
  const minutes = await db
    .select()
    .from(providerUsage)
    .where(
      and(
        eq(providerUsage.provider, provider),
        eq(providerUsage.windowType, 'minute'),
        gte(providerUsage.windowStart, minuteStart(now - USAGE_REQUEST_WINDOW_MS)),
        before === undefined ? undefined : lte(providerUsage.windowStart, minuteStart(before)),
      ),
    );
  const requests: number[] = [];
  for (const row of minutes) {
    const end = Date.parse(row.windowStart) + MINUTE_MS - 1;
    if (!Number.isFinite(end)) throw new Error(`unreadable usage bucket ${row.windowStart}`);
    for (let k = 0; k < row.requestCount; k++) requests.push(end);
  }
  requests.sort((a, b) => a - b);

  const days = await db
    .select()
    .from(providerUsage)
    .where(
      and(
        eq(providerUsage.provider, provider),
        eq(providerUsage.windowType, 'day'),
        gte(providerUsage.windowStart, dayStart(now - USAGE_SYMBOL_WINDOW_MS)),
        before === undefined ? undefined : lte(providerUsage.windowStart, dayStart(before)),
      ),
    );
  const symbols = new Map<string, number>();
  for (const row of days) {
    const end = Date.parse(`${row.windowStart}T00:00:00Z`) + DAY_MS - 1;
    if (!Number.isFinite(end)) throw new Error(`unreadable usage bucket ${row.windowStart}`);
    if (!Array.isArray(row.symbols)) throw new Error(`unreadable usage symbols ${row.windowStart}`);
    for (const s of row.symbols) {
      if (typeof s !== 'string') throw new Error(`unreadable usage symbols ${row.windowStart}`);
      if ((symbols.get(s) ?? -Infinity) < end) symbols.set(s, end);
    }
  }
  return { requests, symbols };
}

/**
 * Deletes buckets no window can still count at `now` (ms): minute rows wholly older than a day,
 * day rows wholly older than 31 days. Returns the rows deleted.
 */
export async function pruneProviderUsage(db: Db, now: number): Promise<number> {
  const minutes = await db
    .delete(providerUsage)
    .where(
      and(
        eq(providerUsage.windowType, 'minute'),
        lt(providerUsage.windowStart, minuteStart(now - USAGE_REQUEST_WINDOW_MS)),
      ),
    )
    .returning({ provider: providerUsage.provider });
  const days = await db
    .delete(providerUsage)
    .where(
      and(
        eq(providerUsage.windowType, 'day'),
        lt(providerUsage.windowStart, dayStart(now - USAGE_SYMBOL_WINDOW_MS)),
      ),
    )
    .returning({ provider: providerUsage.provider });
  return minutes.length + days.length;
}
