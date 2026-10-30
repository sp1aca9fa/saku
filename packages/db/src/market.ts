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
  type Vintage,
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
  fxWithdrawals,
  issuerRecords,
  readjustments,
  series,
  seriesWithdrawals,
  standIns,
  symbols,
} from './schema';

/** Rows per insert statement (SQLite caps bound variables per statement). */
const CHUNK = 500;

/**
 * Re-adjustment detection (requirements 04: provider adjusted values keep the latest snapshot
 * plus one re-adjustment event per factor; they are for verification only, and raw fields are
 * compared exactly in the revision log, never with this tolerance).
 *
 * Rule: a change of a provider's adjusted close whose relative size is within the source's
 * declared rounding (`PluginInfo.adjCloseRounding`, relative) is rounding, not a re-adjustment:
 * the new value is stored (latest snapshot), no event is recorded. The same tolerance decides
 * whether changed dates share one factor. A source that declares none gets the default, 1e-9
 * (double-precision recomputation; one dividend is orders of magnitude larger).
 */
export const DEFAULT_ADJ_CLOSE_ROUNDING = 1e-9;

/**
 * The largest rounding a source may declare: it must stay below the smallest real
 * re-adjustment, a dividend relative to the price (a 0.01 distribution on a 500 share is 2e-5).
 */
export const MAX_ADJ_CLOSE_ROUNDING = 1e-5;

/** Refuses a rounding that is not a number in (0, MAX_ADJ_CLOSE_ROUNDING]. */
export function checkAdjCloseRounding(rounding: number, owner: string): void {
  if (!Number.isFinite(rounding) || rounding <= 0 || rounding > MAX_ADJ_CLOSE_ROUNDING) {
    throw new Error(
      `${owner}: adjCloseRounding ${rounding} is not above 0 and at most ${MAX_ADJ_CLOSE_ROUNDING}.`,
    );
  }
}

const sameFactor = (a: number, b: number, rounding: number) =>
  Math.abs(a - b) <= rounding * Math.abs(b);

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
 * adjusted closes are stored (latest snapshot) and grouped into one `readjustments` event per
 * factor; a change within the source's rounding (`adjCloseRounding`, default
 * DEFAULT_ADJ_CLOSE_ROUNDING) of the stored value is rounding and makes no event.
 */
