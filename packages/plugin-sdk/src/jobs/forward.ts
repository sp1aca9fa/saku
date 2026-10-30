// The daily forward record (requirements 05, A2): for every registered version, each trading day
// since the last entry (catch-up) whose close came after registration, the decision with its
// data health, chained to the previous entry. Nothing runs before `forward_records_from` is set
// (the A1 gate). Stand-ins the primary later corrected are annotated, never edited, by their own
// step (`annotateStandInCorrections`), caught up from the database before every recompute.
import {
  type RawBar,
  type StrategyDay,
  Strategy,
  type TickerHealth,
  type TradingDate,
  backtest,
  dependencies,
  canonicalJson,
  evaluate,
  forwardDecision,
  NEAR_TIE,
  zonedInstant,
} from '@saku/core';
import { type SessionClose, type Sessions, TOLERANCE } from '@saku/data';
import {
  type Db,
  type ForwardEntry,
  activeSymbols,
  allVersions,
  annotate,
  annotationsOf,
  appendForward,
  canonicalBars,
  forwardRecord,
  getSetting,
  lastEntry,
  latestHealth,
  resolvedStandIns,
  sha256,
  standInOn,
  unresolvedStandIns,
} from '@saku/db';
import { cashRateReader } from './cash';

export interface ForwardOptions {
  runId: string;
  sessions: Sessions;
  to: TradingDate;
}

export interface ForwardSummary {
  skipped?: string;
  appended: number;
  safeStateDays: number;
  /** Today's decisions, for the log (and the alerts, later in A2). */
  today: { version: string; allocation: string; dataStatus: string; reasons: string[] }[];
  /**
   * Versions whose stored definition no longer parses (e.g. a rule added after registration):
   * nothing is appended for them (no guessed decision); the others still run. The run is then
   * incomplete and the admins' job-failure alert names each one and why; the days are caught up
   * once the definition parses again.
   */
  errors: { version: string; error: string }[];
}

/**
 * A registered version's strategy, or the reason it does not parse. Registered versions are
 * immutable, so a stricter schema can refuse one stored before: that version is reported and
 * skipped, never evaluated on a guess, and never stops the other versions.
 */
