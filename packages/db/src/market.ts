// Storing what sources deliver. Nothing stored is silently overwritten: changed raw bar fields go
// to `bar_revisions`, a provider's rewrite of its adjusted values becomes `readjustments` events,
// and series, FX and issuer values keep every vintage.
import {
  type FxKind,
  type FxRate,
  type IssuerRecord,
  PointInTime,
  type RawBar,
  type RawBarField,
  type SeriesPoint,
  type TradingDate,
  zonedInstant,
} from '@saku/core';
import { and, asc, between, desc, eq, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  barRevisions,
  bars,
  barsRaw,
  dataHealth,
  fxRates,
  issuerRecords,
  readjustments,
  series,
  standIns,
  symbols,
} from './schema';

/** Rows per insert statement (SQLite caps bound variables per statement). */
const CHUNK = 500;

/** Two provider adjustment ratios this close are one re-adjustment (float noise aside). */
const SAME_FACTOR = 1e-9;

export interface SymbolInput {
  ticker: string;
  tier: number;
  assetClass: string;
  currency: string;
  leverageFactor?: number;
  /** Ticker of the underlying, which must be listed earlier or already stored. */
  underlying?: string;
  issuer?: string;
  indexSeries?: string;
}

/** Adds symbols that are missing and updates the descriptive fields of those that exist. */
export async function upsertSymbols(db: Db, list: SymbolInput[]): Promise<void> {
  for (const s of list) {
    const underlyingSymbolId = s.underlying
      ? ((await symbolId(db, s.underlying)) ??
        failUnknown(`${s.ticker}'s underlying ${s.underlying}`))
      : null;
    const values = {
      tier: s.tier,
      assetClass: s.assetClass,
      currency: s.currency,
      leverageFactor: s.leverageFactor ?? 1,
      underlyingSymbolId,
      issuer: s.issuer ?? null,
      indexSeries: s.indexSeries ?? null,
    };
    await db
      .insert(symbols)
      .values({ ticker: s.ticker, ...values })
      .onConflictDoUpdate({ target: symbols.ticker, set: values });
  }
}

function failUnknown(what: string): never {
  throw new Error(`Unknown symbol: ${what}`);
}

export async function symbolId(db: Db, ticker: string): Promise<number | undefined> {
  const [row] = await db.select({ id: symbols.id }).from(symbols).where(eq(symbols.ticker, ticker));
  return row?.id;
}

export async function activeSymbols(db: Db) {
  return db.select().from(symbols).where(eq(symbols.active, true)).orderBy(asc(symbols.id));
}

/** Records metadata a source reported (inception date, exchange) where none is stored yet. */
export async function fillSymbolMeta(
  db: Db,
  id: number,
  meta: { inceptionDate?: string; exchange?: string },
): Promise<void> {
  const [row] = await db.select().from(symbols).where(eq(symbols.id, id));
  if (!row) return;
  const set = {
    ...(!row.inceptionDate && meta.inceptionDate && { inceptionDate: meta.inceptionDate }),
    ...(!row.exchange && meta.exchange && { exchange: meta.exchange }),
  };
  if (Object.keys(set).length > 0) await db.update(symbols).set(set).where(eq(symbols.id, id));
}

export interface RawBarsResult {
  inserted: number;
  revised: number;
  readjustments: number;
  /** Stored dates the source no longer returned in this window (kept, reported). */
  missing: TradingDate[];
}

const FIELDS: { field: RawBarField; get: (b: RawBar) => number | null }[] = [
  { field: 'open', get: (b) => b.open ?? null },
  { field: 'high', get: (b) => b.high ?? null },
  { field: 'low', get: (b) => b.low ?? null },
  { field: 'close', get: (b) => b.close },
  { field: 'close_is_split_adjusted', get: (b) => (b.closeIsSplitAdjusted ? 1 : 0) },
  { field: 'volume', get: (b) => b.volume ?? null },
  { field: 'div_cash', get: (b) => b.divCash },
  { field: 'split_factor', get: (b) => b.splitFactor },
];

type StoredBar = typeof barsRaw.$inferSelect;

function asRawBar(row: StoredBar): RawBar {
  return {
    date: row.date,
    ...(row.open !== null && { open: row.open }),
    ...(row.high !== null && { high: row.high }),
    ...(row.low !== null && { low: row.low }),
    close: row.close,
    closeIsSplitAdjusted: row.closeIsSplitAdjusted,
    ...(row.volume !== null && { volume: row.volume }),
    divCash: row.divCash,
    splitFactor: row.splitFactor,
    ...(row.providerAdjClose !== null && { providerAdjClose: row.providerAdjClose }),
  };
}

