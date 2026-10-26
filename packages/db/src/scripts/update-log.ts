// `pnpm update:log --from <commit> --to <commit> [--failed <step>]`: the update script records
// each update (or failed one) in the activity log.
import { createDb } from '../client';
import { dbConfigFromEnv, loadRootEnv } from '../env';
import { exitIfUnmigrated } from '../migrate';
import { activityLog } from '../schema';

loadRootEnv();
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg('from');
const to = arg('to');
const failed = arg('failed');
if (!from || !to) {
  console.error('Usage: pnpm update:log --from <commit> --to <commit> [--failed <step>]');
  process.exit(1);
}
const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
await db.insert(activityLog).values({
  actor: 'system',
  action: failed ? 'update.failed' : 'update',
  detail: { from, to, ...(failed && { step: failed }) },
});
