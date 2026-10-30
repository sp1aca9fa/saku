import { Sessions } from '@saku/data';
import { recordProviderRequest, schema } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formerKeys,
  loadPlugins,
  notifierContexts,
  pluginContext,
  providerOf,
  providerQuotas,
  providerUsageStore,
  savePluginInfos,
  savedPluginInfos,
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

  it('every shipped calendar table loads as sessions (a bad table fails here, not every job)', async () => {
    const loaded = await loadPlugins();
    const tables = loaded.calendars.flatMap((c) => c.calendars);
    expect(tables.map((t) => t.id)).toEqual(
      expect.arrayContaining(['xnys', 'us-fed', 'ecb-target']),
    );
    for (const t of tables) {
      const sessions = new Sessions(t);
      for (const d of t.earlyCloses?.dates ?? []) expect(sessions.closeOf(d)).toBe('early');
    }
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

  it('formerKeys: per provider, the keys of plug-ins declaring it under another id', () => {
    const keys = formerKeys([
      { key: 'acme-bars', kind: 'bar', provider: 'acme' },
      { key: 'acme-bars', kind: 'fx', provider: 'acme' },
      { key: 'acme', kind: 'series', provider: 'acme' },
      { key: 'acme-days', kind: 'calendar', provider: 'acme' },
      { key: 'other', kind: 'bar' },
    ]);
    expect([...keys]).toEqual([['acme', ['acme-bars']]]);
  });

  it('formerKeys: provider ids from the saved descriptions (renamed, removed, added)', () => {
    const saved = [
      { key: 'acme-bars', kind: 'bar', description: { key: 'acme-bars', provider: 'acme' } },
      {
        key: 'acme-fx',
        kind: 'fx',
        description: { key: 'acme-fx', provider: 'acme-corp', formerProviders: ['acme-old'] },
      },
      { key: 'solo', kind: 'bar', description: { key: 'solo', provider: 'solo-co' } },
      { key: 'fresh', kind: 'bar', description: { key: 'fresh' } },
      { key: 'days', kind: 'calendar', description: { key: 'days', provider: 'x-days' } },
      // Another kind under the same key: not this plug-in's row.
      { key: 'fresh', kind: 'fx', description: { key: 'fresh', provider: 'elsewhere' } },
      // A removed plug-in's row is not read (even unreadable).
      { key: 'gone', kind: 'bar', description: 'garbage' },
    ];
    const keys = formerKeys(
      [
        // Renamed acme to acme-corp; the fx plug-in was already saved under it.
        { key: 'acme-bars', kind: 'bar', provider: 'acme-corp' },
        { key: 'acme-fx', kind: 'fx', provider: 'acme-corp' },
        // Removed: back to the key.
        { key: 'solo', kind: 'bar' },
        // Added: the key counts (as before).
        { key: 'fresh', kind: 'bar', provider: 'fresh-co' },
        { key: 'days', kind: 'calendar' },
      ],
      saved,
    );
    expect([...keys]).toEqual([
      ['acme-corp', ['acme-bars', 'acme', 'acme-fx', 'acme-old']],
      ['solo', ['solo-co']],
      ['fresh-co', ['fresh']],
    ]);
  });

  it('fault: an unreadable saved description of a loaded plug-in throws (history unknown)', () => {
    const loaded = [{ key: 'acme-bars', kind: 'bar' as const }];
    for (const description of [
      null,
      'text',
      [],
      { provider: 7 },
      { provider: 'Bad Id' },
      { formerProviders: 'acme' },
      { formerProviders: ['acme', 3] },
    ]) {
      expect(() => formerKeys(loaded, [{ key: 'acme-bars', kind: 'bar', description }])).toThrow(
        /bar acme-bars unreadable/,
      );
    }
  });

  it('providerQuotas: the guarded count loads the history of former keys too', async () => {
    const asked: string[] = [];
    const store: UsageStore = {
      load: async (id) => {
        asked.push(id);
        return { requests: [], symbols: new Map() };
      },
      record: async () => {},
    };
    const quota = providerQuotas(store, undefined, new Map([['acme', ['acme-bars', 'acme-fx']]]));
    const fetchImpl = (async () => new Response('{}')) as typeof fetch;
    const a = new PoliteHttp({ fetchImpl, minDelayMs: 0 });
    const b = new PoliteHttp({ fetchImpl, minDelayMs: 0 });
    quota({ key: 'acme-bars', provider: 'acme' }, a);
    quota({ key: 'acme-fx', provider: 'acme' }, b);
    await b.json('https://example.test/a');
    await a.json('https://example.test/a');
    expect(asked).toEqual(['acme', 'acme-bars', 'acme-fx']);
    // A client its context already guarded under the provider id gets them as well.
    asked.length = 0;
    const own = providerQuotas(undefined, undefined, new Map([['acme', ['acme-bars']]]));
    const c = new PoliteHttp({ fetchImpl, usage: { provider: 'acme', store } });
    own({ key: 'acme-bars', provider: 'acme' }, c);
    await c.json('https://example.test/a');
    expect(asked).toEqual(['acme', 'acme-bars']);
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

  describe('saved provider ids', () => {
    const at = (iso: string) => new Date(iso);
    const stored = (db: Awaited<ReturnType<typeof testDb>>) =>
      savedPluginInfos(db).then((rows) =>
        rows.map((r) => r.description as Record<string, unknown>),
      );

    it('a renamed provider id is saved as former while its usage counts, merged across saves', async () => {
      const db = await testDb();
      const bars: PluginInfo = { ...info, provider: 'acme' };
      await savePluginInfos(db, [bars], at('2026-01-01T00:00:00Z'));
      await recordProviderRequest(db, {
        provider: 'acme',
        at: Date.parse('2026-01-01T12:00:00Z'),
        symbol: 'AAA',
      });
      // Renamed: acme is remembered (its symbol counts for 31 days).
      await savePluginInfos(db, [{ ...bars, provider: 'acme-corp' }], at('2026-01-02T00:00:00Z'));
      expect((await stored(db))[0]).toMatchObject({
        provider: 'acme-corp',
        formerProviders: ['acme'],
      });
      // Renamed again after acme-corp stored usage: both kept.
      await recordProviderRequest(db, {
        provider: 'acme-corp',
        at: Date.parse('2026-01-02T12:00:00Z'),
        symbol: 'BBB',
      });
      await savePluginInfos(db, [{ ...bars, provider: 'acme-x' }], at('2026-01-03T00:00:00Z'));
      expect((await stored(db))[0]).toMatchObject({ formerProviders: ['acme', 'acme-corp'] });
      // A save that changes nothing keeps them.
      await savePluginInfos(db, [{ ...bars, provider: 'acme-x' }], at('2026-01-04T00:00:00Z'));
      expect((await stored(db))[0]).toMatchObject({ formerProviders: ['acme', 'acme-corp'] });
      // Back to acme: it is the provider again, not a former id; acme-x never stored usage.
      await savePluginInfos(db, [bars], at('2026-01-05T00:00:00Z'));
      expect((await stored(db))[0]).toMatchObject({
        provider: 'acme',
        formerProviders: ['acme-corp'],
      });
    });

    it('an old id is dropped once no window counts its rows; a removed id goes back to the key', async () => {
      const db = await testDb();
      await savePluginInfos(db, [{ ...info, provider: 'acme' }], at('2026-01-01T00:00:00Z'));
      await recordProviderRequest(db, {
        provider: 'acme',
        at: Date.parse('2026-01-01T12:00:00Z'),
        symbol: 'AAA',
      });
      // Removed (back to the key): acme still counts on day 31.
      await savePluginInfos(db, [info], at('2026-02-01T00:00:00Z'));
      expect((await stored(db))[0]).toMatchObject({ formerProviders: ['acme'] });
      expect((await stored(db))[0]!.provider).toBeUndefined();
      // Day 33: the symbol's day is outside 31 days and no request is in the last day.
      await savePluginInfos(db, [info], at('2026-02-03T00:00:00Z'));
      expect((await stored(db))[0]!.formerProviders).toBeUndefined();
      // Rows without a symbol count only for a day.
      const db2 = await testDb();
      await savePluginInfos(db2, [{ ...info, provider: 'acme' }], at('2026-01-01T00:00:00Z'));
      await recordProviderRequest(db2, {
        provider: 'acme',
        at: Date.parse('2026-01-01T12:00:00Z'),
        symbol: null,
      });
      await savePluginInfos(db2, [info], at('2026-01-02T11:00:00Z'));
      expect((await stored(db2))[0]).toMatchObject({ formerProviders: ['acme'] });
      await savePluginInfos(db2, [info], at('2026-01-02T13:00:00Z'));
      expect((await stored(db2))[0]!.formerProviders).toBeUndefined();
    });

    it('a calendar gets no former ids; an unreadable saved description stops the save', async () => {
      const db = await testDb();
      const days: PluginInfo = { ...info, key: 'days', kind: 'calendar', provider: 'x-days' };
      await savePluginInfos(db, [days], at('2026-01-01T00:00:00Z'));
      await recordProviderRequest(db, {
        provider: 'x-days',
        at: Date.parse('2026-01-01T01:00:00Z'),
        symbol: 'A',
      });
      await savePluginInfos(db, [{ ...days, provider: undefined }], at('2026-01-01T02:00:00Z'));
      expect((await stored(db))[0]!.formerProviders).toBeUndefined();
      await db
        .update(schema.pluginInfo)
        .set({ description: { key: 'days', provider: 'NOT AN ID' } });
      await expect(
        savePluginInfos(db, [{ ...info, key: 'days', kind: 'bar' }, days]),
      ).resolves.toBeUndefined();
      await db.delete(schema.pluginInfo);
      await savePluginInfos(db, [info], at('2026-01-01T00:00:00Z'));
      await db.update(schema.pluginInfo).set({ description: { key: 'example', provider: 3 } });
      await expect(savePluginInfos(db, [info], at('2026-01-01T01:00:00Z'))).rejects.toThrow(
        /bar example unreadable/,
      );
    });
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

  it('a channel the service refuses (429) stops only itself', async () => {
    const notifier = {
      info: { key: 'fake', kind: 'notifier' as const, name: 'Fake', termsUrl: 'x', maxLength: 10 },
      validTarget: () => true,
      send: async () => {},
    };
    const contexts = notifierContexts({ info() {}, warn() {} }, undefined, {
      minDelayMs: 0,
      fetchImpl: (async (url: string) =>
        new Response('ok', { status: url.endsWith('/1') ? 429 : 200 })) as typeof fetch,
    });
    const c1 = contexts(notifier, 'c1');
    const c2 = contexts(notifier, 'c2');
    const c3 = contexts(notifier, 'c3');
    await expect(c1.http.text('https://example.test/1')).rejects.toThrow(/HTTP 429/);
    await expect(c2.http.text('https://example.test/2')).resolves.toBe('ok');
    await expect(c2.http.text('https://example.test/1')).rejects.toThrow(/HTTP 429/);
    await expect(c3.http.text('https://example.test/3')).resolves.toBe('ok');
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
