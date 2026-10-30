import { schema } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadPlugins,
  notifierContexts,
  pluginContext,
  providerOf,
  providerQuotas,
  providerUsageStore,
  savePluginInfos,
  validateInfos,
} from './registry';
import { PoliteHttp, QuotaError, type UsageStore } from './http';
import type { PluginInfo } from './types';

const info: PluginInfo = {
  key: 'example',
  kind: 'bar',
  name: 'Example Data',
  provides: { tickers: ['AAA'] },
  suggestedRole: 'secondary',
  termsUrl: 'https://example.test/terms',
};
const log = { info: () => {}, warn: () => {} };

describe('plug-in registry', () => {
  it('loads the public package and skips a missing private one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saku-plugins-'));
    mkdirSync(join(root, 'plugins-public', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'plugins-public', 'src', 'index.ts'),
      `export const bars = [{ info: ${JSON.stringify(info)}, fetchBars: async () => [] }];`,
    );
    const loaded = await loadPlugins(root);
    expect(loaded.bars.map((b) => b.info.key)).toEqual(['example']);
    expect(loaded.missing).toEqual(['plugins']);
  });

  it('refuses bad or duplicate keys', () => {
    expect(() => validateInfos([{ ...info, key: 'Bad Key' }])).toThrow();
    expect(() => validateInfos([info, info])).toThrow(/Two bar plug-ins/);
    expect(() => validateInfos([info, { ...info, kind: 'fx' }])).not.toThrow();
  });

  it('refuses a declared adjusted-close rounding that is not a small positive number', () => {
    expect(() => validateInfos([{ ...info, adjCloseRounding: 1e-6 }])).not.toThrow();
    for (const bad of [0, -1e-6, 1e-4, Number.NaN]) {
      expect(() => validateInfos([{ ...info, adjCloseRounding: bad }])).toThrow(/adjCloseRounding/);
    }
  });

  it('refuses a publishes declaration that is not an issuer source naming known kinds', () => {
    const issuer = { ...info, kind: 'issuer' as const };
    expect(() => validateInfos([{ ...issuer, publishes: { nav: true } }])).not.toThrow();
    expect(() =>
      validateInfos([{ ...issuer, publishes: { distributions: true, splits: true } }]),
    ).not.toThrow();
    const bad: unknown[] = [{}, { navs: true }, { nav: false }, { nav: 'yes' }, null, []];
    for (const publishes of bad) {
      expect(() =>
        validateInfos([{ ...issuer, publishes: publishes as PluginInfo['publishes'] }]),
      ).toThrow(/publishes/);
    }
    expect(() => validateInfos([{ ...info, publishes: { nav: true } }])).toThrow(/publishes/);
  });

  it('refuses plug-ins of one provider with different limits, naming both', () => {
    const bars = { ...info, key: 'acme-bars', provider: 'acme', limits: { perMinute: 10 } };
    const fx = { ...info, key: 'acme-fx', kind: 'fx' as const, provider: 'acme' };
    expect(() => validateInfos([bars, { ...fx, limits: { perMinute: 10 } }])).not.toThrow();
    for (const limits of [undefined, { perMinute: 20 }, { perMinute: 10, perDay: 100 }]) {
      expect(() => validateInfos([bars, { ...fx, limits }])).toThrow(
        /"bar acme-bars" and "fx acme-fx" share the provider "acme" but declare different limits/,
      );
    }
    // Default provider: the key. The same key in two kinds is one provider.
    expect(() => validateInfos([info, { ...info, kind: 'fx', limits: { perDay: 5 } }])).toThrow(
      /share the provider "example"/,
    );
    // A provider id that is another plug-in's key is that plug-in's provider.
    expect(() =>
      validateInfos([
        { ...info, key: 'acme', limits: { perMinute: 10 } },
        { ...fx, limits: { perMinute: 10 } },
      ]),
    ).not.toThrow();
    // A notifier is its own provider (its key); calendars send no requests.
    const notifier = { key: 'acme', kind: 'notifier' as const, termsUrl: 'x', limits: {} };
    expect(() => validateInfos([bars, notifier])).toThrow(/different limits/);
    expect(() => validateInfos([bars, { ...info, key: 'acme', kind: 'calendar' }])).not.toThrow();
    for (const provider of ['Acme', 'a', '', 'acme provider']) {
      expect(() => validateInfos([{ ...bars, provider }])).toThrow(/provider/);
    }
  });

  it('counts a context under its provider id, by default its key', async () => {
    const asked: string[] = [];
    const store: UsageStore = {
      load: async (provider) => {
        asked.push(provider);
        throw new Error('database locked');
      },
      record: async () => {},
    };
    for (const i of [info, { ...info, provider: 'acme' }]) {
      const ctx = pluginContext(i, log, { env: {}, usage: store });
      expect(ctx.http.provider).toBe(providerOf(i));
      await expect(ctx.http.text('https://example.test/a')).rejects.toBeInstanceOf(QuotaError);
    }
    expect(asked).toEqual(['example', 'acme']);
  });

  it('providerQuotas: the clients of one provider share a guarded count; others stay apart', () => {
    const store: UsageStore = {
      load: async () => ({ requests: [], symbols: new Map() }),
      record: async () => {},
    };
    const quota = providerQuotas(store);
    const a = new PoliteHttp();
    const b = new PoliteHttp();
    const c = new PoliteHttp();
    quota({ key: 'acme-bars', provider: 'acme' }, a);
    quota({ key: 'acme-fx', provider: 'acme' }, b);
    quota({ key: 'other' }, c);
    expect([a.provider, b.provider, c.provider]).toEqual(['acme', 'acme', 'other']);
    // A client already counted under another id is refused (it would store under the wrong one).
    const wrong = new PoliteHttp({ usage: { provider: 'x', store } });
    expect(() => quota({ key: 'new' }, wrong)).toThrow(/counted under x/);
    expect(() =>
      quota({ key: 'z', provider: 'acme' }, new PoliteHttp({ limits: { perDay: 1 } })),
    ).toThrow(/same limits/);
  });

  it('a plug-in without limits can send (no declared limit)', async () => {
    const ctx = pluginContext(info, log, {
      env: {},
      http: { minDelayMs: 0, fetchImpl: (async () => new Response('{}')) as typeof fetch },
    });
    await ctx.http.forSymbol('AAA');
    await expect(ctx.http.json('https://example.test/a')).resolves.toEqual({});
  });

  it("hands over the run's final time when given", () => {
    expect(pluginContext(info, log, { env: {}, finalAfter: '18:30' }).finalAfter).toBe('18:30');
    expect(pluginContext(info, log, { env: {} }).finalAfter).toBeUndefined();
  });

  it('saves descriptions, replacing the previous run’s', async () => {
    const db = await testDb();
    await savePluginInfos(db, [info], new Date('2026-01-01T00:00:00Z'));
    await savePluginInfos(db, [{ ...info, name: 'Renamed' }], new Date('2026-01-02T00:00:00Z'));
    const rows = await db.select().from(schema.pluginInfo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ savedAt: '2026-01-02T00:00:00.000Z' });
    expect((rows[0]!.description as PluginInfo).name).toBe('Renamed');
  });

  it('hands over the key, and stops when it is missing', () => {
    const keyed = { ...info, keyEnv: 'EXAMPLE_KEY' };
    expect(pluginContext(keyed, log, { env: { EXAMPLE_KEY: 'k' } }).apiKey).toBe('k');
    expect(() => pluginContext(keyed, log, { env: {} })).toThrow(/EXAMPLE_KEY/);
    const two = { ...info, keyEnv: ['EXAMPLE_ID', 'EXAMPLE_SECRET'] };
    expect(() => pluginContext(two, log, { env: { EXAMPLE_ID: 'i' } })).toThrow(/EXAMPLE_SECRET/);
    const ctx = pluginContext(two, log, { env: { EXAMPLE_ID: 'i', EXAMPLE_SECRET: 's' } });
    expect(ctx.keys).toEqual({ EXAMPLE_ID: 'i', EXAMPLE_SECRET: 's' });
  });
});