export function parseVersion(version: {
  canonicalJson: string;
}): { strategy: Strategy } | { error: string } {
  let stored: unknown;
  try {
    stored = (JSON.parse(version.canonicalJson) as { strategy?: unknown }).strategy;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const parsed = Strategy.safeParse(stored);
  if (parsed.success) return { strategy: parsed.data };
  // One line per problem, where it is: readable in the log and the admins' job-failure alert.
  return {
    error: parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; '),
  };
}

const toRaw = (r: Awaited<ReturnType<typeof canonicalBars>>[number]): RawBar => ({
  date: r.date,
  ...(r.open !== null && { open: r.open }),
  ...(r.high !== null && { high: r.high }),
  ...(r.low !== null && { low: r.low }),
  close: r.close,
  closeIsSplitAdjusted: false,
  ...(r.volume !== null && { volume: r.volume }),
  divCash: r.divCash,
  splitFactor: r.splitFactor,
});

export async function forward(db: Db, o: ForwardOptions): Promise<ForwardSummary> {
  const summary: ForwardSummary = {
    appended: 0,
    safeStateDays: 0,
    today: [],
    errors: [],
  };
  const from = await getSetting(db, 'forward_records_from');
  if (!from) return { ...summary, skipped: 'forward records not started (forward_records_from)' };

  const { symbolIds, loadRows, barsOf } = await reader(db);
  const cashRate = await cashRateReader(db);

  const healthOn = (rows: Rows, date: TradingDate) => healthOf(db, symbolIds, rows, date);

  for (const version of await allVersions(db)) {
    const parsed = parseVersion(version);
    if ('error' in parsed) {
      summary.errors.push({ version: `${version.name} (${version.id})`, error: parsed.error });
      continue;
    }
    const { strategy } = parsed;
    const deps = dependencies(strategy);
    const last = await lastEntry(db, version.id);
    const start = last ? last.date : from;
    const dates = o.sessions
      .between(start, o.to)
      // Only closes after registration: the record never starts in the past.
      .filter(
        (d) => (!last || d > last.date) && recordsDay(d, from, version.registeredAt, o.sessions),
      );

    // One read per version and run: the bars up to the run's last date, each date then sees only
    // its prefix (dated <= that date), the same rows a read up to that date returns. The jobs lock
    // holds the bars still while this runs.
    const all = dates.length > 0 ? await loadRows(deps, o.to) : {};
    // The record so far, read once; each appended entry joins it as stored (the inserted row).
    const prior: StrategyDay[] =
      dates.length > 0 ? (await forwardRecord(db, version.id)).map(asDay) : [];
    for (const date of dates) {
      const rows = upTo(all, date);
      const bars = barsOf(rows);
      const decision = forwardDecision(strategy, date, bars, await healthOn(rows, date));
      const equity = forwardEquity(strategy, prior, bars, cashRate, {
        date,
        signals: decision.signals ?? {},
        allocation: decision.allocation,
        holdings: decision.holdings,
        ties: decision.ties,
      });
      const entry = await appendForward(
        db,
        version,
        {
          date,
          allocation: decision.allocation,
          holdings: decision.holdings,
          safeStateApplied: decision.safeStateApplied,
          dataStatus: decision.dataStatus,
          equity,
          detail: {
            signals: decision.signals,
            reasons: decision.reasons,
            ties: decision.ties,
            execution: strategy.execution,
          },
        },
        o.runId,
      );
      prior.push(asDay(entry));
      summary.appended++;
      if (decision.safeStateApplied) summary.safeStateDays++;
      if (date === o.to) {
        summary.today.push({
          version: version.name,
          allocation: decision.allocation,
          dataStatus: decision.dataStatus,
          reasons: decision.reasons,
        });
      }
    }
  }
  return summary;
}

export interface StandInCorrectionSummary {
  /** Annotations added by this call. */
  annotations: number;
  /**
   * Corrections waiting for an unresolved stand-in (see `standInCorrections`): annotated by a
   * later run once the primary has replaced it.
   */
  deferred: number;
  /**
   * Corrected stand-ins whether an entry used them is unknown (a stored timestamp that is not an
   * ISO 8601 instant): nothing is annotated on a guess; the caller reports each line (the run is
   * incomplete and the admins' job-failure alert names it).
   */
  errors: string[];
}

/**
 * The stand-in correction step (requirements 04, the stand-in rule: forward records that used a
 * stand-in are annotated once the primary arrives, never edited). For every registered version
 * that parses, each resolved stand-in off the primary by more than the layer B close tolerance
 * (as verify reports them; those within it are not annotated) on a ticker it depends on gives
 * one `stand_in_corrected` annotation on every recorded entry that used it (`standInCorrections`:
 * the stand-in day's and each later day's appended while it was unresolved, whose lookback may
 * read it): the recorded allocation against the decision on the corrected bars (only bars dated
 * <= the entry's date, all green: the primary's bar is there now).
 *
 * Caught up from `stand_ins` (not one run's list), so a version skipped in the resolving run is
 * annotated in a later one; idempotent. Run it before every recompute (daily, weekly, `pnpm
 * strategy recompute`): recompute skips the days a correction explains, so a resolved stand-in
 * that flips a day is never told as "the engine decides differently". A version that does not
 * parse is skipped here; the forward step and recompute report it.
 */
export async function annotateStandInCorrections(
  db: Db,
  runId: string | null,
): Promise<StandInCorrectionSummary> {
  const summary: StandInCorrectionSummary = { annotations: 0, deferred: 0, errors: [] };
  const corrected = (await resolvedStandIns(db)).filter(
    (s) => s.deviation !== null && s.deviation > TOLERANCE.close,
  );
  if (corrected.length === 0) return summary;
  const unresolved = await unresolvedStandIns(db);
  const { loadRows, barsOf } = await reader(db);
  const errors = new Set<string>();
  for (const version of await allVersions(db)) {
    const parsed = parseVersion(version);
    if ('error' in parsed) continue;
    const { strategy } = parsed;
    const deps = dependencies(strategy);
    const pending = standInCorrections({
      version: `${version.name} (${version.id})`,
      deps,
      record: await forwardRecord(db, version.id),
      corrected,
      unresolved,
      annotated: (await annotationsOf(db, version.id, 'stand_in_corrected')).map((a) => {
        const d = a.detail as { ticker?: unknown; standInDate?: unknown };
        // Written before `standInDate` existed: on the stand-in day's own entry.
        return { date: a.date, ticker: d.ticker, standInDate: d.standInDate ?? a.date };
      }),
    });
    for (const e of pending.errors) errors.add(e);
    summary.deferred += pending.deferred;
    for (const { standIn, recorded } of pending.annotate) {
      const bars = barsOf(await loadRows(deps, recorded.date));
      const now = forwardDecision(strategy, recorded.date, bars, allGreen(deps));
      await annotate(db, {
        versionId: version.id,
        date: recorded.date,
        kind: 'stand_in_corrected',
        detail: {
          ticker: standIn.ticker,
          standInDate: standIn.date,
          // Against the stand-in's last stored close: a later run may have replaced the close
          // an entry used while the stand-in was unresolved (docs/data-pipeline.md).
          deviation: standIn.deviation,
          recordedAllocation: recorded.allocation,
          correctedAllocation: now.allocation,
          differs: now.allocation !== recorded.allocation,
        },
        runId,
      });
      summary.annotations++;
    }
  }
  summary.errors = [...errors];
  return summary;
}

/** A resolved stand-in as `resolvedStandIns` reads it. */
export interface ResolvedStandIn {
  ticker: string;
  date: TradingDate;
  deviation: number | null;
  /** The run that first recorded it (null for rows stored outside a run). */
  runId: string | null;
  createdAt: string;
  /** The run in which the primary replaced it. */
  resolvedRunId: string | null;
  resolvedAt: string | null;
}

/** ISO 8601 with a `Z` or an offset, as `toISOString` writes `created_at` and `resolved_at`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A stored timestamp as epoch milliseconds, or NaN when it is not an ISO 8601 instant. Compared
 * as instants, never as text; a form without a zone (e.g. SQLite's `YYYY-MM-DD HH:MM:SS`) is
 * refused rather than read in the server's local time.
 */
export function instantOf(text: string | null): number {
  return text !== null && ISO_INSTANT.test(text) ? Date.parse(text) : NaN;
}

/**
 * The corrections still to annotate for one version (requirements 04, the stand-in rule: records
 * are annotated once the primary arrives, never edited; 05: recomputations are annotations). For
 * each corrected stand-in on a ticker the version depends on: every recorded entry dated on or
 * after the stand-in's date that used it (its own day, and later days whose lookback may read it),
 * not annotated yet for that entry date, ticker and stand-in date (idempotent).
 *
 * Whether an entry used the stand-in is decided by run ids first, since verify records and
 * resolves stand-ins before the forward step appends within a run (runs hold the jobs lock):
 * an entry appended in the resolving run used the primary's bar; one appended in the run that
 * first recorded the stand-in used it. Only an entry from another run (or without a run) is
 * placed by time: it used the stand-in when appended at or after the stand-in was first recorded
 * and before the primary resolved it (compared as instants). A timestamp that is not an instant
 * then leaves that unknown: an error, nothing annotated.
 *
 * A correction waits (`deferred`) while any ticker the version depends on has an unresolved
 * stand-in dated on or before the entry's date: its corrected decision would rest on a price not
 * verified yet. It is annotated by a later run, once the primary has replaced that one too.
 */
export function standInCorrections(o: {
  version: string;
  deps: string[];
  record: Pick<ForwardEntry, 'date' | 'allocation' | 'createdAt' | 'runId'>[];
  corrected: ResolvedStandIn[];
  /** Stand-ins the primary has not replaced yet. */
  unresolved: { ticker: string; date: TradingDate }[];
  annotated: { date: string; ticker: unknown; standInDate: unknown }[];
}): {
  annotate: { standIn: ResolvedStandIn; recorded: Pick<ForwardEntry, 'date' | 'allocation'> }[];
  deferred: number;
  errors: string[];
} {
  const done = new Set(
    o.annotated.map((a) => `${a.date} ${String(a.ticker)} ${String(a.standInDate)}`),
  );
  // The earliest unresolved stand-in among the version's tickers: an entry dated on or after it
  // waits.
  const waitFrom = o.unresolved
    .filter((u) => o.deps.includes(u.ticker))
    .reduce<string | undefined>(
      (min, u) => (min === undefined || u.date < min ? u.date : min),
      undefined,
    );
  const out: ReturnType<typeof standInCorrections> = { annotate: [], deferred: 0, errors: [] };
  for (const s of o.corrected) {
    if (!o.deps.includes(s.ticker)) continue;
    const from = instantOf(s.createdAt);
    const until = instantOf(s.resolvedAt);
    let unplaced = false;
    for (const recorded of o.record) {
      if (recorded.date < s.date) continue;
      if (done.has(`${recorded.date} ${s.ticker} ${s.date}`)) continue;
      if (recorded.runId !== null && recorded.runId === s.resolvedRunId) continue;
      let used: boolean;
      if (recorded.runId !== null && recorded.runId === s.runId) used = true;
      else if (Number.isNaN(from) || Number.isNaN(until)) {
        // Unknown for every entry placed by time: one line for the stand-in, none annotated.
        if (!unplaced) {
          out.errors.push(
            `${s.ticker} ${s.date}: the stand-in's timestamps are not instants ` +
              `(created ${s.createdAt}, resolved ${s.resolvedAt}); its correction is not annotated`,
          );
        }
        unplaced = true;
        continue;
      } else {
        const at = instantOf(recorded.createdAt);
        if (Number.isNaN(at)) {
          out.errors.push(
            `${o.version} ${recorded.date}: the entry's created_at (${recorded.createdAt}) is ` +
              `not an instant; the ${s.ticker} ${s.date} stand-in correction is not annotated`,
          );
          continue;
        }
        used = at >= from && at < until;
      }
      if (!used) continue;
      if (waitFrom !== undefined && waitFrom <= recorded.date) {
        out.deferred++;
        continue;
      }
      out.annotate.push({ standIn: s, recorded });
    }
  }
  return out;
}

/**
 * Each ticker's grade on the date: the canonical bar's status (set by every verify run). `rows`:
 * each ticker's canonical rows up to `date` (the last one is the day's bar when there is one).
 */
export async function healthOf(
  db: Db,
  symbolIds: Map<string, number>,
  rows: Rows,
  date: TradingDate,
): Promise<Record<string, TickerHealth>> {
  const out: Record<string, TickerHealth> = {};
  for (const [t, list] of Object.entries(rows)) {
    const bar = list.at(-1);
    const id = symbolIds.get(t)!;
    if (!bar || bar.date !== date || !bar.status) {
      // No bar that day: the grade says why (a refused stand-in), else it stays `no_data`.
      const graded = await latestHealth(db, id, date);
      if (graded && graded.status !== 'green') {
        out[t] = { status: graded.status, reasons: graded.reasons };
      }
      continue;
    }
    const reasons =
      bar.status === 'green' ? [] : ((await latestHealth(db, id, date))?.reasons ?? []);
    const stood = bar.standIn ? await standInOn(db, id, date) : undefined;
    out[t] = {
      status: bar.status,
      reasons,
      ...(stood && !stood.resolvedAt && { standInBand: stood.band }),
    };
  }
  return out;
}

export type Rows = Record<string, Awaited<ReturnType<typeof canonicalBars>>>;

/** Reads the canonical bars of the active universe up to a date. */
export async function reader(db: Db) {
  const symbolIds = new Map((await activeSymbols(db)).map((s) => [s.ticker, s.id]));
  const loadRows = async (tickers: string[], to: TradingDate): Promise<Rows> => {
    const out: Rows = {};
    for (const t of tickers) {
      const id = symbolIds.get(t);
      if (id !== undefined) out[t] = await canonicalBars(db, id, to);
    }
    return out;
  };
  const barsOf = (rows: Rows) =>
    Object.fromEntries(Object.entries(rows).map(([t, list]) => [t, list.map(toRaw)]));
  return { symbolIds, loadRows, barsOf };
}

/**
 * Each ticker's rows dated on or before `date` (no look-ahead). The rows are in ascending date
 * order (as `canonicalBars` returns them) and `YYYY-MM-DD` compares as text, so a binary search
 * finds the cut: the first row dated after `date`.
 */
export function upTo(rows: Rows, date: TradingDate): Rows {
  const out: Rows = {};
  for (const [t, list] of Object.entries(rows)) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.date <= date) lo = mid + 1;
      else hi = mid;
    }
    out[t] = list.slice(0, lo);
  }
  return out;
}

