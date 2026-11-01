// `pnpm plugins`: loads and validates every plug-in and saves their descriptions. The update
// script runs it to check a new version starts; it takes no lock (the update holds the jobs lock).
// `pnpm plugins tax-regime <key>`: sets the install's tax regime to a loaded regime (requirements
// 07, 12; refused for an unknown key, or for a change once users have tax data).
import { createDb } from '@saku/db';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { allInfos, loadPlugins, savePluginInfos } from '../registry';
import { assertServerOnly } from '../server-only';
import { setTaxRegime } from '../tax-regime';

assertServerOnly();
loadRootEnv();
const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const plugins = await loadPlugins();
const [command, key] = process.argv.slice(2);

if (command === 'tax-regime') {
  if (!key) {
    console.error('Usage: pnpm plugins tax-regime <key>');
    console.error(
      `Loaded tax regimes: ${plugins.taxRegimes.map((r) => r.info.key).join(', ') || 'none'}`,
    );
    process.exit(1);
  }
  try {
    await setTaxRegime(db, key, plugins.taxRegimes);
    console.log(`tax_regime = ${key}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (command !== undefined) {
  console.error('Usage: pnpm plugins | pnpm plugins tax-regime <key>');
  process.exit(1);
} else {
  const infos = allInfos(plugins);
  for (const line of await savePluginInfos(db, infos)) console.error(line);
  for (const i of infos) console.log(`${i.kind} ${i.key}`);
  for (const r of plugins.taxRegimes) console.log(`tax_regime ${r.info.key}`);
  if (plugins.missing.length > 0) console.log(`Not present: ${plugins.missing.join(', ')}`);
}
