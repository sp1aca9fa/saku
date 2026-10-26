// Fetching from every source and storing what arrives (requirements 04: bootstrap and daily
// imports). Sources run one after another, each with its own HTTP client. A source that refuses
// (403, 429) or would pass its quota stops for the run; any other failure is recorded for that
// ticker and the run goes on.
import type { TradingDate } from '@saku/core';
import {
  type Db,
  activeSymbols,
  fillSymbolMeta,
  getSetting,
  storeFx,
  storeRawBars,
  storeSeries,
} from '@saku/db';
import type { Sessions } from '@saku/data';
import { BlockedError, QuotaError } from '../http';
import type { LoadedPlugins } from '../registry';
import type { Logger, PluginContext, PluginInfo } from '../types';

/** The earliest date a bootstrap asks for. */
export const BOOTSTRAP_FROM = '1990-01-01';
/** Sessions refetched by every daily run (the overlap catches late corrections). */
export const DAILY_OVERLAP = 10;

export interface SourceReport {
  source: string;
  kind: 'bar' | 'series' | 'fx';
  ok: string[];
  failed: { item: string; error: string }[];
  /** Why the source stopped for the run, or was skipped. */
  stopped?: string;
  inserted: number;
  revised: number;
  readjustments: number;
  /** Stored dates a source no longer returned, per item. */
  missing: Record<string, TradingDate[]>;
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
  };
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

function contextOrSkip(r: SourceReport, info: PluginInfo, o: IngestOptions) {
  try {
    return o.context(info);
  } catch (e) {
    r.stopped = message(e);
    o.log.warn(`${info.key} skipped`, { reason: r.stopped });
    return null;
  }
}

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
    const ctx = contextOrSkip(r, source.info, o);
    if (!ctx) continue;
    await perItem(
      r,
      symbols.map((s) => s.ticker),
      o.log,
      async (ticker) => {
        const symbol = symbols.find((s) => s.ticker === ticker)!;
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
    const ctx = contextOrSkip(r, source.info, o);
    if (!ctx) continue;
    await perItem(r, source.info.provides.series ?? [], o.log, async (id) => {
      const from = windowStart(source.info, wanted(), o.to);
      const points = await source.fetchSeries(id, from, o.to, ctx);
      r.inserted += await storeSeries(db, {
        series: id,
        source: source.info.key,
        points,
        fetchedAt: now().toISOString(),
      });
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
    const ctx = contextOrSkip(r, source.info, o);
    if (!ctx) continue;
    await perItem(r, supported, o.log, async (pair) => {
      const from = windowStart(source.info, wanted(), o.to);
      const rates = await source.fetchRates(pair, from, o.to, ctx);
      r.inserted += await storeFx(db, {
        source: source.info.key,
        kind: 'valuation',
        rates,
        fetchedAt: now().toISOString(),
      });
    });
  }
  return reports;
}
