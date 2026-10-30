import {
  type Db,
  providerUsageSince,
  pruneProviderUsage,
  recordProviderRequest,
  schema,
} from '@saku/db';
import { findRepoRoot } from '@saku/db/env';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PoliteHttp, type PoliteHttpOptions, type UsageStore } from './http';
import type {
  Logger,
  Notifier,
  NotifierInfo,
  PluginContext,
  PluginInfo,
  PluginModule,
} from './types';

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
  return { bars: [], series: [], fx: [], issuers: [], calendars: [], notifiers: [], missing: [] };
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
    loaded.issuers.push(...(mod.issuers ?? []));
    loaded.calendars.push(...(mod.calendars ?? []));
    loaded.notifiers.push(...(mod.notifiers ?? []));
  }
  validateInfos([...allInfos(loaded), ...loaded.notifiers.map((n) => n.info)]);
  return loaded;
}

export function allInfos(plugins: PluginModule): PluginInfo[] {
  return [
    ...(plugins.bars ?? []),
    ...(plugins.series ?? []),
    ...(plugins.fx ?? []),
    ...(plugins.issuers ?? []),
    ...(plugins.calendars ?? []),
  ].map((p) => p.info);
}

/** Keys are lowercase identifiers, unique per kind, and each source names its terms. */
export function validateInfos(
  infos: Pick<PluginInfo | NotifierInfo, 'key' | 'kind' | 'termsUrl'>[],
): void {
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

/**
 * The quota guard's store in the database (`provider_usage`): loading prunes buckets no window
 * can count any more, then reads the provider's last day of requests and 31 days of symbols.
 */
export function providerUsageStore(db: Db): UsageStore {
  return {
    async load(provider, now) {
      await pruneProviderUsage(db, now);
      return providerUsageSince(db, provider, now);
    },
    record: (provider, at, symbol) => recordProviderRequest(db, { provider, at, symbol }),
  };
}

/**
 * A run's context for one source: its own HTTP client at the provider's pace, and its key.
 * `usage`: the quota guard's store, so the provider's limits hold across runs (counted under the
 * plug-in's key).
 */
export function pluginContext(
  info: Pick<PluginInfo | NotifierInfo, 'key' | 'name' | 'keyEnv' | 'limits'>,
  log: Logger,
  options: {
    env?: Record<string, string | undefined>;
    http?: PoliteHttpOptions;
    now?: Date;
    usage?: UsageStore;
  } = {},
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
    http: new PoliteHttp({
      limits: info.limits,
      secrets: Object.values(keys),
      ...(options.usage && { usage: { provider: info.key, store: options.usage } }),
      ...options.http,
    }),
    now: options.now ?? new Date(),
    log,
    ...(names.length > 0 && { apiKey: keys[names[0]!], keys }),
  };
}

/**
 * Contexts for notifiers in one run: one client per channel, so the service's pace and limits
 * apply across that channel's messages and a channel the service refuses (403, 429) stops only
 * itself; no automatic retry, since a resent POST could deliver an alert twice (what failed is
 * tried again at the next check).
 */
export function notifierContexts(
  log: Logger,
): (notifier: Notifier, channelId: string) => PluginContext {
  const made = new Map<string, PluginContext>();
  return (notifier, channelId) => {
    const key = `${notifier.info.key} ${channelId}`;
    let ctx = made.get(key);
    if (!ctx) {
      ctx = pluginContext(notifier.info, log, { http: { retries: 0 } });
      made.set(key, ctx);
    }
    return ctx;
  };
}
