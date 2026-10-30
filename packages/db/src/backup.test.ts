import { createClient } from '@libsql/client';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupDatabase,
  backupName,
  pruneBackups,
  restoreBackup,
  snapshotDatabase,
  toKeep,
} from './backup';
import { createDb } from './client';
import { migrateDb } from './migrate';
import { symbols } from './schema';

describe('backups', () => {
  it('backs up, checks and restores into a new database only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saku-backup-test-'));
    const url = `file:${join(dir, 'live.db')}`;
    const db = createDb({ url });
    await migrateDb(db);
    await db
      .insert(symbols)
      .values({ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' });
    db.$client.close();

    const { file, tables } = await backupDatabase(url, join(dir, 'backups'), '2026-01-05');
    expect(file.endsWith(backupName('2026-01-05'))).toBe(true);
    expect(tables).toBeGreaterThan(10);

    await expect(restoreBackup(file, join(dir, 'live.db'))).rejects.toThrow(/exists/);
    const target = join(dir, 'restored', 'saku.db');
    await restoreBackup(file, target);
    const c = createClient({ url: `file:${target}` });
    expect((await c.execute('SELECT ticker FROM symbols')).rows[0]?.[0]).toBe('AAA');
    c.close();
  });

  it('a snapshot never creates a missing source database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saku-snapshot-missing-'));
    const live = join(dir, 'live.db');
    const copy = join(dir, 'copy.db');
    for (const url of [`file:${live}`, `file://${live}`]) {
      await expect(snapshotDatabase(url, copy)).rejects.toThrow(/No database at/);
    }
    await expect(snapshotDatabase('file::memory:', copy)).rejects.toThrow(/not a database file/);
    await expect(snapshotDatabase('libsql://example.invalid', copy)).rejects.toThrow(
      /not a database file/,
    );
    expect(existsSync(live)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a corrupt backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saku-backup-bad-'));
    const { createGzip } = await import('node:zlib');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    const { createWriteStream } = await import('node:fs');
    const bad = join(dir, 'bad.db.gz');
    await pipeline(
      Readable.from([Buffer.from('not a database')]),
      createGzip(),
      createWriteStream(bad),
    );
    await expect(restoreBackup(bad, join(dir, 'out.db'))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['bad.db.gz']);
  });

  it('keeps 30 days plus the first of each month for 12 months', async () => {
    const days: string[] = [];
    for (
      let d = new Date('2025-01-01T00:00:00Z');
      d <= new Date('2026-03-31T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      days.push(d.toISOString().slice(0, 10));
    }
    const keep = toKeep(days);
    expect([...keep].filter((d) => d >= '2026-03-02').length).toBe(30);
    const monthly = [...keep].filter((d) => d.endsWith('-01') && d < '2026-03-02').sort();
    expect(monthly[0]).toBe('2025-04-01');
    expect(monthly.length).toBe(12); // 2025-04 to 2026-03
    const dir = mkdtempSync(join(tmpdir(), 'saku-prune-'));
    for (const d of days.slice(-40)) writeFileSync(join(dir, backupName(d)), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    // 40 - the 30 newest - the first of March and of February (02-20, the oldest there).
    expect((await pruneBackups(dir)).length).toBe(8);
    expect(readdirSync(dir)).toContain('notes.txt');
  });
});
