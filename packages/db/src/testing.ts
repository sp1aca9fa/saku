// Test helpers shared by the packages' tests (not used by the app or jobs).
import { createDb, type Db } from './client';
import { migrateDb } from './migrate';

/** A fresh in-memory database with every migration applied. */
export async function testDb(): Promise<Db> {
  const db = createDb({ url: 'file::memory:' });
  await migrateDb(db);
  return db;
}
