// The A1 gate (stage-a, pre-registered): computed from each trading day's latest daily run.
//   - the primary succeeds on every trading day (after retries);
//   - at least one secondary is available on >= 95% of days;
//   - layer B passes on >= 99% of days where a secondary was available;
//   - layer C passes on >= 99% of days;
//   - every failure explained (the non-green results are listed for that).
import { type Db, activeSymbols, schema } from '@saku/db';
import { and, asc, eq } from 'drizzle-orm';

export const GATE = { secondaryAvailability: 0.95, layerB: 0.99, layerC: 0.99 } as const;

export interface SpikeDay {
  date: string;
  runId: string;
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
  o: { from?: string; to?: string } = {},
): Promise<SpikeReport> {
  const roles = await db
    .select()
    .from(schema.sourceRoles)
    .where(eq(schema.sourceRoles.dataKind, 'bars'));
  const primary = roles.find((r) => r.role === 'primary')?.pluginKey;
  const secondaries = roles.filter((r) => r.role === 'secondary').map((r) => r.pluginKey);
  const symbols = await activeSymbols(db);

  // The latest daily run for each target date.
  const runs = await db
    .select()
    .from(schema.jobRuns)
    .where(eq(schema.jobRuns.jobType, 'daily'))
    .orderBy(asc(schema.jobRuns.startedAt));
  const latest = new Map<string, string>();
  for (const r of runs) {
    const date = r.datesProcessed?.[0];
    if (date && (!o.from || date >= o.from) && (!o.to || date <= o.to)) latest.set(date, r.id);
  }

  const days: SpikeDay[] = [];
  for (const [date, runId] of [...latest].sort()) {
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
