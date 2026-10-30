// Daily backups (requirements 12): a compressed, checked SQLite copy per day, 30 days plus the
// first of each month for 12 months, and a restore that only ever writes a new database.
// Not exported from the package index: the web app never needs it.
import { createClient } from '@libsql/client';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { dataDir } from './env';

const NAME = /^saku-(\d{4}-\d{2}-\d{2})\.db\.gz$/;
export const backupName = (day: string) => `saku-${day}.db.gz`;
/** Today in the server's own time zone, `YYYY-MM-DD` (backups are named by it). */
export const localDay = (now = new Date()) => now.toLocaleDateString('en-CA');
export const backupDir = (env: Record<string, string | undefined> = process.env) =>
  env.SAKU_BACKUP_DIR?.trim() || join(dataDir(env), 'backups');

/** Opens a copy and runs SQLite's integrity check; throws unless it says ok. */
async function checkCopy(file: string): Promise<number> {
  const c = createClient({ url: `file:${file}` });
  try {
    const rs = await c.execute('PRAGMA integrity_check');
    const verdict = String(rs.rows[0]?.[0] ?? '');
    if (verdict !== 'ok') throw new Error(`backup copy failed the integrity check: ${verdict}`);
    const tables = await c.execute(
      "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    return Number(tables.rows[0]?.[0] ?? 0);
  } finally {
    c.close();
  }
}

/**
 * A consistent copy of the database at `url` in the new file `file` (VACUUM INTO, which only
 * reads the source), checked by SQLite's integrity check; returns its table count. Used by the
 * backups and by `pnpm drill`, which runs on such a copy. The source must be an existing file:
 * opening a missing one would create an empty database there (and copy nothing).
 */
export async function snapshotDatabase(url: string, file: string): Promise<number> {
  if (existsSync(file)) throw new Error(`${file} exists; a snapshot only writes a new file.`);
  const path = filePathOf(url);
  if (path === undefined) throw new Error(`${url} is not a database file (a file: URL).`);
  if (!existsSync(path)) {
    throw new Error(`No database at ${path}; nothing was copied (and no file was created).`);
  }
  const source = createClient({ url });
  try {
    await source.execute({ sql: 'VACUUM INTO ?', args: [file] });
  } finally {
    source.close();
  }
  return checkCopy(file);
}

/** The file a `file:` URL names (`file:/a/b`, `file:///a/b`, `file:rel`), or undefined. */
function filePathOf(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  // libsql reads what follows `?` as options, not as part of the path.
  const bare = url.split('?')[0]!;
  const path = bare.startsWith('file://') ? fileURLToPath(bare) : bare.slice('file:'.length);
  return path === '' || path === ':memory:' ? undefined : path;
}

/**
 * Writes `<dir>/saku-<day>.db.gz` from the database file at `url` (a consistent snapshot through
 * VACUUM INTO, checked before it is compressed). The file appears whole or not at all.
 */
export async function backupDatabase(url: string, dir: string, day: string) {
  const work = await mkdtemp(join(tmpdir(), 'saku-backup-'));
  try {
    const copy = join(work, 'saku.db');
    const tables = await snapshotDatabase(url, copy);
    await mkdir(dir, { recursive: true });
    const file = join(dir, backupName(day));
    const partial = `${file}.partial`;
    await pipeline(createReadStream(copy), createGzip({ level: 9 }), createWriteStream(partial));
    await rename(partial, file);
    return { file, bytes: (await stat(file)).size, tables };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Backups to keep: the newest 30, plus the first of each month for the 12 newest months. */
export function toKeep(days: string[]): Set<string> {
  const sorted = [...days].sort().reverse();
  const keep = new Set(sorted.slice(0, 30));
  const firstOfMonth = new Map<string, string>();
  for (const d of [...sorted].reverse())
    if (!firstOfMonth.has(d.slice(0, 7))) firstOfMonth.set(d.slice(0, 7), d);
  for (const d of [...firstOfMonth.values()].sort().reverse().slice(0, 12)) keep.add(d);
  return keep;
}

export async function pruneBackups(dir: string): Promise<string[]> {
  const days = (await readdir(dir)).flatMap((f) => NAME.exec(f)?.[1] ?? []);
  const keep = toKeep(days);
  const removed = days.filter((d) => !keep.has(d));
  for (const d of removed) await rm(join(dir, backupName(d)));
  return removed;
}

/** Unpacks a backup into a database file that does not exist yet (never over a live one). */
export async function restoreBackup(file: string, target: string) {
  if (existsSync(target)) throw new Error(`${target} exists; restore only writes a new database.`);
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await pipeline(createReadStream(file), createGunzip(), createWriteStream(partial));
  try {
    const tables = await checkCopy(partial);
    await rename(partial, target);
    return { target, tables };
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
}
