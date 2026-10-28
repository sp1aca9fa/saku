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
  forwardDecision,
  zonedInstant,
} from '@saku/core';
import type { Sessions } from '@saku/data';
import {
  type Db,
  type Version,
  activeSymbols,
  allVersions,
  annotate,
  appendForward,
  canonicalBars,
  forwardRecord,
  getSetting,
  lastEntry,
  latestHealth,
  schema,
  seriesPointInTime,
  standInOn,
} from '@saku/db';
import type { VerifySummary } from './verify';
import { asc, eq } from 'drizzle-orm';

/** The USD cash rate series (FRED 3-month T-bill, percent a year). */
export const CASH_SERIES = 'DTB3';

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

  const symbolIds = new Map((await activeSymbols(db)).map((s) => [s.ticker, s.id]));
  const [seriesRole] = await db
    .select()
    .from(schema.sourceRoles)
    .where(eq(schema.sourceRoles.dataKind, 'series'))
    .orderBy(asc(schema.sourceRoles.position));
  const cash = seriesRole ? await seriesPointInTime(db, CASH_SERIES, seriesRole.pluginKey) : null;
  // Known before the session opens (no look-ahead).
  const cashRate = (date: TradingDate) =>
    cash?.asOf(date, zonedInstant(date, '09:30', 'America/New_York'))?.value ?? 0;

  const loadRows = async (tickers: string[], to: TradingDate) => {
    const out: Record<string, Awaited<ReturnType<typeof canonicalBars>>> = {};
    for (const t of tickers) {
      const id = symbolIds.get(t);
      if (id !== undefined) out[t] = await canonicalBars(db, id, to);
    }
    return out;
  };
  const barsOf = (rows: Awaited<ReturnType<typeof loadRows>>) =>
    Object.fromEntries(Object.entries(rows).map(([t, list]) => [t, list.map(toRaw)]));
  /** Each ticker's grade on the date: the canonical bar's status (set by every verify run). */
  const healthOn = async (rows: Awaited<ReturnType<typeof loadRows>>, date: TradingDate) => {
    const out: Record<string, TickerHealth> = {};
    for (const [t, list] of Object.entries(rows)) {
      const bar = list.at(-1);
      if (!bar || bar.date !== date || !bar.status) continue;
      const id = symbolIds.get(t)!;
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

    for (const date of dates) {
      const rows = await loadRows(deps, date);
      const bars = barsOf(rows);
      const decision = forwardDecision(strategy, date, bars, await healthOn(rows, date));
      const equity = await forwardEquity(db, version, strategy, bars, cashRate, {
        date,
        signals: decision.signals ?? {},
        allocation: decision.allocation,
        holdings: decision.holdings,
        ties: decision.ties,
      });
      await appendForward(
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
      const healthy = Object.fromEntries(
        deps.map((t) => [t, { status: 'green' as const, reasons: [] }]),
      );
      const now = forwardDecision(strategy, off.date, bars, healthy);
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

/** The record's own equity: its recorded holdings traded as the strategy executes, from 1. */
async function forwardEquity(
  db: Db,
  version: Version,
  strategy: Strategy,
  bars: Record<string, RawBar[]>,
  cashRate: (date: TradingDate) => number,
  today: StrategyDay,
): Promise<number | null> {
  const days: StrategyDay[] = (await forwardRecord(db, version.id)).map((e) => ({
    date: e.date,
    signals: {},
    allocation: e.allocation,
    holdings: e.holdings as StrategyDay['holdings'],
    ties: [],
  }));
  days.push(today);
  try {
    return backtest({ strategy, days, bars, cashRate }).points.at(-1)!.equity;
  } catch {
    // A holding without a bar that day: the equity is unknown, not guessed.
    return null;
  }
}
