// Strategies and the journal from the server (A2; the web UI comes with D1).
//
//   pnpm strategy check <file.yaml> [--registration [--user <username> | --library]]
//                                                          validate a definition (no record); with
//                                                          --registration also every reason register
//                                                          would refuse (writes nothing); prints the
//                                                          costs it would use (the install's
//                                                          broker_costs for any the file omits);
//                                                          exit 1 when a cost is not known
//   pnpm strategy register <file.yaml> --user <username>   register: an immutable version whose
//   pnpm strategy register <file.yaml> --library           forward record starts with the next close;
//                                                          refused for same_close or a ticker whose
//                                                          full history has not passed the checks
//                                                          (a strategy file is YAML, .yaml or .yml,
//                                                          or JSON; cli/strategy-file.ts)
//   pnpm strategy list
//   pnpm strategy show <version id> [--days 10]           the latest forward entries
//   pnpm strategy verify                                   recompute every hash chain
//   pnpm strategy recompute                                the current engine against the record
//                                                          (corrected stand-ins, then differences
//                                                          annotated; the daily run does this too)
//   pnpm journal add <version id> <signal date> done|skipped|delayed --user <username>
//                    [--date <action date>] [--note <text>]
//   pnpm journal list <version id> --user <username>
//   pnpm channel add discord|telegram --user <username> [--admin]   asks for the webhook address
//                    or chat id (kept out of the shell history), stored encrypted
//   pnpm channel list|disable|enable|test [<channel id>] --user <username>
//   pnpm alert update-failed --from <commit> --to <commit> --step <step> [--stuck]
//                    (the update script, after going back)
import { type Strategy, dependencies, isTradingDate, tradingDateOf } from '@saku/core';
import { translator } from '@saku/content';
import { Sessions } from '@saku/data';
import {
  addChannel,
  addJournalEntry,
  allVersions,
  channelsOf,
  createDb,
  deliveryTargets,
  forwardRecord,
  openRechecks,
  getSetting,
  getUserByUsername,
  journalOf,
  setChannelEnabled,
} from '@saku/db';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { sendUpdateFailed } from '../jobs/alerts';
import { SYSTEM_CA } from '../jobs/anchor';
import { chainLines, chainProblems, verifyChains } from '../jobs/chain-verify';
import { costsLine, effectiveCosts } from '../jobs/costs';
import { openRecheckNote, recheckTimeZone } from '../jobs/recheck';
import {
  type CommandOutput,
  previewRegistration,
  recomputeRecords,
  registerStrategy,
} from '../jobs/strategy-commands';
import { dailyAfterOf, dailyTarget } from '../jobs/target';
import { parseCheckArgs } from './check-args';
import { refusalNote } from './version-refusal';
import { readStrategyFile, strategySummary } from './strategy-file';
import { codeVersion } from '../code-version';
import { loadPlugins, notifierContexts, providerUsageStore } from '../registry';
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
/** Prints a command's output and exits with its code. */
const finish = (o: CommandOutput): never => {
  for (const line of o.stdout) console.log(line);
  for (const line of o.stderr) console.error(line);
  process.exit(o.exitCode);
};

const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);

async function userId(): Promise<string> {
  const name = flag('user') ?? fail('Name the account: --user <username>.');
  const user = await getUserByUsername(db, name);
  return user?.id ?? fail(`No account ${name}.`);
}

/** A strategy file (YAML or JSON, `strategy-file.ts`), validated; exits with the reasons if not. */
function load(file: string | undefined): Strategy {
  if (!file) fail('Name the strategy file (.yaml, .yml or .json).');
  const read = readStrategyFile(resolve(process.env.INIT_CWD ?? findRepoRoot(), file!), file!);
  if ('error' in read) fail(read.error);
  return (read as { strategy: Strategy }).strategy;
}

/** The market calendar (xnys), as the daily run reads it. */
async function marketSessions(): Promise<Sessions> {
  const calendar = (await loadPlugins()).calendars
    .flatMap((c) => c.calendars)
    .find((c) => c.id === 'xnys');
  if (!calendar) fail('No xnys calendar plug-in is loaded.');
  return new Sessions(calendar!);
}

