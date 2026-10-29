// Builds canonical bars from the primary source (a secondary's bar standing in where the primary
// has none and the stand-in rule allows it), with our adjusted series, runs layers A-C over
// stored data, layer D (issuer reconciliation, advisory: yellow at most) for every symbol with
// records from an issuer source that has a role, and grades each symbol and day (data health).
// Daily runs store every result and health row in their window; full-history passes store one
// summary per check plus every non-green result and symbol health row (requirements 04), the
// overall health row of every date they graded and each symbol's graded date range
// (`health_coverage`). A symbol without any primary bar is graded too: red `primary_missing`
// (04 severity rules: primary data missing with no usable stand-in; a stand-in needs the
// primary's history around it).
import type { HealthStatus, RawBar, TradingDate } from '@saku/core';
import { totalReturnIndex } from '@saku/core';
import {
  type CheckResult,
  type DayHealth,
  type Sessions,
  TOLERANCE,
  adjReturnCheck,
  fxCheck,
  indexCheck,
  layerA,
  layerB,
  layerD,
  leverageCheck,
  seriesHealth,
  standIns,
  symbolHealth,
  unsplit,
  worst,
} from '@saku/data';
import {
  type Db,
  activeSymbols,
  getSetting,
  issuerRecordsOf,
  navTolerances,
  schema,
  unmatchedTolerances,
  seriesPointInTime,
} from '@saku/db';
import { cashSeries } from './cash';
import { and, asc, eq, gte, isNull, lte, min, sql } from 'drizzle-orm';

const CHUNK = 500;
const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

export interface VerifyOptions {
  runId: string;
  sessions: Sessions;
  /** Daily: results for dates from `from` on are stored. Full: the whole history is summarized. */
  mode: 'daily' | 'full';
  from?: TradingDate;
  to: TradingDate;
  /** The cash series' calendar (business days); without it, its freshness is not checked. */
  seriesSessions?: Sessions;
  /** When the run looks (only values known by then count). */
  now?: Date;
  /**
   * Per issuer source the run used: the tickers it `supports`, and those its fetch failed or
   * stopped for this run (layer D grades a fund with no NAV stored from them yellow). Given, a
   * source with a role but no entry is a plug-in that is not loaded: unavailable for the day and
   * never fresh for the funds it has records for. Not given (a direct call): not judged.
   */
  issuers?: IssuerAvailability[];
}

export interface IssuerAvailability {
  source: string;
  supported: string[];
  unavailable: string[];
}

export interface VerifySummary {
  results: number;
  stored: number;
  byStatus: Record<string, number>;
  /** Overall data health on `to`. */
  health: HealthStatus;
  /** What was not green overall on `to` (symbols, FX and series checks). */
  reasons: string[];
  standIns: number;
  /** Stand-ins the primary has now replaced, off by more than the layer B close tolerance. */
  standInsOff: { ticker: string; date: TradingDate; deviation: number }[];
  /** The stored `issuer_nav_tolerance` does not parse (layer D observes only; yellow). */
  toleranceInvalid: boolean;
  /** `issuer_nav_tolerance` keys that name no active symbol. */
  toleranceUnmatched: string[];
}

type CanonicalBar = RawBar & { source: string; standIn: boolean };

type Stored = CheckResult & { symbolId: number | null };

/** The cash series' freshness reason on a run's date: `<series>:missing@<source>` or `stale(n)`. */
export function cashReason(
  source: { series: string; source: string } | undefined,
  behind: number | undefined,
): string {
  const what = behind === undefined ? 'missing' : `stale(${behind})`;
  return `${source?.series ?? 'cash'}:${what}@${source?.source ?? 'none'}`;
}

/** The days behind in a cash freshness reason (undefined: missing), or null for another code. */
export function parseCashReason(code: string): { behind: number | undefined } | null {
  const m = /^[^:@\s]+:(missing|stale\((\d+)\))@[^@\s]+$/.exec(code);
  if (!m) return null;
  return { behind: m[2] === undefined ? undefined : Number(m[2]) };
}

