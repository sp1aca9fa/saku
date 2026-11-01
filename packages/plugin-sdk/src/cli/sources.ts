// Source roles and the CSV fallback from the server (requirements 04, 15; the Settings page comes
// with D1). Plug-ins suggest a role on the first run; the admin decides here.
//
//   pnpm sources list                                     roles per data kind, and loaded
//                                                         plug-ins that have none (not used)
//   pnpm sources set <bars|series|fx|issuer> <key> <primary|secondary|check>
//   pnpm sources remove <kind> <key>                      stop using it (its data stays; the
//                                                         primary stays until another is set)
//   pnpm sources issuer-stats [--years N]                 per fund and issuer source, the
//                                                         observed |close / NAV - 1| over the
//                                                         last N years (default 2), to set
//                                                         issuer_nav_tolerance from
//   pnpm sources readjustments [--source <key>] [--run <id>]
//                                                         per source, the spread of |factor - 1|
//                                                         of one run's re-adjustment events (by
//                                                         adjusted-close level), to confirm a
//                                                         declared adjCloseRounding; default the
//                                                         latest bootstrap or weekly run with any
//   pnpm sources stand-in list [--open]                   stored stand-ins (or the open ones:
//                                                         neither resolved nor settled by a
//                                                         close), oldest first: ticker, date,
//                                                         source, close, band, age in sessions,
//                                                         state, whether a canonical bar uses
//                                                         it and whether it can be closed
//   pnpm sources stand-in close <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin>
//                                                         an admin closes one the primary will
//                                                         never replace (requirements 04
//                                                         stand-in rule 5): nothing waits on it
//                                                         any more; its price stays. `--user`
//                                                         names the acting admin (shell access
//                                                         to the server is the authentication)
//   pnpm sources closed-event list [--open]               dividends and splits the bars
//                                                         primary dated on a closed market day
//                                                         (or the open ones: not resolved), with
//                                                         the session the fund is red from
//   pnpm sources closed-event resolve <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin>
//                                                         an admin resolves one that is not real
//                                                         (decisions log 2026-11-01, C19): the
//                                                         fund is no longer red for it; the event
//                                                         stays out of the series. A real event
//                                                         the source misdated waits for the
//                                                         source. `--user` as for stand-in close
//   pnpm csv import <file> --ticker <TICKER> --prices raw|split-adjusted [--source csv-<name>]
//                                                         validated daily bars, stored as their
//                                                         own source (default `csv`); give it a
//                                                         role to use it
import { SOURCE_ROLES, type SourceRole, tradingDateOf } from '@saku/core';
import { Sessions, parseBarsCsv } from '@saku/data';
import {
  activeSymbols,
  createDb,
  removeSourceRole,
  schema,
  setSourceRole,
  sourceRolesOf,
  standInList,
  storeRawBars,
} from '@saku/db';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describeCounts, issuerStats } from '../jobs/issuer';
import { lock } from '../jobs/lock';
import { ageInSessions, closeStandIn, latestDailyTarget, standInListText } from '../jobs/stand-ins';
import { closedDayEventText, closedDayEvents, resolveClosedEvent } from '../jobs/closed-events';
import {
  defaultReadjustmentRun,
  parseReadjustmentArgs,
  readjustmentRun,
  readjustmentStats,
  readjustmentText,
} from '../jobs/readjustments';
import { allInfos, issuerPublishesOf, loadPlugins } from '../registry';
import { DATA_KIND, dataKindOf, unassigned } from '../roles';
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
const KINDS = Object.values(DATA_KIND) as string[];
/** The xnys sessions (stand-in ages, CSV dates). */
const xnys = () =>
  new Sessions(
    plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'xnys') ??
      fail('No xnys calendar plug-in is loaded.'),
  );

/** Role changes and imports are refused while a job runs (it reads roles throughout). */
function withJobsLock<T>(fn: () => Promise<T>): Promise<T> {
  const held = lock('jobs');
  if ('heldBy' in held) fail(`A job is running (process ${held.heldBy}); try again later.`);
  const { release } = held as { release: () => void };
  return fn().finally(release);
}

const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const plugins = await loadPlugins();
const infos = allInfos(plugins);

