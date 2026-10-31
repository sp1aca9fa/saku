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
  type IssuerPublishes,
  type Sessions,
  TOLERANCE,
  adjReturnCheck,
  fxCheck,
  freshnessStatus,
  fxUnavailable,
  indexCheck,
  indexUnavailable,
  layerA,
  layerB,
  layerD,
  leverageCheck,
  notComparedOf,
  seriesHealth,
  standIns,
  symbolHealth,
  unsplit,
  worst,
} from '@saku/data';
import {
  type Db,
  activeSymbols,
  fxPointInTime,
  getSetting,
  issuerRecordsOf,
  navTolerances,
  schema,
  latestCloseOf,
  standInMatchesBar,
  unmatchedTolerances,
  seriesPointInTime,
} from '@saku/db';
import { cashSeries } from './cash';
import type { NotCompared } from './issuer';
import { and, asc, eq, gte, isNotNull, isNull, lte, min, sql } from 'drizzle-orm';

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
  /**
   * The calendars sources declare (`PluginInfo.calendar`), by source key: a missing FX rate on a
   * day the primary's calendar is closed is an expected gap. None given: no day counts as closed.
   */
  sourceCalendars?: Record<string, Sessions>;
  /**
   * What each issuer source declares it publishes (`PluginInfo.publishes`), by source key: layer
   * D compares only those kinds. A source not named: inferred from its records.
   */
  issuerPublishes?: Record<string, IssuerPublishes>;
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
  /** Stored canonical bars this run's build no longer produced, removed (`writeCanonical`). */
  removedCanonical: RemovedCanonical[];
  /**
   * Closed stand-ins (rule 5) whose canonical bar this run built differently (another secondary,
   * a revised value) or refused (`now` null): no longer settled; such a day is graded at least
   * yellow, `stand_in_closed_changed@<source>` (a refused one is red already).
   */
  closedChanged: {
    ticker: string;
    date: TradingDate;
    /** The latest close (`latestCloseOf`). */
    closed: { source: string; close: number; closedAt: string };
    now: { source: string; close: number } | null;
  }[];
  /** The stored `issuer_nav_tolerance` does not parse (layer D observes only; yellow). */
  toleranceInvalid: boolean;
  /** `issuer_nav_tolerance` keys that name no active symbol. */
  toleranceUnmatched: string[];
  /**
   * Issuer records dated in the run's window (`from` to `to`) that layer D did not compare for
   * being in another currency than the fund's (C15 (a): "not compared", told in the run's log).
   */
  navNotCompared: NotCompared[];
}

/** A stand-in bar carries the band and basis this build computed (stored for the margin test). */
type CanonicalBar = RawBar & { source: string; standIn: boolean; band?: number; basis?: string };

type Stored = CheckResult & { symbolId: number | null };

/**
 * A point-in-time series' freshness reason on a run's date (the cash rate, a fund's index, the
 * base-currency FX pair): `<series>:missing@<source>` or `<series>:stale(n)@<source>`.
 */
export function freshnessReason(series: string, source: string, behind: number | undefined) {
  const what = behind === undefined ? 'missing' : `stale(${behind})`;
  return `${series}:${what}@${source}`;
}

/** The cash series' freshness reason (`cash:missing@none` when no source declares a cash rate). */
export function cashReason(
  source: { series: string; source: string } | undefined,
  behind: number | undefined,
): string {
  return freshnessReason(source?.series ?? 'cash', source?.source ?? 'none', behind);
}

/** The days behind in a freshness reason (undefined: missing), or null for another code. */
export function parseFreshnessReason(code: string): { behind: number | undefined } | null {
  const m = /^[^:@\s]+:(missing|stale\((\d+)\))@[^@\s]+$/.exec(code);
  if (!m) return null;
  return { behind: m[2] === undefined ? undefined : Number(m[2]) };
}

/**
 * The status a reason of the overall row carries on its own, for the reasons a later run's grade
 * of the same date must not hide (the health report merges them from the run that targeted the
 * date): series freshness (its status from the days behind) and an FX cross-check that could not
 * run (`<pair>:B.fx_unavailable@<source>`, yellow). Null for any other code.
 */
export function carriedReasonStatus(code: string): HealthStatus | null {
  const fresh = parseFreshnessReason(code);
  if (fresh) return freshnessStatus(fresh.behind ?? Infinity);
  return /^[^:@\s]+:B\.fx_unavailable@[^@\s]+$/.test(code) ? 'yellow' : null;
}

/** Whether a source's calendar is closed on `date`; outside the calendar: unknown, not closed. */
function isClosed(calendar: Sessions, date: TradingDate): boolean {
  try {
    return !calendar.isSession(date);
  } catch {
    return false;
  }
}