/** The market calendar and the latest final session, as registration reads them. */
async function registrationInput() {
  const sessions = await marketSessions();
  let through: string;
  try {
    // The latest session whose data is final now: a full check must have graded through it.
    through = dailyTarget(sessions, new Date(), dailyAfterOf(process.env.SAKU_DAILY_AFTER));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  return { sessions, through: through! };
}

if (tool === 'strategy' && command === 'check') {
  const args = parseCheckArgs(rest);
  if ('error' in args) fail(args.error);
  const a = args as Exclude<typeof args, { error: string }>;
  const s = load(a.file);
  // What the file says, as read: a misread value shows here, before anything is registered.
  for (const line of strategySummary(s)) console.log(line);
  // The costs a backtest or registration would use now (the install's for those the file omits).
  // Unknown costs: not valid to run, exit 1 (never read as 0).
  const costs = await effectiveCosts(db, s);
  if ('problem' in costs) fail(`Costs not known: ${costs.problem}`);
  console.log(costsLine(costs as Exclude<typeof costs, { problem: string }>));
  console.log(`${s.name}: valid; depends on ${dependencies(s).join(', ')}.`);
  if (a.registration) {
    // The same account lookup as register; without either flag the account is not checked.
    if (a.user !== undefined) await userId();
    const out = await previewRegistration(db, { strategy: s, ...(await registrationInput()) });
    if (a.user === undefined && !a.library) {
      out.stdout.push('Account not checked (give --user or --library).');
    }
    finish(out);
  }
} else if (tool === 'strategy' && command === 'register') {
  const s = load(rest[0]);
  const ownerId = rest.includes('--library') ? null : await userId();
  // What is about to become an immutable version, as read from the file.
  console.log(`Registering "${s.name}":`);
  for (const line of strategySummary(s).slice(1)) console.log(`  ${line}`);
  finish(await registerStrategy(db, { strategy: s, ownerId, ...(await registrationInput()) }));
} else if (tool === 'strategy' && command === 'list') {
  const timeZone = await recheckTimeZone(db);
  for (const v of await allVersions(db)) {
    const record = await forwardRecord(db, v.id);
    const last = record.at(-1);
    // A day red at its first grading is not recorded until its final (requirements 04).
    const open = (await openRechecks(db, v.id)).map((r) => `; ${openRecheckNote(r, timeZone)}`);
    console.log(
      `${v.id}  ${v.name}  ${v.ownerId ? 'user' : 'library'}  registered ${v.registeredAt}  ` +
        `${record.length} days${last ? `, last ${last.date}: ${last.allocation} (${last.dataStatus})` : ''}` +
        open.join('') +
        (refusalNote(v) ?? ''),
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
  const caFile = process.env.SAKU_TSA_CAFILE?.trim() || SYSTEM_CA;
  const checked = await verifyChains(db, { caFile });
  for (const line of chainLines(checked)) console.log(line);
  process.exit(chainProblems(checked) ? 1 : 0);
} else if (tool === 'strategy' && command === 'recompute') {
  finish(await recomputeRecords(db, { code: codeVersion(), sessions: await marketSessions() }));
} else if (tool === 'journal' && command === 'add') {
  const [versionId, signalDate, action] = rest;
  if (!versionId || !signalDate || !isTradingDate(signalDate))
    fail('Name the version and signal date.');
  if (action !== 'done' && action !== 'skipped' && action !== 'delayed') {
    fail('The action is done, skipped or delayed.');
  }
  const date = flag('date');
  if (date !== undefined && !isTradingDate(date)) fail('--date is a date like 2026-10-28.');
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
} else if (tool === 'channel') {
  const authSecret = process.env.AUTH_SECRET?.trim() || fail('AUTH_SECRET is not set in .env.');
  const owner = await userId();
  const { notifiers } = await loadPlugins();
  if (command === 'add') {
    const notifier =
      notifiers.find((n) => n.info.key === rest[0]) ??
      fail(`Channel types: ${notifiers.map((n) => n.info.key).join(', ')}.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const target = (await rl.question(`${notifier.info.name} webhook address or chat id: `)).trim();
    rl.close();
    if (!notifier.validTarget(target)) fail(`That is not a ${notifier.info.name} target.`);
    const id = await addChannel(db, owner, {
      type: notifier.info.key,
      target,
      admin: rest.includes('--admin'),
      authSecret,
    });
    console.log(`Added channel ${id}. Try it: pnpm channel test ${id} --user ${flag('user')}`);
  } else if (command === 'list') {
    for (const c of await channelsOf(db, owner)) {
      console.log(`${c.id}  ${c.type}${c.admin ? '  admin' : ''}  ${c.enabled ? 'on' : 'off'}`);
    }
  } else if (command === 'disable' || command === 'enable') {
    await setChannelEnabled(
      db,
      owner,
      rest[0] ?? fail('Name the channel id.'),
      command === 'enable',
    );
    console.log(`Channel ${command}d.`);
  } else if (command === 'test') {
    const channel =
      (await deliveryTargets(db, owner, authSecret)).find((c) => c.id === rest[0]) ??
      fail('No enabled channel with that id.');
    const target =
      channel.target ?? fail('The target does not decrypt: is AUTH_SECRET the one used to add it?');
    const notifier =
      notifiers.find((n) => n.info.key === channel.type) ?? fail(`No ${channel.type} plug-in.`);
    const user = await getUserByUsername(db, flag('user')!);
    const t = translator(user?.language ?? (await getSetting(db, 'primary_language')) ?? 'en');
    const log = { info: () => {}, warn: () => {} };
    await notifier.send(
      target,
      t('alerts.test'),
      notifierContexts(log, providerUsageStore(db))(notifier, channel.id),
    );
    console.log('Sent.');
  } else fail('pnpm channel add|list|disable|enable|test');
} else if (tool === 'alert' && command === 'update-failed') {
  const { notifiers } = await loadPlugins();
  const log = { info: () => {}, warn: (m: string, d?: object) => console.error(m, d ?? '') };
  const sent = await sendUpdateFailed(db, {
    date: tradingDateOf(new Date()),
    notifiers,
    authSecret: process.env.AUTH_SECRET?.trim() ?? '',
    context: notifierContexts(log, providerUsageStore(db)),
    log,
    from: flag('from') ?? fail('--from <commit>'),
    to: flag('to') ?? fail('--to <commit>'),
    step: flag('step') ?? 'unknown',
    stuck: rest.includes('--stuck'),
  });
  console.log(
    `Admin alert: ${sent.sent} sent${sent.failed.length ? `, ${sent.failed.length} failed` : ''}.`,
  );
} else {
  fail(
    'Usage: pnpm strategy check [--registration]|register|list|show|verify|recompute ... | pnpm journal add|list ... | pnpm channel ... ' +
      '(see packages/plugin-sdk/src/cli/strategy.ts)',
  );
}
