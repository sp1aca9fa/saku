// Source roles and the CSV fallback from the server (requirements 04, 15; the Settings page comes
// with D1). Plug-ins suggest a role on the first run; the admin decides here.
//
//   pnpm sources list                                     roles per data kind, and loaded
//                                                         plug-ins that have none (not used)
//   pnpm sources set <bars|series|fx> <key> <primary|secondary|check>
//   pnpm sources remove <bars|series|fx> <key>            stop using it (its data stays)
//   pnpm csv import <file> --ticker <TICKER> [--source csv-<name>]
//                                                         validated daily bars, stored as their
//                                                         own source (default `csv`); give it a
//                                                         role to use it
import { SOURCE_ROLES, type SourceRole } from '@saku/core';
import { Sessions, parseBarsCsv } from '@saku/data';
import {
  activeSymbols,
  createDb,
  removeSourceRole,
  schema,
  setSourceRole,
  sourceRolesOf,
  storeRawBars,
} from '@saku/db';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { lock } from '../jobs/lock';
import { allInfos, loadPlugins } from '../registry';
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
const DATA_KINDS = { bar: 'bars', series: 'series', fx: 'fx' } as const;
const KINDS = Object.values(DATA_KINDS) as string[];

const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const plugins = await loadPlugins();
const infos = allInfos(plugins);

if (tool === 'sources' && command === 'list') {
  const roles = await sourceRolesOf(db);
  for (const r of roles) console.log(`${r.dataKind}  ${r.position}  ${r.pluginKey}  ${r.role}`);
  const unassigned = infos.filter(
    (i) =>
      i.kind in DATA_KINDS &&
      !roles.some(
        (r) =>
          r.pluginKey === i.key && r.dataKind === DATA_KINDS[i.kind as keyof typeof DATA_KINDS],
      ),
  );
  for (const i of unassigned) {
    console.log(
      `${DATA_KINDS[i.kind as keyof typeof DATA_KINDS]}  -  ${i.key}  not assigned ` +
        `(suggests ${i.suggestedRole}; not used until set)`,
    );
  }
} else if (tool === 'sources' && (command === 'set' || command === 'remove')) {
  const [kind, key, role] = rest;
  if (!kind || !KINDS.includes(kind)) fail(`The data kind is one of ${KINDS.join(', ')}.`);
  if (!key) fail('Name the source key (pnpm sources list).');
  const hasData = async () =>
    (
      await db
        .select({ source: schema.barsRaw.source })
        .from(schema.barsRaw)
        .where(eq(schema.barsRaw.source, key!))
        .limit(1)
    ).length > 0;
  const known = infos.some((i) => i.key === key) || (kind === 'bars' && (await hasData()));
  if (command === 'remove') {
    console.log(
      (await removeSourceRole(db, { dataKind: kind!, key: key!, actor: 'cli' }))
        ? `${key} is no longer used for ${kind}.`
        : `${key} had no role for ${kind}.`,
    );
  } else {
    if (!SOURCE_ROLES.includes(role as SourceRole)) fail(`The role is ${SOURCE_ROLES.join(', ')}.`);
    if (!known) fail(`No plug-in or stored data named ${key}.`);
    const r = await setSourceRole(db, {
      dataKind: kind!,
      key: key!,
      role: role as SourceRole,
      actor: 'cli',
    });
    console.log(
      `${key} is ${role} for ${kind}${r.demoted ? `; ${r.demoted} is now a secondary` : ''}. ` +
        'The next run uses it.',
    );
  }
} else if (tool === 'csv' && command === 'import') {
  const file = rest[0] && !rest[0].startsWith('--') ? rest[0] : fail('Name the CSV file.');
  const ticker = flag('ticker') ?? fail('Name the ticker: --ticker <TICKER>.');
  const source = flag('source') ?? 'csv';
  if (!/^csv(-[a-z0-9]+)*$/.test(source)) fail('The source key is csv or csv-<name>.');
  if (infos.some((i) => i.key === source)) fail(`${source} is a plug-in's key; choose another.`);
  const symbol =
    (await activeSymbols(db)).find((s) => s.ticker === ticker) ??
    fail(`${ticker} is not in the universe (pnpm symbols import).`);
  const calendar =
    plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'xnys') ??
    fail('No xnys calendar plug-in is loaded.');
  const path = resolve(process.env.INIT_CWD ?? findRepoRoot(), file!);
  const parsed = parseBarsCsv(readFileSync(path, 'utf8'), new Sessions(calendar));
  if (parsed.errors.length) {
    fail(`Nothing imported:\n${parsed.errors.slice(0, 20).join('\n')}`);
  }
  // Market data is written by one process at a time (the jobs hold the same lock).
  const held = lock('jobs');
  if ('heldBy' in held) fail(`A job is running (process ${held.heldBy}); try again later.`);
  const { release } = held as { release: () => void };
  try {
    const stored = await storeRawBars(db, {
      symbolId: symbol.id,
      source,
      bars: parsed.bars,
      runId: null,
      fetchedAt: new Date().toISOString(),
    });
    await db.insert(schema.activityLog).values({
      actor: 'cli',
      action: 'csv.import',
      detail: {
        file: basename(path),
        ticker,
        source,
        rows: parsed.bars.length,
        from: parsed.bars[0]!.date,
        to: parsed.bars.at(-1)!.date,
        ...stored,
      },
    });
    console.log(
      `${ticker} from ${source}: ${parsed.bars.length} bars (${parsed.bars[0]!.date} to ` +
        `${parsed.bars.at(-1)!.date}), ${stored.inserted} new, ${stored.revised} revised.`,
    );
    const role = (await sourceRolesOf(db)).find(
      (r) => r.dataKind === 'bars' && r.pluginKey === source,
    );
    console.log(
      role
        ? `${source} is ${role.role}; pnpm verify (or the next run) checks it.`
        : `Not used yet: pnpm sources set bars ${source} secondary (or primary while the main source is down).`,
    );
  } finally {
    release();
  }
} else {
  fail(
    'Usage: pnpm sources list | set <kind> <key> <role> | remove <kind> <key> | ' +
      'pnpm csv import <file> --ticker <TICKER> [--source csv-<name>]',
  );
}
