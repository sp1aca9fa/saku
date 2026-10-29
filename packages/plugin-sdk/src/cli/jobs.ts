// `pnpm bootstrap` and `pnpm daily` (requirements 04, 12). Runs only on the server.
//
//   pnpm bootstrap         full history from every source (first install, new symbols)
//   pnpm daily             once per trading day, at the first check after the day's data is
//                          final; exits at once when the day is done (the hourly timer calls it)
//   pnpm daily --force     run again for the latest final day
//   pnpm checks            layers A-C over the full history (summaries and non-green results)
//   pnpm probe             A1: the last sessions of one ticker from every bar source, to a log
//   pnpm spike             A1: the gate, day by day, from the daily runs
import { Sessions } from '@saku/data';
import { tradingDateOf } from '@saku/core';
import { activeSymbols, createDb } from '@saku/db';
import { backupDatabase, backupDir, localDay, pruneBackups } from '@saku/db/backup';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { codeVersion } from '../code-version';
import { PoliteHttp } from '../http';
import { lock, readStamp, writeStamp } from '../jobs/lock';
import { jobLogger } from '../jobs/log';
import { probe } from '../jobs/probe';
import { runJob } from '../jobs/run';
import { GATE, type SpikeReport, spikeReport } from '../jobs/spike';
import { dailyTarget } from '../jobs/target';
import { loadPlugins, notifierContexts, pluginContext } from '../registry';
import { assertServerOnly } from '../server-only';

assertServerOnly();
loadRootEnv();
const JOBS = ['bootstrap', 'daily', 'checks', 'probe', 'spike'] as const;
const job = process.argv[2] as (typeof JOBS)[number];
if (!JOBS.includes(job)) {
  console.error(
    'Usage: pnpm bootstrap | pnpm daily [--force] | pnpm checks | pnpm probe | pnpm spike',
  );
  process.exit(1);
}
const force = process.argv.includes('--force');
const log = jobLogger(job);

const held = lock('jobs');
if ('heldBy' in held) {
  log.info(`Another job is running (process ${held.heldBy}); exiting.`);
  process.exit(0);
}

const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const plugins = await loadPlugins();
const calendar = plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'xnys');
if (!calendar) throw new Error('No xnys calendar plug-in is loaded.');
const sessions = new Sessions(calendar);
// Business days of the cash series (FRED's DTB3 follows the Federal Reserve holidays).
const fed = plugins.calendars.flatMap((c) => c.calendars).find((c) => c.id === 'us-fed');
const seriesSessions = fed ? new Sessions(fed) : undefined;
const now = new Date();
const target = dailyTarget(sessions, now, process.env.SAKU_DAILY_AFTER || undefined);

if (job === 'spike') {
  console.log(spikeMarkdown(await spikeReport(db)));
  held.release();
  process.exit(0);
}

if (job === 'probe') {
  const ticker = process.env.SAKU_PROBE_TICKER?.trim() || (await activeSymbols(db))[0]?.ticker;
  if (!ticker) throw new Error('No symbols: run pnpm symbols import first.');
  const today = sessions.onOrBefore(tradingDateOf(now));
  const lines = await probe(plugins, {
    ticker,
    from: sessions.before(today, 2),
    to: today,
    context: (info) => pluginContext(info, log),
  });
  for (const l of lines.filter((l) => l.error)) log.warn(`probe ${l.source}: ${l.error}`);
  held.release();
  process.exit(0);
}

if (job === 'daily' && !force && (readStamp('daily') ?? '') >= target) {
  held.release();
  process.exit(0);
}

// From here on, the jobs that record a run.
const result = await runJob(db, plugins, {
  job: job as 'bootstrap' | 'daily' | 'checks',
  target,
  sessions,
  seriesSessions,
  now,
  log,
  context: (info) => pluginContext(info, log),
  alerting: {
    date: target,
    notifiers: plugins.notifiers,
    authSecret: process.env.AUTH_SECRET?.trim() ?? '',
    context: notifierContexts(log),
    log,
  },
  tsa: {
    authorities: (process.env.SAKU_TSA_URLS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    ...(process.env.SAKU_TSA_CAFILE?.trim() && { caFile: process.env.SAKU_TSA_CAFILE.trim() }),
  },
  code: codeVersion(),
  afterDaily: async () => {
    const backup = await backupDatabase(dbConfigFromEnv().url, backupDir(), localDay(now));
    await pruneBackups(backupDir());
    log.info(`Backup ${backup.file} (${(backup.bytes / 1e6).toFixed(1)} MB)`);
  },
  onComplete: async () => {
    writeStamp('daily', target);
    return heartbeat();
  },
});
held.release();
process.exit(result.ok ? 0 : 1);
/** Pings healthchecks.io after a full success; the missing ping is what raises the alarm. */
async function heartbeat(): Promise<boolean> {
  const url = process.env.HEALTHCHECK_URL?.trim();
  if (!url) return false;
  try {
    await new PoliteHttp({ retries: 2 }).text(url);
    return true;
  } catch (e) {
    log.warn('Heartbeat ping failed', { error: String(e) });
    return false;
  }
}

function spikeMarkdown(r: SpikeReport): string {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const sources = Object.keys(r.availability);
  const lines = [
    `| Date | Primary | ${sources.join(' | ')} | Layer B | Layer C | Not green |`,
    `|---|---|${sources.map(() => '---|').join('')}---|---|---|`,
    ...r.days.map(
      (d) =>
        `| ${d.date} | ${d.primaryOk ? 'ok' : 'FAILED'} | ${sources.map((s) => (d.available[s] ? 'yes' : 'no')).join(' | ')} | ${d.layerBPass ? 'pass' : 'fail'} | ${d.layerCPass ? 'pass' : 'fail'} | ${d.nonGreen.length} |`,
    ),
    '',
    `Days: ${r.days.length}. Primary ok: ${r.primaryOkDays}.`,
    `Secondary availability (gate: one >= ${pct(GATE.secondaryAvailability)}): ${sources.map((s) => `${s} ${pct(r.availability[s] ?? 0)}`).join(', ')}.`,
    `Layer B (gate >= ${pct(GATE.layerB)}): ${r.layerB.passed}/${r.layerB.days}. Layer C (gate >= ${pct(GATE.layerC)}): ${r.layerC.passed}/${r.layerC.days}.`,
    `Numeric gate: ${r.passed ? 'passed' : 'not passed'} (every failure must still be explained).`,
  ];
  return lines.join('\n');
}