export async function storeRawBars(
  db: Db,
  input: {
    symbolId: number;
    source: string;
    bars: RawBar[];
    runId: string | null;
    fetchedAt: string;
    /** The source's declared relative rounding of its adjusted closes. */
    adjCloseRounding?: number;
  },
): Promise<RawBarsResult> {
  const rounding = input.adjCloseRounding ?? DEFAULT_ADJ_CLOSE_ROUNDING;
  checkAdjCloseRounding(rounding, input.source);
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
        const factor = newAdj / oldAdj;
        // Rounding noise: the new value is stored below, but it is no re-adjustment.
        if (!sameFactor(factor, 1, rounding)) ratios.push({ date: bar.date, factor });
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
    const groups = groupFactors(ratios, rounding);
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

/**
 * Consecutive changed dates sharing one factor form one re-adjustment event: each date is compared
 * with the event's factor (its first date's ratio), within `rounding` relative. No chaining from
 * date to date, so small steps that add up to more than the rounding start a new event.
 */
export function groupFactors(
  ratios: { date: string; factor: number }[],
  rounding = DEFAULT_ADJ_CLOSE_ROUNDING,
): { from: string; to: string; factor: number }[] {
  const groups: { from: string; to: string; factor: number }[] = [];
  for (const r of ratios) {
    const last = groups.at(-1);
    if (last && sameFactor(r.factor, last.factor, rounding)) {
      last.to = r.date;
    } else {
      groups.push({ from: r.date, to: r.date, factor: r.factor });
    }
  }
  return groups;
}

/**
 * What storing series values or FX rates did. Every row is appended; a stored row is never
 * changed (its old value stays readable as known until the new row's `known_at`).
 */
export interface StoredValues {
  /** Rows for a date and publication time (or, with none given, a date) not stored before. */
  inserted: number;
  /**
   * Dates (per series or pair) whose latest stored value for the same publication time (or, with
   * none given, the same date) the source now reports differently: stored as a new row known
   * from its fetch (a restatement could not have been known earlier; spec 2026-10-30
   * restated-vintage), reported like a bar revision. A new publication time is a new vintage,
   * not a revision, known from its publication time.
   *
   * A newly stored withdrawal (the source no longer has a value for the date from its
   * publication time, or with none given, from the fetch) is always listed here too, so it is
   * reported like a revised value and never silent (spec 2026-10-30 withdrawn-values).
   */
  revised: { item: string; date: TradingDate }[];
  /** The newly stored withdrawals (each also in `revised`). */
  withdrawn: { item: string; date: TradingDate }[];
}

/** A stored or incoming vintage: a value, or a withdrawal (`value` null). */
interface VintageRow {
  date: string;
  publishedAt: string | null;
  fetchedAt: string;
  knownAt: string;
  value: number | null;
}

/**
 * Keeps a vintage only when it is new: no stored row for that date and publication time (or,
 * with none given, for that date) yet, or the latest stored one (value or withdrawal, by fetch
 * time) says something else (a revision). A withdrawal is the same as a stored withdrawal for
 * the same key, so a refetch stores nothing (idempotent). Refuses a value and a withdrawal for
 * the same date and publication time in one response (which one holds would be a guess).
 *
 * `known_at` (spec 2026-10-30 restated-vintage; requirements 04, no look-ahead): a vintage first
 * seen is known from its publication time (the source's history), as given in `incoming`; a
 * restatement of a stored vintage (same key, another value or a withdrawal) only from the later
 * of that time and its fetch, so a read before our fetch keeps the original.
 */
function newVintages<T extends VintageRow>(
  stored: T[],
  incoming: T[],
  item: string,
): { values: T[]; withdrawals: T[]; result: Omit<StoredValues, 'inserted'> & { new: number } } {
  const key = (r: T) => `${r.date}|${r.publishedAt ?? ''}`;
  const seen = new Map<string, T>();
  for (const row of incoming) {
    const other = seen.get(key(row));
    if (other && (other.value === null) !== (row.value === null)) {
      throw new Error(
        `${item}: a value and a withdrawal for ${row.date} with the same publication time`,
      );
    }
    seen.set(key(row), row);
  }
  const latest = new Map<string, T>();
  for (const row of [...stored].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))) {
    latest.set(key(row), row);
  }
  const values: T[] = [];
  const withdrawals: T[] = [];
  const revised = new Set<TradingDate>();
  const withdrawn = new Set<TradingDate>();
  let fresh = 0;
  for (let row of incoming) {
    const prev = latest.get(key(row));
    if (prev && prev.value === row.value) continue;
    // Both UTC ISO text (`instant`, and the jobs' fetch time), so string order is time order.
    if (prev && row.fetchedAt > row.knownAt) row = { ...row, knownAt: row.fetchedAt };
    if (row.value === null) {
      withdrawals.push(row);
      withdrawn.add(row.date);
      revised.add(row.date);
      continue;
    }
    values.push(row);
    if (prev) revised.add(row.date);
    else fresh++;
  }
  const list = (dates: Set<TradingDate>) => [...dates].sort().map((date) => ({ item, date }));
  return {
    values,
    withdrawals,
    result: { new: fresh, revised: list(revised), withdrawn: list(withdrawn) },
  };
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

/**
 * Stores a series' vintages: values in `series`, withdrawals in `series_withdrawals` (both
 * append-only; see `newVintages` for what counts as new).
 */
export async function storeSeries(
  db: Db,
  input: { series: string; source: string; points: SeriesPoint[]; fetchedAt: string },
): Promise<StoredValues> {
  if (input.points.length === 0) return { inserted: 0, revised: [], withdrawn: [] };
  const dates = input.points.map((p) => p.date).sort();
  const range = [dates[0]!, dates.at(-1)!] as const;
  const common = { series: input.series, source: input.source };
  const stored = [
    ...(await db
      .select()
      .from(series)
      .where(
        and(
          eq(series.series, input.series),
          eq(series.source, input.source),
          between(series.date, ...range),
        ),
      )),
    ...(
      await db
        .select()
        .from(seriesWithdrawals)
        .where(
          and(
            eq(seriesWithdrawals.series, input.series),
            eq(seriesWithdrawals.source, input.source),
            between(seriesWithdrawals.date, ...range),
          ),
        )
    ).map((r) => ({ ...r, value: null })),
  ];
  const { values, withdrawals, result } = newVintages(
    stored,
    input.points.map((p) => ({
      ...common,
      date: p.date,
      value: p.withdrawn ? null : p.value,
      publishedAt: p.publishedAt ?? null,
      fetchedAt: input.fetchedAt,
      knownAt: p.publishedAt ? instant(p.publishedAt) : input.fetchedAt,
    })),
    input.series,
  );
  const rows = values.map((r) => ({ ...r, value: r.value! }));
  const gone = withdrawals.map(({ value: _, ...r }) => r);
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.insert(series).values(rows.slice(i, i + CHUNK));
    }
    for (let i = 0; i < gone.length; i += CHUNK) {
      await tx.insert(seriesWithdrawals).values(gone.slice(i, i + CHUNK));
    }
  });
  return { inserted: result.new, revised: result.revised, withdrawn: result.withdrawn };
}

