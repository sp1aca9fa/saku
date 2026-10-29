import { describe, expect, it } from 'vitest';
import {
  finishRun,
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
