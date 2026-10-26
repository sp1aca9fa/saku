// Builds canonical bars from the primary source (with our adjusted series) and runs layers A-C
// over stored data. Daily runs store every result in their window; full-history passes store
// one summary per check plus every non-green result (requirements 04, storage of results).
import type { RawBar, TradingDate } from '@saku/core';
import { totalReturnIndex } from '@saku/core';
import {
  type CheckResult,
  type Sessions,
  adjReturnCheck,
  fxCheck,
  indexCheck,
  layerA,
  layerB,
  leverageCheck,
  unsplit,
} from '@saku/data';
import { type Db, activeSymbols, getSetting, schema } from '@saku/db';
import { and, asc, eq, sql } from 'drizzle-orm';

const CHUNK = 500;
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

export interface VerifyOptions {
  runId: string;
  sessions: Sessions;
  /** Daily: results for dates from `from` on are stored. Full: the whole history is summarized. */
  mode: 'daily' | 'full';
  from?: TradingDate;
  to: TradingDate;
}

export interface VerifySummary {
  results: number;
  stored: number;
  byStatus: Record<string, number>;
}

type Stored = CheckResult & { symbolId: number | null };

async function roles(db: Db, dataKind: string) {
  const rows = await db
    .select()
    .from(schema.sourceRoles)
    .where(eq(schema.sourceRoles.dataKind, dataKind))
    .orderBy(asc(schema.sourceRoles.position));
  return {
    primary: rows.find((r) => r.role === 'primary')?.pluginKey,
    secondaries: rows.filter((r) => r.role === 'secondary').map((r) => r.pluginKey),
    checks: rows.filter((r) => r.role === 'check').map((r) => r.pluginKey),
  };
}

async function rawBars(db: Db, symbolId: number): Promise<Map<string, RawBar[]>> {
  const rows = await db
    .select()
    .from(schema.barsRaw)
    .where(eq(schema.barsRaw.symbolId, symbolId))
    .orderBy(asc(schema.barsRaw.date));
  const bySource = new Map<string, RawBar[]>();
  for (const r of rows) {
    const list = bySource.get(r.source) ?? [];
    list.push({
      date: r.date,
      ...(r.open !== null && { open: r.open }),
      ...(r.high !== null && { high: r.high }),
      ...(r.low !== null && { low: r.low }),
      close: r.close,
      closeIsSplitAdjusted: r.closeIsSplitAdjusted,
      ...(r.volume !== null && { volume: r.volume }),
      divCash: r.divCash,
      splitFactor: r.splitFactor,
      ...(r.providerAdjClose !== null && { providerAdjClose: r.providerAdjClose }),
    });
    bySource.set(r.source, list);
  }
  return bySource;
}

/** The latest known value per date of a series from one source. */
async function latestSeries(db: Db, id: string, source: string) {
  const rows = await db
    .select()
    .from(schema.series)
    .where(and(eq(schema.series.series, id), eq(schema.series.source, source)))
    .orderBy(asc(schema.series.date), asc(schema.series.knownAt), asc(schema.series.fetchedAt));
  const latest = new Map<string, number>();
  for (const r of rows) latest.set(r.date, r.value);
  return [...latest].map(([date, value]) => ({ date, value }));
}

async function latestFx(db: Db, pair: string, source: string) {
  const rows = await db
    .select()
    .from(schema.fxRates)
    .where(
      and(
        eq(schema.fxRates.pair, pair),
        eq(schema.fxRates.source, source),
        eq(schema.fxRates.kind, 'valuation'),
      ),
    )
    .orderBy(asc(schema.fxRates.date), asc(schema.fxRates.knownAt), asc(schema.fxRates.fetchedAt));
  const latest = new Map<string, number>();
  for (const r of rows) latest.set(r.date, r.rate);
  return [...latest].map(([date, rate]) => ({ date, rate }));
}

/** Writes the primary's bars with our adjusted series as the canonical bars. */
async function writeCanonical(db: Db, symbolId: number, source: string, bars: RawBar[]) {
  const adj = totalReturnIndex(bars);
  const rows = bars.map((b, i) => ({
    symbolId,
    date: b.date,
    open: b.open ?? null,
    high: b.high ?? null,
    low: b.low ?? null,
    close: b.close,
    volume: b.volume ?? null,
    divCash: b.divCash,
    splitFactor: b.splitFactor,
    adjClose: adj[i]!,
    source,
    standIn: false,
  }));
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await tx
        .insert(schema.bars)
        .values(chunk)
        .onConflictDoUpdate({
          target: [schema.bars.symbolId, schema.bars.date],
          set: {
            open: sqlExcluded('open'),
            high: sqlExcluded('high'),
            low: sqlExcluded('low'),
            close: sqlExcluded('close'),
            volume: sqlExcluded('volume'),
            divCash: sqlExcluded('div_cash'),
            splitFactor: sqlExcluded('split_factor'),
            adjClose: sqlExcluded('adj_close'),
            source: sqlExcluded('source'),
            standIn: sqlExcluded('stand_in'),
          },
        });
    }
  });
}