/**
 * Stores one source's bars for one symbol: new dates are inserted; for stored dates, every
 * changed raw field is logged in `bar_revisions` before the row is updated. Changed provider
 * adjusted closes are grouped into one `readjustments` event per factor.
 */
export async function storeRawBars(
  db: Db,
  input: {
    symbolId: number;
    source: string;
    bars: RawBar[];
    runId: string | null;
    fetchedAt: string;
  },
): Promise<RawBarsResult> {
  const result: RawBarsResult = { inserted: 0, revised: 0, readjustments: 0, missing: [] };
  if (input.bars.length === 0) return result;
  const sorted = [...input.bars].sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(sorted.map((b) => b.date)).size !== sorted.length) {
    throw new Error(`${input.source} sent the same date twice for symbol ${input.symbolId}`);
  }
  const from = sorted[0]!.date;
  const to = sorted.at(-1)!.date;
  const key = and(eq(barsRaw.symbolId, input.symbolId), eq(barsRaw.source, input.source));

  await db.transaction(async (tx) => {
    const stored = new Map(
      (
        await tx
          .select()
          .from(barsRaw)
          .where(and(key, between(barsRaw.date, from, to)))
      ).map((r) => [r.date, r]),
    );
    const sent = new Set(sorted.map((b) => b.date));
    result.missing = [...stored.keys()].filter((d) => !sent.has(d)).sort();

    const inserts: (typeof barsRaw.$inferInsert)[] = [];
    const revisions: (typeof barRevisions.$inferInsert)[] = [];
    const ratios: { date: string; factor: number }[] = [];
    for (const bar of sorted) {
      const row = {
        symbolId: input.symbolId,
        date: bar.date,
        source: input.source,
        open: bar.open ?? null,
        high: bar.high ?? null,
        low: bar.low ?? null,
        close: bar.close,
        closeIsSplitAdjusted: bar.closeIsSplitAdjusted,
        volume: bar.volume ?? null,
        divCash: bar.divCash,
        splitFactor: bar.splitFactor,
        providerAdjClose: bar.providerAdjClose ?? null,
        fetchedAt: input.fetchedAt,
      };
      const old = stored.get(bar.date);
      if (!old) {
        inserts.push(row);
        continue;
      }
      const before = asRawBar(old);
      const changed = FIELDS.filter((f) => f.get(before) !== f.get(bar));
      for (const f of changed) {
        revisions.push({
          symbolId: input.symbolId,
          date: bar.date,
          source: input.source,
          field: f.field,
          oldValue: f.get(before),
          newValue: f.get(bar),
          detectedAt: input.fetchedAt,
          runId: input.runId,
        });
      }
      const oldAdj = old.providerAdjClose;
      const newAdj = row.providerAdjClose;
      const adjChanged = oldAdj !== newAdj;
      if (adjChanged && oldAdj !== null && newAdj !== null && oldAdj !== 0) {
        ratios.push({ date: bar.date, factor: newAdj / oldAdj });
      }
      if (changed.length > 0 || adjChanged) {
        await tx
          .update(barsRaw)
          .set(row)
          .where(and(key, eq(barsRaw.date, bar.date)));
      }
    }
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await tx.insert(barsRaw).values(inserts.slice(i, i + CHUNK));
    }
    for (let i = 0; i < revisions.length; i += CHUNK) {
      await tx.insert(barRevisions).values(revisions.slice(i, i + CHUNK));
    }
    const groups = groupFactors(ratios);
    for (const g of groups) {
      await tx.insert(readjustments).values({
        symbolId: input.symbolId,
        source: input.source,
        fromDate: g.from,
        toDate: g.to,
        factor: g.factor,
        detectedAt: input.fetchedAt,
        runId: input.runId,
      });
    }
    result.inserted = inserts.length;
    result.revised = new Set(revisions.map((r) => r.date)).size;
    result.readjustments = groups.length;
  });
  return result;
}

/** Consecutive changed dates sharing one factor form one re-adjustment event. */
export function groupFactors(
  ratios: { date: string; factor: number }[],
): { from: string; to: string; factor: number }[] {
  const groups: { from: string; to: string; factor: number }[] = [];
  for (const r of ratios) {
    const last = groups.at(-1);
    if (last && Math.abs(r.factor - last.factor) <= SAME_FACTOR * Math.abs(last.factor)) {
      last.to = r.date;
    } else {
      groups.push({ from: r.date, to: r.date, factor: r.factor });
    }
  }
  return groups;
}

/**
 * Keeps a value only when it is new: no stored row for that date and publication time (or, with
 * none given, for that date) yet, or the latest stored one says something else.
 */
