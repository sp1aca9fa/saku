// `pnpm symbols list | import <file.json>`: the asset universe (an admin choice). A file lists
// symbols as in templates/universe/; an underlying must come before the funds that track it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDb } from '../client';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '../env';
import { type SymbolInput, activeSymbols, upsertSymbols } from '../market';
import { exitIfUnmigrated } from '../migrate';

loadRootEnv();
const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const [command, file] = process.argv.slice(2);

if (command === 'list') {
  for (const s of await activeSymbols(db)) {
    console.log(
      [
        s.ticker,
        `tier ${s.tier}`,
        s.assetClass,
        s.currency,
        s.leverageFactor !== 1 ? `${s.leverageFactor}x` : '',
      ]
        .join('  ')
        .trim(),
    );
  }
} else if (command === 'import' && file) {
  const list = JSON.parse(readFileSync(resolve(findRepoRoot(), file), 'utf8')) as SymbolInput[];
  await upsertSymbols(db, list);
  console.log(`${list.length} symbol(s) imported.`);
} else {
  console.error('Usage: pnpm symbols list | pnpm symbols import <file.json>');
  process.exit(1);
}