export async function storeFx(
  db: Db,
  input: { source: string; kind: FxKind; rates: FxRate[]; fetchedAt: string },
): Promise<StoredValues> {
  const out: StoredValues = { inserted: 0, revised: [], withdrawn: [] };
  const pairs = [...new Set(input.rates.map((r) => r.pair))];
  for (const pair of pairs) {
    const rates = input.rates.filter((r) => r.pair === pair);
    const dates = rates.map((r) => r.date).sort();
    const range = [dates[0]!, dates.at(-1)!] as const;
    const common = { pair, source: input.source, kind: input.kind };
    const stored = [
      ...(
        await db
          .select()
          .from(fxRates)
          .where(
            and(
              eq(fxRates.pair, pair),
              eq(fxRates.source, input.source),
              eq(fxRates.kind, input.kind),
              between(fxRates.date, ...range),
            ),
          )
      ).map(({ rate, ...r }) => ({ ...r, value: rate as number | null })),
      ...(
        await db
          .select()
          .from(fxWithdrawals)
          .where(
            and(
              eq(fxWithdrawals.pair, pair),
              eq(fxWithdrawals.source, input.source),
              eq(fxWithdrawals.kind, input.kind),
              between(fxWithdrawals.date, ...range),
            ),
          )
      ).map((r) => ({ ...r, value: null })),
    ];
    const { values, withdrawals, result } = newVintages(
      stored,
      rates.map((r) => ({
        ...common,
        date: r.date,
        value: r.withdrawn ? null : r.rate,
        publishedAt: r.publishedAt ?? null,
        fetchedAt: input.fetchedAt,
        knownAt: r.publishedAt ? instant(r.publishedAt) : input.fetchedAt,
      })),
      pair,
    );
    const rows = values.map(({ value, ...r }) => ({ ...r, rate: value! }));
    const gone = withdrawals.map(({ value: _, ...r }) => r);
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.insert(fxRates).values(rows.slice(i, i + CHUNK));
      }
      for (let i = 0; i < gone.length; i += CHUNK) {
        await tx.insert(fxWithdrawals).values(gone.slice(i, i + CHUNK));
      }
    });
    out.inserted += result.new;
    out.revised.push(...result.revised);
    out.withdrawn.push(...result.withdrawn);
  }
  return out;
}

const ISSUER_FIELDS = ['nav', 'distribution', 'split'] as const;
/** Every stored issuer value (a change in any one is a new row). */
const ISSUER_VALUES = [...ISSUER_FIELDS, 'currency'] as const;