function newVintages<T extends { date: string; publishedAt: string | null; fetchedAt: string }>(
  stored: T[],
  incoming: T[],
  same: (a: T, b: T) => boolean,
): T[] {
  const latest = new Map<string, T>();
  for (const row of [...stored].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))) {
    latest.set(`${row.date}|${row.publishedAt ?? ''}`, row);
  }
  return incoming.filter((row) => {
    const prev = latest.get(`${row.date}|${row.publishedAt ?? ''}`);
    return !prev || !same(prev, row);
  });
}

/**
 * A publication time as UTC ISO text, so `known_at` values compare correctly as strings. A date
 * without a time is refused: read as midnight it would make a value known hours early.
 */
function instant(text: string): string {
  const ms = Date.parse(text);
  // A time without Z or an offset would be read in the server's own time zone.
  if (!/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text) || Number.isNaN(ms)) {
    throw new Error(`publishedAt must be an instant with a time of day and a zone, not "${text}"`);
  }
  return new Date(ms).toISOString();
}

/**
 * `known_at` as read: rows stored before publication times needed a time of day carry only a
 * date, known at the end of that day in New York at the earliest (never its midnight).
 */
const readKnownAt = <T extends { knownAt: string }>(rows: T[]): T[] =>
  rows.map((r) =>
    /^\d{4}-\d{2}-\d{2}$/.test(r.knownAt)
      ? { ...r, knownAt: zonedInstant(r.knownAt, '23:59', 'America/New_York') }
      : r,
  );

export async function storeSeries(
  db: Db,
  input: { series: string; source: string; points: SeriesPoint[]; fetchedAt: string },
): Promise<number> {
  if (input.points.length === 0) return 0;
  const dates = input.points.map((p) => p.date).sort();
  const key = and(eq(series.series, input.series), eq(series.source, input.source));
  const stored = await db
    .select()
    .from(series)
    .where(and(key, between(series.date, dates[0]!, dates.at(-1)!)));
  const rows = newVintages(
    stored,
    input.points.map((p) => ({
      series: input.series,
      source: input.source,
      date: p.date,
      value: p.value,
      publishedAt: p.publishedAt ?? null,
      fetchedAt: input.fetchedAt,
      knownAt: p.publishedAt ? instant(p.publishedAt) : input.fetchedAt,
    })),
    (a, b) => a.value === b.value,
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(series).values(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}

export async function storeFx(
  db: Db,
  input: { source: string; kind: FxKind; rates: FxRate[]; fetchedAt: string },
): Promise<number> {
  let count = 0;
  const pairs = [...new Set(input.rates.map((r) => r.pair))];
  for (const pair of pairs) {
    const rates = input.rates.filter((r) => r.pair === pair);
    const dates = rates.map((r) => r.date).sort();
    const stored = await db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.pair, pair),
          eq(fxRates.source, input.source),
          eq(fxRates.kind, input.kind),
          between(fxRates.date, dates[0]!, dates.at(-1)!),
        ),
      );
    const rows = newVintages(
      stored,
      rates.map((r) => ({
        pair,
        source: input.source,
        kind: input.kind,
        date: r.date,
        rate: r.rate,
        publishedAt: r.publishedAt ?? null,
        fetchedAt: input.fetchedAt,
        knownAt: r.publishedAt ? instant(r.publishedAt) : input.fetchedAt,
      })),
      (a, b) => a.rate === b.rate,
    );
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(fxRates).values(rows.slice(i, i + CHUNK));
    }
    count += rows.length;
  }
  return count;
}

const ISSUER_FIELDS = ['nav', 'distribution', 'split'] as const;

/**
 * Stores one issuer source's records for one symbol (layer D): a row is added only when the
 * values for (symbol, source, date) differ from the latest stored, so a changed value is a new
 * row and nothing stored is overwritten. A response with the same date twice, or a value that is
 * not a finite number, is refused whole (nothing stored; the caller reports it).
 */
export async function storeIssuerRecords(
  db: Db,
  input: { symbolId: number; source: string; records: IssuerRecord[]; fetchedAt: string },
): Promise<number> {
  if (input.records.length === 0) return 0;
  const dates = input.records.map((r) => r.date).sort();
  if (new Set(dates).size !== dates.length) {
    throw new Error(`${input.source} sent the same date twice for symbol ${input.symbolId}`);
  }
  for (const r of input.records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      throw new Error(`${input.source} sent a date that is not YYYY-MM-DD: "${r.date}"`);
    }
    for (const f of ISSUER_FIELDS) {
      const v = r[f];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
        throw new Error(`${input.source} sent a ${f} that is not a number on ${r.date}`);
      }
    }
  }
  const key = and(
    eq(issuerRecords.symbolId, input.symbolId),
    eq(issuerRecords.source, input.source),
  );
  const stored = await db
    .select()
    .from(issuerRecords)
    .where(and(key, between(issuerRecords.date, dates[0]!, dates.at(-1)!)))
    .orderBy(asc(issuerRecords.fetchedAt));
  const latest = new Map<string, (typeof stored)[number]>();
  for (const row of stored) latest.set(row.date, row);
  const rows = input.records
    .map((r) => ({
      symbolId: input.symbolId,
      source: input.source,
      date: r.date,
      nav: r.nav ?? null,
      distribution: r.distribution ?? null,
      split: r.split ?? null,
      fetchedAt: input.fetchedAt,
    }))
    .filter((row) => {
      const prev = latest.get(row.date);
      return !prev || ISSUER_FIELDS.some((f) => prev[f] !== row[f]);
    });
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(issuerRecords).values(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}

