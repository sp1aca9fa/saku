import { stateDir } from '@saku/db/env';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Never two runs of a job at once, whether started by hand or by a timer: a lock file holding the
 * running process's ID. A lock left by a process that is gone (machine off, run stopped) is taken
 * over. Returns `release`, or the process holding it.
 */
export function lock(
  name: string,
  dir: string = join(stateDir(), 'locks'),
  pid: number = process.pid,
): { release: () => void } | { heldBy: number } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name.replace(/[^\w-]/g, '_')}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx' });
      return {
        release: () => {
          try {
            if (readFileSync(file, 'utf8') === String(pid)) rmSync(file);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number(readFileSync(file, 'utf8'));
      if (holder && holder !== pid && alive(holder)) return { heldBy: holder };
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not lock ${name}`);
}

/** The last trading date a job finished, from its stamp file. */
export function readStamp(name: string, dir: string = join(stateDir(), 'stamps')): string | null {
  try {
    return readFileSync(join(dir, name), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writeStamp(name: string, date: string, dir: string = join(stateDir(), 'stamps')) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${date}\n`);
}