export async function verify(db: Db, o: VerifyOptions): Promise<VerifySummary> {
  const results: Stored[] = [];
  const bars = await roles(db, 'bars');
  if (!bars.primary) throw new Error('No primary bar source is set (source_roles).');
  const symbols = await activeSymbols(db);
  const raw = new Map<number, Map<string, RawBar[]>>();
  for (const s of symbols) raw.set(s.id, await rawBars(db, s.id));

  const seriesRoles = await roles(db, 'series');
  for (const s of symbols) {
    const bySource = raw.get(s.id)!;
    const primary = (bySource.get(bars.primary) ?? []).filter((b) => b.date <= o.to);
    const add = (rs: CheckResult[]) => results.push(...rs.map((r) => ({ ...r, symbolId: s.id })));
    if (primary.length > 0) await writeCanonical(db, s.id, bars.primary, primary);

    for (const [source, list] of bySource) {
      const own = list.filter((b) => b.date <= o.to);
      add(
        layerA(own, {
          source,
          primary: source === bars.primary,
          leverage: s.leverageFactor,
          sessions: o.sessions,
          ...(source === bars.primary && s.inceptionDate && { from: s.inceptionDate }),
        }),
      );
      if (own.some((b) => b.providerAdjClose !== undefined)) {
        add(adjReturnCheck(primary, unsplit(own), source));
      }
    }
    for (const source of [...bars.secondaries, ...bars.checks]) {
      const other = bySource.get(source);
      if (!other) continue;
      const secondary = unsplit(other.filter((b) => b.date <= o.to));
      // Compare only where the secondary has history (a plan's limit is not a missing bar).
      const start = secondary[0]?.date;
      if (start)
        add(
          layerB(
            primary.filter((b) => b.date >= start),
            secondary,
            source,
          ),
        );
    }
    if (s.underlyingSymbolId !== null) {
      const u = raw.get(s.underlyingSymbolId)?.get(bars.primary) ?? [];
      add(leverageCheck(primary, u, s.leverageFactor));
    }
    if (s.indexSeries && seriesRoles.primary) {
      add(indexCheck(primary, await latestSeries(db, s.indexSeries, seriesRoles.primary)));
    }
  }

  const base = await getSetting(db, 'base_currency');
  const fx = await roles(db, 'fx');
  if (base && base !== 'USD' && fx.primary) {
    const pair = `USD${base}`;
    const primary = await latestFx(db, pair, fx.primary);
    for (const source of fx.secondaries) {
      const rs = fxCheck(primary, await latestFx(db, pair, source), source);
      results.push(...rs.map((r) => ({ ...r, symbolId: null })));
    }
  }

  const inWindow = results.filter((r) => r.date <= o.to && (!o.from || r.date >= o.from));
  const byStatus: Record<string, number> = {};
  for (const r of inWindow) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const keep = o.mode === 'daily' ? inWindow : inWindow.filter((r) => r.status !== 'green');
  await storeResults(db, o.runId, keep);
  if (o.mode === 'full') await storeSummaries(db, o.runId, inWindow);
  return { results: inWindow.length, stored: keep.length, byStatus };
}

async function storeResults(db: Db, runId: string, rs: Stored[]) {
  const rows = rs.map((r) => ({
    runId,
    layer: r.layer,
    checkName: r.check,
    symbolId: r.symbolId,
    source: r.source ?? null,
    date: r.date,
    status: r.status,
    observed: Number.isFinite(r.observed) ? r.observed! : null,
    expected: Number.isFinite(r.expected) ? r.expected! : null,
    tolerance: r.tolerance ?? null,
    message: r.message ?? null,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(schema.checkResults).values(rows.slice(i, i + CHUNK));
  }
}

async function storeSummaries(db: Db, runId: string, rs: Stored[]) {
  const groups = new Map<
    string,
    {
      layer: CheckResult['layer'];
      check: string;
      checked: number;
      passed: number;
      max: number | null;
    }
  >();
  for (const r of rs) {
    const key = `${r.layer}|${r.check}`;
    const g = groups.get(key) ?? {
      layer: r.layer,
      check: r.check,
      checked: 0,
      passed: 0,
      max: null,
    };
    g.checked++;
    if (r.status === 'green') g.passed++;
    if (r.deviation !== undefined && (g.max === null || r.deviation > g.max)) g.max = r.deviation;
    groups.set(key, g);
  }
  if (groups.size === 0) return;
  await db.insert(schema.checkSummaries).values(
    [...groups.values()].map((g) => ({
      runId,
      layer: g.layer,
      checkName: g.check,
      checked: g.checked,
      passed: g.passed,
      maxDeviation: g.max,
    })),
  );
}