if (tool === 'sources' && command === 'list') {
  const roles = await sourceRolesOf(db);
  for (const r of roles) console.log(`${r.dataKind}  ${r.position}  ${r.pluginKey}  ${r.role}`);
  for (const i of unassigned(infos, roles)) {
    console.log(
      `${dataKindOf(i)}  -  ${i.key}  not assigned (suggests ${i.suggestedRole}; not used until set)`,
    );
  }
} else if (tool === 'sources' && (command === 'set' || command === 'remove')) {
  const [kind, key, role] = rest;
  if (!kind || !KINDS.includes(kind)) fail(`The data kind is one of ${KINDS.join(', ')}.`);
  if (!key) fail('Name the source key (pnpm sources list).');
  try {
    if (command === 'remove') {
      const removed = await withJobsLock(() =>
        removeSourceRole(db, { dataKind: kind!, key: key!, actor: 'cli' }),
      );
      console.log(
        removed ? `${key} is no longer used for ${kind}.` : `${key} had no role for ${kind}.`,
      );
    } else {
      if (!SOURCE_ROLES.includes(role as SourceRole)) {
        fail(`The role is ${SOURCE_ROLES.join(', ')}.`);
      }
      // A plug-in of this data kind, or (for bars) a CSV source with stored data.
      const plugin = infos.some((i) => i.key === key && dataKindOf(i) === kind);
      const csv =
        kind === 'bars' &&
        /^csv(-[a-z0-9]+)*$/.test(key!) &&
        (
          await db
            .select({ source: schema.barsRaw.source })
            .from(schema.barsRaw)
            .where(eq(schema.barsRaw.source, key!))
            .limit(1)
        ).length > 0;
      if (!plugin && !csv) fail(`No ${kind} plug-in or imported CSV source named ${key}.`);
      const r = await withJobsLock(() =>
        setSourceRole(db, { dataKind: kind!, key: key!, role: role as SourceRole, actor: 'cli' }),
      );
      console.log(
        `${key} is ${role} for ${kind}${r.demoted ? `; ${r.demoted} is now a secondary` : ''}. ` +
          'The next run uses it.',
      );
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
} else if (tool === 'sources' && command === 'issuer-stats') {
  const yearsArg = flag('years');
  const years = yearsArg === undefined ? 2 : Number(yearsArg);
  if (!Number.isInteger(years) || years < 1 || years > 50) {
    fail('--years is a whole number from 1 to 50.');
  }
  const to = tradingDateOf(new Date());
  const start = new Date(`${to}T00:00:00Z`);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const from = start.toISOString().slice(0, 10);
  const stats = await issuerStats(db, {
    from,
    to,
    publishes: issuerPublishesOf(plugins.issuers),
    sessions: xnys(),
  });
  if (stats.toleranceInvalid) {
    console.log('Warning: issuer_nav_tolerance does not parse; layer D observes only until reset.');
  }
  if (stats.toleranceUnmatched.length > 0) {
    console.log(
      `Warning: issuer_nav_tolerance names no active symbol: ${stats.toleranceUnmatched.join(', ')}`,
    );
  }
  if (stats.rows.length === 0) {
    console.log(
      'No issuer NAV records stored (an issuer plug-in with a role fetches them; sources ' +
        'declaring no NAV are left out).',
    );
  } else {
    const pct = (v: number | undefined) => (v === undefined ? '-' : `${(100 * v).toFixed(3)}%`);
    console.log(
      `|close / NAV - 1| from ${from} to ${to} (primary closes; stand-in days and days graded ` +
        'red left out)',
    );
    console.log(
      'ticker  source  days  median  p99  max  left out (stand-in, red)  ' +
        'not compared (records in another currency)  tolerance set',
    );
    for (const r of stats.rows) {
      console.log(
        `${r.ticker}  ${r.source}  ${r.days}  ${pct(r.median)}  ${pct(r.p99)}  ${pct(r.max)}  ` +
          `${r.leftOut.standIn}, ${r.leftOut.red}  ` +
          `${describeCounts(r.otherCurrency)}  ` +
          `${r.tolerance === undefined ? 'none (observed only)' : pct(r.tolerance)}`,
      );
    }
    console.log(
      'Set: pnpm settings set issuer_nav_tolerance \'{"<TICKER>":0.005}\' (a fraction, ' +
        'above 0, at most 0.2; every fund in one map).',
    );
  }
} else if (tool === 'sources' && command === 'readjustments') {
  const args = parseReadjustmentArgs(rest);
  if ('error' in args) fail(args.error);
  const { source, run: runId } = args as { source?: string; run?: string };
  const run =
    runId === undefined
      ? await defaultReadjustmentRun(db, source)
      : ((await readjustmentRun(db, runId)) ?? fail(`No run ${runId}.`));
  if (!run) {
    console.log(
      `No bootstrap or weekly run stored re-adjustment events${source ? ` of ${source}` : ''}.`,
    );
  } else {
    const stats = await readjustmentStats(db, { runId: run.id, ...(source && { source }) });
    const declared = (key: string) =>
      plugins.bars.find((b) => b.info.key === key)?.info.adjCloseRounding;
    console.log(readjustmentText(run, stats, declared));
  }
} else if (tool === 'sources' && command === 'stand-in' && rest[0] === 'list') {
  const open = rest.includes('--open');
  const today = tradingDateOf(new Date());
  const sessions = xnys();
  for (const line of standInListText(await standInList(db, { open }), {
    sessions,
    today,
    open,
    latestDaily: await latestDailyTarget(db),
  })) {
    console.log(line);
  }
} else if (tool === 'sources' && command === 'stand-in' && rest[0] === 'close') {
  // Requirements 04 stand-in rule 5: an admin closes it with a written reason, never automatic.
  // closeStandIn checks the admin first (`--user` names the acting admin: this runs on a server
  // only admins can reach), then takes the jobs lock itself. The calendar is resolved before.
  const [, ticker, date] = rest;
  if (!ticker || ticker.startsWith('--') || !date || date.startsWith('--')) {
    fail(
      'Usage: pnpm sources stand-in close <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin>',
    );
  }
  const username = flag('user');
  if (!username || username.startsWith('--')) fail('Name the admin: --user <username>.');
  const reasonArg = flag('reason');
  const reason = reasonArg && !reasonArg.startsWith('--') ? reasonArg : '';
  const sessions = xnys();
  const r = await closeStandIn(db, {
    ticker: ticker!,
    date: date!,
    username: username!,
    reason,
    sessions,
  });
  if (!r.ok) fail(r.error);
  const age = ageInSessions(sessions, date!, tradingDateOf(new Date()));
  console.log(
    `Closed the ${ticker} stand-in of ${date}${age === undefined ? '' : ` (${age} sessions ago)`}: ` +
      'its price stays and nothing waits on it any more. The next run annotates the recorded ' +
      'days that used it and tells their owners once.',
  );
} else if (tool === 'sources' && command === 'closed-event' && rest[0] === 'list') {
  const open = rest.includes('--open');
  for (const line of closedDayEventText(await closedDayEvents(db, xnys()), { open })) {
    console.log(line);
  }
} else if (tool === 'sources' && command === 'closed-event' && rest[0] === 'resolve') {
  // Decisions log 2026-11-01, C19: an admin resolves an event that is not real, with a written
  // reason; resolveClosedEvent checks the admin first, then takes the jobs lock itself.
  const [, ticker, date] = rest;
  if (!ticker || ticker.startsWith('--') || !date || date.startsWith('--')) {
    fail(
      'Usage: pnpm sources closed-event resolve <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin>',
    );
  }
  const username = flag('user');
  if (!username || username.startsWith('--')) fail('Name the admin: --user <username>.');
  const reasonArg = flag('reason');
  const reason = reasonArg && !reasonArg.startsWith('--') ? reasonArg : '';
  const r = await resolveClosedEvent(db, {
    ticker: ticker!,
    date: date!,
    username: username!,
    reason,
    sessions: xnys(),
  });
  if (!r.ok) fail(r.error);
  console.log(
    `Resolved the ${ticker} event dated ${date}: from the next run on, the fund is no longer red ` +
      'for it. The event stays out of the series (never moved to a session).',
  );
} else if (tool === 'csv' && command === 'import') {
  const file = rest[0] && !rest[0].startsWith('--') ? rest[0] : fail('Name the CSV file.');
  const ticker = flag('ticker') ?? fail('Name the ticker: --ticker <TICKER>.');
  // Stated, never guessed: many exports give split-adjusted prices under "Close".
  const prices = flag('prices');
  if (prices !== 'raw' && prices !== 'split-adjusted') {
    fail('State the prices: --prices raw (as traded) or --prices split-adjusted.');
  }
  const source = flag('source') ?? 'csv';
  if (!/^csv(-[a-z0-9]+)*$/.test(source)) fail('The source key is csv or csv-<name>.');
  if (infos.some((i) => i.key === source)) fail(`${source} is a plug-in's key; choose another.`);
  const symbol =
    (await activeSymbols(db)).find((s) => s.ticker === ticker) ??
    fail(`${ticker} is not in the universe (pnpm symbols import).`);
  const path = resolve(process.env.INIT_CWD ?? findRepoRoot(), file!);
  const parsed = parseBarsCsv(readFileSync(path, 'utf8'), xnys(), {
    splitAdjusted: prices === 'split-adjusted',
  });
  if (parsed.errors.length) {
    fail(`Nothing imported:\n${parsed.errors.slice(0, 20).join('\n')}`);
  }
  if (parsed.missing.length) {
    console.log(
      `Warning: ${parsed.missing.length} trading days missing in the file's range ` +
        `(${parsed.missing.slice(0, 5).join(', ')}${parsed.missing.length > 5 ? ', ...' : ''}).`,
    );
  }
  // Market data is written by one process at a time (the jobs hold the same lock).
  await withJobsLock(async () => {
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
  });
} else {
  fail(
    'Usage: pnpm sources list | set <kind> <key> <role> | remove <kind> <key> | ' +
      'issuer-stats [--years N] | readjustments [--source <key>] [--run <id>] | ' +
      'stand-in list [--open] | ' +
      'stand-in close <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin> | ' +
      'closed-event list [--open] | ' +
      'closed-event resolve <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin> | ' +
      'pnpm csv import <file> --ticker <TICKER> --prices raw|split-adjusted [--source csv-<name>]',
  );
}
