// `pnpm drill red [--date <YYYY-MM-DD>]` (stage A2 acceptance): a simulated red day on a temporary
// copy of the database, with the real alert channels; every alert is marked as a drill. Nothing
// is recorded: no forward record, timestamp, stamp, heartbeat or run in the live database
// (jobs/drill.ts). Runs only on the server. Exits 0 only when the day was red, each registered
// strategy applied its safe state and its alert reached at least one channel.
import { Sessions } from '@saku/data';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { drillSummary, redDrill } from '../jobs/drill';
import { jobLogger } from '../jobs/log';
import { dailyAfterOf, dailyTarget } from '../jobs/target';
import { loadPlugins, notifierContexts, providerUsageStore } from '../registry';
import { assertServerOnly } from '../server-only';
import { drillDate, parseDrillArgs } from './drill-args';

try {
  assertServerOnly();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
loadRootEnv();
const args = parseDrillArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(args.error);
  process.exit(1);
}
const plugins = await loadPlugins();
const calendar = plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'xnys');
if (!calendar) {
  console.error('No xnys calendar plug-in is loaded.');
  process.exit(1);
}
const sessions = new Sessions(calendar);
const fed = plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'us-fed');
const now = new Date();
const target = drillDate(
  sessions,
  args.date,
  dailyTarget(sessions, now, dailyAfterOf(process.env.SAKU_DAILY_AFTER)),
);
if ('error' in target) {
  console.error(target.error);
  process.exit(1);
}
const log = jobLogger('drill');
const result = await redDrill({
  url: dbConfigFromEnv().url,
  plugins,
  sessions,
  seriesSessions: fed ? new Sessions(fed) : undefined,
  target: target.date,
  now,
  log,
  alerting: {
    notifiers: plugins.notifiers,
    authSecret: process.env.AUTH_SECRET?.trim() ?? '',
    // The notifiers' request counts go to the copy: the live database is not written.
    context: (copy) => notifierContexts(log, providerUsageStore(copy)),
  },
});
console.log(drillSummary(result));
process.exit('ok' in result && result.ok ? 0 : 1);
