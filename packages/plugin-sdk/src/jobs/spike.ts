// The A1 gate (stage-a, pre-registered): computed over every NYSE session in the range (from
// the calendar), each from its latest daily run that finished and stored check results for it.
// A session without one counts as failed everywhere (reason `no_run`): the primary did not
// succeed, no secondary was available, layers B and C did not pass. A run that finished as failed
// (incomplete, e.g. a secondary down) still counts by what it stored, so a secondary's outage is
// measured as secondary availability, not as a primary failure. Unknown never reads as passing.
//   - the primary succeeds on every trading day (after retries);
//   - at least one secondary is available on >= 95% of days;
//   - layer B passes on >= 99% of days where a secondary was available;
//   - layer C passes on >= 99% of days;
//   - every failure explained (the non-green results are listed for that).
import type { TradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import { type Db, activeSymbols, schema } from '@saku/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

export const GATE = { secondaryAvailability: 0.95, layerB: 0.99, layerC: 0.99 } as const;

export interface SpikeDay {
  date: string;
  /** The run the day is measured from; null: no finished daily run stored results for it. */
  runId: string | null;
  /** Why the day failed without being measured. */
  reason?: 'no_run';
  primaryOk: boolean;
  /** Secondary source -> it had the day's bar for every symbol it covers. */
  available: Record<string, boolean>;
  layerBPass: boolean;
  layerCPass: boolean;
  nonGreen: {
    layer: string;
    check: string;
    source: string | null;
    status: string;
    message: string | null;
  }[];
}

export interface SpikeReport {
  days: SpikeDay[];
  primaryOkDays: number;
  availability: Record<string, number>;
  layerB: { days: number; passed: number };
  layerC: { days: number; passed: number };
  passed: boolean;
}

export async function spikeReport(
  db: Db,
  o: { sessions: Sessions; from?: TradingDate; to?: TradingDate },
): Promise<SpikeReport> {
  const roles = await db
    .select()
    .from(schema.sourceRoles)
    .where(eq(schema.sourceRoles.dataKind, 'bars'));
  const primary = roles.find((r) => r.role === 'primary')?.pluginKey;
  const secondaries = roles.filter((r) => r.role === 'secondary').map((r) => r.pluginKey);
  const symbols = await activeSymbols(db);

  // Finished daily runs, oldest first; for each target date the latest one that stored results.
  const runs = await db
    .select()
    .from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.jobType, 'daily'), isNotNull(schema.jobRuns.finishedAt)))
    .orderBy(asc(schema.jobRuns.startedAt));
  const latest = new Map<string, string>();
  for (const r of runs) {
    const date = r.datesProcessed?.[0];
    if (!date) continue;
    const [stored] = await db
      .select({ id: schema.checkResults.id })
      .from(schema.checkResults)
      .where(and(eq(schema.checkResults.runId, r.id), eq(schema.checkResults.date, date)))
      .limit(1);
    if (stored) latest.set(date, r.id);
  }

  // The range: given, else from the first to the last measured date. Every session in it counts.
  const measured = [...latest.keys()].sort();
  const from = o.from ?? measured[0];
  const to = o.to ?? measured.at(-1);
  const sessions = from && to && from <= to ? o.sessions.between(from, to) : [];

  const days: SpikeDay[] = [];
  for (const date of sessions) {
    const runId = latest.get(date);
    if (!runId) {
      days.push({
        date,
        runId: null,
        reason: 'no_run',
        primaryOk: false,
        available: Object.fromEntries(secondaries.map((s) => [s, false])),
        layerBPass: false,
        layerCPass: false,
        nonGreen: [],
      });
      continue;
    }
    const rs = await db
      .select()
      .from(schema.checkResults)
      .where(and(eq(schema.checkResults.runId, runId), eq(schema.checkResults.date, date)));
    const live = symbols.filter((s) => !s.inceptionDate || s.inceptionDate <= date);
    const primaryBars = rs.filter(
      (r) => r.checkName === 'bar_valid' && r.source === primary && r.status !== 'red',
    );
    const available: Record<string, boolean> = {};
    for (const s of secondaries) {
      const closes = rs.filter((r) => r.checkName === 'close_match' && r.source === s);
      available[s] = closes.length > 0 && closes.every((r) => r.message !== 'no secondary bar');
    }
    const layer = (l: string) => rs.filter((r) => r.layer === l);
    days.push({
      date,
      runId,
      primaryOk: primaryBars.length >= live.length,
      available,
      layerBPass: layer('B').every((r) => r.status === 'green'),
      layerCPass: layer('C').every((r) => r.status === 'green'),
      nonGreen: rs
        .filter((r) => r.status !== 'green')
        .map((r) => ({
          layer: r.layer,
          check: r.checkName,
          source: r.source,
          status: r.status,
          message: r.message,
        })),
    });
  }

  const n = days.length;
  const availability: Record<string, number> = {};
  for (const s of secondaries)
    availability[s] = n ? days.filter((d) => d.available[s]).length / n : 0;
  // Layer B counts the days a secondary was available (a day without a run had none).
  const withSecondary = days.filter((d) => Object.values(d.available).some(Boolean));
  const layerB = {
    days: withSecondary.length,
    passed: withSecondary.filter((d) => d.layerBPass).length,
  };
  const layerC = { days: n, passed: days.filter((d) => d.layerCPass).length };
  const primaryOkDays = days.filter((d) => d.primaryOk).length;
  const passed =
    n > 0 &&
    primaryOkDays === n &&
    Object.values(availability).some((a) => a >= GATE.secondaryAvailability) &&
    layerB.days > 0 &&
    layerB.passed / layerB.days >= GATE.layerB &&
    layerC.passed / layerC.days >= GATE.layerC;
  return { days, primaryOkDays, availability, layerB, layerC, passed };
}
