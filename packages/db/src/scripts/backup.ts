// `pnpm backup`: today's backup now, then pruning (the daily job does the same after each run).
import { backupDatabase, backupDir, localDay, pruneBackups } from '../backup';
import { dbConfigFromEnv, loadRootEnv } from '../env';

loadRootEnv();
const day = localDay();
const { file, bytes, tables } = await backupDatabase(dbConfigFromEnv().url, backupDir(), day);
console.log(`${file}: ${(bytes / 1e6).toFixed(1)} MB, ${tables} tables, integrity ok.`);
const removed = await pruneBackups(backupDir());
if (removed.length) console.log(`Pruned: ${removed.join(', ')}`);
