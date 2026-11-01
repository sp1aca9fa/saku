// `pnpm settings list | set <key> <value>`: install-wide admin settings from the server.
// `pnpm settings deposit-rate add <ratePct> <from YYYY-MM-DD> <currency>` | `deposit-rate list`:
// the base currency's deposit rate, a dated append-only series (deposit-rates.ts).
import { createDb } from '../client';
import { dbConfigFromEnv, loadRootEnv } from '../env';
import { exitIfUnmigrated } from '../migrate';
import { activeSymbols } from '../market';
import { addDepositRate, depositRateEntries } from '../deposit-rates';
import {
  SETTINGS,
  getSetting,
  isSettingKey,
  parseNavTolerances,
  setSetting,
  unmatchedTolerances,
} from '../settings';

loadRootEnv();
const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const [command, key, value, ...more] = process.argv.slice(2);

if (command === 'list') {
  for (const k of Object.keys(SETTINGS)) {
    console.log(`${k} = ${(isSettingKey(k) && (await getSetting(db, k))) ?? '(not set)'}`);
  }
} else if (command === 'set' && key && value && isSettingKey(key)) {
  try {
    await setSetting(db, key, value);
    console.log(`${key} = ${value}`);
    if (key === 'issuer_nav_tolerance') {
      const tickers = (await activeSymbols(db)).map((s) => s.ticker);
      const unmatched = unmatchedTolerances(parseNavTolerances(value) ?? {}, tickers);
      if (unmatched.length > 0) {
        console.log(`Warning: no active symbol named ${unmatched.join(', ')} (stored as given).`);
      }
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (command === 'deposit-rate' && key === 'add' && value && more.length === 2) {
  try {
    await addDepositRate(db, { ratePct: value, from: more[0]!, currency: more[1]! });
    console.log(`deposit rate ${value}% a year in ${more[1]} from ${more[0]}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (command === 'deposit-rate' && key === 'list') {
  const entries = await depositRateEntries(db);
  if (entries.length === 0) console.log('No deposit rate entries (the rate is unknown).');
  for (const e of entries) console.log(`from ${e.from}: ${e.ratePct}% a year (${e.currency})`);
} else {
  console.error(
    `Usage: pnpm settings list | pnpm settings set <${Object.keys(SETTINGS).join('|')}> <value> | ` +
      'pnpm settings deposit-rate add <ratePct> <from YYYY-MM-DD> <currency> | pnpm settings deposit-rate list',
  );
  process.exit(1);
}
