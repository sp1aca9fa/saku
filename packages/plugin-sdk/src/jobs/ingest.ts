// Fetching from every source and storing what arrives (requirements 04: bootstrap and daily
// imports). Sources run one after another, each with its own HTTP client. A source that refuses
// (403, 429) or would pass its quota stops for the run; any other failure is recorded for that
// ticker and the run goes on. Issuer sources (layer D) are best effort: what they did is reported
// like the others, but the caller does not count it against the run (`countsForRun`).
//
// Quota guard (requirements 04): every source's client counts its provider's requests across runs
// (the database's `provider_usage`, unless the context already has a store), on the run's clock
// when one is injected. A bar, meta or issuer fetch names its symbol first, so a provider's
// symbols-per-month limit holds; a fetch it refuses stops the source for the run like a block.
import type { TradingDate } from '@saku/core';
import {
  type Db,
  type StoredValues,
  activeSymbols,
  fillSymbolMeta,
  getSetting,
  storeFx,
  storeIssuerRecords,
  storeRawBars,
  storeSeries,
} from '@saku/db';
import type { Sessions } from '@saku/data';
import { BlockedError, type PoliteHttp, QuotaError, type UsageStore } from '../http';
import { type LoadedPlugins, providerUsageStore } from '../registry';
import type { IssuerSource, Logger, PluginContext, PluginInfo } from '../types';
import type { IssuerAvailability } from './verify';

/** The earliest date a bootstrap asks for. */
export const BOOTSTRAP_FROM = '1990-01-01';
/** Sessions refetched by every daily run (the overlap catches late corrections). */
export const DAILY_OVERLAP = 10;

export interface SourceReport {
  source: string;
  kind: 'bar' | 'series' | 'fx' | 'issuer';
  ok: string[];
  failed: { item: string; error: string }[];
  /** Why the source stopped for the run, or was skipped. */
  stopped?: string;
  inserted: number;
  revised: number;
  readjustments: number;
  /** Stored dates a source no longer returned, per item. */
  missing: Record<string, TradingDate[]>;
  /**
   * Series and FX: stored dates whose value the source now reports differently, per item (each a
   * new row known from this fetch; the old one kept). Counted in `revised` and reported with the
   * bar revisions.
   */
  revisedValues: Record<string, TradingDate[]>;
  /** Issuer sources: the tickers it supports (all of them when `supports` failed). */
  supported?: string[];
}