/**
 * Stores one issuer source's records for one symbol (layer D): a row is added only when the
 * values for (symbol, source, date) differ from the latest stored, so a changed value is a new
 * row and nothing stored is overwritten. A response with the same date twice, a value that is
 * not a finite number, or a NAV without its currency (ISO 4217) is refused whole (nothing stored;
 * the caller reports it).
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
    // A NAV in an unknown currency could not be compared: refused, never assumed.
    if (r.currency !== undefined && !/^[A-Z]{3}$/.test(r.currency)) {
      throw new Error(`${input.source} sent a currency that is not ISO 4217 on ${r.date}`);
    }
    if (r.nav !== undefined && r.currency === undefined) {
      throw new Error(`${input.source} sent a NAV without its currency on ${r.date}`);
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
      currency: r.currency ?? null,
      distribution: r.distribution ?? null,
      split: r.split ?? null,
      fetchedAt: input.fetchedAt,
    }))
    .filter((row) => {
      const prev = latest.get(row.date);
      return !prev || ISSUER_VALUES.some((f) => prev[f] !== row[f]);
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
      ...(r.currency !== null && { currency: r.currency }),
      ...(r.distribution !== null && { distribution: r.distribution }),
      ...(r.split !== null && { split: r.split }),
    });
    latest.set(r.source, bySource);
  }
  return new Map([...latest].map(([source, byDate]) => [source, [...byDate.values()]]));
}

interface StoredVintage {
  date: string;
  publishedAt: string | null;
  knownAt: string;
  fetchedAt: string;
}

/**
 * Values and withdrawals as point-in-time versions, in fetch order (PointInTime keeps that order
 * for equal vintage and known times, so a later fetch's restatement of the same vintage wins).
 *
 * Vintage time (spec 2026-10-30 restated-vintage): rows without `published_at` use their own
 * `known_at` (their fetch). Rows with one share the vintage of every row with the same date and
 * `published_at` text (the key `newVintages` stores by), and its time is the earliest `known_at`
 * among them: the first-seen row's, which is its publication time (later restatements are known
 * at or after it). Taken from the stored, already normalized `known_at` rather than by parsing
 * `published_at` again, so older rows (date-only, read as known at the day end) rank as they
 * are read.
 */
function vintages(
  values: (StoredVintage & { value: number })[],
  withdrawals: StoredVintage[],
): Vintage[] {
  const all = readKnownAt([
    ...values.map((r) => ({ ...r, withdrawn: false as const })),
    ...withdrawals.map((r) => ({ ...r, withdrawn: true as const, value: undefined })),
  ]).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const key = (r: StoredVintage) => `${r.date}|${r.publishedAt}`;
  const vintageAt = new Map<string, string>();
  for (const r of all) {
    if (r.publishedAt === null) continue;
    const at = vintageAt.get(key(r));
    if (at === undefined || r.knownAt < at) vintageAt.set(key(r), r.knownAt);
  }
  return all.map((r): Vintage => {
    const v = r.publishedAt === null ? r.knownAt : vintageAt.get(key(r))!;
    return r.withdrawn
      ? { date: r.date, withdrawn: true, knownAt: r.knownAt, vintageAt: v }
      : { date: r.date, value: r.value, knownAt: r.knownAt, vintageAt: v };
  });
}

/** Every vintage of a series from one source (withdrawals included), for `asOf`. */
export async function seriesPointInTime(db: Db, id: string, source: string): Promise<PointInTime> {
  const cols = {
    date: series.date,
    publishedAt: series.publishedAt,
    knownAt: series.knownAt,
    fetchedAt: series.fetchedAt,
  };
  const values = await db
    .select({ ...cols, value: series.value })
    .from(series)
    .where(and(eq(series.series, id), eq(series.source, source)));
  const withdrawals = await db
    .select({
      date: seriesWithdrawals.date,
      publishedAt: seriesWithdrawals.publishedAt,
      knownAt: seriesWithdrawals.knownAt,
      fetchedAt: seriesWithdrawals.fetchedAt,
    })
    .from(seriesWithdrawals)
    .where(and(eq(seriesWithdrawals.series, id), eq(seriesWithdrawals.source, source)));
  return new PointInTime(vintages(values, withdrawals));
}

/** Every vintage of an FX pair of one kind from one source (withdrawals included), for `asOf`. */
export async function fxPointInTime(
  db: Db,
  pair: string,
  source: string,
  kind: FxKind = 'valuation',
): Promise<PointInTime> {
  const values = await db
    .select({
      date: fxRates.date,
      value: fxRates.rate,
      publishedAt: fxRates.publishedAt,
      knownAt: fxRates.knownAt,
      fetchedAt: fxRates.fetchedAt,
    })
    .from(fxRates)
    .where(and(eq(fxRates.pair, pair), eq(fxRates.source, source), eq(fxRates.kind, kind)));
  const withdrawals = await db
    .select({
      date: fxWithdrawals.date,
      publishedAt: fxWithdrawals.publishedAt,
      knownAt: fxWithdrawals.knownAt,
      fetchedAt: fxWithdrawals.fetchedAt,
    })
    .from(fxWithdrawals)
    .where(
      and(
        eq(fxWithdrawals.pair, pair),
        eq(fxWithdrawals.source, source),
        eq(fxWithdrawals.kind, kind),
      ),
    );
  return new PointInTime(vintages(values, withdrawals));
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