/** The first canonical bar of each symbol (where its graded history starts). */
async function firstCanonical(db: Db): Promise<Map<number, TradingDate>> {
  const rows = await db
    .select({ symbolId: schema.bars.symbolId, first: min(schema.bars.date) })
    .from(schema.bars)
    .groupBy(schema.bars.symbolId);
  return new Map(rows.flatMap((r) => (r.first ? [[r.symbolId, r.first] as const] : [])));
}

/**
 * The sessions a symbol without any primary bar is graded red on: from its first canonical bar,
 * else its inception date, to the run's date (the later of that and the window's start); with
 * neither known, the run's date only. Never before the calendar starts.
 */
function missingPrimaryDates(
  sessions: Sessions,
  start: TradingDate | undefined,
  o: { from?: TradingDate; to: TradingDate },
): TradingDate[] {
  if (start === undefined) return sessions.isSession(o.to) ? [o.to] : [];
  let from = start;
  if (o.from && o.from > from) from = o.from;
  if (sessions.calendar.validFrom > from) from = sessions.calendar.validFrom;
  return from > o.to ? [] : sessions.between(from, o.to);
}

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

/** Writes the canonical bars (primary or stand-in) with our adjusted series and health status. */
async function writeCanonical(
  db: Db,
  symbolId: number,
  bars: CanonicalBar[],
  health: Map<TradingDate, DayHealth>,
) {
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
    source: b.source,
    standIn: b.standIn,
    status: health.get(b.date)?.status ?? null,
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
            status: sqlExcluded('status'),
          },
        });
    }
  });
}

/**
 * Sets the health status of a symbol's stored canonical bars on `dates` (a run of sessions),
 * leaving their values as they are: for a symbol graded without rebuilding its bars (no primary
 * bar), so a bar's status (what the forward step reads) never stays greener than the grade.
 */
async function markCanonical(db: Db, symbolId: number, dates: TradingDate[], status: HealthStatus) {
  if (dates.length === 0) return;
  await db
    .update(schema.bars)
    .set({ status })
    .where(
      and(
        eq(schema.bars.symbolId, symbolId),
        gte(schema.bars.date, dates[0]!),
        lte(schema.bars.date, dates.at(-1)!),
      ),
    );
}

/**
 * Records new stand-ins (a later run may still change an unresolved one) and resolves those the
 * primary has now replaced. Returns the resolved ones off by more than the close tolerance.
 */
async function recordStandIns(
  db: Db,
  runId: string,
  symbolId: number,
  used: { date: TradingDate; source: string; bar: RawBar; band: number; basis: string }[],
  primary: Map<TradingDate, RawBar>,
): Promise<{ date: TradingDate; deviation: number }[]> {
  for (const s of used) {
    await db
      .insert(schema.standIns)
      .values({
        symbolId,
        date: s.date,
        source: s.source,
        close: s.bar.close,
        band: s.band,
        basis: s.basis,
        runId,
      })
      .onConflictDoUpdate({
        target: [schema.standIns.symbolId, schema.standIns.date],
        set: { source: s.source, close: s.bar.close, band: s.band, basis: s.basis },
        setWhere: isNull(schema.standIns.resolvedAt),
      });
  }
  const open = await db
    .select()
    .from(schema.standIns)
    .where(and(eq(schema.standIns.symbolId, symbolId), isNull(schema.standIns.resolvedAt)));
  const off: { date: TradingDate; deviation: number }[] = [];
  for (const row of open) {
    const p = primary.get(row.date);
    if (!p) continue;
    const deviation = Math.abs(p.close / row.close - 1);
    await db
      .update(schema.standIns)
      .set({
        primaryClose: p.close,
        deviation,
        resolvedAt: new Date().toISOString(),
        resolvedRunId: runId,
      })
      .where(and(eq(schema.standIns.symbolId, symbolId), eq(schema.standIns.date, row.date)));
    if (deviation > TOLERANCE.close) off.push({ date: row.date, deviation });
  }
  return off;
}

