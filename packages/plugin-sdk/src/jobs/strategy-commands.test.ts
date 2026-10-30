import { Strategy } from '@saku/core';
import { finishRun, schema, setSetting, startRun, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lock } from './lock';
import { recomputeRecords, registerStrategy } from './strategy-commands';

const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'] as const;
const strategy = (execution = 'next_open') =>
  Strategy.parse({
    name: 'Test',
    account: 'taxable',
    execution,
    safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
    evaluation: { frequency: 'daily' },
    allocations: [{ name: 'All', holdings: [{ ticker: 'AAA', weight: 100 }] }],
  });

/** A database whose only symbol passed a full check through the last date. */
async function passed() {
  const db = await testDb();
  await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  const id = (await symbolId(db, 'AAA'))!;
  await db
    .insert(schema.bars)
    .values(
      D.map((date) => ({ symbolId: id, date, close: 1, source: 'p', status: 'green' as const })),
    );
  await setSetting(db, 'forward_records_from', D[0]);
  const run = await startRun(db, 'checks');
  await db
    .insert(schema.healthCoverage)
    .values({ runId: run, symbolId: id, fromDate: D[0], toDate: D[3] });
  await db.insert(schema.dataHealth).values(
    D.map((date) => ({
      runId: run,
      date,
      symbolId: null,
      status: 'green' as const,
      reasons: [],
    })),
  );
  await finishRun(db, run, { ok: true, datesProcessed: [D[3]] });
  return db;
}

const lockDir = () => join(mkdtempSync(join(tmpdir(), 'saku-register-test-')), 'locks');

describe('registerStrategy', () => {
  it('registers when nothing refuses it, and releases the lock', async () => {
    const db = await passed();
    const dir = lockDir();
    const out = await registerStrategy(db, {
      strategy: strategy(),
      ownerId: null,
      through: D[3],
      lockDir: dir,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout[0]).toMatch(/^Registered Test: version /);
    expect(await db.select().from(schema.strategyVersions)).toHaveLength(1);
    expect(existsSync(join(dir, 'jobs.lock'))).toBe(false);
  });

  it('refuses with a non-zero exit and registers nothing when there is a problem', async () => {
    const db = await passed();
    const out = await registerStrategy(db, {
      strategy: strategy('same_close'),
      ownerId: null,
      through: D[3],
      lockDir: lockDir(),
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr[0]).toMatch(/^Not registered:\n- same_close trades at a close/);
    expect(await db.select().from(schema.strategyVersions)).toHaveLength(0);
  });

  it('refuses while a job holds the lock, without reading or registering', async () => {
    const db = await passed();
    const dir = lockDir();
    // Held by another live process (the test runner's parent).
    const held = lock('jobs', dir, process.ppid);
    expect('release' in held).toBe(true);
    const out = await registerStrategy(db, {
      strategy: strategy(),
      ownerId: null,
      through: D[3],
      lockDir: dir,
    });
    expect(out).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: [`A job is running (process ${process.ppid}); try again when it is done.`],
    });
    expect(await db.select().from(schema.strategyVersions)).toHaveLength(0);
    expect(existsSync(join(dir, 'jobs.lock'))).toBe(true);
  });
});

describe('recomputeRecords', () => {
  it('refuses while a job holds the lock', async () => {
    const db = await testDb();
    const dir = lockDir();
    lock('jobs', dir, process.ppid);
    const out = await recomputeRecords(db, { code: 'test', lockDir: dir });
    expect(out.exitCode).toBe(1);
    expect(out.stderr[0]).toMatch(/^A job is running/);
  });

  it('runs and releases the lock when no job holds it', async () => {
    const db = await testDb();
    const dir = lockDir();
    const out = await recomputeRecords(db, { code: 'test', lockDir: dir });
    expect(out).toEqual({
      exitCode: 0,
      stdout: ['0 recorded days, 0 new differences.'],
      stderr: [],
    });
    expect(existsSync(join(dir, 'jobs.lock'))).toBe(false);
  });
});
