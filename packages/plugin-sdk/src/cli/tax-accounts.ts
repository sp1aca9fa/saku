// A user's tax accounts from the server (requirements 07 "Model"; C1; the web UI comes with D1).
//
//   pnpm tax-accounts list --user <username>
//   pnpm tax-accounts open <account type> --user <username> [--opened-on YYYY-MM-DD]
//   pnpm tax-accounts close <account type> --user <username> [--on YYYY-MM-DD]
//
// Account types are the install regime's (`pnpm plugins tax-regime <key>`); `taxable` is implied
// for every user, never opened or closed. Opening the first account locks the install's tax
// regime. Dates are not later than today in the install's time zone (`time_zone`); a close
// without --on is dated today there (without a time zone, --on is required). After a closed
// account of a type, reopening it needs --opened-on, later than that close.
import {
  IMPLIED_TAX_ACCOUNT,
  closeTaxAccount,
  createDb,
  getUserByUsername,
  openTaxAccount,
  taxAccountsOf,
} from '@saku/db';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { loadPlugins } from '../registry';
import { assertServerOnly } from '../server-only';
import { installTaxRegime } from '../tax-regime';
import { parseTaxAccountsArgs } from './tax-accounts-args';

assertServerOnly();
loadRootEnv();
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const parsed = parseTaxAccountsArgs(process.argv.slice(2));
if ('error' in parsed) fail(parsed.error);
const args = parsed as Exclude<typeof parsed, { error: string }>;

const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const owner = (await getUserByUsername(db, args.user))?.id ?? fail(`No account ${args.user}.`);
const install = await installTaxRegime(db, (await loadPlugins()).taxRegimes);
const regime = 'regime' in install ? install.regime : undefined;
const regimeNote =
  'unset' in install
    ? 'The tax regime is not set (pnpm plugins tax-regime <key>).'
    : 'unknown' in install
      ? `No loaded tax regime has the key ${install.unknown}.`
      : 'changed' in install
        ? `The ${install.changed.key} regime's rules changed since it was set (now version ${install.changed.version}); accounts cannot be opened until that is resolved.`
        : undefined;

try {
  if (args.command === 'list') {
    if (regimeNote) console.log(regimeNote);
    else console.log(`Tax regime: ${regime!.info.key} (version ${regime!.info.version})`);
    console.log(`${IMPLIED_TAX_ACCOUNT}  open (every user holds it)`);
    const accounts = await taxAccountsOf(db, owner);
    for (const a of accounts) {
      const opened = a.openedOn ? `opened ${a.openedOn}` : 'opening date not given';
      const state = a.closedOn ? `closed ${a.closedOn}` : 'open';
      console.log(`${a.accountType}  ${state}  ${opened}  (recorded ${a.createdAt})`);
    }
    if (regime) {
      const open = new Set(accounts.filter((a) => !a.closedOn).map((a) => a.accountType));
      const more = regime.accountTypes
        .map((t) => t.key)
        .filter((k) => k !== IMPLIED_TAX_ACCOUNT && !open.has(k));
      if (more.length > 0) console.log(`Can be opened: ${more.join(', ')}`);
    }
  } else if (args.command === 'open') {
    if (!regime) fail(regimeNote!);
    await openTaxAccount(db, owner, {
      regime: { key: regime!.info.key, accountTypes: regime!.accountTypes.map((t) => t.key) },
      accountType: args.accountType,
      ...(args.openedOn !== undefined && { openedOn: args.openedOn }),
      actor: 'cli',
    });
    console.log(`${args.user}: ${args.accountType} account opened.`);
  } else {
    const closedOn = await closeTaxAccount(db, owner, {
      accountType: args.accountType,
      ...(args.closedOn !== undefined && { closedOn: args.closedOn }),
      actor: 'cli',
    });
    console.log(`${args.user}: ${args.accountType} account closed on ${closedOn}.`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
process.exit(0);
