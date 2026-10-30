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
  savePluginInfos,
  validateInfos,
} from './registry';
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
  });
});
