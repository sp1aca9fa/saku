// The USD cash rate series (requirements 04): the one the series sources declare in
// `provides.cashRates.USD`, from the first source in role order that declares one. No provider's
// series id is named in core.
import { type Db, schema } from '@saku/db';
import { and, asc, eq } from 'drizzle-orm';
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
  for (const role of roles) {
    const [row] = await db
      .select()
      .from(schema.pluginInfo)
      .where(and(eq(schema.pluginInfo.key, role.pluginKey), eq(schema.pluginInfo.kind, 'series')));
    const series = (row?.description as PluginInfo | undefined)?.provides.cashRates?.[currency];
    if (series) return { series, source: role.pluginKey };
  }
  return undefined;
}
