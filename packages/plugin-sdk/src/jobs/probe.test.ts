import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageStore } from '../http';
import { emptyPlugins, pluginContext } from '../registry';
import type { BarSource } from '../types';
import { finalization, probe } from './probe';

const quiet = { info() {}, warn() {} };

const source = (
  key: string,
  fetch: () => Promise<{ date: string; close: number }[]>,
): BarSource => ({
  info: { key, kind: 'bar', name: key, provides: {}, suggestedRole: 'secondary', termsUrl: 'x' },
  fetchBars: async () =>
    (await fetch()).map((b) => ({ ...b, closeIsSplitAdjusted: false, divCash: 0, splitFactor: 1 })),
});

describe('probe', () => {
  it('appends what each source returned, and errors, to the probe file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saku-probe-')), 'probe.jsonl');
    const plugins = {
      ...emptyPlugins(),
      bars: [
        source('a', async () => [{ date: '2026-01-05', close: 10 }]),
        source('b', async () => {
          throw new Error('HTTP 503');
        }),
      ],
    };
    await probe(plugins, {
      ticker: 'AAA',
      from: '2026-01-01',
      to: '2026-01-05',
      context: () => ({ http: undefined as never, now: new Date(), log: { info() {}, warn() {} } }),
      now: () => new Date('2026-01-05T22:20:00Z'),
      file,
    });
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        at: '2026-01-05T22:20:00.000Z',
        source: 'a',
        ticker: 'AAA',
        date: '2026-01-05',
        close: 10,
        divCash: 0,
      },
      { at: '2026-01-05T22:20:00.000Z', source: 'b', ticker: 'AAA', error: 'HTTP 503' },
    ]);
  });

  it('names its ticker to the quota guard: a new one over the symbol cap is refused', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saku-probe-')), 'probe.jsonl');
    const recorded: (string | null)[] = [];
    const store: UsageStore = {
      load: async () => ({ requests: [], symbols: new Map([['OLD', Date.now()]]) }),
      record: async (_provider, _at, symbol) => {
        recorded.push(symbol);
      },
    };
    const fetching: BarSource = {
      ...source('a', async () => []),
      fetchBars: async (_t, _f, to, ctx) => {
        await ctx.http.json('https://example.test/bars');
        return [{ date: to, close: 1, closeIsSplitAdjusted: false, divCash: 0, splitFactor: 1 }];
      },
    };
    const run = (ticker: string, symbolsPerMonth: number) =>
      probe(
        { ...emptyPlugins(), bars: [fetching] },
        {
          ticker,
          from: '2026-01-01',
          to: '2026-01-05',
          context: (info) =>
            pluginContext({ ...info, limits: { symbolsPerMonth } }, quiet, {
              usage: store,
              http: {
                minDelayMs: 0,
                fetchImpl: (async () => new Response('{}')) as typeof fetch,
              },
            }),
          file,
        },
      );
    // 80% of 1 is 1 symbol: OLD is counted, AAA is new.
    expect((await run('AAA', 1))[0]).toMatchObject({ error: expect.stringMatching(/symbols/) });
    expect(recorded).toEqual([]);
    expect((await run('AAA', 10))[0]).toMatchObject({ close: 1 });
    expect(recorded).toEqual(['AAA']);
  });

  it('bar sources of one provider share its count: together under 80% of the limit', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saku-probe-')), 'probe.jsonl');
    const run = async (provider: string | undefined) => {
      let clock = 1_000_000;
      const times: number[] = [];
      const recorded: string[] = [];
      const store: UsageStore = {
        load: async () => ({ requests: [], symbols: new Map() }),
        record: async (p) => {
          recorded.push(p);
        },
      };
      const fetching = (key: string): BarSource => ({
        info: {
          ...source(key, async () => []).info,
          limits: { perMinute: 2 },
          ...(provider && { provider }),
        },
        fetchBars: async (_t, _f, to, ctx) => {
          await ctx.http.json('https://example.test/bars');
          return [{ date: to, close: 1, closeIsSplitAdjusted: false, divCash: 0, splitFactor: 1 }];
        },
      });
      const lines = await probe(
        { ...emptyPlugins(), bars: [fetching('acme-a'), fetching('acme-b')] },
        {
          ticker: 'AAA',
          from: '2026-01-01',
          to: '2026-01-05',
          context: (info) =>
            pluginContext(info, quiet, {
              usage: store,
              http: {
                minDelayMs: 0,
                clock: () => clock,
                wallClock: () => 0,
                sleep: async (ms) => {
                  clock += ms;
                },
                fetchImpl: (async () => {
                  times.push(clock);
                  return new Response('{}');
                }) as typeof fetch,
              },
            }),
          file,
        },
      );
      return { lines, times, recorded };
    };
    // 80% of 2 per minute is 1: the second source waits out the first one's minute.
    const shared = await run('acme');
    expect(shared.lines.every((l) => l.error === undefined)).toBe(true);
    expect(shared.times).toEqual([1_000_000, 1_060_001]);
    expect(shared.recorded).toEqual(['acme', 'acme']);
    // Default: each key is its own provider, paced alone.
    const apart = await run(undefined);
    expect(apart.times).toEqual([1_000_000, 1_000_000]);
    expect(apart.recorded).toEqual(['acme-a', 'acme-b']);
  });

  it('finds when a bar first appeared and last changed', () => {
    const l = (at: string, close: number) => ({ at, source: 'a', ticker: 'AAA', date: 'd', close });
    expect(finalization([l('t1', 10), l('t2', 10.1), l('t3', 10.1), l('t4', 10.1)])).toEqual([
      { source: 'a', date: 'd', first: 't1', lastChange: 't2', changes: 1 },
    ]);
  });
});
