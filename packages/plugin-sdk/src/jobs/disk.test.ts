import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addChannel, createUser, setSetting } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { sendDiskSpace } from './alerts';
import { DISK_WARN_PERCENT, diskLine, diskWarns, formatBytes, measureDisk } from './disk';
import { fakeNotifier } from './testkit';

const fsOf = (total: number, free: number) => async () => ({
  bsize: 1,
  blocks: total,
  bavail: free,
});

describe('measureDisk', () => {
  it('sums the database with its -wal and -shm files and reads the disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saku-disk-'));
    const file = join(dir, 'x.db');
    writeFileSync(file, Buffer.alloc(1000));
    writeFileSync(`${file}-wal`, Buffer.alloc(200));
    const d = await measureDisk(`file:${file}`, fsOf(1000, 400));
    expect(d).toMatchObject({
      databaseBytes: 1200,
      totalBytes: 1000,
      freeBytes: 400,
      usedPercent: 60,
    });
  });

  it('is unknown for a non-file or missing database', async () => {
    expect(await measureDisk('libsql://host', fsOf(1, 1))).toBeNull();
    expect(await measureDisk('file::memory:', fsOf(1, 1))).toBeNull();
    expect(await measureDisk('file:/nonexistent/x.db', fsOf(1, 1))).toBeNull();
  });

  it('warns at exactly 70.0 and not at 69.9', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saku-disk-'));
    const file = join(dir, 'x.db');
    writeFileSync(file, 'x');
    expect(DISK_WARN_PERCENT).toBe(70);
    expect(diskWarns((await measureDisk(`file:${file}`, fsOf(1000, 301)))!)).toBe(false);
    expect(diskWarns((await measureDisk(`file:${file}`, fsOf(1000, 300)))!)).toBe(true);
  });
});

describe('disk line', () => {
  it('formats sizes and the used percent', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    const d = { databaseBytes: 3 * 1024 ** 2, totalBytes: 1000, freeBytes: 300, usedPercent: 70 };
    expect(diskLine(d)).toBe('Database 3.0 MB; disk 70.0% used, 300 B free (warning at 70%).');
    expect(diskLine({ ...d, freeBytes: 600, usedPercent: 40 })).toBe(
      'Database 3.0 MB; disk 40.0% used, 600 B free.',
    );
    expect(diskLine(null)).toContain('not measured');
  });
});

describe('disk alert', () => {
  const disk = { databaseBytes: 2048, totalBytes: 1000, freeBytes: 250, usedPercent: 75 };
  const run = async (language: string | null) => {
    const db = await testDb();
    const owner = await createUser(db, {
      username: 'alex',
      passwordHash: 'x',
      totpSecretEnc: 'x',
      totpLastStep: 1,
      backupCodeHashes: ['a'],
      isAdmin: true,
    });
    if (language) {
      const { schema } = await import('@saku/db');
      await db.update(schema.users).set({ language });
    }
    await setSetting(db, 'forward_records_from', '2026-01-05');
    await addChannel(db, owner, {
      type: 'fake',
      target: 'ops',
      admin: true,
      authSecret: 's'.repeat(32),
    });
    const { notifier, sent } = fakeNotifier();
    const o = {
      date: '2026-01-05',
      notifiers: [notifier],
      authSecret: 's'.repeat(32),
      context: () => ({ http: null as never, now: new Date(), log: { info() {}, warn() {} } }),
      log: { info() {}, warn() {} },
      disk,
    };
    return { db, o, sent };
  };

  it('is sent once per day, in English', async () => {
    const { db, o, sent } = await run(null);
    expect((await sendDiskSpace(db, o)).sent).toBe(1);
    expect((await sendDiskSpace(db, o)).sent).toBe(0);
    expect(sent[0]!.text).toContain('Saku: the server disk is 75.0% full');
    expect(sent[0]!.text).toContain('250 B is free and the database is 2.0 KB.');
    expect(sent[0]!.text).toContain('Data health:');
  });

  it('is sent in Japanese', async () => {
    const { db, o, sent } = await run('ja');
    await sendDiskSpace(db, o);
    expect(sent[0]!.text).toContain('ディスク使用率が 75.0% になりました');
    expect(sent[0]!.text).toContain('空き容量は 250 B、データベースは 2.0 KB です。');
  });
});
