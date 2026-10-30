// The USD cash rate series (requirements 04): the one the series sources declare in
// `provides.cashRates.USD`, from the first source in role order that declares one, among the
// plug-ins the latest run loaded (a removed plug-in keeps its old row). No provider's series id is
// named in core.
import { type PointInTime, type TradingDate, zonedInstant } from '@saku/core';
import { type Db, schema, seriesPointInTime } from '@saku/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { PluginInfo } from '../types';

export async function cashSeries(
  db: Db,
  currency = 'USD',
): Promise<{ series: string; source: string } | undefined> {
  const roles = await db
    .select()
    .from(schema.sourceRoles)
    .where(eq(schema.sourceRoles.dataKind, 'series'))
    .orderBy(asc(schema.sourceRoles.position));
  const [latest] = await db
    .select({ savedAt: schema.pluginInfo.savedAt })
    .from(schema.pluginInfo)
    .orderBy(desc(schema.pluginInfo.savedAt))
    .limit(1);
  for (const role of roles) {
    const [row] = await db
      .select()
      .from(schema.pluginInfo)
      .where(and(eq(schema.pluginInfo.key, role.pluginKey), eq(schema.pluginInfo.kind, 'series')));
    if (!row || row.savedAt !== latest?.savedAt) continue;
    const series = (row?.description as PluginInfo | undefined)?.provides.cashRates?.[currency];
    if (series) return { series, source: role.pluginKey };
  }
  return undefined;
}

/** When a trading date's cash rate is read: before its session opens (no look-ahead). */
export const cashReadAt = (date: TradingDate): string =>
  zonedInstant(date, '09:30', 'America/New_York');

/** The cash series and every vintage of it, loaded once (undefined: no source declares one). */
export async function cashPointInTime(
  db: Db,
): Promise<{ series: string; source: string; values: PointInTime } | undefined> {
  const source = await cashSeries(db);
  if (!source) return undefined;
  return { ...source, values: await seriesPointInTime(db, source.series, source.source) };
}

/**
 * The USD cash rate in percent a year for a trading date, as known before its session opens (no
 * look-ahead). Unknown stays undefined: a day that needs it then has no equity, never 0%.
 */
export function cashRateOf(
  cash: { values: PointInTime } | undefined,
): (date: TradingDate) => number | undefined {
  return (date) => cash?.values.asOf(date, cashReadAt(date))?.value;
}

export async function cashRateReader(db: Db): Promise<(date: TradingDate) => number | undefined> {
  return cashRateOf(await cashPointInTime(db));
}
