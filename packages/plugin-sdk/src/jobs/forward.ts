// The daily forward record (requirements 05, A2): for every registered version, each trading day
// since the last entry (catch-up) whose close came after registration, the decision with its
// data health, chained to the previous entry. Nothing runs before `forward_records_from` is set
// (the A1 gate). Stand-ins the primary later corrected are annotated, never edited, by their own
// step (`annotateStandInCorrections`), caught up from the database before every recompute.
import {
  SAFE_STATE,
  type LookbackFlag,
  type RawBar,
  type StandInPrice,
  type StrategyDay,
  Strategy,
  StoredStrategy,
  type TickerHealth,
  type TradingDate,
  backtest,
  dependencies,
  strategyTickers,
  canonicalJson,
  evaluate,
  forwardDecision,
  CASH_BASE,
  type EquityPoint,
  mayHoldCashBase,
  NEAR_TIE,
  zonedInstant,
} from '@saku/core';
import { type SessionClose, type Sessions, TOLERANCE } from '@saku/data';
import {
  type Db,
  type ForwardEntry,
  type Recheck,
  type RecheckDecision,
  RECHECK_MAX_MINUTES,
  activeSymbols,
  allVersions,
  annotate,
  annotationsOf,
  appendForward,
  canonicalBars,
  closedStandIns,
  closeRecheck,
  forwardRecord,
  getSetting,
  insertRecheck,
  isOpenStandIn,
  lastEntry,
  latestCloseOf,
  latestHealth,
  openRechecks,
  recheckMinutes,
  resolvedStandIns,
  sha256,
  standInOn,
  unresolvedStandIns,
} from '@saku/db';
import { type BaseCurrencyInputs, baseCurrencyInputs } from './base-currency';
import { cashRateReader } from './cash';
import { DAILY_OVERLAP } from './ingest';
import { firstGrading, recheckDeadline, regrade } from './recheck';

