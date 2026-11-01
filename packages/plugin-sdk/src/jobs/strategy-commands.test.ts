import { Strategy } from '@saku/core';
import { Sessions } from '@saku/data';
import { finishRun, schema, setSetting, startRun, symbolId, upsertSymbols } from '@saku/db';
import { parseVersion } from './forward';
import { testDb } from '@saku/db/testing';
import { eq } from 'drizzle-orm';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lock } from './lock';
import {
  checkStrategy,
  previewRegistration,
  recomputeRecords,
  registerStrategy,
} from './strategy-commands';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
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

const BROKER_COSTS = '{"slippageBps":"5","feePct":"0.1","fxSpreadPct":"0.2"}';

/** A database whose only symbol passed a full check through the last date. */
async function passed() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
  ]);
  const id = (await symbolId(db, 'AAA'))!;
  await db
    .insert(schema.bars)
    .values(
      D.map((date) => ({ symbolId: id, date, close: 1, source: 'p', status: 'green' as const })),
    );
  await setSetting(db, 'forward_records_from', D[0]);
  // The test strategy omits every cost: the install's are used (requirements 05 "Costs").
  await setSetting(db, 'broker_costs', BROKER_COSTS);
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
      sessions,
      lockDir: dir,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout[0]).toMatch(/^Registered Test: version /);
    expect(await db.select().from(schema.strategyVersions)).toHaveLength(1);
    expect(existsSync(join(dir, 'jobs.lock'))).toBe(false);
  });

  it('prints closed-day bars as a note, registered or refused', async () => {
    const db = await passed();
    const id = (await symbolId(db, 'AAA'))!;
    // A canonical row on a Saturday (left from before): no signal reads it.
    await db
      .insert(schema.bars)
      .values({ symbolId: id, date: '2026-01-03', close: 1, source: 'p', status: 'red' });
    const note = [
      'Note:',
      '- AAA: 1 bar on days the market was closed, excluded (no signal reads them): 2026-01-03.',
    ];
    const o = { ownerId: null, through: D[3], sessions };
    const refused = await registerStrategy(db, {
      ...o,
      strategy: strategy('same_close'),
      lockDir: lockDir(),
    });
    expect(refused).toMatchObject({ exitCode: 1, stdout: note });
    const out = await registerStrategy(db, { ...o, strategy: strategy(), lockDir: lockDir() });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.slice(-2)).toEqual(note);
  });

  it('refuses with a non-zero exit and registers nothing when there is a problem', async () => {
    const db = await passed();
    const out = await registerStrategy(db, {
      strategy: strategy('same_close'),
      ownerId: null,
      through: D[3],
      sessions,
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
      sessions,
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

describe('registerStrategy costs', () => {
  const o = { ownerId: null, through: D[3], sessions };
  const stored = async (db: Awaited<ReturnType<typeof passed>>) => {
    const [v] = await db.select().from(schema.strategyVersions);
    return v!;
  };

  it("stores the install's costs for those omitted; a later settings change leaves it as registered", async () => {
    const db = await passed();
    const out = await registerStrategy(db, { ...o, strategy: strategy(), lockDir: lockDir() });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      "Costs: slippageBps 5, feePct 0.1, fxSpreadPct 0.2 (not applied yet: backtests are in USD until the base-currency layer) (from the install's broker_costs: slippageBps, feePct, fxSpreadPct)",
    );
    const v = await stored(db);
    const costs = { slippageBps: 5, feePct: 0.1, fxSpreadPct: 0.2 };
    expect(JSON.parse(v.canonicalJson).strategy.costs).toEqual(costs);
    // The stored version parses unchanged (forward.ts reads it as registered).
    expect(parseVersion(v)).toEqual({ strategy: { ...strategy(), costs } });

    await setSetting(db, 'broker_costs', '{"slippageBps":"50","feePct":"1","fxSpreadPct":"2"}');
    const after = await stored(db);
    expect(after.canonicalJson).toBe(v.canonicalJson);
    expect(after.hash).toBe(v.hash);
    expect(parseVersion(after)).toEqual({ strategy: { ...strategy(), costs } });
  });

  it("keeps the strategy's own costs and takes only the omitted ones", async () => {
    const db = await passed();
    const own = Strategy.parse({ ...strategy(), costs: { slippageBps: 0, fxSpreadPct: 0.5 } });
    const out = await registerStrategy(db, { ...o, strategy: own, lockDir: lockDir() });
    expect(out.stdout).toContain(
      "Costs: slippageBps 0, feePct 0.1, fxSpreadPct 0.5 (not applied yet: backtests are in USD until the base-currency layer) (from the install's broker_costs: feePct)",
    );
    expect(JSON.parse((await stored(db)).canonicalJson).strategy.costs).toEqual({
      slippageBps: 0,
      feePct: 0.1,
      fxSpreadPct: 0.5,
    });
  });

  it('refuses and registers nothing when a cost is omitted and the install has none', async () => {
    const db = await passed();
    await db.delete(schema.appSettings).where(eq(schema.appSettings.key, 'broker_costs'));
    const out = await registerStrategy(db, { ...o, strategy: strategy(), lockDir: lockDir() });
    expect(out.exitCode).toBe(1);
    expect(out.stderr[0]).toMatch(
      /^Not registered:\n- The strategy leaves out costs\.slippageBps, costs\.feePct, costs\.fxSpreadPct and the install has no broker costs set/,
    );
    expect(await db.select().from(schema.strategyVersions)).toHaveLength(0);
    // Stated in the file, nothing is read from the install.
    const full = Strategy.parse({
      ...strategy(),
      costs: { slippageBps: 1, feePct: 0, fxSpreadPct: 0 },
    });
    const ok = await registerStrategy(db, { ...o, strategy: full, lockDir: lockDir() });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain(
      'Costs: slippageBps 1, feePct 0, fxSpreadPct 0 (not applied yet: backtests are in USD until the base-currency layer)',
    );
  });
});

describe('checkStrategy (pnpm strategy check)', () => {
  const N = '(not applied yet: backtests are in USD until the base-currency layer)';
  const noCosts = async () => {
    const db = await passed();
    await db.delete(schema.appSettings).where(eq(schema.appSettings.key, 'broker_costs'));
    return db;
  };

  it('prints the costs and valid; exit 1 when a cost is not known', async () => {
    expect(await checkStrategy(await passed(), strategy())).toEqual({
      exitCode: 0,
      stdout: [
        `Costs: slippageBps 5, feePct 0.1, fxSpreadPct 0.2 ${N} (from the install's broker_costs: slippageBps, feePct, fxSpreadPct)`,
        'Test: valid; depends on AAA.',
      ],
      stderr: [],
    });
    const out = await checkStrategy(await noCosts(), strategy());
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual([
      expect.stringMatching(/^Costs not known: The strategy leaves out/),
    ]);
  });

  it('with --registration lists every reason, the unknown costs among them, exit 1', async () => {
    const db = await noCosts();
    const out = await checkStrategy(db, strategy('same_close'), {
      through: D[3],
      sessions,
      lockDir: lockDir(),
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr[0]).toMatch(
      /^Would not register:\n- The strategy leaves out costs\.slippageBps.*\n- same_close trades at a close/,
    );
    // Ready: the costs line once, then valid, then ready.
    const ok = await checkStrategy(await passed(), strategy(), {
      through: D[3],
      sessions,
      lockDir: lockDir(),
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toEqual([
      expect.stringMatching(/^Costs: /),
      'Test: valid; depends on AAA.',
      'Ready to register.',
    ]);
  });
});

describe('previewRegistration', () => {
  const input = (execution: string, dir: string) => ({
    strategy: strategy(execution),
    through: D[3],
    sessions,
    lockDir: dir,
  });

  it('lists the problems with exit 1 and registers nothing', async () => {
    const db = await passed();
    const out = await previewRegistration(db, input('same_close', lockDir()));
    expect(out.exitCode).toBe(1);
    expect(out.stderr[0]).toMatch(/^Would not register:\n- same_close trades at a close/);
    expect(await db.select().from(schema.strategyVersions)).toHaveLength(0);
  });

  it('says ready with exit 0 and registers nothing', async () => {
    const db = await passed();
    const dir = lockDir();
    const out = await previewRegistration(db, input('next_open', dir));
    expect(out).toEqual({
      exitCode: 0,
      stdout: [
        'Ready to register.',
        "Costs: slippageBps 5, feePct 0.1, fxSpreadPct 0.2 (not applied yet: backtests are in USD until the base-currency layer) (from the install's broker_costs: slippageBps, feePct, fxSpreadPct)",
      ],
      stderr: [],
    });
    expect(await db.select().from(schema.strategyVersions)).toHaveLength(0);
    expect(existsSync(join(dir, 'jobs.lock'))).toBe(false);
  });

  it('refuses while a job holds the lock', async () => {
    const db = await passed();
    const dir = lockDir();
    lock('jobs', dir, process.ppid);
    const out = await previewRegistration(db, input('next_open', dir));
    expect(out.exitCode).toBe(1);
    expect(out.stderr[0]).toMatch(/^A job is running/);
  });
});

describe('recomputeRecords', () => {
  it('refuses while a job holds the lock', async () => {
    const db = await testDb();
    const dir = lockDir();
    lock('jobs', dir, process.ppid);
    const out = await recomputeRecords(db, { code: 'test', sessions, lockDir: dir });
    expect(out.exitCode).toBe(1);
    expect(out.stderr[0]).toMatch(/^A job is running/);
  });

  it('runs and releases the lock when no job holds it', async () => {
    const db = await testDb();
    const dir = lockDir();
    const out = await recomputeRecords(db, { code: 'test', sessions, lockDir: dir });
    expect(out).toEqual({
      exitCode: 0,
      stdout: ['0 recorded days, 0 new differences.'],
      stderr: [],
    });
    expect(existsSync(join(dir, 'jobs.lock'))).toBe(false);
  });
});
