import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { dbConfigFromEnv } from './env';
import { pendingMigrations } from './migrate';
import { bars, fxRates, jobRuns, symbols, users } from './schema';
import { testDb } from './testing';

describe('database', () => {
  it('applies every migration', async () => {
    const db = await testDb();
    expect(await pendingMigrations(db)).toEqual([]);
  });

  it('enforces stable enums with CHECK constraints', async () => {
    const db = await testDb();
    const run = { jobType: 'daily', startedAt: '2026-01-02T00:00:00Z', status: 'running' } as const;
    await db.insert(jobRuns).values(run);
    await expect(db.insert(jobRuns).values({ ...run, status: 'done' as never })).rejects.toThrow();
    const [spy] = await db
      .insert(symbols)
      .values({ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' })
      .returning();
    const bar = { symbolId: spy!.id, date: '2026-01-02', close: 10, source: 'example' };
    await expect(db.insert(bars).values({ ...bar, status: 'blue' as never })).rejects.toThrow();
    await db.insert(bars).values(bar);
  });

  it('keeps usernames unique', async () => {
    const db = await testDb();
    await db.insert(users).values({ username: 'alex' });
    await expect(db.insert(users).values({ username: 'alex' })).rejects.toThrow();
  });

  it('keeps every vintage of an FX rate', async () => {
    const db = await testDb();
    const rate = {
      pair: 'USDXXX',
      date: '2026-01-02',
      source: 'example',
      kind: 'valuation',
    } as const;
    await db.insert(fxRates).values({
      ...rate,
      rate: 100,
      fetchedAt: '2026-01-02T16:00:00Z',
      knownAt: '2026-01-02T16:00:00Z',
    });
    await db.insert(fxRates).values({
      ...rate,
      rate: 101,
      fetchedAt: '2026-01-03T16:00:00Z',
      knownAt: '2026-01-03T16:00:00Z',
    });
    const rows = await db.select().from(fxRates).where(eq(fxRates.pair, 'USDXXX'));
    expect(rows.map((r) => r.rate)).toEqual([100, 101]);
  });
});

describe('dbConfigFromEnv', () => {
  it('defaults to saku.db in the data folder', () => {
    expect(dbConfigFromEnv({ SAKU_DATA_DIR: '/tmp/saku-test-data' }).url).toBe(
      'file:/tmp/saku-test-data/saku.db',
    );
  });

  it('refuses hosted databases', () => {
    expect(() => dbConfigFromEnv({ DATABASE_URL: 'libsql://example.turso.io' })).toThrow();
  });
});
