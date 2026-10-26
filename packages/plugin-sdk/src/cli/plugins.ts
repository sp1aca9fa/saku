// `pnpm plugins`: loads and validates every plug-in and saves their descriptions. The update
// script runs it to check a new version starts; it takes no lock (the update holds the jobs lock).
import { createDb } from '@saku/db';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { allInfos, loadPlugins, savePluginInfos } from '../registry';
import { assertServerOnly } from '../server-only';

assertServerOnly();
loadRootEnv();
const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const plugins = await loadPlugins();
const infos = allInfos(plugins);
await savePluginInfos(db, infos);
for (const i of infos) console.log(`${i.kind} ${i.key}`);
if (plugins.missing.length > 0) console.log(`Not present: ${plugins.missing.join(', ')}`);
