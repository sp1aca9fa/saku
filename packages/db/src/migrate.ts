// Not exported from the package index so the web bundle never pulls in the migrator.
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Migrations in the repo that the database has not applied yet (tags, oldest first). */
export async function pendingMigrations(db: Db): Promise<string[]> {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] };
  let applied = 0;
  try {
    const [row] = await db.all<{ last: number | null }>(
      sql`select max(created_at) as last from "__drizzle_migrations"`,
    );
    applied = Number(row?.last ?? 0);
  } catch {
    // No migrations table yet: nothing applied.
  }
  return journal.entries.filter((e) => e.when > applied).map((e) => e.tag);
}

/** For CLI scripts: stop with a clear message instead of failing mid-run on a missing table. */
export async function exitIfUnmigrated(db: Db): Promise<void> {
  const pending = await pendingMigrations(db);
  if (pending.length === 0) return;
  console.error(
    `Database is missing migration(s): ${pending.join(', ')}. Run \`pnpm db:migrate\` first.`,
  );
  process.exit(1);
}
