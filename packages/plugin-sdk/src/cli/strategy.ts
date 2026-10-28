// Strategies and the journal from the server (A2; the web UI comes with D1).
//
//   pnpm strategy check <file.json>                       validate a definition (no record)
//   pnpm strategy register <file.json> --user <username>   register: an immutable version whose
//   pnpm strategy register <file.json> --library           forward record starts with the next close
//   pnpm strategy list
//   pnpm strategy show <version id> [--days 10]           the latest forward entries
//   pnpm strategy verify                                   recompute every hash chain
//   pnpm journal add <version id> <signal date> done|skipped|delayed --user <username>
//                    [--date <action date>] [--note <text>]
//   pnpm journal list <version id> --user <username>
import { Strategy, dependencies, isTradingDate } from '@saku/core';
import {
  activeSymbols,
  addJournalEntry,
  allVersions,
  createDb,
  forwardRecord,
  getSetting,
  getUserByUsername,
  journalOf,
  registerVersion,
  verifyChain,
} from '@saku/db';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertServerOnly } from '../server-only';

assertServerOnly();
loadRootEnv();
const [tool, command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);

async function userId(): Promise<string> {
  const name = flag('user') ?? fail('Name the account: --user <username>.');
  const user = await getUserByUsername(db, name);
  return user?.id ?? fail(`No account ${name}.`);
}

function load(file: string | undefined) {
  if (!file) fail('Name the strategy file (JSON).');
  const parsed = Strategy.safeParse(
    JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? findRepoRoot(), file!), 'utf8')),
  );
  if (!parsed.success) {
    fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  return parsed.data!;
}

if (tool === 'strategy' && command === 'check') {
  const s = load(rest[0]);
  console.log(`${s.name}: valid; depends on ${dependencies(s).join(', ')}.`);
} else if (tool === 'strategy' && command === 'register') {
  const from = await getSetting(db, 'forward_records_from');
  if (!from) {
    fail(
      'Registration starts a forward record, which opens after the A1 gate: ' +
        'pnpm settings set forward_records_from <date> first.',
    );
  }
  const s = load(rest[0]);
  const known = new Set((await activeSymbols(db)).map((x) => x.ticker));
  const missing = dependencies(s).filter((t) => !known.has(t));
  if (missing.length) fail(`Not in the universe: ${missing.join(', ')} (pnpm symbols import).`);
  const ownerId = rest.includes('--library') ? null : await userId();
  const v = await registerVersion(db, { ownerId, name: s.name, strategy: s });
  console.log(`Registered ${s.name}: version ${v.id}, hash ${v.hash}.`);
  console.log('Its forward record starts with the first close after now.');
} else if (tool === 'strategy' && command === 'list') {
  for (const v of await allVersions(db)) {
    const record = await forwardRecord(db, v.id);
    const last = record.at(-1);
    console.log(
      `${v.id}  ${v.name}  ${v.ownerId ? 'user' : 'library'}  registered ${v.registeredAt}  ` +
        `${record.length} days${last ? `, last ${last.date}: ${last.allocation} (${last.dataStatus})` : ''}`,
    );
  }
} else if (tool === 'strategy' && command === 'show') {
  const days = Number(flag('days') ?? 10);
  for (const e of (await forwardRecord(db, rest[0] ?? fail('Name the version id.'))).slice(-days)) {
    const p = JSON.parse(e.payload) as { reasons?: string[] };
    console.log(
      `${e.date}  ${e.allocation}  ${e.dataStatus}${e.safeStateApplied ? ' (safe state)' : ''}  ` +
        `equity ${e.equity?.toFixed(4) ?? '?'}${p.reasons?.length ? `  ${p.reasons.join(', ')}` : ''}`,
    );
  }
} else if (tool === 'strategy' && command === 'verify') {
  let bad = 0;
  for (const v of await allVersions(db)) {
    const problems = await verifyChain(db, v);
    if (problems.length) bad++;
    console.log(`${v.name} (${v.id}): ${problems.length ? problems.join('; ') : 'chain ok'}`);
  }
  process.exit(bad ? 1 : 0);
} else if (tool === 'journal' && command === 'add') {
  const [versionId, signalDate, action] = rest;
  if (!versionId || !signalDate || !isTradingDate(signalDate))
    fail('Name the version and signal date.');
  if (action !== 'done' && action !== 'skipped' && action !== 'delayed') {
    fail('The action is done, skipped or delayed.');
  }
  const date = flag('date');
  const note = flag('note');
  await addJournalEntry(db, await userId(), {
    versionId: versionId!,
    signalDate: signalDate!,
    action: action as 'done' | 'skipped' | 'delayed',
    ...(date && { actionDate: date }),
    ...(note && { note }),
  });
  console.log('Recorded.');
} else if (tool === 'journal' && command === 'list') {
  for (const j of await journalOf(db, await userId(), rest[0] ?? fail('Name the version id.'))) {
    console.log(
      `${j.signalDate}  ${j.action}${j.actionDate ? ` on ${j.actionDate}` : ''}${j.note ? `  ${j.note}` : ''}`,
    );
  }
} else {
  fail(
    'Usage: pnpm strategy check|register|list|show|verify ... | pnpm journal add|list ... ' +
      '(see packages/plugin-sdk/src/cli/strategy.ts)',
  );
}
