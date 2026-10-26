import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { type DbConfig, dbConfigFromEnv } from './env';
import * as schema from './schema';

/** How long a writer waits for another one to finish (the app, a job and a manual run). */
const BUSY_MS = 60_000;

export function createDb(config: DbConfig) {
  return drizzle(createClient({ timeout: BUSY_MS, ...config }), { schema });
}

export type Db = ReturnType<typeof createDb>;

let shared: Db | undefined;

/** Process-wide database from the environment, created on first use (the app's pages). */
export function getDb(): Db {
  shared ??= createDb(dbConfigFromEnv());
  return shared;
}
