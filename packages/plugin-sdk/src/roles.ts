// Which loaded plug-ins the admin's source roles use (requirements 04, 15). Plug-ins suggest a
// role on the first run of each data kind; after that a plug-in without a role is not used: it
// is neither fetched from nor checked.
import type { LoadedPlugins } from './registry';
import type { PluginInfo } from './types';

/** The data kind a plug-in kind's roles are kept under. */
export const DATA_KIND = { bar: 'bars', series: 'series', fx: 'fx', issuer: 'issuer' } as const;
export type DataKind = (typeof DATA_KIND)[keyof typeof DATA_KIND];

export const dataKindOf = (info: Pick<PluginInfo, 'kind'>): DataKind | undefined =>
  DATA_KIND[info.kind as keyof typeof DATA_KIND];

type Role = { dataKind: string; pluginKey: string };
const hasRole = (info: PluginInfo, roles: Role[]) =>
  roles.some((r) => r.pluginKey === info.key && r.dataKind === dataKindOf(info));

/** Loaded data plug-ins without a role (not used until the admin assigns one). */
export function unassigned(infos: PluginInfo[], roles: Role[]): PluginInfo[] {
  return infos.filter((i) => dataKindOf(i) !== undefined && !hasRole(i, roles));
}

/** Only the data plug-ins that have a role; other kinds are kept as loaded. */
export function assignedOnly(plugins: LoadedPlugins, roles: Role[]): LoadedPlugins {
  const keep = <T extends { info: PluginInfo }>(list: T[]) =>
    list.filter((p) => hasRole(p.info, roles));
  return {
    ...plugins,
    bars: keep(plugins.bars),
    series: keep(plugins.series),
    fx: keep(plugins.fx),
  };
}
