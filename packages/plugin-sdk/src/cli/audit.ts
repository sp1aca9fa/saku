// The monthly audit report on the server (stage-a A3; requirements 04 layer H), read-only: what
// the data and the forward records went through in one month (jobs/audit.ts). The monthly job
// (`pnpm monthly`) stores the same report and sends its short form to the admins.
//
//   pnpm audit-report                    the previous calendar month in the install's time zone
//                                        (`time_zone`, else the system's)
//   pnpm audit-report --month <YYYY-MM>  that month (refused until it is over and its last
//                                        trading day's data is final)
//   pnpm audit-report --lang <code>      the reasons' language (default: primary_language, else en)
//
// (Not `pnpm audit`: that is pnpm's own command, which checks packages for security issues.)
//
// Exit code: 0 when the report was produced, whatever it found (its last line, "Verdict: ...",
// says it); 1 only for an error: a wrong argument, no database, no xnys calendar, a month not
// over yet.
import { languages, translator } from '@saku/content';
import { Sessions } from '@saku/data';
import { existsSync } from 'node:fs';
import { createDb, getSetting } from '@saku/db';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { SYSTEM_CA } from '../jobs/anchor';
import {
  auditReport,
  auditText,
  declaredLimits,
  installTimeZone,
  monthReady,
  previousMonth,
} from '../jobs/audit';
import { dailyAfterOf } from '../jobs/target';
import { allInfos, loadPlugins } from '../registry';
import { assertServerOnly } from '../server-only';
import { parseAuditArgs } from './audit-args';

assertServerOnly();
loadRootEnv();
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const parsed = parseAuditArgs(process.argv.slice(2));
if ('error' in parsed) fail(parsed.error);
const args = parsed as Exclude<typeof parsed, { error: string }>;

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

const plugins = await loadPlugins();
const calendar =
  plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'xnys') ??
  fail('No xnys calendar plug-in is loaded.');
const sessions = new Sessions(calendar);
const now = new Date();
const timeZone = await installTimeZone(db);
const month = args.month ?? previousMonth(now, timeZone);
let finalAfter: string;
try {
  finalAfter = dailyAfterOf(process.env.SAKU_DAILY_AFTER);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
const ready = await monthReady(db, month, { now, timeZone, sessions, finalAfter: finalAfter! });
if (!ready.ok) {
  // The whole-months note only fits a month that is not over (or not final) yet.
  fail(ready.kind === 'clock' ? `${ready.why} The report covers whole months.` : ready.why);
}

const report = await auditReport(db, {
  month,
  timeZone,
  sessions,
  now,
  limits: declaredLimits([...allInfos(plugins), ...plugins.notifiers.map((n) => n.info)]),
  caFile: process.env.SAKU_TSA_CAFILE?.trim() || SYSTEM_CA,
});
console.log(auditText(translator(lang), report));
// The report was produced: exit 0 whatever it found; the verdict line says it.
process.exit(0);
