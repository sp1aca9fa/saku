import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Walks up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Loads the repo root `.env` into process.env (existing variables win). For CLI scripts. */
export function loadRootEnv(): void {
  const file = join(findRepoRoot(), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

type Env = Record<string, string | undefined>;

/** Database, backups and the analysis copy: `SAKU_DATA_DIR`, else `~/.local/share/saku`. */
export function dataDir(env: Env = process.env): string {
  const base = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return env.SAKU_DATA_DIR?.trim() || join(base, 'saku');
}

/** Logs, stamps and locks: `SAKU_STATE_DIR`, else `~/.local/state/saku`. */
export function stateDir(env: Env = process.env): string {
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return env.SAKU_STATE_DIR?.trim() || join(base, 'saku');
}

export interface DbConfig {
  url: string;
}

/**
 * Reads DATABASE_URL (a `file:` URL), else uses `saku.db` in the data folder. Relative paths
 * resolve against the repo root; the file's directory is created.
 */
export function dbConfigFromEnv(env: Env = process.env): DbConfig {
  const raw = env.DATABASE_URL?.trim() || `file:${join(dataDir(env), 'saku.db')}`;
  if (!raw.startsWith('file:')) {
    throw new Error('DATABASE_URL must be a file: URL (hosted databases are not supported in v1).');
  }
  const path = raw.slice('file:'.length);
  if (path === ':memory:') return { url: raw };
  const absolute = isAbsolute(path) ? path : resolve(findRepoRoot(), path);
  mkdirSync(dirname(absolute), { recursive: true });
  return { url: `file:${absolute}` };
}
