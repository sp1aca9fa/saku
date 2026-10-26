import { describe, expect, it } from 'vitest';
import { finishRun, seedSourceRoles, startRun } from './runs';
import { jobRuns, sourceRoles } from './schema';
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