/**
 * A symbol's issuer records per source, the latest stored values per date, oldest date first
 * (`sources`: only these, e.g. the issuer sources that have a role).
 */
export async function issuerRecordsOf(
  db: Db,
  symbolId: number,
  sources?: string[],
): Promise<Map<string, IssuerRecord[]>> {
  const rows = await db
    .select()
    .from(issuerRecords)
    .where(eq(issuerRecords.symbolId, symbolId))
    .orderBy(asc(issuerRecords.date), asc(issuerRecords.fetchedAt));
  const latest = new Map<string, Map<string, IssuerRecord>>();
  for (const r of rows) {
    if (sources && !sources.includes(r.source)) continue;
    const bySource = latest.get(r.source) ?? new Map<string, IssuerRecord>();
    bySource.set(r.date, {
      date: r.date,
      ...(r.nav !== null && { nav: r.nav }),
      ...(r.distribution !== null && { distribution: r.distribution }),
      ...(r.split !== null && { split: r.split }),
    });
    latest.set(r.source, bySource);
  }
  return new Map([...latest].map(([source, byDate]) => [source, [...byDate.values()]]));
}

/** Every vintage of a series from one source, for point-in-time reads (`asOf`). */
export async function seriesPointInTime(db: Db, id: string, source: string): Promise<PointInTime> {
  const rows = await db
    .select({ date: series.date, value: series.value, knownAt: series.knownAt })
    .from(series)
    .where(and(eq(series.series, id), eq(series.source, source)));
  return new PointInTime(readKnownAt(rows));
}

/** Every vintage of an FX pair of one kind from one source, for point-in-time reads. */
export async function fxPointInTime(
  db: Db,
  pair: string,
  source: string,
  kind: FxKind = 'valuation',
): Promise<PointInTime> {
  const rows = await db
    .select({ date: fxRates.date, value: fxRates.rate, knownAt: fxRates.knownAt })
    .from(fxRates)
    .where(and(eq(fxRates.pair, pair), eq(fxRates.source, source), eq(fxRates.kind, kind)));
  return new PointInTime(readKnownAt(rows));
}

export type CanonicalRow = typeof bars.$inferSelect;

/** A symbol's canonical bars (primary or stand-in) up to a date, oldest first. */
export async function canonicalBars(
  db: Db,
  symbolId: number,
  to: TradingDate,
): Promise<CanonicalRow[]> {
  return db
    .select()
    .from(bars)
    .where(and(eq(bars.symbolId, symbolId), lte(bars.date, to)))
    .orderBy(asc(bars.date));
}

/** The latest health grade of a symbol on a date (null symbol: the day overall). */
export async function latestHealth(db: Db, symbolId: number, date: TradingDate) {
  const [row] = await db
    .select()
    .from(dataHealth)
    .where(and(eq(dataHealth.symbolId, symbolId), eq(dataHealth.date, date)))
    .orderBy(desc(dataHealth.id))
    .limit(1);
  return row;
}

/** The stand-in recorded for a symbol and date, if any. */
export async function standInOn(db: Db, symbolId: number, date: TradingDate) {
  const [row] = await db
    .select()
    .from(standIns)
    .where(and(eq(standIns.symbolId, symbolId), eq(standIns.date, date)));
  return row;
}

/** What a run revised in stored raw bars: counts per ticker and field, with the date range. */
export async function revisionsOfRun(db: Db, runId: string) {
  return db
    .select({
      ticker: symbols.ticker,
      source: barRevisions.source,
      field: barRevisions.field,
      count: sql<number>`count(*)`,
      from: sql<string>`min(${barRevisions.date})`,
      to: sql<string>`max(${barRevisions.date})`,
    })
    .from(barRevisions)
    .innerJoin(symbols, eq(symbols.id, barRevisions.symbolId))
    .where(eq(barRevisions.runId, runId))
    .groupBy(symbols.ticker, barRevisions.source, barRevisions.field)
    .orderBy(symbols.ticker, barRevisions.source, barRevisions.field);
}
