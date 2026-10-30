// Strategies and the journal from the server (A2; the web UI comes with D1).
//
//   pnpm strategy check <file.json>                       validate a definition (no record)
//   pnpm strategy register <file.json> --user <username>   register: an immutable version whose
//   pnpm strategy register <file.json> --library           forward record starts with the next close;
//                                                          refused for same_close or a ticker whose
//                                                          full history has not passed the checks
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
import { Strategy, dependencies, isTradingDate, tradingDateOf } from '@saku/core';
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
  getSetting,
  getUserByUsername,
  journalOf,
  registerVersion,
  schema,
  setChannelEnabled,
  sha256,
  verifyChain,
} from '@saku/db';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { sendUpdateFailed } from '../jobs/alerts';
import { SYSTEM_CA, verifyToken } from '../jobs/anchor';
import { annotateStandInCorrections, recompute } from '../jobs/forward';
import { lock } from '../jobs/lock';
import { registrationProblems } from '../jobs/registration';
import { dailyAfterOf, dailyTarget } from '../jobs/target';
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
/** Releases the jobs lock when this command holds it. */
let release: (() => void) | undefined;
const exit = (code: number): never => {
  release?.();
  process.exit(code);
};
const fail = (message: string): never => {
  console.error(message);
  return exit(1);
};

/**
 * Commands that read check results or write annotations take the jobs lock, so they never run
 * during a job (half-rebuilt bars, duplicate append-only annotations).
 */
function takeJobsLock() {
  const held = lock('jobs');
  if ('heldBy' in held)
    fail(`A job is running (process ${held.heldBy}); try again when it is done.`);
  release = (held as { release: () => void }).release;
}

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
  const s = load(rest[0]);
  const ownerId = rest.includes('--library') ? null : await userId();
  const calendar = (await loadPlugins()).calendars
    .flatMap((c) => c.calendars)
    .find((c) => c.id === 'xnys');
  if (!calendar) fail('No xnys calendar plug-in is loaded.');
  let through: string;
  try {
    // The latest session whose data is final now: a full check must have graded through it.
    through = dailyTarget(
      new Sessions(calendar!),
      new Date(),
      dailyAfterOf(process.env.SAKU_DAILY_AFTER),
    );
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  takeJobsLock();
  try {
    const problems = await registrationProblems(db, s, { through: through! });
    if (problems.length) fail(`Not registered:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    const v = await registerVersion(db, { ownerId, name: s.name, strategy: s });
    console.log(`Registered ${s.name}: version ${v.id}, hash ${v.hash}.`);
    console.log('Its forward record starts with the first close after now.');
  } finally {
    release?.();
  }
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
  const caFile = process.env.SAKU_TSA_CAFILE?.trim() || SYSTEM_CA;
  for (const a of await db.select().from(schema.chainAnchors)) {
    const heads = JSON.parse(a.heads) as { date: string; heads: Record<string, string> };
    const problems: string[] = [];
    if (sha256(a.heads) !== a.chainHeadHash) problems.push('hash');
    for (const [versionId, hash] of Object.entries(heads.heads)) {
      const known =
        (await forwardRecord(db, versionId)).some((e) => e.hash === hash) ||
        (await allVersions(db)).some((v) => v.id === versionId && v.hash === hash);
      if (!known) problems.push(`head of ${versionId} not in the record`);
    }
    if (!a.proof || !(await verifyToken(a.proof as Uint8Array, a.chainHeadHash, caFile))) {
      problems.push('timestamp token');
    }
    if (problems.length) bad++;
    console.log(
      `Anchor ${heads.date} (${a.authority}): ${problems.length ? problems.join('; ') : 'ok'}`,
    );
  }
  process.exit(bad ? 1 : 0);
} else if (tool === 'strategy' && command === 'recompute') {
  takeJobsLock();
  try {
    // Corrected stand-ins first, as the runs do: a day one explains is not a recompute difference.
    const c = await annotateStandInCorrections(db, null);
    if (c.annotations) console.log(`${c.annotations} stand-in corrections annotated.`);
    for (const e of c.errors) console.log(e);
    const r = await recompute(db, { runId: null, code: codeVersion() });
    for (const d of r.differences) {
      console.log(`${d.version} ${d.date}: recorded ${d.recorded}, now ${d.now} (annotated)`);
    }
    for (const e of r.errors) {
      const what = e.kind === 'parse' ? 'definition does not parse' : 'could not evaluate';
      console.log(`${e.version}: ${what} (${e.error})`);
    }
    if (r.differences.length) console.log('The next daily run alerts the admins.');
    console.log(`${r.checked} recorded days, ${r.differences.length} new differences.`);
    exit(r.differences.length || r.errors.length || c.errors.length ? 1 : 0);
  } finally {
    release?.();
  }
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
    'Usage: pnpm strategy check|register|list|show|verify|recompute ... | pnpm journal add|list ... | pnpm channel ... ' +
      '(see packages/plugin-sdk/src/cli/strategy.ts)',
  );
}
