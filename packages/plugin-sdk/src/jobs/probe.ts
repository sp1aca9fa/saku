// A1 measurement: when is each bar source's daily data final? Every hourly check fetches the last
// few sessions of one ticker from every bar source and appends what came back to a JSON-lines
// file. The first time a date appears, and the last time its values change, give the times.
// The CLI gives each source a client with the quota guard's store, so probe requests count
// toward the provider's limits across runs like any other; within the probe, the clients of one
// provider share one count (`providerQuotas`).
import { stateDir } from '@saku/db/env';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type LoadedPlugins, providerQuotas } from '../registry';
import type { PluginContext, PluginInfo } from '../types';

export interface ProbeLine {
  at: string;
  source: string;
  ticker: string;
  date?: string;
  close?: number;
  volume?: number;
  divCash?: number;
  providerAdjClose?: number;
  error?: string;
}

export async function probe(
  plugins: LoadedPlugins,
  o: {
    ticker: string;
    from: string;
    to: string;
    context: (info: PluginInfo) => PluginContext;
    now?: () => Date;
    file?: string;
  },
): Promise<ProbeLine[]> {
  const now = o.now ?? (() => new Date());
  const lines: ProbeLine[] = [];
  // No store here: the contexts carry it (a context without one is counted in the run only).
  const quota = providerQuotas();
  for (const source of plugins.bars) {
    const base = { source: source.info.key, ticker: o.ticker };
    try {
      const ctx = o.context(source.info);
      const http = ctx.http as PluginContext['http'] | undefined;
      if (http) quota(source.info, http);
      // The quota guard counts the ticker against the provider's symbols-per-month limit; a
      // context without a client (tests) can send nothing.
      await http?.forSymbol(o.ticker);
      const bars = await source.fetchBars(o.ticker, o.from, o.to, ctx);
      const at = now().toISOString();
      for (const b of bars) {
        lines.push({
          at,
          ...base,
          date: b.date,
          close: b.close,
          ...(b.volume !== undefined && { volume: b.volume }),
          divCash: b.divCash,
          ...(b.providerAdjClose !== undefined && { providerAdjClose: b.providerAdjClose }),
        });
      }
      if (bars.length === 0) lines.push({ at, ...base, error: 'no bars' });
    } catch (e) {
      lines.push({
        at: now().toISOString(),
        ...base,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const file = o.file ?? join(stateDir(), 'probe.jsonl');
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return lines;
}

/**
 * Per source and date: when the bar first appeared, and when its values last changed, from the
 * probe file's lines (oldest first).
 */
export function finalization(lines: ProbeLine[]) {
  const out = new Map<
    string,
    { source: string; date: string; first: string; lastChange: string; changes: number }
  >();
  const last = new Map<string, string>();
  for (const l of lines) {
    if (!l.date) continue;
    const key = `${l.source}|${l.date}`;
    const values = JSON.stringify([l.close, l.volume, l.divCash, l.providerAdjClose]);
    const seen = out.get(key);
    if (!seen) {
      out.set(key, { source: l.source, date: l.date, first: l.at, lastChange: l.at, changes: 0 });
    } else if (last.get(key) !== values) {
      seen.lastChange = l.at;
      seen.changes++;
    }
    last.set(key, values);
  }
  return [...out.values()];
}
