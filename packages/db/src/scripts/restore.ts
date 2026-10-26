// `pnpm restore <backup.db.gz> [target.db]`: unpacks a backup into a new database file (default:
// the configured database, which must not exist yet). Never overwrites a database.
import { restoreBackup } from '../backup';
import { dbConfigFromEnv, loadRootEnv } from '../env';

loadRootEnv();
const [file, target] = process.argv.slice(2);
if (!file) {
  console.error('Usage: pnpm restore <backup.db.gz> [target.db]');
  process.exit(1);
}
try {
  const out = await restoreBackup(file, target ?? dbConfigFromEnv().url.replace(/^file:/, ''));
  console.log(
    `Restored to ${out.target} (${out.tables} tables, integrity ok). Run pnpm db:migrate next.`,
  );
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
