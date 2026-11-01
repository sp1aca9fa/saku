// `pnpm plugins`: loads and validates every plug-in and saves their descriptions. The update
// script runs it to check a new version starts; it takes no lock (the update holds the jobs lock).
// `pnpm plugins tax-regime <key>`: sets the install's tax regime to a loaded regime (requirements
// 07, 12; refused for an unknown key, or for a change once users have tax data).
// `pnpm plugins benchmarks <file.json>`: sets the benchmark set (requirements 01, 12) from a JSON
// file (`templates/benchmarks/`), each benchmark's account checked against the install's regime
// as loaded (refused when no regime is set or it is not loaded).
import { benchmarkLabel, translator } from '@saku/content';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDb, getSetting, parseBenchmarks, setSetting } from '@saku/db';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '@saku/db/env';
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
} else if (command === 'benchmarks') {
  try {
    if (!key)
      throw new Error('Usage: pnpm plugins benchmarks <file.json> (see templates/benchmarks/)');
    const regimeKey = await getSetting(db, 'tax_regime');
    if (regimeKey === undefined) {
      throw new Error(
        "Set the tax regime first (pnpm plugins tax-regime <key>): each benchmark's account is one of its account types.",
      );
    }
    const regime = plugins.taxRegimes.find((r) => r.info.key === regimeKey);
    if (!regime) throw new Error(`The install's tax regime ${regimeKey} is not loaded.`);
    const text = readFileSync(resolve(process.env.INIT_CWD ?? findRepoRoot(), key), 'utf8');
    // Read strictly from the file's own text (a key given twice is refused), stored compact.
    const parsed = parseBenchmarks(text);
    if ('problems' in parsed) {
      throw new Error(
        `Not a valid benchmarks:\n${parsed.problems.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    await setSetting(db, 'benchmarks', JSON.stringify(parsed.benchmarks), 'cli', {
      accountTypes: regime.accountTypes.map((a) => a.key),
    });
    // Each with what it holds next to its name (in the install's primary language).
    const t = translator((await getSetting(db, 'primary_language')) ?? 'en');
    console.log('benchmarks =');
    for (const b of parsed.benchmarks) {
      console.log(
        `  ${b.id}: ${benchmarkLabel(t, b)}, fee ${b.feePctPerYear}% a year, ${b.account}`,
      );
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (command !== undefined) {
  console.error(
    'Usage: pnpm plugins | pnpm plugins tax-regime <key> | pnpm plugins benchmarks <file.json>',
  );
  process.exit(1);
} else {
  const infos = allInfos(plugins);
  for (const line of await savePluginInfos(db, infos)) console.error(line);
  for (const i of infos) console.log(`${i.kind} ${i.key}`);
  for (const r of plugins.taxRegimes) console.log(`tax_regime ${r.info.key}`);
  if (plugins.missing.length > 0) console.log(`Not present: ${plugins.missing.join(', ')}`);
}
