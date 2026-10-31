// The data-health report on the server (requirements 04, layer H; stage A3), read-only: what was
// not green, overall and per symbol, with the reasons in words, as the latest run that covered
// each date graded it (jobs/health.ts). The admin page replaces this with D1.
//
//   pnpm health                       the last 5 trading days up to the latest graded date
//   pnpm health --date <YYYY-MM-DD>   one trading day
//   pnpm health --days <N>            the last N trading days (with --date: N days ending there)
//   pnpm health --lang <code>         the reasons' language (default: primary_language, else en)
//
// It ends with a verdict in words: "Verdict: all green." when every shown date is green (overall
// and every symbol), else "Verdict: not all green (N dates red, M yellow[, K not graded])."
//
// The summary of one run (jobs/health-summary.ts): its non-green check results grouped by
// (status, layer, check, symbol or the day, source), and its non-green health rows grouped by
// (row status, stored reason code, symbol or the day); red first, then by count.
//
//   pnpm health --summary [--run <id>]          the latest full-history run that stored results
//   pnpm health --summary --check <name> [--symbol <ticker>] [--source <id>]
//                                               that check's non-green dates (at most 200 shown;
//                                               --symbol day: the results about the day, FX)
//   pnpm health --summary --values [--per-group <N>] [--status red|yellow|all]
//                                               the stored values behind up to N dates (default
//                                               5, 1 to 50) of each non-green group (default red
//                                               ones), first and last included, evenly spread
//   pnpm health --summary --check <name> --values  the values behind each listed date (at most 50)
//
// The values are read as stored now (jobs/health-values.ts), not necessarily what the run saw.
// It ends with a verdict: "Verdict: all green." only when the run succeeded and stored the
// overall row of its target (complete), its per-check counts agree with its stored results, and
// it has no non-green check result and no non-green health row (`runSummary(...).allGreen`);
// "Verdict: incomplete run." when it is not complete; "Verdict: not all green." otherwise.
//
// Exit code (both modes): 0 when the report was produced, whatever the grades (the verdict line
// says them); 1 only for an error: a wrong argument, no database, an unknown run, check, symbol or
// source, a symbol the run did not grade, or nothing graded yet.
import { type Translate, languages, translator } from '@saku/content';
import { Sessions } from '@saku/data';
import { existsSync } from 'node:fs';
import { type Db, createDb, getSetting, schema } from '@saku/db';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { eq } from 'drizzle-orm';
import { describeReason, describeReasons } from '../jobs/alerts';
import {
  type DayReport,
  type Grade,
  daysVerdict,
  healthReport,
  latestGradedDate,
  latestRun,
  storedAny,
} from '../jobs/health';
import {
  DATE_CAP,
  DAY,
  NO_REASON,
  type SummaryRun,
  checkSources,
  defaultSummaryRun,
  findRun,
  gradedRange,
  groupDates,
  nonGreenChecks,
  reasonCode,
  recentRuns,
  runHasCheck,
  runSummary,
  sourceRefusal,
  summaryGroupDates,
  summaryGroupRows,
  summaryVerdict,
} from '../jobs/health-summary';
import {
  PER_GROUP_DEFAULT,
  VALUES_CAP,
  ValuesReader,
  fmt,
  resultLine,
  sampleDates,
  table,
} from '../jobs/health-values';
import { diskLine, measureDisk } from '../jobs/disk';
import { loadPlugins } from '../registry';
import { assertServerOnly } from '../server-only';
import { parseHealthArgs } from './health-args';

assertServerOnly();
loadRootEnv();
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const parsed = parseHealthArgs(process.argv.slice(2));
if ('error' in parsed) fail(parsed.error);
const args = parsed as Exclude<typeof parsed, { error: string }>;

let days = 5;
if (args.mode === 'days') {
  days = args.days === undefined ? (args.date ? 1 : 5) : Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 1000) {
    fail('--days is a whole number from 1 to 1000.');
  }
  const dateArg = args.date;
  if (dateArg) {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateArg) && !Number.isNaN(Date.parse(dateArg));
    if (!valid || new Date(`${dateArg}T00:00:00Z`).toISOString().slice(0, 10) !== dateArg) {
      fail(`${dateArg} is not a date (YYYY-MM-DD).`);
    }
  }
}

