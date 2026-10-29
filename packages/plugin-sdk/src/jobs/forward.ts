// The daily forward record (requirements 05, A2): for every registered version, each trading day
// since the last entry (catch-up) whose close came after registration, the decision with its
// data health, chained to the previous entry. Nothing runs before `forward_records_from` is set
// (the A1 gate). Stand-ins the primary later corrected are annotated, never edited.
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
import type { Sessions } from '@saku/data';
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
  sha256,
  standInOn,
} from '@saku/db';
import { cashRateReader } from './cash';
import type { VerifySummary } from './verify';

export interface ForwardOptions {
  runId: string;
  sessions: Sessions;
  to: TradingDate;
  standInsOff?: VerifySummary['standInsOff'];
}

export interface ForwardSummary {
  skipped?: string;
  appended: number;
  safeStateDays: number;
  annotations: number;
  /** Today's decisions, for the log (and the alerts, later in A2). */
  today: { version: string; allocation: string; dataStatus: string; reasons: string[] }[];
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
  const summary: ForwardSummary = { appended: 0, safeStateDays: 0, annotations: 0, today: [] };
  const from = await getSetting(db, 'forward_records_from');
  if (!from) return { ...summary, skipped: 'forward records not started (forward_records_from)' };

  const { symbolIds, loadRows, barsOf } = await reader(db);
  const cashRate = await cashRateReader(db);

  /** Each ticker's grade on the date: the canonical bar's status (set by every verify run). */
  const healthOn = async (rows: Rows, date: TradingDate) => {
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
  };

  for (const version of await allVersions(db)) {
    const strategy = Strategy.parse(JSON.parse(version.canonicalJson).strategy);
    const deps = dependencies(strategy);
    const last = await lastEntry(db, version.id);
    const start = last ? last.date : from;
    const dates = o.sessions
      .between(start, o.to)
      .filter((d) => (!last || d > last.date) && d >= from)
      // Only closes after registration: the record never starts in the past.
      .filter((d) => zonedInstant(d, '16:00', 'America/New_York') > version.registeredAt);

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

    // A stand-in the primary has since corrected: would the day's decision have differed?
    for (const off of o.standInsOff ?? []) {
      if (!deps.includes(off.ticker)) continue;
      const recorded = (await forwardRecord(db, version.id)).find((e) => e.date === off.date);
      if (!recorded) continue;
      const bars = barsOf(await loadRows(deps, off.date));
      const now = forwardDecision(strategy, off.date, bars, allGreen(deps));
      await annotate(db, {
        versionId: version.id,
        date: off.date,
        kind: 'stand_in_corrected',
        detail: {
          ticker: off.ticker,
          deviation: off.deviation,
          recordedAllocation: recorded.allocation,
          correctedAllocation: now.allocation,
          differs: now.allocation !== recorded.allocation,
        },
        runId: o.runId,
      });
      summary.annotations++;
    }
  }
  return summary;
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
  /** Versions the current engine could not evaluate at all (nothing annotated for them). */
  errors: { version: string; error: string }[];
}

/**
 * Requirements A2: the current engine must reproduce every recorded decision, or the difference
 * is annotated. Each version is evaluated once over today's canonical bars (the engine is causal,
 * so each recorded day reads only bars up to that day), and only the engine's output is compared:
 * health was graded and recorded then. A difference can come from the engine or from data
 * corrected since; the annotation names the code version. Skipped: safe-state days that recorded
 * no signals (nothing to reproduce) and days a corrected stand-in already explains.
 */
export async function recompute(
  db: Db,
  o: { runId: string | null; code: string },
): Promise<RecomputeSummary> {
  const summary: RecomputeSummary = { checked: 0, differences: [], errors: [] };
  const { loadRows, barsOf } = await reader(db);
  for (const version of await allVersions(db)) {
    const record = await forwardRecord(db, version.id);
    if (record.length === 0) continue;
    const strategy = Strategy.parse(JSON.parse(version.canonicalJson).strategy);
    const deps = dependencies(strategy);
    let days: Map<TradingDate, StrategyDay>;
    try {
      const bars = barsOf(await loadRows(deps, record.at(-1)!.date));
      days = new Map(evaluate(strategy, bars).map((d) => [d.date, d]));
    } catch (e) {
      // Not an engine difference to annotate day by day: a failure to report.
      summary.errors.push({
        version: version.name,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const seen = new Set(
      (await annotationsOf(db, version.id, 'recomputed')).map((a) => `${a.date} ${a.fingerprint}`),
    );
    const explained = new Set(
      (await annotationsOf(db, version.id, 'stand_in_corrected')).map((a) => a.date),
    );
    for (const e of record) {
      const recorded = JSON.parse(e.payload) as {
        signals?: Record<string, boolean | number> | null;
      };
      if (e.safeStateApplied && !recorded.signals) continue;
      if (explained.has(e.date)) continue;
      summary.checked++;
      const now = days.get(e.date);
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
