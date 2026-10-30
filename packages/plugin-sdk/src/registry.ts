import { ISSUER_PUBLISHED_KINDS, type IssuerPublishes } from '@saku/data';
import {
  type Db,
  USAGE_SYMBOL_WINDOW_MS,
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
import {
  type FormerId,
  PoliteHttp,
  type PoliteHttpOptions,
  type UsageStore,
  mergeFormerIds,
  sameLimits,
} from './http';
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
 * Saved descriptions carry `formerProviders` (see `savePluginInfos`).
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
 * A provider id a plug-in declared before, saved in its description: `since`, when it stopped
 * being the plug-in's provider (ISO time). Only rows stored before then are the plug-in's; later
 * ones belong to whoever still uses the id.
 */
export interface FormerProvider {
  id: string;
  since: string;
}

/**
 * How long a former provider id is remembered after `since`: the longest window the guard counts
 * (31 days of symbols) plus one day bucket, since a symbol counts from the end of its stored day
 * (`providerUsageSince`), so a symbol sent just before `since` can count until then.
 */
export const FORMER_PROVIDER_KEPT_MS = USAGE_SYMBOL_WINDOW_MS + 86_400_000;

/**
 * What a saved description says about the provider ids its requests were stored under: its saved
 * provider (`provider`, default the key) and its former ids, each with the time it stopped (ms;
 * undefined for an entry saved without one, by an earlier version, as a bare id). An unreadable
 * description gives `error`: those ids, so that history, are unknown.
 */
function readSaved(
  saved: SavedPluginInfo,
): { provider: string; former: { id: string; since?: number }[] } | { error: string } {
  const error = {
    error: `saved description of ${saved.kind} ${saved.key} unreadable: the provider ids its usage is stored under are unknown`,
  };
  const d = saved.description;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return error;
  const { provider, formerProviders } = d as Record<string, unknown>;
  if (provider !== undefined && (typeof provider !== 'string' || !KEY.test(provider))) {
    return error;
  }
  if (formerProviders !== undefined && !Array.isArray(formerProviders)) return error;
  const former: { id: string; since?: number }[] = [];
  for (const f of (formerProviders as unknown[] | undefined) ?? []) {
    if (typeof f === 'string' && KEY.test(f)) {
      former.push({ id: f });
      continue;
    }
    if (f === null || typeof f !== 'object') return error;
    const { id, since } = f as Record<string, unknown>;
    const at = typeof since === 'string' ? Date.parse(since) : Number.NaN;
    if (typeof id !== 'string' || !KEY.test(id) || !Number.isFinite(at)) return error;
    former.push({ id, since: at });
  }
  return { provider: (provider as string | undefined) ?? saved.key, former };
}

/**
 * Per provider id, the other ids whose stored history counts for it, or why it is unknown.
 * `unknown`: a saved description of one of its plug-ins could not be read; that provider's
 * sources send nothing (`providerQuotas`), the others are not affected.
 */
export interface FormerIds {
  ids: FormerId[];
  unknown?: string;
}

/**
 * Per provider id, the other ids the loaded plug-ins' requests were stored under, whose stored
 * history still counts for it (`PoliteHttp.alsoCount`; requirements 04 "Quota guard"):
 * - the key of a plug-in that declares a provider (its requests went under its key before), all
 *   of its rows;
 * - from its saved description (`saved`, matched by key and kind): its former provider ids, only
 *   rows stored before each stopped being its provider (another plug-in may still use it); and
 *   the provider id it was saved with when that differs from the current one (read before this
 *   run saved: all of its rows, the conservative side). A renamed id (acme to acme-corp) or a
 *   removed one (acme to the key) so still counts.
 * Calendars send no requests and are left out. An unreadable saved description of a loaded
 * plug-in marks its provider's history unknown.
 */
export function formerKeys(
  infos: (Pick<PluginInfo, 'key' | 'kind'> & Pick<Partial<PluginInfo>, 'provider'>)[],
  saved: readonly SavedPluginInfo[] = [],
): Map<string, FormerIds> {
  const out = new Map<string, FormerIds>();
  for (const info of infos) {
    if (info.kind === 'calendar') continue;
    const provider = providerOf(info);
    const entry = out.get(provider) ?? { ids: [] };
    const ids: FormerId[] = [...entry.ids, { id: info.key }];
    const row = saved.find((s) => s.key === info.key && s.kind === info.kind);
    const read = row && readSaved(row);
    if (read && 'error' in read) entry.unknown ??= read.error;
    else if (read) {
      ids.push({ id: read.provider });
      for (const f of read.former) {
        ids.push(f.since === undefined ? { id: f.id } : { id: f.id, before: f.since });
      }
    }
    entry.ids = mergeFormerIds(provider, ids);
    if (entry.ids.length > 0 || entry.unknown !== undefined) out.set(provider, entry);
  }
  return out;
}

/**
 * Within one run, the clients of all plug-ins of one provider share one count (`PoliteHttp.share`)
 * and one block (a 429 or a challenge page answered to any stops them all; a 403 only its own):
 * the first client of a provider is guarded (with `usage`, unless its context already did) and
 * the later ones join it. Returns the function to call with each source's client before it sends
 * anything; it throws when a client cannot join (another provider's guard, different limits) or
 * its provider's history is unknown (`former`), so that source sends nothing. `clock`: the run's
 * clock, when injected. `former`: per provider id, the other ids its plug-ins' requests were
 * stored under (`formerKeys`), whose stored history the guarded count loads too.
 */
export function providerQuotas(
  usage?: UsageStore,
  clock?: () => number,
  former: Map<string, FormerIds> = new Map(),
): (
  info: Pick<PluginInfo, 'key'> & Pick<Partial<PluginInfo>, 'provider'>,
  http: PoliteHttp,
) => void {
  const first = new Map<string, PoliteHttp>();
  return (info, http) => {
    const provider = providerOf(info);
    const f = former.get(provider);
    if (f?.unknown !== undefined) {
      throw new Error(`earlier requests of ${provider} unknown: ${f.unknown}`);
    }
    if (http.guarded && http.provider !== provider) {
      throw new Error(`client counted under ${http.provider}, not its provider ${provider}`);
    }
    const peer = first.get(provider);
    if (peer) {
      http.share(peer);
      return;
    }
    if (usage && !http.guarded) http.guard({ provider, store: usage }, clock);
    if (http.guarded && f && f.ids.length > 0) http.alsoCount(f.ids);
    first.set(provider, http);
  };
}

/**
 * Saves every plug-in's description (done by each job run, `pnpm plugins` and `pnpm probe`), in
 * one transaction; Settings lists them from here. A provider id changed or removed must not drop
 * the usage stored under the old one (requirements 04 "Quota guard"), so each description is
 * saved with `formerProviders`: the provider ids its saved description names (its saved provider
 * and former ids) other than its current provider and its key (the key always counts,
 * `formerKeys`), merged across saves, each with `since`, when it stopped being the plug-in's
 * provider: the later of `now` and the system clock (no request of the plug-in under the old id
 * is stored later than that), kept from the save that first saw the change. An id is dropped
 * once `since` lies more than `FORMER_PROVIDER_KEPT_MS` before the earlier of the two clocks: no
 * window can count the plug-in's rows under it any more. An entry saved as a bare id (no `since`)
 * takes this save's time.
 *
 * A non-calendar plug-in's saved description that cannot be read is left as it is (its former
 * ids would be lost) and returned, one line each; `formerKeys` then stops only its provider's
 * sources until the row is restored or removed (docs/plugins.md). Calendars send no requests and
 * get no former ids.
 */
export async function savePluginInfos(
  db: Db,
  infos: PluginInfo[],
  now = new Date(),
  /** The system clock (tests replace it). */
  wallClock: () => number = Date.now,
): Promise<string[]> {
  const savedAt = now.toISOString();
  const wall = wallClock();
  const stoppedAt = Math.max(now.getTime(), wall);
  const readAt = Math.min(now.getTime(), wall);
  return db.transaction(async (tx) => {
    const saved: SavedPluginInfo[] = await tx
      .select({
        key: schema.pluginInfo.key,
        kind: schema.pluginInfo.kind,
        description: schema.pluginInfo.description,
      })
      .from(schema.pluginInfo);
    const kept: string[] = [];
    for (const info of infos) {
      const row = saved.find((s) => s.key === info.key && s.kind === info.kind);
      const read = row && info.kind !== 'calendar' ? readSaved(row) : undefined;
      if (read && 'error' in read) {
        kept.push(`${read.error}; left as saved`);
        continue;
      }
      const provider = providerOf(info);
      const since = new Map<string, number>();
      for (const f of [
        ...(read?.former ?? []),
        ...(read ? [{ id: read.provider, since: stoppedAt }] : []),
      ]) {
        const at = f.since ?? stoppedAt;
        if (f.id === provider || f.id === info.key) continue;
        if (readAt - at > FORMER_PROVIDER_KEPT_MS) continue;
        // One id stopped twice (a former id declared and dropped again): the later time keeps
        // more of its rows.
        since.set(f.id, Math.max(since.get(f.id) ?? -Infinity, at));
      }
      const formerProviders: FormerProvider[] = [...since]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, at]) => ({ id, since: new Date(at).toISOString() }));
      const description =
        formerProviders.length > 0 ? { ...info, formerProviders } : (info as unknown);
      await tx
        .insert(schema.pluginInfo)
        .values({ key: info.key, kind: info.kind, description, savedAt })
        .onConflictDoUpdate({
          target: [schema.pluginInfo.key, schema.pluginInfo.kind],
          set: { description, savedAt },
        });
    }
    return kept;
  });
}

/**
 * The quota guard's store in the database (`provider_usage`): loading prunes buckets no window
 * can count any more, then reads the provider's last day of requests and 31 days of symbols.
 */
export function providerUsageStore(db: Db): UsageStore {
  return {
    async load(provider, now, before) {
      await pruneProviderUsage(db, now);
      return providerUsageSince(db, provider, now, before);
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
