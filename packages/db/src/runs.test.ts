import { describe, expect, it } from 'vitest';
import {
  finishRun,
  latestDailyRun,
  removeSourceRole,
  seedSourceRoles,
  setSourceRole,
  sourceRolesOf,
  startRun,
} from './runs';
import { activityLog, jobRuns, sourceRoles } from './schema';
import { testDb } from './testing';

describe('job runs', () => {
  it('records start and outcome', async () => {
    const db = await testDb();
    const id = await startRun(db, 'daily');
    await finishRun(db, id, { ok: false, error: 'boom', datesProcessed: ['2026-01-02'] });
    const [row] = await db.select().from(jobRuns);
    expect(row).toMatchObject({ status: 'failed', error: 'boom', datesProcessed: ['2026-01-02'] });
  });
});

describe('latestDailyRun', () => {
  const at = (iso: string) => new Date(iso);

  it('is undefined with no daily run, even when other jobs ran', async () => {
    const db = await testDb();
    expect(await latestDailyRun(db)).toBeUndefined();
    await finishRun(db, await startRun(db, 'weekly', at('2026-11-07T15:00:00Z')), { ok: true });
    expect(await latestDailyRun(db)).toBeUndefined();
  });

  it('is the latest daily-kind row by start: a later re-check or forced row wins', async () => {
    const db = await testDb();
    const day = await startRun(db, 'daily', at('2026-11-06T01:20:00Z'), '2026-11-05');
    await finishRun(db, day, { ok: true, datesProcessed: ['2026-11-05'] });
    const re = await startRun(db, 'daily', at('2026-11-06T02:20:00Z'), '2026-11-05', {
      recheck: true,
    });
    await finishRun(db, re, { ok: false, error: 'x', datesProcessed: ['2026-11-05'] });
    expect(await latestDailyRun(db)).toEqual({
      startedAt: '2026-11-06T02:20:00.000Z',
      status: 'failed',
      datesProcessed: ['2026-11-05'],
    });
    // A forced run killed after it started: still running, its target recorded at the start.
    await startRun(db, 'daily', at('2026-11-06T15:00:00Z'), '2026-11-05');
    expect(await latestDailyRun(db)).toMatchObject({
      status: 'running',
      datesProcessed: ['2026-11-05'],
    });
  });

  it('ignores a later weekly, bootstrap or checks row', async () => {
    const db = await testDb();
    const day = await startRun(db, 'daily', at('2026-11-06T01:20:00Z'), '2026-11-05');
    await finishRun(db, day, { ok: true, datesProcessed: ['2026-11-05'] });
    for (const job of ['weekly', 'bootstrap', 'checks'] as const) {
      await finishRun(db, await startRun(db, job, at('2026-11-07T15:00:00Z')), { ok: false });
    }
    expect(await latestDailyRun(db)).toMatchObject({
      status: 'success',
      datesProcessed: ['2026-11-05'],
    });
  });
});

describe('seedSourceRoles', () => {
  it('seeds one primary per data kind and never touches a kind already set', async () => {
    const db = await testDb();
    await seedSourceRoles(db, [
      { key: 'a', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 'b', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 'c', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    expect(
      await seedSourceRoles(db, [{ key: 'z', dataKind: 'bars', suggestedRole: 'primary' }]),
    ).toBe(0);
    const rows = await db.select().from(sourceRoles);
    expect(rows.map((r) => `${r.pluginKey}:${r.role}`)).toEqual([
      'a:primary',
      'b:secondary',
      'c:secondary',
    ]);
  });
});

describe('source roles set by the admin', () => {
  it('one primary: a new one demotes the old; new sources go last; removal is logged', async () => {
    const db = await testDb();
    await seedSourceRoles(db, [
      { key: 'a', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 'b', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    expect(
      await setSourceRole(db, { dataKind: 'bars', key: 'csv', role: 'primary', actor: 'cli' }),
    ).toEqual({ demoted: 'a' });
    const roles = (await sourceRolesOf(db)).map((r) => [r.pluginKey, r.role, r.position]);
    expect(roles).toEqual([
      ['a', 'secondary', 0],
      ['b', 'secondary', 1],
      ['csv', 'primary', 2],
    ]);
    // Setting the same primary again demotes nothing.
    expect(
      await setSourceRole(db, { dataKind: 'bars', key: 'csv', role: 'primary', actor: 'cli' }),
    ).toEqual({});
    // The primary is never demoted or removed by itself: one primary always remains.
    await expect(
      setSourceRole(db, { dataKind: 'bars', key: 'csv', role: 'secondary', actor: 'cli' }),
    ).rejects.toThrow('set another source as primary first');
    await expect(
      removeSourceRole(db, { dataKind: 'bars', key: 'csv', actor: 'cli' }),
    ).rejects.toThrow('primary');
    await setSourceRole(db, { dataKind: 'bars', key: 'a', role: 'primary', actor: 'cli' });
    expect(await removeSourceRole(db, { dataKind: 'bars', key: 'csv', actor: 'cli' })).toBe(true);
    expect(await removeSourceRole(db, { dataKind: 'bars', key: 'csv', actor: 'cli' })).toBe(false);
    const log = (await db.select().from(activityLog)).map((r) => r.action);
    expect(log).toEqual([
      'source_roles.seed',
      'source_roles.set',
      'source_roles.set',
      'source_roles.set',
      'source_roles.remove',
    ]);
  });
});