export interface ForwardOptions {
  runId: string;
  sessions: Sessions;
  to: TradingDate;
  /**
   * The forward step's clock (requirements 04 "Red re-check before execution"): whether a red
   * day's grading is past its re-check deadline (no look-ahead), and the time a re-checked day's
   * final instruction is decided (`finalDecidedAt`). Default: the system clock.
   */
  now?: Date;
  /**
   * When the run started its work, after the jobs lock (`RunOptions.start`): whether this run is
   * the last check before a deadline (the next tick comes before start + period). Default: `now`.
   */
  start?: Date;
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
  /** Days red at their first grading waiting for a re-check (no entry yet), opened or still open. */
  rechecks: { version: string; date: TradingDate; deadline: string; opened: boolean }[];
  /** Re-checks this run closed, each with the entry it appended. */
  finals: { version: string; date: TradingDate; outcome: 'cleared' | 'safe_state' | 'late' }[];
  /** Anything else that kept a version's days from being recorded (the run is incomplete). */
  problems: string[];
  /**
   * Days recorded on data graded yellow outside the strategy's own grade (a CASH_BASE value read
   * on an FX 2 to 5 sessions late or from a single source): computed with a visible warning
   * (requirements 04 yellow), logged; the run stays complete.
   */
  warnings: string[];
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
  // The stored-version schema: a limit added after registration (the cost limits, C2) never
  // refuses a version registered before it.
  const parsed = StoredStrategy.safeParse(stored);
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

type Decision = ReturnType<typeof forwardDecision>;

/** A decision as a re-check row keeps it (the provisional message's fallback). */
const keptDecision = (d: Decision): RecheckDecision => ({
  allocation: d.allocation,
  holdings: d.holdings,
  dataStatus: d.dataStatus,
  reasons: d.reasons,
  signals: d.signals,
  ties: d.ties,
});

/**
 * A re-check row's kept decision read back, or null when it is not one `keptDecision` writes
 * (never recorded on a guess): the safe state with its holdings, a red status and its reasons.
 */
export function readKeptDecision(value: unknown): RecheckDecision | null {
  const d = value as Partial<Record<keyof RecheckDecision, unknown>> | null;
  if (!d || typeof d !== 'object') return null;
  if (d.allocation !== SAFE_STATE || d.dataStatus !== 'red') return null;
  if (!Array.isArray(d.holdings) || d.holdings.length === 0) return null;
  for (const h of d.holdings as unknown[]) {
    const x = h as { ticker?: unknown; weight?: unknown } | null;
    if (!x || typeof x.ticker !== 'string' || typeof x.weight !== 'number') return null;
    if (!Number.isFinite(x.weight)) return null;
  }
  if (!Array.isArray(d.reasons) || !d.reasons.every((r) => typeof r === 'string')) return null;
  if (!Array.isArray(d.ties) || !d.ties.every((r) => typeof r === 'string')) return null;
  if (d.signals !== null && (typeof d.signals !== 'object' || Array.isArray(d.signals)))
    return null;
  return d as RecheckDecision;
}

/**
 * The forward step (requirements 05): every registered version's days since its last entry, in
 * order, each decided on the canonical bars up to it with its data health. A day red at its first
 * grading (requirements 04 "Red re-check before execution"; the rules are in `recheck.ts`):
 * - with a later hourly check before its deadline: a re-check is opened (no entry yet), and the
 *   version's later days wait for it (the chain order);
 * - otherwise (a late run): the safe-state entry at once, as before, the re-check recorded as
 *   `not_rechecked` (its alert says so).
 * An open re-check is graded again by every run: cleared, the normal decision; still red at the
 * last check before the deadline, the safe state; past the deadline, the safe state as the
 * provisional message gave it. The entry then carries `finalDecidedAt` (the forward step's clock:
 * when the final instruction was decided; the same run sends it right after, and the time it was
 * sent is a `red_recheck_sent` annotation, `sendRecheckAlerts`) in its hashed text, and the first
 * red grading is an annotation (`red_recheck`), never an edit; both commit together with the
 * closed re-check.
 */
export async function forward(db: Db, o: ForwardOptions): Promise<ForwardSummary> {
  const summary: ForwardSummary = {
    appended: 0,
    safeStateDays: 0,
    today: [],
    errors: [],
    rechecks: [],
    finals: [],
    problems: [],
    warnings: [],
  };
  const from = await getSetting(db, 'forward_records_from');
  if (!from) return { ...summary, skipped: 'forward records not started (forward_records_from)' };

  const { symbolIds, loadRows, barsOf } = await reader(db, o.sessions);
  const cashRate = await cashRateReader(db);
  // Read only for a version that may hold CASH_BASE (`forwardEquity`): the deposit rate point in
  // time, and an FX value refused when stale or disputed (`baseCurrencyInputs`).
  const base = await baseCurrencyInputs(db, {
    pointInTime: true,
    guard: { sessions: o.sessions },
  });
  const clock = o.now ?? new Date();
  const clockIso = clock.toISOString();
  const startMs = (o.start ?? clock).getTime();
  // The deadline's setting: a stored value that does not parse opens no re-check (the safe
  // state at once, as before C16), and the run names it.
  const minutes = await recheckMinutes(db);
  if ('invalid' in minutes) {
    summary.problems.push(
      `red_recheck_minutes_before_open is ${minutes.invalid}, not whole minutes from 0 to ` +
        `${RECHECK_MAX_MINUTES}: a red day gets the safe state at once (no re-check) until it is fixed`,
    );
  }
  const deadlineOf = (date: TradingDate) =>
    'minutes' in minutes ? recheckDeadline(date, o.sessions, minutes.minutes) : undefined;

  const healthOn = (rows: Rows, date: TradingDate) =>
    healthOf(db, symbolIds, rows, date, o.sessions);

  for (const version of await allVersions(db)) {
    const parsed = parseVersion(version);
    if ('error' in parsed) {
      summary.errors.push({ version: `${version.name} (${version.id})`, error: parsed.error });
      continue;
    }
    const { strategy } = parsed;
    const name = `${version.name} (${version.id})`;
    const deps = dependencies(strategy);
    const last = await lastEntry(db, version.id);
    // At most one open re-check, on the day after the last entry (the forward step opens one only
    // there and appends nothing after it): anything else is not what this step writes, and the
    // version is left for the admins rather than recorded around it.
    const open = await openRechecks(db, version.id);
    /** The open re-check, until this run closes it. */
    let pending: Recheck | undefined = open[0];
    if (open.length > 1 || (pending && last && pending.date <= last.date)) {
      summary.problems.push(
        `${name}: open red re-checks ${open.map((r) => r.date).join(', ')} do not follow the ` +
          `last entry (${last?.date ?? 'none'}); nothing recorded for the version`,
      );
      continue;
    }
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
    // The safe state's tickers too: the record's equity holds them on a session without a
    // decision (core `strategyTickers`); only the dependencies grade the day.
    const all = dates.length > 0 ? await loadRows(strategyTickers(strategy), o.to) : {};
    // The record so far, read once; each appended entry joins it as stored (the inserted row).
    const prior: StrategyDay[] =
      dates.length > 0 ? (await forwardRecord(db, version.id)).map(asDay) : [];
    for (const date of dates) {
      const rows = upTo(all, date);
      const bars = barsOf(rows);
      const graded = Object.fromEntries(deps.map((t) => [t, rows[t]]).filter(([, r]) => r));
      let decision: Decision = forwardDecision(strategy, date, bars, await healthOn(graded, date));
      /** The open re-check this entry closes, and how. */
      let closes: { row: Recheck; outcome: 'cleared' | 'safe_state' | 'late' } | undefined;
      /** A red first grading recorded at once (no hourly check left before its deadline). */
      let notRechecked: { deadline: string; provisional: RecheckDecision } | undefined;
      if (pending && date === pending.date) {
        const outcome = regrade({
          red: decision.safeStateApplied,
          start: startMs,
          clock: clock.getTime(),
          deadline: Date.parse(pending.deadline),
        });
        if (outcome === 'pending') {
          summary.rechecks.push({ version: name, date, deadline: pending.deadline, opened: false });
          break;
        }
        if (outcome === 'late') {
          // The instruction in force at the deadline: the provisional message's fallback.
          const kept = readKeptDecision(pending.provisional);
          if (!kept) {
            summary.problems.push(
              `${name} ${date}: the re-check's provisional decision does not read back; ` +
                'nothing recorded (never on a guess)',
            );
            break;
          }
          decision = { date, ...kept, safeStateApplied: true };
        }
        closes = { row: pending, outcome };
        pending = undefined;
      } else if (pending) {
        // The open re-check is on the first day after the last entry, so it comes first and
        // stops the loop until it is final; any other order is not what this step writes.
        summary.problems.push(
          `${name}: ${date} comes before the open red re-check of ${pending.date}; nothing recorded`,
        );
        break;
      } else if (decision.safeStateApplied) {
        const deadline = deadlineOf(date);
        if (deadline !== undefined) {
          const provisional = keptDecision(decision);
          if (
            firstGrading({
              start: startMs,
              clock: clock.getTime(),
              deadline: Date.parse(deadline),
            }) === 'open'
          ) {
            await insertRecheck(db, {
              versionId: version.id,
              date,
              firstRedAt: clockIso,
              firstRunId: o.runId,
              deadline,
              provisional,
            });
            summary.rechecks.push({ version: name, date, deadline, opened: true });
            break;
          }
          notRechecked = { deadline, provisional };
        }
      }
      const equity = forwardEquity(
        strategy,
        prior,
        bars,
        cashRate,
        {
          date,
          signals: decision.signals ?? {},
          allocation: decision.allocation,
          holdings: decision.holdings,
          ties: decision.ties,
        },
        // Only a version registered before C2's cost freeze reads an omitted cost as 0.
        !version.costsResolved,
        // Recorded with an unknown equity, and reported: the run is not a silent success.
        (reason) => summary.problems.push(`${name} ${date}: equity unknown: ${reason}`),
        base,
        // Recorded, with the FX warning reported (a single-source or late FX is never green).
        (reason) => summary.warnings.push(`${name} ${date}: FX warning: ${reason}`),
      );
      const input = {
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
          // What was finally signaled after a re-check, with when it was decided (C16; in the
          // hashed text; the time it was sent is the `red_recheck_sent` annotation).
          ...(closes && { finalDecidedAt: clockIso }),
        },
      };
      // The entry and what records it elsewhere commit together (or neither does).
      const entry = await db.transaction(async (tx) => {
        const appended = await appendForward(tx, version, input, o.runId);
        if (closes) {
          const { row, outcome } = closes;
          await closeRecheck(tx, row.id, { finalAt: clockIso, finalRunId: o.runId, outcome });
          // The first red grading as a note (requirements 04: kept as a note, never an edit).
          await annotate(tx, {
            versionId: version.id,
            date,
            kind: 'red_recheck',
            detail: {
              firstRedAt: row.firstRedAt,
              reasons: row.reasons,
              deadline: row.deadline,
              outcome,
              finalDecidedAt: clockIso,
            },
            runId: o.runId,
          });
        }
        if (notRechecked) {
          await insertRecheck(tx, {
            versionId: version.id,
            date,
            firstRedAt: clockIso,
            firstRunId: o.runId,
            ...notRechecked,
            notRechecked: { finalRunId: o.runId },
          });
        }
        return appended;
      });
      prior.push(asDay(entry));
      summary.appended++;
      if (decision.safeStateApplied) summary.safeStateDays++;
      if (closes) summary.finals.push({ version: name, date, outcome: closes.outcome });
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

/** A recorded day whose stand-in correction waits, and the unresolved stand-in it waits for. */
export interface Deferred {
  versionId: string;
  /** `name (id)`, for the log and the admins. */
  version: string;
  date: TradingDate;
  blocking: { ticker: string; date: TradingDate };
}

export interface StandInCorrectionSummary {
  /** Annotations added by this call. */
  annotations: number;
  /**
   * Recorded days whose correction waits for an unresolved stand-in (see `standInCorrections`),
   * once per version and date, with the stand-in it waits for: annotated by a later run once the
   * primary has replaced it. Recompute skips them meanwhile (`RecomputeOptions.waiting`).
   */
  deferred: Deferred[];
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
 * <= the entry's date; the primary's bar is there now) with the day's health as graded now
 * (`healthOf`), so a day still red stays in the safe state in the comparison.
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
  sessions: Sessions,
): Promise<StandInCorrectionSummary> {
  const summary: StandInCorrectionSummary = { annotations: 0, deferred: [], errors: [] };
  const corrected = (await resolvedStandIns(db)).filter(
    (s) => s.deviation !== null && s.deviation > TOLERANCE.close,
  );
  if (corrected.length === 0) return summary;
  const unresolved = await unresolvedStandIns(db);
  const { symbolIds, loadRows, barsOf } = await reader(db, sessions);
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
    for (const d of pending.deferred) {
      summary.deferred.push({
        versionId: version.id,
        version: `${version.name} (${version.id})`,
        ...d,
      });
    }
    for (const { standIn, recorded } of pending.annotate) {
      const rows = await loadRows(deps, recorded.date);
      // The day's health as graded now (the primary's bar is there now): a day still red for
      // another reason (a red day in the lookback, say) stays in the safe state, so the corrected
      // allocation never claims a normal signal the data does not allow.
      const health = await healthOf(db, symbolIds, rows, recorded.date, sessions);
      const now = forwardDecision(strategy, recorded.date, barsOf(rows), health);
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
          // The primary arrived after an admin had closed it (rule 5): said so.
          ...(standIn.closedAt && { closedAt: standIn.closedAt }),
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

export interface StandInClosureSummary {
  /** Annotations added by this call. */
  annotations: number;
  /** As `StandInCorrectionSummary.errors`: nothing annotated on a guess; the caller reports. */
  errors: string[];
}

/**
 * The closing step (requirements 04 stand-in rule 5: a stand-in the primary never replaces is
 * closed by an admin with a reason; the record keeps the stand-in price; 05: forward records are
 * append-only). For every registered version that parses, each closed stand-in on a ticker it
 * depends on gives one `stand_in_closed` annotation (ticker, stand-in date, the reason and when
 * it was closed, the recorded allocation) on every recorded entry that used it while it was open
 * (`standInClosures`). Nothing is recomputed: the price the entries used stays the price. Caught
 * up from `stand_ins`, idempotent; the owner is told by `sendStandInClosures`.
 */
export async function annotateStandInClosures(
  db: Db,
  runId: string | null,
): Promise<StandInClosureSummary> {
  const summary: StandInClosureSummary = { annotations: 0, errors: [] };
  const closed = await closedStandIns(db);
  if (closed.length === 0) return summary;
  const errors = new Set<string>();
  for (const version of await allVersions(db)) {
    const parsed = parseVersion(version);
    if ('error' in parsed) continue;
    const pending = standInClosures({
      version: `${version.name} (${version.id})`,
      deps: dependencies(parsed.strategy),
      record: await forwardRecord(db, version.id),
      closed,
      annotated: (await annotationsOf(db, version.id, 'stand_in_closed')).map((a) => {
        const d = a.detail as { ticker?: unknown; standInDate?: unknown; closedAt?: unknown };
        return { date: a.date, ticker: d.ticker, standInDate: d.standInDate, closedAt: d.closedAt };
      }),
    });
    for (const e of pending.errors) errors.add(e);
    for (const { standIn, recorded } of pending.annotate) {
      await annotate(db, {
        versionId: version.id,
        date: recorded.date,
        kind: 'stand_in_closed',
        detail: {
          ticker: standIn.ticker,
          standInDate: standIn.date,
          reason: standIn.closeReason,
          closedAt: standIn.closedAt,
          recordedAllocation: recorded.allocation,
        },
        runId,
      });
      summary.annotations++;
    }
  }
  summary.errors = [...errors];
  return summary;
}

/** A closed stand-in as `closedStandIns` reads it. */
export interface ClosedStandIn {
  ticker: string;
  date: TradingDate;
  /** The run that first recorded it (null for rows stored outside a run). */
  runId: string | null;
  createdAt: string;
  closedAt: string | null;
  closeReason: string | null;
  /** The close before this one (a re-close after its price changed), null for the first. */
  previousClosedAt?: string | null;
}

/**
 * The closure annotations still to write for one version (rule 5 with 05's append-only record):
 * for each close of a stand-in on a ticker the version depends on, every recorded entry dated on
 * or after its date that used it while it was open, not annotated yet for that entry date,
 * ticker, stand-in date and close. "Used it" is decided as for corrections (`standInCorrections`):
 * appended in the run that first recorded it, it did; otherwise by time, appended at or after it
 * was first recorded and before it was closed (instants). A re-close (its price changed after an
 * earlier close, `previousClosedAt`) covers the entries appended from the earlier close up to it,
 * by time only: those read the stand-in since, at the closed or the changed price. Entries
 * appended after a close were decided knowing it was closed and are not annotated for it (a
 * primary arriving later still annotates them as a correction, through the resolution). A
 * timestamp that is not an instant leaves that unknown: an error, nothing annotated on a guess.
 */
export function standInClosures(o: {
  version: string;
  deps: string[];
  record: Pick<ForwardEntry, 'date' | 'allocation' | 'createdAt' | 'runId'>[];
  closed: ClosedStandIn[];
  annotated: { date: string; ticker: unknown; standInDate: unknown; closedAt: unknown }[];
}): {
  annotate: {
    standIn: ClosedStandIn & { closedAt: string; closeReason: string };
    recorded: Pick<ForwardEntry, 'date' | 'allocation'>;
  }[];
  errors: string[];
} {
  const done = new Set(
    o.annotated.map(
      (a) => `${a.date} ${String(a.ticker)} ${String(a.standInDate)} ${String(a.closedAt)}`,
    ),
  );
  const out: ReturnType<typeof standInClosures> = { annotate: [], errors: [] };
  for (const s of o.closed) {
    if (!o.deps.includes(s.ticker)) continue;
    // The triggers of migration 0011 refuse a close without its reason; checked all the same.
    if (s.closedAt === null || s.closeReason === null || s.closeReason.trim() === '') {
      out.errors.push(`${s.ticker} ${s.date}: closed without a reason; its close is not annotated`);
      continue;
    }
    const standIn = { ...s, closedAt: s.closedAt, closeReason: s.closeReason };
    const reclose = (s.previousClosedAt ?? null) !== null;
    const from = instantOf(reclose ? s.previousClosedAt! : s.createdAt);
    const until = instantOf(s.closedAt);
    let unplaced = false;
    for (const recorded of o.record) {
      if (recorded.date < s.date) continue;
      if (done.has(`${recorded.date} ${s.ticker} ${s.date} ${s.closedAt}`)) continue;
      let used: boolean;
      if (!reclose && recorded.runId !== null && recorded.runId === s.runId) used = true;
      else if (Number.isNaN(from) || Number.isNaN(until)) {
        if (!unplaced) {
          out.errors.push(
            `${s.ticker} ${s.date}: the stand-in's timestamps are not instants ` +
              `(${reclose ? `previous close ${s.previousClosedAt}` : `created ${s.createdAt}`}, ` +
              `closed ${s.closedAt}); its close is not annotated`,
          );
        }
        unplaced = true;
        continue;
      } else {
        const at = instantOf(recorded.createdAt);
        if (Number.isNaN(at)) {
          out.errors.push(
            `${o.version} ${recorded.date}: the entry's created_at (${recorded.createdAt}) is ` +
              `not an instant; the ${s.ticker} ${s.date} stand-in close is not annotated`,
          );
          continue;
        }
        used = at >= from && at < until;
      }
      if (used) out.annotate.push({ standIn, recorded });
    }
  }
  return out;
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
  /** Set when an admin had closed it before the primary arrived after all (rule 5). */
  closedAt?: string | null;
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
 * A correction waits (`deferred`, once per entry date, naming the earliest such stand-in) while
 * any ticker the version depends on has an unresolved stand-in dated on or before the entry's
 * date and on or after the version's first entry: its corrected decision would rest on a price
 * not verified yet. It is annotated by a later run, once the primary has replaced that one too.
 * An unresolved stand-in before the first entry does not hold anything back: the recorded and
 * the corrected decision read it alike, so it explains no difference between them.
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
  deferred: { date: TradingDate; blocking: { ticker: string; date: TradingDate } }[];
  errors: string[];
} {
  const done = new Set(
    o.annotated.map((a) => `${a.date} ${String(a.ticker)} ${String(a.standInDate)}`),
  );
  // The earliest unresolved stand-in among the version's tickers since its first entry: an entry
  // dated on or after it waits.
  const first = o.record[0]?.date;
  const blocking = o.unresolved
    .filter((u) => o.deps.includes(u.ticker) && first !== undefined && u.date >= first)
    .reduce<{ ticker: string; date: TradingDate } | undefined>(
      (min, u) => (min === undefined || u.date < min.date ? u : min),
      undefined,
    );
  const out: ReturnType<typeof standInCorrections> = { annotate: [], deferred: [], errors: [] };
  const waiting = new Set<string>();
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
      if (blocking && blocking.date <= recorded.date) {
        if (!waiting.has(recorded.date)) {
          waiting.add(recorded.date);
          out.deferred.push({
            date: recorded.date,
            blocking: { ticker: blocking.ticker, date: blocking.date },
          });
        }
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
 * With it, what the decision needs about the days before (`forwardDecision` applies it to the
 * tickers the signals read): the unresolved stand-ins up to the date (`openStandIns`) and the
 * re-check window's red or ungraded days (`lookbackFlags`).
 */
export async function healthOf(
  db: Db,
  symbolIds: Map<string, number>,
  rows: Rows,
  date: TradingDate,
  sessions: Sessions,
): Promise<Record<string, TickerHealth>> {
  const out: Record<string, TickerHealth> = {};
  const window = recheckWindow(sessions, date);
  for (const [t, list] of Object.entries(rows)) {
    const bar = list.at(-1);
    const id = symbolIds.get(t)!;
    let day: TickerHealth;
    if (!bar || bar.date !== date || !bar.status) {
      // No bar that day: the grade says why (a refused stand-in), else it stays `no_data`.
      const graded = await latestHealth(db, id, date);
      if (!graded || graded.status === 'green') continue;
      day = { status: graded.status, reasons: graded.reasons };
    } else {
      const reasons =
        bar.status === 'green' ? [] : ((await latestHealth(db, id, date))?.reasons ?? []);
      day = { status: bar.status, reasons };
    }
    const standIns = await openStandIns(db, id, list);
    const lookback = await lookbackFlags(db, id, list, window, date);
    out[t] = {
      ...day,
      ...(standIns.length > 0 && { standIns }),
      ...(lookback.length > 0 && { lookback }),
    };
  }
  return out;
}

/**
 * The re-check window before `date` (requirements 04 "Red in the lookback": the last 10 trading
 * days before it, the sessions every daily run grades again, `DAILY_OVERLAP`), oldest first,
 * `date` excluded. A calendar that starts inside the window gives the sessions from its start.
 */
export function recheckWindow(sessions: Sessions, date: TradingDate): TradingDate[] {
  let start: TradingDate;
  try {
    start = sessions.before(date, DAILY_OVERLAP);
  } catch {
    start = sessions.calendar.validFrom;
  }
  return sessions.between(start, date).filter((d) => d < date);
}

/**
 * The days in the re-check window that keep the ticker red (requirements 04 "Red in the
 * lookback"), as graded now (each run rewrites the grades it checks, so a day graded again as not
 * red clears by itself). The rule, per date:
 * - a canonical bar: its `bars.status` (rewritten for every canonical bar by every verify run,
 *   daily and full alike: the checks grade every session from the primary's first bar, only the
 *   stored `data_health` rows are limited to the run's window). `red` is red, NULL is ungraded,
 *   so red too ("not graded" is never clean); green and yellow are not;
 * - a session without a canonical bar (from the ticker's first bar on): red whatever is stored,
 *   since the signals read a series with that price missing. Its latest symbol grade in
 *   `data_health` names why when it is red (`red`); none at all is `ungraded`; a stored grade
 *   that is not red (an older row left by a run that stopped after removing the bar, say) is not
 *   believed: `missing`;
 * - a session before the ticker's first canonical bar was never a session for it: nothing.
 * Only the window's sessions are read: a bar on a day the market was closed is not in the series
 * the signals read (requirements 04 "Closed-day bars"; `reader` leaves such rows out and verify
 * no longer builds them), so its red grade on that day keeps no strategy red. Days before
 * `forward_records_from` are nothing special. `rows`: the ticker's canonical rows up to `date`,
 * oldest first (as `reader` returns them).
 */
export async function lookbackFlags(
  db: Db,
  symbolId: number,
  rows: Rows[string],
  window: TradingDate[],
  date: TradingDate,
): Promise<LookbackFlag[]> {
  const first = rows[0]?.date;
  if (first === undefined || window.length === 0) return [];
  const byDate = new Map(
    rows.filter((r) => r.date >= window[0]! && r.date < date).map((r) => [r.date, r]),
  );
  const out: LookbackFlag[] = [];
  for (const d of window.filter((x) => x >= first)) {
    const bar = byDate.get(d);
    if (bar) {
      if (bar.status === null) out.push({ date: d, why: 'ungraded' });
      else if (bar.status === 'red') out.push({ date: d, why: 'red' });
      continue;
    }
    const graded = await latestHealth(db, symbolId, d);
    out.push({ date: d, why: !graded ? 'ungraded' : graded.status === 'red' ? 'red' : 'missing' });
  }
  return out;
}

/**
 * Whether a stored stand-in still waits for the primary (requirements 04 stand-in rule): only
 * those are moved by the decision-margin test. Not a resolved one (the primary's bar replaced it),
 * nor one an admin closed (rule 5) while its canonical bar is still the price of its latest close:
 * its price stays and is read as it is. A closed one whose canonical bar changed is open again
 * until closed again (`@saku/db` `isOpenStandIn`; verify grades that day
 * `stand_in_closed_changed`).
 */
export { isOpenStandIn };

/**
 * The ticker's unresolved stand-in prices up to the last of `rows` (requirements 04 stand-in rule
 * items 2 and 6): every canonical stand-in bar whose stored stand-in is still open, with its band.
 */
export async function openStandIns(
  db: Db,
  symbolId: number,
  rows: Rows[string],
): Promise<StandInPrice[]> {
  const out: StandInPrice[] = [];
  for (const r of rows) {
    if (!r.standIn) continue;
    const stood = await standInOn(db, symbolId, r.date);
    if (!stood) continue;
    const latest = stood.closedAt === null ? null : await latestCloseOf(db, symbolId, r.date);
    if (!isOpenStandIn(stood, latest, r)) continue;
    // Reopened (its closed price changed): the band of the current build, not the frozen row's;
    // a bar written before 0012 has none: the widest of the row's, the close's and the layer C
    // base tolerance (the band with no independent check).
    const band =
      latest === null
        ? stood.band
        : (r.standInBand ?? Math.max(stood.band, latest.band, TOLERANCE.leverageBase));
    out.push({ date: r.date, band });
  }
  return out;
}

export type Rows = Record<string, Awaited<ReturnType<typeof canonicalBars>>>;

/**
 * Reads the canonical bars of the active universe up to a date, through `canonicalBars`: rows on
 * days the market calendar says were closed are left out (requirements 04 "Closed-day bars").
 */
export async function reader(db: Db, sessions: Sessions) {
  const symbolIds = new Map((await activeSymbols(db)).map((s) => [s.ticker, s.id]));
  const loadRows = async (tickers: string[], to: TradingDate): Promise<Rows> => {
    const out: Rows = {};
    for (const t of tickers) {
      const id = symbolIds.get(t);
      if (id !== undefined) out[t] = await canonicalBars(db, id, to, sessions);
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
 * no signals (nothing to reproduce), days a corrected stand-in already explains (the engine now
 * decides the allocation the `stand_in_corrected` annotation gives for that day), and days whose
 * correction waits (`o.waiting`).
 */
export async function recompute(
  db: Db,
  o: {
    runId: string | null;
    code: string;
    /**
     * Days whose stand-in correction waits (`annotateStandInCorrections`' `deferred`): skipped,
     * not counted as checked. Their recorded decision used a stand-in the primary has corrected,
     * so a difference now would be that correction, not the engine; it is annotated as one once
     * the stand-in it waits for is resolved.
     */
    waiting?: Pick<Deferred, 'versionId' | 'date'>[];
    /** The market calendar (canonical reads leave closed-day rows out, `reader`). */
    sessions: Sessions;
  },
): Promise<RecomputeSummary> {
  const waiting = new Set((o.waiting ?? []).map((w) => `${w.versionId} ${w.date}`));
  const summary: RecomputeSummary = { checked: 0, differences: [], errors: [] };
  const { loadRows, barsOf } = await reader(db, o.sessions);
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
      if (waiting.has(`${version.id} ${e.date}`)) continue;
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
 * `prior` is the whole record before `today`, in date order. `omittedCostsAsZero` only for a
 * version registered before C2 froze the effective costs into it (`costs_resolved` false): its
 * omitted cost is charged as 0, as when it was recorded; for any other an omitted cost fails
 * (docs/indicators.md "Costs"). When the backtest fails (a holding without a bar that day, an
 * unresolved cost) the equity is unknown, never guessed: null, and `onUnknown` gets the reason so
 * the run reports it (exported for those tests). `base`: the base currency, FX and deposit rate
 * (`baseCurrencyInputs`), passed to the backtest only for a version that may hold CASH_BASE, so
 * the FX never touches a USD-only version's equity (requirements 04: FX health affects only
 * base-currency valuation). Today's point without a value (its FX unknown or refused by the
 * guard, or an earlier conversion that could not be priced) is null, with the backtest's reason
 * and the guard's (docs/indicators.md "Base-currency cash"); a day with a usable FX after it is
 * valued. When today's value read an FX the guard graded yellow (stale by 2 to 5 sessions, or
 * single source), it is recorded and `onWarning` gets the reason.
 */
export function forwardEquity(
  strategy: Strategy,
  prior: StrategyDay[],
  bars: Record<string, RawBar[]>,
  cashRate: (date: TradingDate) => number | undefined,
  today: StrategyDay,
  omittedCostsAsZero: boolean,
  onUnknown?: (reason: string) => void,
  base?: BaseCurrencyInputs,
  onWarning?: (reason: string) => void,
): number | null {
  const days = [...prior, today];
  const inputs = cashBaseInputs(strategy, base);
  let points: EquityPoint[];
  try {
    points = backtest({ strategy, days, bars, cashRate, omittedCostsAsZero, ...inputs }).points;
  } catch (e) {
    onUnknown?.(e instanceof Error ? e.message : String(e));
    return null;
  }
  const point = points.at(-1)!;
  if (point.equity === null) {
    // The guard's reason for the session whose FX was missing (stale, disputed), when it gave one.
    const why = inputs.fxProblem?.(point.unknown!.date);
    const reason = point.unknown?.reason ?? 'unknown';
    onUnknown?.(why === undefined ? reason : `${reason}: ${why.reason}`);
    return null;
  }
  // Today's value read today's FX when CASH_BASE was held at today's close or before today's
  // trade (or the earlier point had no value, so what it held is not known): a warning grade on
  // that FX is reported.
  const readsFx = (p: EquityPoint | undefined) =>
    p !== undefined && (CASH_BASE in p.weights || p.equity === null);
  if (readsFx(point) || readsFx(points.at(-2))) {
    const problem = inputs.fxProblem?.(point.date);
    if (problem?.level === 'yellow') onWarning?.(problem.reason);
  }
  return point.equity;
}

/**
 * The base-currency inputs a version's backtest gets: all of them when it may hold CASH_BASE,
 * none otherwise (its USD equity never reads FX). The USD equity is what the record stores.
 */
export function cashBaseInputs(
  strategy: Strategy,
  base: BaseCurrencyInputs | undefined,
): BaseCurrencyInputs {
  return base && mayHoldCashBase(strategy) ? base : {};
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