/**
 * Each primary bar on a closed day that carries a dividend or split, with the first session after
 * it (on or before `to`; none yet, or past the calendar's end: left out until a run reaches it).
 * Such a bar is kept out of the canonical series (requirements 04 "Closed-day bars"), so its event
 * is in no bar the signals read and the return into that session would be read without it (a
 * split as a fall): that session is graded red, `closed_day_event@<closed date>`, while the bar
 * is stored. The event is never moved to a session (which one is a guess).
 */
function closedDayEvents(
  closedDays: RawBar[],
  sessions: Sessions,
  to: TradingDate,
): { date: TradingDate; next: TradingDate; reason: string }[] {
  const out: { date: TradingDate; next: TradingDate; reason: string }[] = [];
  for (const b of closedDays) {
    if (b.divCash === 0 && b.splitFactor === 1) continue;
    let next: TradingDate;
    try {
      next = sessions.after(b.date);
    } catch {
      continue;
    }
    if (next <= to) out.push({ date: b.date, next, reason: `closed_day_event@${b.date}` });
  }
  return out;
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

/** The sources with a role for a data kind, as stored now (primary, secondaries, checks). */
export async function roles(db: Db, dataKind: string) {
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

/** A symbol's stored raw bars by source, sorted by date, as the checks read them. */
export async function rawBars(db: Db, symbolId: number): Promise<Map<string, RawBar[]>> {
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

/** A stored canonical bar the run's build no longer produced, removed (see `writeCanonical`). */
export interface RemovedCanonical {
  ticker: string;
  date: TradingDate;
  source: string;
  standIn: boolean;
  close: number;
  /** Its grade before removal (null: never graded). */
  status: HealthStatus | null;
}

/**
 * Writes the canonical bars (primary or stand-in) with our adjusted series and health status.
 * Canonical bars are derived, rebuilt from the raw bars by every run: a stored canonical bar
 * dated from the primary's first bar (`from`) to the run's date that this build did not produce
 * (a stand-in a later run refused while the primary still lacks the day, a date the primary no
 * longer has, a bar on a day that is no session once the build leaves such days out) is removed,
 * so no stale price or grade greener than the day's own stays where the signals and the forward
 * step read (requirements 04: never a normal signal on red data). The raw bars, their revision
 * log and the `stand_ins` row stay; the day is then read through its `data_health` grade
 * (`primary_missing` or `stand_in_refused`, red). Bars before `from` (kept from an earlier
 * primary, graded by no check; registration refuses them) are left as they are. Returns the
 * removed ones, for the run log.
 */
async function writeCanonical(
  db: Db,
  symbolId: number,
  bars: CanonicalBar[],
  health: Map<TradingDate, DayHealth>,
  span: { from: TradingDate; to: TradingDate },
): Promise<Omit<RemovedCanonical, 'ticker'>[]> {
  const built = new Set(bars.map((b) => b.date));
  const removed: Omit<RemovedCanonical, 'ticker'>[] = [];
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
    standInBand: b.standIn ? (b.band ?? null) : null,
    standInBasis: b.standIn ? (b.basis ?? null) : null,
    status: health.get(b.date)?.status ?? null,
  }));
  await db.transaction(async (tx) => {
    const stored = await tx
      .select({
        date: schema.bars.date,
        source: schema.bars.source,
        standIn: schema.bars.standIn,
        close: schema.bars.close,
        status: schema.bars.status,
      })
      .from(schema.bars)
      .where(
        and(
          eq(schema.bars.symbolId, symbolId),
          gte(schema.bars.date, span.from),
          lte(schema.bars.date, span.to),
        ),
      );
    for (const row of stored) {
      if (built.has(row.date)) continue;
      await tx
        .delete(schema.bars)
        .where(and(eq(schema.bars.symbolId, symbolId), eq(schema.bars.date, row.date)));
      removed.push(row);
    }
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
            standInBand: sqlExcluded('stand_in_band'),
            standInBasis: sqlExcluded('stand_in_basis'),
            status: sqlExcluded('status'),
          },
        });
    }
  });
  return removed.sort((a, b) => (a.date < b.date ? -1 : 1));
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
 * primary has now replaced, closed ones too (rule 5: a primary that arrives after the close is
 * still compared and recorded; the close stays). A closed row's close is frozen, so it is compared
 * against the close the canonical bar last used (`lastUsed`: the stored canonical stand-in close
 * before this run rebuilt the day), as an open one's last stored close is: the price the entries
 * read until now. Returns the resolved ones off by more than the close tolerance.
 */