// Read-only: a missing database file is reported, not created.
const config = dbConfigFromEnv();
const file = config.url.startsWith('file:') ? config.url.slice('file:'.length) : undefined;
if (file && file !== ':memory:' && !existsSync(file)) fail(`No database at ${file}.`);
const db = createDb(config);
await exitIfUnmigrated(db);

const lang = args.lang ?? (await getSetting(db, 'primary_language')) ?? 'en';
if (!languages().includes(lang)) {
  fail(`No texts for ${lang}; installed: ${languages().join(', ')}.`);
}
const t = translator(lang);

if (args.mode === 'summary') process.exit(await summary(db, t, args));

const plugins = await loadPlugins();
const calendar =
  plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'xnys') ??
  fail('No xnys calendar plug-in is loaded.');
const sessions = new Sessions(calendar);

const run = await latestRun(db);
console.log(header(run));
try {
  console.log(diskLine(await measureDisk(config.url)));
} catch (e) {
  console.log(`Database and disk: not measured (${e instanceof Error ? e.message : String(e)}).`);
}

const end =
  (args.mode === 'days' ? args.date : undefined) ??
  (await latestGradedDate(db, sessions)) ??
  fail('No run has graded any date yet (pnpm bootstrap, then pnpm daily).');
let dates: string[];
try {
  if (!sessions.isSession(end)) fail(`${end} is not a trading day.`);
  dates = sessions.between(days === 1 ? end : sessions.before(end, days - 1), end);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const report = await healthReport(db, { dates: dates!, sessions });
for (const day of report) {
  for (const line of describeDay(t, day)) console.log(line);
}
// The report was produced: exit 0 whatever the grades; the verdict says them.
console.log(daysVerdict(report));
process.exit(0);

function header(r: Awaited<ReturnType<typeof latestRun>>): string {
  if (!r) return 'Latest run: none.';
  if (r.status === 'running') {
    return `Latest run: ${r.jobType}, running or interrupted (its grades count once it finishes).`;
  }
  const error = r.error?.split('\n')[0]?.trim();
  return (
    `Latest run: ${r.jobType} for ${r.datesProcessed?.[0] ?? 'an unknown date'}, ${r.status}` +
    `${error ? ` (${error})` : ''}, heartbeat ${r.heartbeatSent ? 'sent' : 'not sent'}.`
  );
}

function describeGrade(t: Translate, g: Grade): string {
  if (g.status === 'not_graded') return 'not graded';
  return g.reasons.length ? `${g.status}: ${describeReasons(t, g.reasons)}` : g.status;
}

function describeDay(t: Translate, d: DayReport): string[] {
  const by = d.run ? `  (${d.run.jobType} run for ${d.run.target})` : '';
  if (d.green) return [`${d.date}  green${by}`];
  return [
    `${d.date}  ${describeGrade(t, d.overall)}${by}`,
    ...d.symbols.map((s) => `  ${s.ticker}  ${describeGrade(t, s.grade)}`),
  ];
}

async function summary(
  db: Db,
  t: Translate,
  a: Extract<typeof args, { mode: 'summary' }>,
): Promise<number> {
  const found = a.run === undefined ? await defaultSummaryRun(db) : await findRun(db, a.run);
  if (!found && a.run === undefined) {
    return fail('No finished bootstrap, weekly or checks run has stored results yet.');
  }
  if (!found) {
    const latest = (await recentRuns(db, 5)).map(
      (r) => `${r.id} (${r.jobType} for ${r.target ?? 'an unknown date'}, ${r.status})`,
    );
    return fail(`No run ${a.run}.${latest.length ? ` Latest runs: ${latest.join('; ')}.` : ''}`);
  }
  const run: SummaryRun = found;
  // The group asked for, refused before anything is printed when the run or symbol lacks it.
  let symbolId: number | null | undefined;
  if (a.check !== undefined) {
    if (!(await runHasCheck(db, run.id, a.check))) {
      const known = await nonGreenChecks(db, run.id);
      fail(
        `Run ${run.id} has no check ${a.check}.` +
          (known.length ? ` Checks with non-green results: ${known.join(', ')}.` : ''),
      );
    }
    if (a.symbol !== undefined) {
      const [row] = await db
        .select({ id: schema.symbols.id })
        .from(schema.symbols)
        .where(eq(schema.symbols.ticker, a.symbol));
      // `day`: the results about the day (FX checks), unless a symbol has that ticker.
      if (row) symbolId = row.id;
      else if (a.symbol === DAY) symbolId = null;
      else fail(`No symbol ${a.symbol}.`);
    }
    if (a.source !== undefined) {
      // A full run stores only non-green results: a source with none of this check is unknown.
      const refusal = sourceRefusal(
        run.id,
        a.check,
        a.source,
        await checkSources(db, run.id, a.check),
      );
      if (refusal) fail(refusal);
    }
  }
  const error = run.error?.split('\n')[0]?.trim();
  console.log(
    `Run ${run.id}: ${run.jobType} for ${run.target ?? 'an unknown date'}, ${run.status}` +
      `${error ? ` (${error})` : ''}, started ${run.startedAt}.`,
  );
  const stored = await storedAny(db, run.id);
  if (run.finishedAt === null) {
    console.log('Still running or interrupted: what it stored so far may be incomplete.');
  }
  if (run.jobType === 'daily') {
    console.log('A daily run: its results cover the sessions of its window only.');
  }
  if (!stored) {
    console.log('It stored nothing: no date was graded by it (nothing here is green).');
    return 1;
  }

  const s = await runSummary(db, run);
  if (!s.complete) {
    const why = {
      not_success: `the run did not succeed (${run.status})`,
      no_target: 'the run names no target date',
      no_target_row: `no overall health row for its target ${run.target}`,
    }[s.incomplete!];
    console.log(`Incomplete: not all rows stored (${why}). Nothing here confirms green.`);
  }
  const greenText =
    s.green === undefined
      ? `green unknown (${s.complete ? 'not stored' : 'incomplete run'})`
      : `green ${s.green}`;
  console.log(`Check results: red ${s.nonGreen.red}, yellow ${s.nonGreen.yellow}, ${greenText}.`);
  const nonGreenStored = s.nonGreen.red + s.nonGreen.yellow;
  if (!s.countsAgree) {
    console.log(
      `Warning: the run's per-check counts say ${s.summaryNonGreen} results were not green, ` +
        `but ${nonGreenStored} are stored.`,
    );
  }
  console.log(
    `Health rows not green: days red ${s.health.day.red}, yellow ${s.health.day.yellow}; ` +
      `symbol-days red ${s.health.symbol.red}, yellow ${s.health.symbol.yellow}.`,
  );
  // The report is produced from here on: it ends with the verdict and exits 0 (an error before
  // this point exits 1).
  const done = () => {
    console.log('');
    console.log(summaryVerdict(s));
    return 0;
  };
  const reader = new ValuesReader(db, {
    runId: run.id,
    ...(run.target && { to: run.target }),
    now: new Date().toISOString(),
  });
  const asStoredNow =
    'Values as stored now, not necessarily what the run saw (raw bars may be revised since: ' +
    '"revised" rows; series and FX rates: the version that holds now and how many are stored). ' +
    "Source roles, a fund's underlying and its index series are read as set now; the returns " +
    'and statuses are the checks recomputed on these values.';

  if (a.check === undefined) {
    console.log('');
    if (s.groups.length === 0) console.log('Check results: none not green.');
    else {
      console.log('Check results not green:');
      const rows = [
        ['status', 'layer', 'check', 'symbol', 'source', 'count', 'first', 'last', 'reason'],
        ...s.groups.map((g) => [
          g.status,
          g.layer,
          g.check,
          g.symbol,
          g.source ?? '-',
          String(g.count),
          g.first,
          g.last,
          describeReason(t, reasonCode(g)),
        ]),
      ];
      for (const line of table(rows)) console.log(line);
    }
    console.log('');
    if (s.healthGroups.length === 0) console.log('Health rows: none not green.');
    else {
      // A row with several reasons is counted under each; a reason whose own status is not
      // known is shown with the status of its rows ("in a red row"), never as its own.
      console.log(
        'Health rows not green, by stored reason (a row with several reasons counts under each; ' +
          '"in a red row": the reason\'s own status is not known):',
      );
      const rows = [
        ['status', 'symbol', 'count', 'first', 'last', 'code', 'reason'],
        ...s.healthGroups.map((g) => [
          g.known ? g.status : `in a ${g.status} row`,
          g.symbol,
          String(g.count),
          g.first,
          g.last,
          g.reason === NO_REASON ? '-' : g.reason,
          g.reason === NO_REASON ? 'no reason stored' : describeReason(t, g.reason),
        ]),
      ];
      for (const line of table(rows)) console.log(line);
    }
    if (a.values) {
      const status = a.status ?? 'red';
      const perGroup = a.perGroup ?? PER_GROUP_DEFAULT;
      const groups = s.groups.filter((g) => status === 'all' || g.status === status);
      console.log('');
      console.log(
        `Values behind the ${status === 'all' ? 'non-green' : status} check results: up to ` +
          `${perGroup} dates per group, the first and the last included, evenly spread.`,
      );
      console.log(asStoredNow);
      if (groups.length === 0) console.log(`No ${status === 'all' ? 'non-green' : status} group.`);
      for (const g of groups) {
        const dates = await summaryGroupDates(db, run.id, g);
        const shown = sampleDates(dates, perGroup);
        console.log('');
        console.log(
          `${g.status}  ${g.layer}  ${g.check}  ${g.symbol}  ${g.source ?? '-'}: ` +
            `${dates.length} ${dates.length === 1 ? 'date' : 'dates'}, ${shown.length} shown`,
        );
        const rows = await summaryGroupRows(db, run.id, g, shown);
        for (const date of shown) {
          const mine = rows.filter((r) => r.date === date);
          for (const r of mine) console.log(resultLine(r));
          // The rows of one date share the group's check, symbol and source: one values block.
          if (mine[0]) for (const line of await reader.lines(mine[0])) console.log(line);
        }
      }
    }
    return done();
  }

  const { rows, total } = await groupDates(
    db,
    run.id,
    {
      check: a.check,
      ...(symbolId !== undefined && { symbolId }),
      ...(a.source !== undefined && { source: a.source }),
    },
    a.values ? VALUES_CAP : DATE_CAP,
  );
  console.log('');
  const what = [
    `check ${a.check}`,
    ...(a.symbol !== undefined ? [`symbol ${a.symbol}`] : []),
    ...(a.source !== undefined ? [`source ${a.source}`] : []),
  ].join(', ');
  if (total === 0) {
    if (symbolId !== undefined) {
      const range = await gradedRange(db, run, symbolId);
      if (!range) {
        console.log(`${a.symbol} was not graded by this run.`);
        return 1;
      }
      console.log(`No non-green result for ${what} (graded ${range.from} to ${range.to}).`);
      return done();
    }
    console.log(`No non-green result for ${what}.`);
    return done();
  }
  console.log(`Non-green results for ${what}: ${total}.`);
  if (a.values) {
    console.log(asStoredNow);
    // Each result, then the values behind it; a block the same as the one just shown (the same
    // date and symbol) is not repeated.
    let last: string | undefined;
    for (const r of rows) {
      console.log(resultLine(r, { full: true }));
      const block = await reader.lines(r);
      const key = block.join('\n');
      if (block.length > 0 && key === last) console.log('  (values as above)');
      else for (const line of block) console.log(line);
      last = key;
    }
  } else {
    const lines = table([
      [
        'date',
        'status',
        'layer',
        'symbol',
        'source',
        'observed',
        'expected',
        'tolerance',
        'message',
      ],
      ...rows.map((r) => [
        r.date,
        r.status,
        r.layer,
        r.symbol,
        r.source ?? '-',
        fmt(r.observed),
        fmt(r.expected),
        fmt(r.tolerance),
        r.message ?? '-',
      ]),
    ]);
    for (const line of lines) console.log(line);
  }
  if (total > rows.length) {
    const cap = a.values ? VALUES_CAP : DATE_CAP;
    console.log(
      `... ${total - rows.length} more (the first ${cap} by date are shown; ` +
        'narrow with --symbol or --source).',
    );
  }
  return done();
}