const allGreen = (tickers: string[]): Record<string, TickerHealth> =>
  Object.fromEntries(tickers.map((t) => [t, { status: 'green' as const, reasons: [] }]));

export interface RecomputeSummary {
  checked: number;
  /** New differences, each annotated (recorded entries are never edited). */
  differences: { version: string; date: TradingDate; recorded: string; now: string }[];
  /**
   * Versions the current engine could not evaluate at all (nothing annotated for them), as
   * `name (id)`: `parse` when the stored definition no longer parses, `evaluate` when it parses
   * but the engine throws on it.
   */
  errors: { version: string; kind: 'parse' | 'evaluate'; error: string }[];
}

/**
 * Requirements A2: the current engine must reproduce every recorded decision, or the difference
 * is annotated. Each version is evaluated once over today's canonical bars (the engine is causal,
 * so each recorded day reads only bars up to that day), and only the engine's output is compared:
 * health was graded and recorded then. A difference can come from the engine or from data
 * corrected since; the annotation names the code version. Skipped: safe-state days that recorded
 * no signals (nothing to reproduce) and days a corrected stand-in already explains (the engine
 * now decides the allocation the `stand_in_corrected` annotation gives for that day).
 */
export async function recompute(
  db: Db,
  o: { runId: string | null; code: string },
): Promise<RecomputeSummary> {
  const summary: RecomputeSummary = { checked: 0, differences: [], errors: [] };
  const { loadRows, barsOf } = await reader(db);
  for (const version of await allVersions(db)) {
    // Before the record check: a version that no longer parses is reported even without a
    // record yet (the forward step skipped it too), so the run is incomplete.
    const parsed = parseVersion(version);
    if ('error' in parsed) {
      summary.errors.push({
        version: `${version.name} (${version.id})`,
        kind: 'parse',
        error: parsed.error,
      });
      continue;
    }
    const { strategy } = parsed;
    const record = await forwardRecord(db, version.id);
    if (record.length === 0) continue;
    const deps = dependencies(strategy);
    let days: Map<TradingDate, StrategyDay>;
    try {
      const bars = barsOf(await loadRows(deps, record.at(-1)!.date));
      days = new Map(evaluate(strategy, bars).map((d) => [d.date, d]));
    } catch (e) {
      // Not an engine difference to annotate day by day: a failure to report.
      summary.errors.push({
        version: `${version.name} (${version.id})`,
        kind: 'evaluate',
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const seen = new Set(
      (await annotationsOf(db, version.id, 'recomputed')).map((a) => `${a.date} ${a.fingerprint}`),
    );
    // What a corrected stand-in explains: each date's corrected allocations. A day is skipped
    // only when the engine now decides exactly that; otherwise it is compared as usual.
    const explained = new Map<TradingDate, Set<string>>();
    for (const a of await annotationsOf(db, version.id, 'stand_in_corrected')) {
      const corrected = (a.detail as { correctedAllocation?: unknown }).correctedAllocation;
      if (typeof corrected !== 'string') continue;
      explained.set(a.date, (explained.get(a.date) ?? new Set()).add(corrected));
    }
    for (const e of record) {
      const recorded = JSON.parse(e.payload) as {
        signals?: Record<string, boolean | number> | null;
      };
      if (e.safeStateApplied && !recorded.signals) continue;
      const now = days.get(e.date);
      if (explained.get(e.date)?.has(now?.allocation ?? 'no decision')) continue;
      summary.checked++;
      const signals = signalsDiffer(recorded.signals ?? null, now?.signals ?? null);
      const nowAllocation = now?.allocation ?? 'no decision';
      // A safe-state day records the normal allocation's signals but not its name.
      const allocationDiffers = !e.safeStateApplied && nowAllocation !== e.allocation;
      if (!allocationDiffers && signals.length === 0) continue;
      const values = Object.fromEntries(signals.map((id) => [id, now?.signals[id] ?? null]));
      const fingerprint = sha256(canonicalJson({ allocation: nowAllocation, values })).slice(0, 16);
      if (seen.has(`${e.date} ${fingerprint}`)) continue;
      await annotate(db, {
        versionId: version.id,
        date: e.date,
        kind: 'recomputed',
        detail: {
          code: o.code,
          fingerprint,
          recordedAllocation: e.allocation,
          recomputedAllocation: nowAllocation,
          signalsDiffer: signals,
        },
        runId: o.runId,
      });
      summary.differences.push({
        version: version.name,
        date: e.date,
        recorded: e.allocation,
        now: nowAllocation,
      });
    }
  }
  return summary;
}

/** Signal ids whose value differs (booleans exactly, numbers beyond 1e-9 relative). */
export function signalsDiffer(
  a: Record<string, boolean | number> | null,
  b: Record<string, boolean | number> | null,
): string[] {
  if (!a || !b) return a === b ? [] : ['*'];
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return ids.filter((id) => {
    const x = a[id];
    const y = b[id];
    if (typeof x === 'number' && typeof y === 'number') {
      return Math.abs(x - y) > NEAR_TIE * Math.max(Math.abs(x), Math.abs(y));
    }
    return x !== y;
  });
}

/** A recorded entry as a strategy day: what was held, nothing else. */
const asDay = (e: ForwardEntry): StrategyDay => ({
  date: e.date,
  signals: {},
  allocation: e.allocation,
  holdings: e.holdings as StrategyDay['holdings'],
  ties: [],
});

/**
 * The record's own equity: its recorded holdings traded as the strategy executes, from 1.
 * `prior` is the whole record before `today`, in date order.
 */
function forwardEquity(
  strategy: Strategy,
  prior: StrategyDay[],
  bars: Record<string, RawBar[]>,
  cashRate: (date: TradingDate) => number | undefined,
  today: StrategyDay,
): number | null {
  const days = [...prior, today];
  try {
    return backtest({ strategy, days, bars, cashRate }).points.at(-1)!.equity;
  } catch {
    // A holding without a bar that day: the equity is unknown, not guessed.
    return null;
  }
}

// --- Which days a version records (shared by forward() and `pnpm drill`) ---

/** The regular close of a US equity session (New York time). */
const REGULAR_CLOSE = '16:00';
/**
 * The earliest close a session can have when the calendar lists no early-close time: the NYSE
 * half-day close (13:00 New York; requirements 04, Calendars).
 */
const EARLIEST_CLOSE = '13:00';

/**
 * Whether the forward step records `date` for a version (requirements 05): on or after
 * `forward_records_from` (the A1 gate; `from`), and only a close after the version's registration,
 * so the record never starts in the past (no look-ahead). The close is the session's actual one
 * from the calendar (requirements 04, Calendars): an early close at its time (13:00 New York), a
 * regular close at 16:00, and where the calendar cannot say whether the day closed early, the
 * earliest it could have closed (the early-close time): a later cut would admit a half-day whose
 * close was already known at registration. `registeredAt` is the stored ISO 8601 instant
 * (`toISOString`), compared with the close's as the forward step always has. `date` must be a
 * session of `sessions` (else this throws).
 */
export function recordsDay(
  date: TradingDate,
  from: string,
  registeredAt: string,
  sessions: Sessions,
): boolean {
  if (date < from) return false;
  return zonedInstant(date, recordClose(date, sessions).time, 'America/New_York') > registeredAt;
}

/**
 * The close `recordsDay` cuts at on a session (New York `HH:MM`) and the calendar's word on it:
 * `regular` 16:00, `early` the table's early-close time, `unknown` the earliest possible close.
 */
export function recordClose(
  date: TradingDate,
  sessions: Sessions,
): { time: string; kind: SessionClose } {
  const kind = sessions.closeOf(date);
  const early = sessions.calendar.earlyCloses?.time ?? EARLIEST_CLOSE;
  return { time: kind === 'regular' ? REGULAR_CLOSE : early, kind };
}