async function recordStandIns(
  db: Db,
  runId: string,
  symbolId: number,
  used: { date: TradingDate; source: string; bar: RawBar; band: number; basis: string }[],
  primary: Map<TradingDate, RawBar>,
  lastUsed: Map<TradingDate, number>,
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
        // A closed stand-in keeps the values it was closed with (requirements 04 stand-in
        // rule 5; a trigger refuses the change): only an open one is replaced.
        setWhere: and(isNull(schema.standIns.resolvedAt), isNull(schema.standIns.closedAt)),
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
    const stood = row.closedAt !== null ? (lastUsed.get(row.date) ?? row.close) : row.close;
    const deviation = Math.abs(p.close / stood - 1);
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
  const removedCanonical: RemovedCanonical[] = [];
  const closedChanged: VerifySummary['closedChanged'] = [];
  const firstBars = await firstCanonical(db);
  /** Full passes: the dates graded per symbol (a missing non-green row is green only inside). */
  const coverage: { symbolId: number; fromDate: TradingDate; toDate: TradingDate }[] = [];
  const covered = (symbolId: number, dates: TradingDate[]) => {
    const inside = dates.filter((d) => d <= o.to && (!o.from || d >= o.from));
    if (inside.length > 0)
      coverage.push({ symbolId, fromDate: inside[0]!, toDate: inside.at(-1)! });
  };

  const seriesRoles = await roles(db, 'series');
  /** When the run looks: series and FX values published later are not known to it. */
  const at = (o.now ?? new Date()).toISOString();
  /** The index series of the symbols graded (their freshness grades the day overall). */
  const indexes = new Set<string>();
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
  const navNotCompared: NotCompared[] = [];
  for (const s of symbols) {
    const bySource = raw.get(s.id)!;
    // A primary that delivers split-adjusted closes is put back on the raw basis too.
    const primaryAll = unsplit((bySource.get(bars.primary) ?? []).filter((b) => b.date <= o.to));
    // Requirements 04 "Closed-day bars": a primary bar dated on a day the calendar says was
    // closed is kept out of the canonical series and of every comparison across days (layer B,
    // C and D, stand-ins), so the sessions around it are compared with the real session before;
    // layer A still checks it (red, `bar_valid` "not a trading day") and its date is graded.
    // Un-split over every bar first, so the restated closes are as before. A date the calendar
    // does not cover is unknown, never closed: kept (and refused by layer A as before).
    const closedDays = primaryAll.filter((b) => o.sessions.closedOn(b.date));
    const primary = primaryAll.filter((b) => !o.sessions.closedOn(b.date));
    const own: CheckResult[] = [];
    const add = (rs: CheckResult[]) => own.push(...rs);
    // The fund's index (layer C), from the series primary, as known at the run (point in time:
    // a value published after the run is not used); no primary or no value: empty, and graded
    // below (never skipped as if the check had passed).
    const index = s.indexSeries
      ? seriesRoles.primary
        ? (await seriesPointInTime(db, s.indexSeries, seriesRoles.primary)).knownAt(at)
        : []
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
      ).filter((b) => !o.sessions.closedOn(b.date)); // as the fund's: its canonical series
      add(leverageCheck(primary, u, s.leverageFactor));
    }
    if (index) {
      const source = seriesRoles.primary;
      add(indexCheck(primary, index, { ...(source && { source }), to: o.to }));
      // No index value at all: no history to compare within, so the run's date only.
      if (index.length === 0 && primary.length > 0) add([indexUnavailable(o.to, source ?? 'none')]);
      if (primary.length > 0) indexes.add(s.indexSeries!);
    }
    if (issuerSources.length > 0) {
      const tolerance = Object.hasOwn(nav.tolerances, s.ticker)
        ? nav.tolerances[s.ticker]
        : undefined;
      const stored = await issuerRecordsOf(db, s.id, issuerSources);
      // Every source with a role, also one with nothing stored for the fund (it may have failed).
      for (const source of issuerSources) {
        const a = availability.get(source);
        const publishes = o.issuerPublishes?.[source];
        const notCompared = notComparedOf(primary, stored.get(source) ?? [], {
          source,
          currency: s.currency,
          to: o.to,
          ...(o.from && { from: o.from }),
          ...(publishes && { publishes }),
          ...(notLoaded(source) && { notLoaded: true }),
        });
        for (const [currency, c] of Object.entries(notCompared)) {
          navNotCompared.push({ ticker: s.ticker, source, currency, ...c });
        }
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
            ...(o.issuerPublishes?.[source] && { publishes: o.issuerPublishes[source] }),
          }),
        );
      }
    }
    results.push(...own.map((r) => ({ ...r, symbolId: s.id })));
    if (primary.length === 0) {
      // No primary bar at all, or only on closed days (a new primary without this symbol's
      // history, or none fetched yet):
      // red on its dates, never left out (left out, the day would read green without it).
      const missing = missingPrimaryDates(
        o.sessions,
        firstBars.get(s.id) ?? s.inceptionDate ?? undefined,
        o,
      );
      const events = closedDayEvents(closedDays, o.sessions, o.to);
      for (const date of missing) {
        const reasons = [
          'primary_missing',
          ...events.filter((e) => e.next === date).map((e) => e.reason),
        ];
        healthRows.push({ symbolId: s.id, date, health: { status: 'red', reasons } });
        grade(date, 'red', s.ticker);
      }
      // Its bars on closed days are graded red with their layer A result, as with other bars.
      const closed = closedDays.map((b) => b.date).filter((d) => !missing.includes(d));
      for (const date of closed) {
        healthRows.push({
          symbolId: s.id,
          date,
          health: { status: 'red', reasons: [`A.bar_valid@${bars.primary}`] },
        });
        grade(date, 'red', s.ticker);
      }
      await markCanonical(db, s.id, missing, 'red');
      covered(s.id, [...missing, ...closed].sort());
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
      ...si.standIns.map((x) => ({
        ...x.bar,
        source: x.source,
        standIn: true,
        band: x.band,
        basis: x.basis,
      })),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));
    canonical.set(s.id, merged);

    // The sessions from the primary's first bar (on a closed day too, as layer A's gaps), and the
    // day of every primary bar on a closed day (layer A flags it red, `bar_valid` "not a trading
    // day"): graded with the sessions, so its red result and grade are stored and shown, while no
    // canonical bar is built for it (requirements 04 "Closed-day bars").
    const closed = closedDays.map((b) => b.date);
    const dates = [
      ...new Set([...o.sessions.between(primaryAll[0]!.date, o.to), ...closed]),
    ].sort();
    const sources = new Map<TradingDate, number>();
    for (const list of [primaryAll, ...secondaries.map(([, l]) => l)]) {
      for (const b of list) sources.set(b.date, (sources.get(b.date) ?? 0) + 1);
    }
    const health = symbolHealth({
      dates,
      results: own,
      primary: bars.primary,
      primaryDates: new Set(primaryAll.map((b) => b.date)),
      sources,
      standIns: si.standIns,
      refused: si.refused,
    });
    for (const e of closedDayEvents(closedDays, o.sessions, o.to)) {
      const h = health.get(e.next);
      if (!h) continue;
      h.status = 'red';
      if (!h.reasons.includes(e.reason)) h.reasons.push(e.reason);
    }
    // Closed stand-ins (rule 5) are settled only while the canonical bar is that stand-in: a day
    // built from another price is graded as a stand-in again (at least yellow, named), and the
    // margin test and the corrections treat it as open (`isOpenStandIn`). The close used by the
    // stored canonical bar is kept to compare a late primary with (`recordStandIns`).
    const closedRows = await db
      .select({
        date: schema.standIns.date,
        source: schema.standIns.source,
        close: schema.standIns.close,
        closedAt: schema.standIns.closedAt,
      })
      .from(schema.standIns)
      .where(
        and(
          eq(schema.standIns.symbolId, s.id),
          isNotNull(schema.standIns.closedAt),
          isNull(schema.standIns.resolvedAt),
        ),
      );
    const lastUsed = new Map<TradingDate, number>();
    for (const row of closedRows) {
      // The latest close counts (an admin may close the new price again, `stand_in_closes`).
      const c = (await latestCloseOf(db, s.id, row.date)) ?? row;
      const date = row.date;
      const [stored] = await db
        .select({ standIn: schema.bars.standIn, close: schema.bars.close })
        .from(schema.bars)
        .where(and(eq(schema.bars.symbolId, s.id), eq(schema.bars.date, date)));
      if (stored?.standIn) lastUsed.set(date, stored.close);
      const built = merged.find((b) => b.date === date);
      if (built && !built.standIn) continue; // the primary's bar: resolved below
      if (built && standInMatchesBar(c, built)) continue;
      closedChanged.push({
        ticker: s.ticker,
        date,
        closed: { source: c.source, close: c.close, closedAt: c.closedAt! },
        now: built ? { source: built.source, close: built.close } : null,
      });
      const h = built && health.get(date);
      if (h) {
        h.status = worst(h.status, 'yellow');
        const reason = `stand_in_closed_changed@${built.source}`;
        if (!h.reasons.includes(reason)) h.reasons.push(reason);
      }
    }
    const removed = await writeCanonical(db, s.id, merged, health, {
      from: primaryAll[0]!.date,
      to: o.to,
    });
    removedCanonical.push(...removed.map((r) => ({ ticker: s.ticker, ...r })));
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
      lastUsed,
    );
    standInCount += si.standIns.filter((x) => !o.from || x.date >= o.from).length;
    standInsOff.push(...off.map((x) => ({ ticker: s.ticker, ...x })));
  }

  const base = await getSetting(db, 'base_currency');
  const fx = await roles(db, 'fx');
  if (base && base !== 'USD') {
    const pair = `USD${base}`;
    // Rates as known at the run (point in time), like the freshness read below.
    const pit = fx.primary ? await fxPointInTime(db, pair, fx.primary) : undefined;
    const primary = (pit?.knownAt(at) ?? []).map((r) => ({ date: r.date, rate: r.value }));
    // The primary's declared closing days are expected gaps (04 point-in-time series).
    const calendar = fx.primary ? o.sourceCalendars?.[fx.primary] : undefined;
    const closed = calendar && ((d: TradingDate) => isClosed(calendar, d));
    for (const source of fx.secondaries) {
      const other = (await fxPointInTime(db, pair, source))
        .knownAt(at)
        .map((r) => ({ date: r.date, rate: r.value }));
      // Only the dates this run grades (a secondary may publish on days that are no session).
      const rs = fxCheck(primary, other, source, closed ? { closed } : {}).filter(
        (r) => r.check !== 'fx_unavailable' || overall.has(r.date),
      );
      // No primary rate at all: no history to compare within, so the run's date only.
      if (primary.length === 0 && overall.has(o.to)) rs.push(fxUnavailable(o.to, source));
      results.push(...rs.map((r) => ({ ...r, symbolId: null })));
      for (const r of rs) {
        if (overall.has(r.date)) grade(r.date, r.status, `${pair}:${r.layer}.${r.check}@${source}`);
      }
    }
    // The primary rate's freshness on the run's date, read through asOf (04 point-in-time
    // series), on the trading calendar: it grades the day overall, never a symbol, so it never
    // changes a signal computed in USD (04). No FX primary: missing, red.
    if (overall.has(o.to)) {
      const last = pit?.asOf(o.to, at)?.date;
      const h = seriesHealth(o.sessions, o.to, last);
      const behind = last === undefined ? undefined : h.behind;
      grade(o.to, h.status, freshnessReason(pair, fx.primary ?? 'none', behind));
    }
  }
  // Each graded fund's index series: its freshness on the run's date, read through asOf, on the
  // trading calendar (the index is compared on the fund's sessions), for the day overall like the
  // cash rate. Its gaps reach the fund through `index_unavailable` (yellow); a stale index alone
  // never applies a strategy's safe state (the bars are checked by layers A and B).
  if (overall.has(o.to)) {
    for (const id of [...indexes].sort()) {
      const pit = seriesRoles.primary
        ? await seriesPointInTime(db, id, seriesRoles.primary)
        : undefined;
      const last = pit?.asOf(o.to, at)?.date;
      const h = seriesHealth(o.sessions, o.to, last);
      const behind = last === undefined ? undefined : h.behind;
      grade(o.to, h.status, freshnessReason(id, seriesRoles.primary ?? 'none', behind));
    }
  }
  // The cash series' freshness on the run's date (rates are read only through asOf).
  const source = await cashSeries(db);
  if (o.seriesSessions && overall.has(o.to)) {
    const cash = source ? await seriesPointInTime(db, source.series, source.source) : undefined;
    const last = cash?.asOf(o.to, at)?.date;
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
  // A day whose canonical bar was removed is read through its stored grade (the forward step and
  // `pnpm health`). Outside the run's window every row of that day is stored too, the overall
  // row and each symbol's, as a daily run stores its window: the day reads as graded by this
  // run, and an older (greener) row is never the latest.
  const removedDates = new Set(removedCanonical.map((r) => r.date));
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
        (inRange(h.date) &&
          (o.mode === 'daily' || h.symbolId === null || h.health.status !== 'green')) ||
        (!inRange(h.date) && h.date <= o.to && removedDates.has(h.date)),
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
    closedChanged,
    removedCanonical,
    toleranceInvalid: nav.invalid,
    toleranceUnmatched: unmatchedTolerances(
      nav.tolerances,
      symbols.map((s) => s.ticker),
    ),
    navNotCompared,
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
