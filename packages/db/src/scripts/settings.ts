// `pnpm settings list | set <key> <value>`: install-wide admin settings from the server.
import { createDb } from '../client';
import { dbConfigFromEnv, loadRootEnv } from '../env';
import { exitIfUnmigrated } from '../migrate';
import { SETTINGS, getSetting, isSettingKey, setSetting } from '../settings';

loadRootEnv();
const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const [command, key, value] = process.argv.slice(2);

if (command === 'list') {
  for (const k of Object.keys(SETTINGS)) {
    console.log(`${k} = ${(isSettingKey(k) && (await getSetting(db, k))) ?? '(not set)'}`);
  }
} else if (command === 'set' && key && value && isSettingKey(key)) {
  try {
    await setSetting(db, key, value);
    console.log(`${key} = ${value}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.error(
    `Usage: pnpm settings list | pnpm settings set <${Object.keys(SETTINGS).join('|')}> <value>`,
  );
  process.exit(1);
}
