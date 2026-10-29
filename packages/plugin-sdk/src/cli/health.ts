// The data-health report on the server (requirements 04, layer H; stage A3), read-only: what was
// not green, overall and per symbol, with the reasons in words, as the latest run that covered
// each date graded it (jobs/health.ts). The admin page replaces this with D1.
//
//   pnpm health                       the last 5 trading days up to the latest graded date
//   pnpm health --date <YYYY-MM-DD>   one trading day
//   pnpm health --days <N>            the last N trading days (with --date: N days ending there)
//   pnpm health --lang <code>         the reasons' language (default: primary_language, else en)
//
// Exit code 0 when every shown date is green (overall and every symbol), 1 otherwise.
import { type Translate, languages, translator } from '@saku/content';
import { Sessions } from '@saku/data';
import { existsSync } from 'node:fs';
import { createDb, getSetting } from '@saku/db';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { describeReasons } from '../jobs/alerts';
import {
  type DayReport,
  type Grade,
  healthReport,
  latestGradedDate,
  latestRun,
} from '../jobs/health';
import { loadPlugins } from '../registry';
import { assertServerOnly } from '../server-only';

assertServerOnly();
loadRootEnv();
const args = process.argv.slice(2);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : fail(`Give a value for --${name}.`);
};
const known = new Set(['--date', '--days', '--lang']);
for (let i = 0; i < args.length; i += 2) {
  if (!known.has(args[i]!)) {
    fail(
      'Usage: pnpm health [--date <YYYY-MM-DD>] [--days <N>] [--lang <code>] ' +
        '(default: the last 5 trading days up to the latest graded date)',
    );
  }
}

const langArg = flag('lang');
const dateArg = flag('date');
const daysArg = flag('days');
const days = daysArg === undefined ? (dateArg ? 1 : 5) : Number(daysArg);
if (!Number.isInteger(days) || days < 1 || days > 1000) {
  fail('--days is a whole number from 1 to 1000.');
}
if (dateArg) {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateArg) && !Number.isNaN(Date.parse(dateArg));
  if (!valid || new Date(`${dateArg}T00:00:00Z`).toISOString().slice(0, 10) !== dateArg) {
    fail(`${dateArg} is not a date (YYYY-MM-DD).`);
  }
}

// Read-only: a missing database file is reported, not created.
const config = dbConfigFromEnv();
const file = config.url.startsWith('file:') ? config.url.slice('file:'.length) : undefined;
if (file && file !== ':memory:' && !existsSync(file)) fail(`No database at ${file}.`);
const db = createDb(config);
await exitIfUnmigrated(db);
const plugins = await loadPlugins();
const calendar =
  plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'xnys') ??
  fail('No xnys calendar plug-in is loaded.');
const sessions = new Sessions(calendar);

const lang = langArg ?? (await getSetting(db, 'primary_language')) ?? 'en';
if (!languages().includes(lang)) {
  fail(`No texts for ${lang}; installed: ${languages().join(', ')}.`);
}
const t = translator(lang);

const run = await latestRun(db);
console.log(header(run));

const end =
  dateArg ??
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
process.exit(report.every((d) => d.green) ? 0 : 1);

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