export interface IngestOptions {
  mode: 'bootstrap' | 'daily';
  /** The last trading date to fetch. */
  to: TradingDate;
  sessions: Sessions;
  runId: string | null;
  log: Logger;
  /** Builds a source's context; throws when its key is missing. */
  context: (info: PluginInfo) => PluginContext;
  now?: () => Date;
  /** Where the quota guard keeps requests across runs. Default: the database (`provider_usage`). */
  usage?: UsageStore;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The first date to ask a source for, given its plan's history. */
export function windowStart(info: PluginInfo, wanted: TradingDate, to: TradingDate): TradingDate {
  let from = wanted;
  if (info.history?.from && info.history.from > from) from = info.history.from;
  if (info.history?.years) {
    const limit = new Date(`${to}T00:00:00Z`);
    limit.setUTCFullYear(limit.getUTCFullYear() - info.history.years);
    // A day inside the limit, so the request never asks for more than the plan allows.
    limit.setUTCDate(limit.getUTCDate() + 1);
    const iso = limit.toISOString().slice(0, 10);
    if (iso > from) from = iso;
  }
  return from;
}

function report(source: string, kind: SourceReport['kind']): SourceReport {
  return {
    source,
    kind,
    ok: [],
    failed: [],
    inserted: 0,
    revised: 0,
    readjustments: 0,
    missing: {},
    revisedValues: {},
  };
}

/** Adds what storing series values or FX rates did to the source's report. */
function noteValues(r: SourceReport, stored: StoredValues): void {
  r.inserted += stored.inserted;
  r.revised += stored.revised.length;
  for (const { item, date } of stored.revised) (r.revisedValues[item] ??= []).push(date);
}

/** Runs `each` per item; a block or quota stop ends the source, other errors are per item. */
async function perItem(
  r: SourceReport,
  items: string[],
  log: Logger,
  each: (item: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    try {
      await each(item);
      r.ok.push(item);
    } catch (e) {
      if (e instanceof BlockedError || e instanceof QuotaError) {
        r.stopped = message(e);
        log.warn(`${r.source} stopped for this run`, { reason: r.stopped });
        return;
      }
      r.failed.push({ item, error: message(e) });
      log.warn(`${r.source} failed for ${item}`, { error: message(e) });
    }
  }
}

/** A context's HTTP client; null only for a test context without one (nothing can be sent). */
const clientOf = (ctx: PluginContext): PoliteHttp | null =>
  (ctx.http as PoliteHttp | null | undefined) ?? null;

/** The source's context with the quota guard attached, or null (skipped, with the reason). */
function contextOrSkip(db: Db, r: SourceReport, info: PluginInfo, o: IngestOptions) {
  try {
    const ctx = o.context(info);
    const http = clientOf(ctx);
    if (http && !http.guarded) {
      const now = o.now;
      http.guard(
        { provider: info.key, store: o.usage ?? providerUsageStore(db) },
        now && (() => now().getTime()),
      );
    }
    return ctx;
  } catch (e) {
    r.stopped = message(e);
    o.log.warn(`${info.key} skipped`, { reason: r.stopped });
    return null;
  }
}

/**
 * Whether a source's failures make the run incomplete. Issuer data is a best-effort check
 * (requirements 04: an issuer site unavailable is yellow), graded by its staleness
 * (`D.issuer_stale`), so a flaky issuer site never stops the heartbeat.
 */
export const countsForRun = (r: SourceReport): boolean => r.kind !== 'issuer';

export async function ingest(db: Db, plugins: LoadedPlugins, o: IngestOptions) {
  const now = o.now ?? (() => new Date());
  const reports: SourceReport[] = [];
  const dailyFrom = o.sessions.before(o.sessions.onOrBefore(o.to), DAILY_OVERLAP);
  const wanted = (inception?: string | null) =>
    o.mode === 'daily'
      ? dailyFrom
      : inception && inception > BOOTSTRAP_FROM
        ? inception
        : BOOTSTRAP_FROM;

  const symbols = await activeSymbols(db);
  for (const source of plugins.bars) {
    const r = report(source.info.key, 'bar');
    reports.push(r);
    const ctx = contextOrSkip(db, r, source.info, o);
    if (!ctx) continue;
    await perItem(
      r,
      symbols.map((s) => s.ticker),
      o.log,
      async (ticker) => {
        const symbol = symbols.find((s) => s.ticker === ticker)!;
        await clientOf(ctx)?.forSymbol(ticker);
        if (o.mode === 'bootstrap' && source.fetchMeta && !symbol.inceptionDate) {
          const meta = await source.fetchMeta(ticker, ctx);
          await fillSymbolMeta(db, symbol.id, meta);
          if (meta.inceptionDate) symbol.inceptionDate = meta.inceptionDate;
        }
        const from = windowStart(source.info, wanted(symbol.inceptionDate), o.to);
        const bars = await source.fetchBars(ticker, from, o.to, ctx);
        const stored = await storeRawBars(db, {
          symbolId: symbol.id,
          source: source.info.key,
          bars,
          runId: o.runId,
          fetchedAt: now().toISOString(),
        });
        r.inserted += stored.inserted;
        r.revised += stored.revised;
        r.readjustments += stored.readjustments;
        if (stored.missing.length > 0) r.missing[ticker] = stored.missing;
      },
    );
  }

  for (const source of plugins.series) {
    const r = report(source.info.key, 'series');
    reports.push(r);
    const ctx = contextOrSkip(db, r, source.info, o);
    if (!ctx) continue;
    await perItem(r, source.info.provides.series ?? [], o.log, async (id) => {
      const from = windowStart(source.info, wanted(), o.to);
      const points = await source.fetchSeries(id, from, o.to, ctx);
      noteValues(
        r,
        await storeSeries(db, {
          series: id,
          source: source.info.key,
          points,
          fetchedAt: now().toISOString(),
        }),
      );
    });
  }

  const base = await getSetting(db, 'base_currency');
  const pairs = base && base !== 'USD' ? [`USD${base}`] : [];
  if (pairs.length === 0) o.log.warn('No FX fetched: base_currency is not set or is USD');
  for (const source of plugins.fx) {
    const r = report(source.info.key, 'fx');
    reports.push(r);
    const supported = pairs.filter((p) => source.supports(p));
    if (supported.length === 0) continue;
    const ctx = contextOrSkip(db, r, source.info, o);
    if (!ctx) continue;
    await perItem(r, supported, o.log, async (pair) => {
      const from = windowStart(source.info, wanted(), o.to);
      const rates = await source.fetchRates(pair, from, o.to, ctx);
      noteValues(
        r,
        await storeFx(db, {
          source: source.info.key,
          kind: 'valuation',
          rates,
          fetchedAt: now().toISOString(),
        }),
      );
    });
  }

  // Issuer data (layer D, best effort), for each active symbol a source supports.
  for (const source of plugins.issuers) {
    const r = report(source.info.key, 'issuer');
    reports.push(r);
    const support = supportedBy(
      source,
      symbols.map((s) => s.ticker),
    );
    r.supported = support.supported;
    if (support.error !== undefined) {
      r.stopped = support.error;
      o.log.warn(`${source.info.key} skipped`, { reason: r.stopped });
      continue;
    }
    const supported = symbols.filter((s) => support.supported.includes(s.ticker));
    if (supported.length === 0) continue;
    const ctx = contextOrSkip(db, r, source.info, o);
    if (!ctx) continue;
    await perItem(
      r,
      supported.map((s) => s.ticker),
      o.log,
      async (ticker) => {
        const symbol = supported.find((s) => s.ticker === ticker)!;
        await clientOf(ctx)?.forSymbol(ticker);
        const from = windowStart(source.info, wanted(symbol.inceptionDate), o.to);
        const records = await source.fetchRecords(ticker, from, o.to, ctx);
        r.inserted += await storeIssuerRecords(db, {
          symbolId: symbol.id,
          source: source.info.key,
          records,
          fetchedAt: now().toISOString(),
        });
      },
    );
  }
  return reports;
}

/**
 * The tickers an issuer source supports. A `supports` that throws leaves it unknown: every ticker
 * counts as supported (so a fund it never delivered is graded, never silently left out).
 */
export function supportedBy(
  source: IssuerSource,
  tickers: string[],
): { supported: string[]; error?: string } {
  try {
    return { supported: tickers.filter((t) => source.supports(t)) };
  } catch (e) {
    return { supported: [...tickers], error: message(e) };
  }
}

/** Per issuer source of a run: what it supports and what it did not deliver this run. */
export function issuerAvailability(reports: SourceReport[]): IssuerAvailability[] {
  return reports
    .filter((r) => r.kind === 'issuer')
    .map((r) => ({
      source: r.source,
      supported: r.supported ?? [],
      unavailable: (r.supported ?? []).filter((t) => !r.ok.includes(t)),
    }));
}
