import { ISSUER_PUBLISHED_KINDS, type IssuerPublishes } from '@saku/data';
import {
  type Db,
  checkAdjCloseRounding,
  providerUsageSince,
  pruneProviderUsage,
  recordProviderRequest,
  schema,
} from '@saku/db';
import { findRepoRoot } from '@saku/db/env';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PoliteHttp, type PoliteHttpOptions, type UsageStore, sameLimits } from './http';
import type {
  IssuerSource,
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

/** What each issuer source declares it publishes, by key (sources without a declaration left out). */
export function issuerPublishesOf(issuers: IssuerSource[] = []): Record<string, IssuerPublishes> {
  return Object.fromEntries(
    issuers.flatMap((s) => (s.info.publishes ? [[s.info.key, s.info.publishes]] : [])),
  );
}

/**
 * Keys are lowercase identifiers, unique per kind, each source names its terms, a declared
 * adjusted-close rounding is a small positive number, and a `publishes` declaration is an issuer
 * source's, naming at least one known kind, each `true` (a declaration of nothing, or with a
 * misspelt kind, would silently leave its checks out of layer D).
 *
 * A declared provider id has the form of a key, and plug-ins of one provider (`providerOf`,
 * notifiers by their key) declare the same limits: they share one count of requests, which
 * cannot honor two different limits (requirements 04 "Quota guard"). Notifiers are grouped too:
 * `provider_usage` is one namespace, so a notifier key equal to a data provider id is one count
 * and must declare the same limits. Calendar plug-ins send no requests and are left out of this.
 */
export function validateInfos(
  infos: (Pick<PluginInfo | NotifierInfo, 'key' | 'kind' | 'termsUrl' | 'limits'> &
    Pick<Partial<PluginInfo>, 'adjCloseRounding' | 'publishes' | 'provider'>)[],
): void {
  const seen = new Set<string>();
  const byProvider = new Map<string, (typeof infos)[number]>();
  for (const info of infos) {
    if (!KEY.test(info.key)) {
      throw new Error(`Plug-in key "${info.key}" must be 2-40 of a-z, 0-9 and -.`);
    }
    if (
      info.provider !== undefined &&
      (typeof info.provider !== 'string' || !KEY.test(info.provider))
    ) {
      throw new Error(
        `Plug-in "${info.key}": provider "${String(info.provider)}" must be 2-40 of a-z, 0-9 and -.`,
      );
    }
    if (info.kind !== 'calendar') {
      const provider = providerOf(info);
      const other = byProvider.get(provider);
      if (!other) byProvider.set(provider, info);
      else if (!sameLimits(other.limits, info.limits)) {
        throw new Error(
          `Plug-ins "${other.kind} ${other.key}" and "${info.kind} ${info.key}" share the provider "${provider}" but declare different limits; one count cannot honor two.`,
        );
      }
    }
    const id = `${info.kind}:${info.key}`;
    if (seen.has(id)) throw new Error(`Two ${info.kind} plug-ins use the key "${info.key}".`);
    seen.add(id);
    if (!info.termsUrl) throw new Error(`Plug-in "${info.key}" has no termsUrl.`);
    if (info.adjCloseRounding !== undefined) {
      checkAdjCloseRounding(info.adjCloseRounding, `Plug-in "${info.key}"`);
    }
    if (info.publishes !== undefined) {
      const p: unknown = info.publishes;
      const entries = p !== null && typeof p === 'object' ? Object.entries(p) : [];
      if (
        info.kind !== 'issuer' ||
        entries.length === 0 ||
        entries.some(
          ([k, v]) => !(ISSUER_PUBLISHED_KINDS as readonly string[]).includes(k) || v !== true,
        )
      ) {
        throw new Error(
          `Plug-in "${info.key}": publishes is for issuer sources and names at least one of ${ISSUER_PUBLISHED_KINDS.join(', ')}, each true.`,
        );
      }
    }
  }
}

/** Plug-in keys and provider ids: 2-40 of a-z, 0-9 and -, starting with a letter. */
const KEY = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * The provider a plug-in's requests count against (its declared `provider`, default its key):
 * the id its quota is shared and stored under (requirements 04 "Quota guard").
 */
export function providerOf(info: Pick<PluginInfo, 'key'> & Pick<Partial<PluginInfo>, 'provider'>) {
  return info.provider ?? info.key;
}

/**
 * A plug-in's saved description as read back from `plugin_info` (unknown shape until checked).
 * Saved descriptions carry `formerProviders`: the other provider ids its requests were stored
 * under (see `savePluginInfos`).
 */
export interface SavedPluginInfo {
  key: string;
  kind: string;
  description: unknown;
}

/** The descriptions the last run saved (a removed plug-in keeps its row). */
export async function savedPluginInfos(db: Db): Promise<SavedPluginInfo[]> {
  return db
    .select({
      key: schema.pluginInfo.key,
      kind: schema.pluginInfo.kind,
      description: schema.pluginInfo.description,
    })
    .from(schema.pluginInfo);
}

/**
 * The provider ids a saved description says the plug-in's requests were stored under: its saved
 * provider (`provider`, default the key) and the former ids saved with it. An unreadable
 * description throws: those ids, so that history, would be unknown (requirements 04 "Quota
 * guard": unknown history sends nothing).
 */
function savedProviderIds(saved: SavedPluginInfo): string[] {
  const d = saved.description;
  const unreadable = () =>
    new Error(
      `Saved description of ${saved.kind} ${saved.key} unreadable: the provider ids its usage is stored under are unknown.`,
    );
  if (d === null || typeof d !== 'object' || Array.isArray(d)) throw unreadable();
  const { provider, formerProviders } = d as Record<string, unknown>;
  if (provider !== undefined && (typeof provider !== 'string' || !KEY.test(provider))) {
    throw unreadable();
  }
  if (
    formerProviders !== undefined &&
    (!Array.isArray(formerProviders) ||
      formerProviders.some((id) => typeof id !== 'string' || !KEY.test(id)))
  ) {
    throw unreadable();
  }
  return [(provider as string | undefined) ?? saved.key, ...((formerProviders as string[]) ?? [])];
}

/**
 * Per provider id, the other ids the loaded plug-ins' requests were stored under, whose stored
 * history still counts for it (`PoliteHttp.alsoCount`; requirements 04 "Quota guard"):
 * - the key of a plug-in that declares a provider (its requests went under its key before);
 * - from its saved description (`saved`, matched by key and kind), the provider id it was saved
 *   with and the former ids saved with that (`savePluginInfos`), when they differ from the
 *   current one: a renamed provider id (acme to acme-corp) or a removed one (acme to the key)
 *   still counts the old id's rows.
 * Calendars send no requests and are left out. An unreadable saved description of a loaded
 * plug-in throws (its history unknown).
 */
export function formerKeys(
  infos: (Pick<PluginInfo, 'key' | 'kind'> & Pick<Partial<PluginInfo>, 'provider'>)[],
  saved: readonly SavedPluginInfo[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const info of infos) {
    if (info.kind === 'calendar') continue;
    const provider = providerOf(info);
    const row = saved.find((s) => s.key === info.key && s.kind === info.kind);
    const ids = [info.key, ...(row ? savedProviderIds(row) : [])].filter((id) => id !== provider);
    if (ids.length === 0) continue;
    const keys = out.get(provider) ?? [];
    for (const id of ids) if (!keys.includes(id)) keys.push(id);
    out.set(provider, keys);
  }
  return out;
}

/**
 * Within one run, the clients of all plug-ins of one provider share one count (`PoliteHttp.share`)
 * and one block (a 429 or a challenge page answered to any stops them all; a 403 only its own):
 * the first client of a provider is guarded (with `usage`, unless its context already did) and
 * the later ones join it. Returns the function to call with each source's client before it sends
 * anything; it throws when a client cannot join (another provider's guard, different limits), so
 * that source sends nothing. `clock`: the run's clock, when injected. `former`: per provider id,
 * the keys its plug-ins were counted under before they declared it (`formerKeys` of the loaded
 * plug-ins), whose stored history the guarded count loads too.
 */
export function providerQuotas(
  usage?: UsageStore,
  clock?: () => number,
  former: Map<string, string[]> = new Map(),
): (
  info: Pick<PluginInfo, 'key'> & Pick<Partial<PluginInfo>, 'provider'>,
  http: PoliteHttp,
) => void {
  const first = new Map<string, PoliteHttp>();
  return (info, http) => {
    const provider = providerOf(info);
    if (http.guarded && http.provider !== provider) {
      throw new Error(`client counted under ${http.provider}, not its provider ${provider}`);
    }
    const peer = first.get(provider);
    if (peer) {
      http.share(peer);
      return;
    }
    if (usage && !http.guarded) http.guard({ provider, store: usage }, clock);
    const keys = former.get(provider) ?? [];
    if (http.guarded && keys.length > 0) http.alsoCount(keys);
    first.set(provider, http);
  };
}

/**
 * Saves every plug-in's description (done by each job run and `pnpm plugins`); Settings lists
 * them from here. A provider id changed or removed must not drop the usage stored under the old
 * one (requirements 04 "Quota guard"), so each description is saved with `formerProviders`: the
 * provider ids of its saved description (its saved provider and former ids) other than its
 * current one, merged across saves. An id is kept while the quota guard would still count rows
 * stored under it (requests in the last day or symbols in the last 31 days, read at the earlier
 * of `now` and the system clock, like the guard) and dropped once none are left: it is
 * remembered as long as its usage can count, and no longer. An unreadable saved description
 * throws (its ids unknown). Calendars send no requests and get none.
 */
export async function savePluginInfos(db: Db, infos: PluginInfo[], now = new Date()) {
  const savedAt = now.toISOString();
  const saved = await savedPluginInfos(db);
  const readAt = Math.min(now.getTime(), Date.now());
  const counts = new Map<string, boolean>();
  const stillCounts = async (id: string) => {
    let c = counts.get(id);
    if (c === undefined) {
      const h = await providerUsageSince(db, id, readAt);
      c = h.requests.length > 0 || h.symbols.size > 0;
      counts.set(id, c);
    }
    return c;
  };
  for (const info of infos) {
    const row = saved.find((s) => s.key === info.key && s.kind === info.kind);
    const former: string[] = [];
    if (row && info.kind !== 'calendar') {
      for (const id of savedProviderIds(row)) {
        if (id !== providerOf(info) && !former.includes(id) && (await stillCounts(id))) {
          former.push(id);
        }
      }
    }
    const description = former.length > 0 ? { ...info, formerProviders: former.sort() } : info;
    await db
      .insert(schema.pluginInfo)
      .values({ key: info.key, kind: info.kind, description, savedAt })
      .onConflictDoUpdate({
        target: [schema.pluginInfo.key, schema.pluginInfo.kind],
        set: { description, savedAt },
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
 * provider id, `providerOf`). A run's jobs make the clients of one provider share their count
 * (`providerQuotas`).
 */
export function pluginContext(
  info: Pick<PluginInfo | NotifierInfo, 'key' | 'name' | 'keyEnv' | 'limits'> &
    Pick<Partial<PluginInfo>, 'provider'>,
  log: Logger,
  options: {
    env?: Record<string, string | undefined>;
    http?: PoliteHttpOptions;
    now?: Date;
    usage?: UsageStore;
    /** The run's final time (`HH:MM` New York), see `PluginContext.finalAfter`. */
    finalAfter?: string;
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
      ...(options.usage && { usage: { provider: providerOf(info), store: options.usage } }),
      ...options.http,
    }),
    now: options.now ?? new Date(),
    log,
    ...(names.length > 0 && { apiKey: keys[names[0]!], keys }),
    ...(options.finalAfter !== undefined && { finalAfter: options.finalAfter }),
  };
}

/**
 * Contexts for notifiers in one run: one client per channel, so a channel the service refuses
 * (403, 429, a challenge) stops only itself (`ownBlocks`); all of a notifier's channels share one
 * count of requests, so the service's pace and limits apply to them together (as they are
 * recorded). No automatic retry,
 * since a resent POST could deliver an alert twice (what failed is tried again at the next
 * check). `usage`: the quota guard's store, so the service's limits hold across runs (counted
 * under the notifier's key). `http`: client options (tests: a fake fetch and clock).
 */
export function notifierContexts(
  log: Logger,
  usage?: UsageStore,
  http: PoliteHttpOptions = {},
): (notifier: Notifier, channelId: string) => PluginContext {
  const made = new Map<string, PluginContext>();
  /** Per notifier key, the first channel's client: the others share its counts and pacing. */
  const first = new Map<string, PoliteHttp>();
  return (notifier, channelId) => {
    const key = `${notifier.info.key} ${channelId}`;
    let ctx = made.get(key);
    if (!ctx) {
      const peer = first.get(notifier.info.key);
      ctx = pluginContext(notifier.info, log, {
        http: { ...http, retries: 0, ownBlocks: true, ...(peer && { shareQuotaWith: peer }) },
        ...(usage && { usage }),
      });
      if (!peer) first.set(notifier.info.key, ctx.http);
      made.set(key, ctx);
    }
    return ctx;
  };
}