describe('notifierContexts', () => {
  it('keeps one client per channel for the run, without retries', () => {
    const notifier = {
      info: { key: 'fake', kind: 'notifier' as const, name: 'Fake', termsUrl: 'x', maxLength: 10 },
      validTarget: () => true,
      send: async () => {},
    };
    const contexts = notifierContexts({ info() {}, warn() {} });
    const a = contexts(notifier, 'c1');
    expect(contexts(notifier, 'c1')).toBe(a);
    // A channel the service refuses blocks only its own client.
    expect(contexts(notifier, 'c2').http).not.toBe(a.http);
    expect(a.http.guarded).toBe(false);
  });

  it('with a usage store, every channel counts the service’s requests across runs', async () => {
    const notifier = {
      info: { key: 'fake', kind: 'notifier' as const, name: 'Fake', termsUrl: 'x', maxLength: 10 },
      validTarget: () => true,
      send: async () => {},
    };
    const asked: string[] = [];
    const store: UsageStore = {
      load: async (provider) => {
        asked.push(provider);
        throw new Error('database locked');
      },
      record: async () => {},
    };
    const contexts = notifierContexts({ info() {}, warn() {} }, store);
    for (const channel of ['c1', 'c2']) {
      const ctx = contexts(notifier, channel);
      expect(ctx.http.guarded).toBe(true);
      // Unknown usage: nothing is sent (the store is read before any request).
      await expect(ctx.http.text('https://example.test/hook')).rejects.toBeInstanceOf(QuotaError);
    }
    // Loaded once for the service (the channels share it), refused for both.
    expect(asked).toEqual(['fake']);
  });

  it('channels of one service share its pace: together never above 80% of the limit', async () => {
    const notifier = {
      info: {
        key: 'fake',
        kind: 'notifier' as const,
        name: 'Fake',
        termsUrl: 'x',
        maxLength: 10,
        limits: { perMinute: 10 },
      },
      validTarget: () => true,
      send: async () => {},
    };
    let now = 1_000_000;
    const times: number[] = [];
    const contexts = notifierContexts({ info() {}, warn() {} }, undefined, {
      minDelayMs: 0,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: (async () => {
        times.push(now);
        return new Response('ok');
      }) as typeof fetch,
    });
    const c1 = contexts(notifier, 'c1');
    const c2 = contexts(notifier, 'c2');
    for (let k = 0; k < 12; k++) {
      await c1.http.text('https://example.test/1');
      await c2.http.text('https://example.test/2');
    }
    expect(times).toHaveLength(24);
    for (const t of times) {
      expect(times.filter((u) => u > t - 60_000 && u <= t).length).toBeLessThanOrEqual(8);
    }
  });

  it('a shared count is loaded once and kept with a clock ahead of the system one', async () => {
    const db = await testDb();
    const store = providerUsageStore(db);
    const wall = Date.parse('2026-01-05T10:00:00Z');
    await store.record('fake', wall - 30_000, null);
    const loadedAt: number[] = [];
    const watched: UsageStore = {
      load: async (provider, at) => {
        loadedAt.push(at);
        return store.load(provider, at);
      },
      record: store.record,
    };
    // The run's clock is two days ahead: reading at it would prune and skip the request above.
    const http = new PoliteHttp({
      usage: { provider: 'fake', store: watched },
      clock: () => wall + 2 * 86_400_000,
      wallClock: () => wall,
      limits: { perDay: 2 },
      fetchImpl: (async () => new Response('ok')) as typeof fetch,
      sleep: async () => {},
      minDelayMs: 0,
    });
    await http.text('https://example.test/hook');
    expect(loadedAt).toEqual([wall]);
    const rows = await db.select().from(schema.providerUsage);
    expect(rows.some((r) => r.windowStart === '2026-01-05T09:59:00.000Z')).toBe(true);
  });
});
