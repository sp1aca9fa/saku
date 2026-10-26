import { type Db, schema } from '@saku/db';
import { findRepoRoot } from '@saku/db/env';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PoliteHttp, type PoliteHttpOptions } from './http';
import type { Logger, PluginContext, PluginInfo, PluginModule } from './types';

/**
 * Plug-in packages, loaded by path so the public repo works without the private `plugins/`
 * submodule (a missing folder is skipped).
 */
export const PLUGIN_PACKAGES = [
  { dir: 'plugins-public', private: false },
  { dir: 'plugins', private: true },
] as const;

export interface LoadedPlugins extends Required<PluginModule> {
  missing: string[];
}

export function emptyPlugins(): LoadedPlugins {
  return { bars: [], series: [], fx: [], calendars: [], missing: [] };
}

export async function loadPlugins(root: string = findRepoRoot()): Promise<LoadedPlugins> {
  const loaded = emptyPlugins();
  for (const pkg of PLUGIN_PACKAGES) {
    const entry = join(root, pkg.dir, 'src', 'index.ts');
    if (!existsSync(entry)) {
      loaded.missing.push(pkg.dir);
      continue;
    }
    const mod = (await import(pathToFileURL(entry).href)) as PluginModule;
    loaded.bars.push(...(mod.bars ?? []));
    loaded.series.push(...(mod.series ?? []));
    loaded.fx.push(...(mod.fx ?? []));
    loaded.calendars.push(...(mod.calendars ?? []));
  }
  validateInfos(allInfos(loaded));
  return loaded;
}

export function allInfos(plugins: PluginModule): PluginInfo[] {
  return [
    ...(plugins.bars ?? []),
    ...(plugins.series ?? []),
    ...(plugins.fx ?? []),
    ...(plugins.calendars ?? []),
  ].map((p) => p.info);
}

/** Keys are lowercase identifiers, unique per kind, and each source names its terms. */
export function validateInfos(infos: PluginInfo[]): void {
  const seen = new Set<string>();
  for (const info of infos) {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(info.key)) {
      throw new Error(`Plug-in key "${info.key}" must be 2-40 of a-z, 0-9 and -.`);
    }
    const id = `${info.kind}:${info.key}`;
    if (seen.has(id)) throw new Error(`Two ${info.kind} plug-ins use the key "${info.key}".`);
    seen.add(id);
    if (!info.termsUrl) throw new Error(`Plug-in "${info.key}" has no termsUrl.`);
  }
}

/** Saves every plug-in's description (done by each job run); Settings lists them from here. */
export async function savePluginInfos(db: Db, infos: PluginInfo[], now = new Date()) {
  const savedAt = now.toISOString();
  for (const info of infos) {
    await db
      .insert(schema.pluginInfo)
      .values({ key: info.key, kind: info.kind, description: info, savedAt })
      .onConflictDoUpdate({
        target: [schema.pluginInfo.key, schema.pluginInfo.kind],
        set: { description: info, savedAt },
      });
  }
}

/** A run's context for one source: its own HTTP client at the provider's pace, and its key. */
export function pluginContext(
  info: PluginInfo,
  log: Logger,
  options: { env?: Record<string, string | undefined>; http?: PoliteHttpOptions; now?: Date } = {},
): PluginContext {
  const env = options.env ?? process.env;
  const names = info.keyEnv === undefined ? [] : [info.keyEnv].flat();
  const keys: Record<string, string> = {};
  for (const name of names) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set in .env (${info.name}).`);
    keys[name] = value;
  }
  return {
    http: new PoliteHttp({ limits: info.limits, ...options.http }),
    now: options.now ?? new Date(),
    log,
    ...(names.length > 0 && { apiKey: keys[names[0]!], keys }),
  };
}