export async function verify(db: Db, o: VerifyOptions): Promise<VerifySummary> {
  const results: Stored[] = [];
  const bars = await roles(db, 'bars');
  if (!bars.primary) throw new Error('No primary bar source is set (source_roles).');
  // Underlyings first: a leveraged fund's stand-in is checked against its underlying's bars.
  const symbols = (await activeSymbols(db)).sort(
    (a, b) => Number(a.underlyingSymbolId !== null) - Number(b.underlyingSymbolId !== null),
  );
  const raw = new Map<number, Map<string, RawBar[]>>();
  for (const s of symbols) raw.set(s.id, await rawBars(db, s.id));
  const canonical = new Map<number, CanonicalBar[]>();
  const healthRows: { symbolId: number | null; date: TradingDate; health: DayHealth }[] = [];
  const overall = new Map<TradingDate, DayHealth>();
  const grade = (date: TradingDate, status: HealthStatus, reason: string) => {
    const h = overall.get(date) ?? { status: 'green' as HealthStatus, reasons: [] };
    h.status = worst(h.status, status);
    if (status !== 'green' && !h.reasons.includes(reason)) h.reasons.push(reason);
    overall.set(date, h);
  };
  let standInCount = 0;
  const standInsOff: VerifySummary['standInsOff'] = [];
  const firstBars = await firstCanonical(db);
  /** Full passes: the dates graded per symbol (a missing non-green row is green only inside). */
  const coverage: { symbolId: number; fromDate: TradingDate; toDate: TradingDate }[] = [];
  const covered = (symbolId: number, dates: TradingDate[]) => {
    const inside = dates.filter((d) => d <= o.to && (!o.from || d >= o.from));
    if (inside.length > 0)
      coverage.push({ symbolId, fromDate: inside[0]!, toDate: inside.at(-1)! });
  };

  const seriesRoles = await roles(db, 'series');
  // Layer D: every issuer source with a role (they are all check sources).
  const issuer = await roles(db, 'issuer');
  const issuerSources = [
    ...(issuer.primary ? [issuer.primary] : []),
    ...issuer.secondaries,
    ...issuer.checks,
  ];
  const nav = await navTolerances(db);
  const availability = new Map((o.issuers ?? []).map((a) => [a.source, a]));
  const notLoaded = (source: string) => o.issuers !== undefined && !availability.has(source);
  for (const s of symbols) {
    const bySource = raw.get(s.id)!;
    // A primary that delivers split-adjusted closes is put back on the raw basis too.
    const primary = unsplit((bySource.get(bars.primary) ?? []).filter((b) => b.date <= o.to));
    const own: CheckResult[] = [];
    const add = (rs: CheckResult[]) => own.push(...rs);
    const index =
      s.indexSeries && seriesRoles.primary
        ? await latestSeries(db, s.indexSeries, seriesRoles.primary)
        : undefined;

    for (const [source, list] of bySource) {
      const mine = list.filter((b) => b.date <= o.to);
      add(
        layerA(mine, {
          source,
          primary: source === bars.primary,
          leverage: s.leverageFactor,
          sessions: o.sessions,
          ...(source === bars.primary && s.inceptionDate && { from: s.inceptionDate }),
        }),
      );
      if (mine.some((b) => b.providerAdjClose !== undefined)) {
        add(adjReturnCheck(primary, unsplit(mine), source));
      }
    }
    const secondaries: [string, RawBar[]][] = [];
    for (const source of [...bars.secondaries, ...bars.checks]) {
      const other = bySource.get(source);
      if (!other) continue;
      const secondary = unsplit(other.filter((b) => b.date <= o.to));
      if (bars.secondaries.includes(source)) secondaries.push([source, secondary]);
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
      const u = unsplit(
        (raw.get(s.underlyingSymbolId)?.get(bars.primary) ?? []).filter((b) => b.date <= o.to),
      );
      add(leverageCheck(primary, u, s.leverageFactor));
    }
    if (index) add(indexCheck(primary, index));
    if (issuerSources.length > 0) {
      const tolerance = Object.hasOwn(nav.tolerances, s.ticker)
        ? nav.tolerances[s.ticker]
        : undefined;
      const stored = await issuerRecordsOf(db, s.id, issuerSources);
      // Every source with a role, also one with nothing stored for the fund (it may have failed).
      for (const source of issuerSources) {
        const a = availability.get(source);
        add(
          layerD(primary, stored.get(source) ?? [], {
            source,
            currency: s.currency,
            sessions: o.sessions,
            to: o.to,
            ...(tolerance !== undefined && { tolerance }),
            ...(nav.invalid && { toleranceInvalid: true }),
            ...(a?.supported.includes(s.ticker) && { supported: true }),
            ...(a?.unavailable.includes(s.ticker) && { unavailable: true }),
            ...(notLoaded(source) && { notLoaded: true }),
          }),
        );
      }
    }
    results.push(...own.map((r) => ({ ...r, symbolId: s.id })));
    if (primary.length === 0) {
      // No primary bar at all (a new primary without this symbol's history, or none fetched yet):
      // red on its dates, never left out (left out, the day would read green without it).
      const missing = missingPrimaryDates(
        o.sessions,
        firstBars.get(s.id) ?? s.inceptionDate ?? undefined,
        o,
      );
      for (const date of missing) {
        healthRows.push({
          symbolId: s.id,
          date,
          health: { status: 'red', reasons: ['primary_missing'] },
        });
        grade(date, 'red', s.ticker);
      }
      await markCanonical(db, s.id, missing, 'red');
      covered(s.id, missing);
      continue;
    }

    const si = standIns({
      primary,
      secondaries,
      sessions: o.sessions,
      leverage: s.leverageFactor,
      ...(s.underlyingSymbolId !== null && {
        underlying: canonical.get(s.underlyingSymbolId) ?? [],
      }),
      ...(index && { index }),
      to: o.to,
    });
    const merged: CanonicalBar[] = [
      ...primary.map((b) => ({ ...b, source: bars.primary!, standIn: false })),
      ...si.standIns.map((x) => ({ ...x.bar, source: x.source, standIn: true })),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));
    canonical.set(s.id, merged);

    const dates = o.sessions.between(primary[0]!.date, o.to);
    const sources = new Map<TradingDate, number>();
    for (const list of [primary, ...secondaries.map(([, l]) => l)]) {
      for (const b of list) sources.set(b.date, (sources.get(b.date) ?? 0) + 1);
    }
    const health = symbolHealth({
      dates,
      results: own,
      primary: bars.primary,
      primaryDates: new Set(primary.map((b) => b.date)),
      sources,
      standIns: si.standIns,
      refused: si.refused,
    });
    await writeCanonical(db, s.id, merged, health);
    covered(s.id, dates);
    for (const [date, h] of health) {
      healthRows.push({ symbolId: s.id, date, health: h });
      grade(date, h.status, s.ticker);
    }
    const off = await recordStandIns(
      db,
      o.runId,
      s.id,
      si.standIns,
      new Map(primary.map((b) => [b.date, b])),
    );
    standInCount += si.standIns.filter((x) => !o.from || x.date >= o.from).length;
    standInsOff.push(...off.map((x) => ({ ticker: s.ticker, ...x })));
  }

  const base = await getSetting(db, 'base_currency');
  const fx = await roles(db, 'fx');
  if (base && base !== 'USD' && fx.primary) {
    const pair = `USD${base}`;
    const primary = await latestFx(db, pair, fx.primary);
    for (const source of fx.secondaries) {
      const rs = fxCheck(primary, await latestFx(db, pair, source), source);
      results.push(...rs.map((r) => ({ ...r, symbolId: null })));
      for (const r of rs) {
        if (overall.has(r.date)) grade(r.date, r.status, `${pair}:${r.layer}.${r.check}@${source}`);
      }
    }
  }
  // The cash series' freshness on the run's date (rates are read only through asOf).
  const source = await cashSeries(db);
  if (o.seriesSessions && overall.has(o.to)) {
    const cash = source ? await seriesPointInTime(db, source.series, source.source) : undefined;
    const last = cash?.asOf(o.to, (o.now ?? new Date()).toISOString())?.date;
    const s = seriesHealth(o.seriesSessions, o.to, last);
    grade(o.to, s.status, cashReason(source, last === undefined ? undefined : s.behind));
  }
  // Issuer data (layer D, advisory) for the day overall, for the admins: a source that could not
  // be fetched (04 severity rules: an issuer site unavailable is yellow), a tolerance setting
  // that does not parse. Strategies read their symbols' grades, which say what each fund lacks.
  if (overall.has(o.to) && issuerSources.length > 0) {
    for (const source of issuerSources) {
      const a = availability.get(source);
      if (notLoaded(source) || (a && a.unavailable.length > 0)) {
        grade(o.to, 'yellow', `issuer_unavailable@${source}`);
      }
    }
    if (nav.invalid) grade(o.to, 'yellow', 'issuer_nav_tolerance_invalid');
  }
  for (const [date, h] of overall) healthRows.push({ symbolId: null, date, health: h });

  const inRange = (date: TradingDate) => date <= o.to && (!o.from || date >= o.from);
  const inWindow = results.filter((r) => inRange(r.date));
  const byStatus: Record<string, number> = {};
  for (const r of inWindow) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const keep = o.mode === 'daily' ? inWindow : inWindow.filter((r) => r.status !== 'green');
  await storeResults(db, o.runId, keep);
  if (o.mode === 'full') {
    await storeSummaries(db, o.runId, inWindow);
    // Before the health rows, so an overall row stored means the coverage is stored too.
    if (coverage.length > 0) {
      await db
        .insert(schema.healthCoverage)
        .values(coverage.map((c) => ({ runId: o.runId, ...c })));
    }
  }
  // Full passes also keep the overall row of every date they graded, green included (the health
  // report reads a date without one as not graded). The overall rows go last: one stored means
  // every symbol row was stored.
  await storeHealth(
    db,
    o.runId,
    healthRows.filter(
      (h) =>
        inRange(h.date) &&
        (o.mode === 'daily' || h.symbolId === null || h.health.status !== 'green'),
    ),
  );
  return {
    results: inWindow.length,
    stored: keep.length,
    byStatus,
    health: overall.get(o.to)?.status ?? 'red',
    reasons: overall.has(o.to) ? overall.get(o.to)!.reasons : ['no_data'],
    standIns: standInCount,
    standInsOff,
    toleranceInvalid: nav.invalid,
    toleranceUnmatched: unmatchedTolerances(
      nav.tolerances,
      symbols.map((s) => s.ticker),
    ),
  };
}

/**
 * Results of a whole-run check (layer E, no symbol), stored as a full-history pass stores them:
 * the non-green ones in full, or every one with `all` (testfol parity: green cases are shown too).
 */
export async function storeRunChecks(
  db: Db,
  runId: string,
  rs: CheckResult[],
  o: { all?: boolean } = {},
) {
  const stored = rs.map((r) => ({ ...r, symbolId: null }));
  await storeResults(
    db,
    runId,
    stored.filter((r) => o.all || r.status !== 'green'),
  );
  await storeSummaries(db, runId, stored);
}

async function storeHealth(
  db: Db,
  runId: string,
  rows: { symbolId: number | null; date: TradingDate; health: DayHealth }[],
) {
  const values = rows.map((r) => ({
    runId,
    date: r.date,
    symbolId: r.symbolId,
    status: r.health.status,
    reasons: r.health.reasons,
  }));
  for (let i = 0; i < values.length; i += CHUNK) {
    await db.insert(schema.dataHealth).values(values.slice(i, i + CHUNK));
  }
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
