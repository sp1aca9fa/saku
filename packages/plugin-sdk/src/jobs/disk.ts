// The database's size and the disk it lives on (requirements 04, "Storage, keys, budget"):
// shown by `pnpm health` and, from the daily run, an admin alert at DISK_WARN_PERCENT. The admin
// page replaces both with D1.
import { existsSync, statSync } from 'node:fs';
import { statfs as nodeStatfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { filePathOf } from '@saku/db/backup';

/** Requirements 04: warn when the disk holding the database is this full (percent). */
export const DISK_WARN_PERCENT = 70;

export interface DiskUsage {
  /** The database file plus its -wal and -shm files, in bytes. */
  databaseBytes: number;
  totalBytes: number;
  /** Free space available to this user. */
  freeBytes: number;
  usedPercent: number;
}

export type Statfs = (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;

/** The size of the database and the disk holding it; null for a database that is not a file. */
export async function measureDisk(
  url: string,
  statfs: Statfs = nodeStatfs as unknown as Statfs,
): Promise<DiskUsage | null> {
  // Null only when there is no database file to measure (not a file URL, or in memory).
  const file = filePathOf(url);
  if (!file) return null;
  // A missing database file throws (ENOENT) with the real cause; -wal and -shm may be absent.
  const databaseBytes = ['', '-wal', '-shm'].reduce(
    (sum, suffix) =>
      suffix === '' || existsSync(file + suffix) ? sum + statSync(file + suffix).size : sum,
    0,
  );
  const fsStats = await statfs(dirname(file));
  const totalBytes = fsStats.blocks * fsStats.bsize;
  if (!(totalBytes > 0)) throw new Error(`The disk holding ${file} reports a size of 0.`);
  const freeBytes = fsStats.bavail * fsStats.bsize;
  return {
    databaseBytes,
    totalBytes,
    freeBytes,
    usedPercent: ((totalBytes - freeBytes) * 100) / totalBytes,
  };
}

/** At or above the warning threshold (exactly 70.0 warns). */
export function diskWarns(d: DiskUsage): boolean {
  return d.usedPercent >= DISK_WARN_PERCENT;
}

/** Bytes in binary units with one decimal, e.g. `1.2 GB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** The `pnpm health` line; says so when the database is not a file or cannot be measured. */
export function diskLine(d: DiskUsage | null): string {
  if (!d) return 'Database and disk: not measured (not a file database).';
  return (
    `Database ${formatBytes(d.databaseBytes)}; disk ${d.usedPercent.toFixed(1)}% used, ` +
    `${formatBytes(d.freeBytes)} free` +
    (diskWarns(d) ? ` (warning at ${DISK_WARN_PERCENT}%).` : '.')
  );
}
