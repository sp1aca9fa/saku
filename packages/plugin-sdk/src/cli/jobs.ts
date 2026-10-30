// `pnpm bootstrap` and `pnpm daily` (requirements 04, 12). Runs only on the server.
//
//   pnpm bootstrap         full history from every source (first install, new symbols)
//   pnpm daily             once per trading day, at the first check after the day's data is
//                          final; exits at once when the day is done (the hourly timer calls it)
//   pnpm daily --force     run again for the latest final day
//   pnpm weekly            full-history refetch (revisions reported), checks, recompute, layer E
//   pnpm verify            layers A-C over the full history and layer E (core vs reference,
//                          incremental vs full, testfol parity cases in plugins/test/testfol)
//                          on the stored data, no fetching
//   pnpm checks            the same as pnpm verify (its A1 name)
//   pnpm probe             A1: the last sessions of one ticker from every bar source, to a log
//   pnpm spike             A1: the gate, every NYSE session from the first daily run to the
//                          latest final day (a session without a run fails; the latest one is
//                          pending until its run finishes); passed needs 20 judged sessions
//   pnpm spike --from <YYYY-MM-DD>
//                          the same, counted from the first NYSE session on or after the date
//                          (earlier sessions are neither listed nor counted; the report says how
//                          many sessions with daily runs it left out and how many of them failed)
// Any other argument after the job name is refused (cli/jobs-args.ts).
import { Sessions } from '@saku/data';
import { tradingDateOf } from '@saku/core';
import { join } from 'node:path';
import { activeSymbols, createDb } from '@saku/db';
import { backupDatabase, backupDir, localDay, pruneBackups } from '@saku/db/backup';
import { dbConfigFromEnv, findRepoRoot, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { codeVersion } from '../code-version';
import { PoliteHttp } from '../http';
import { lock, readStamp, writeStamp } from '../jobs/lock';
import { jobLogger } from '../jobs/log';
import { probe } from '../jobs/probe';
import { runJob } from '../jobs/run';
import { GATE, type SpikeReport, spikeFrom, spikeReport, verdict } from '../jobs/spike';
import { dailyTarget } from '../jobs/target';
import { loadPlugins, notifierContexts, pluginContext, providerUsageStore } from '../registry';
import { assertServerOnly } from '../server-only';
import { USAGE, parseJobArgs } from './jobs-args';

assertServerOnly();
loadRootEnv();
// Every argument after the job name must be a known flag of that job; anything else is refused.
const args = parseJobArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(args.error);
  process.exit(1);
}
const { job, force } = args;
// `pnpm spike --from <date>`: the counted range starts at the first session on or after it.
const spikeFromArg = args.from;
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
  // Through the current daily target: a session without a run fails, except the target while its
  // run window is open (pending).
  const from = spikeFromArg === undefined ? undefined : spikeFrom(sessions, spikeFromArg, target);
  if (from !== undefined && 'error' in from) {
    console.error(from.error);
    console.error(USAGE);
    held.release();
    process.exit(1);
  }
  console.log(
    spikeMarkdown(
      await spikeReport(db, {
        sessions,
        to: target,
        open: target,
        ...(from !== undefined && { from: from.date }),
      }),
    ),
  );
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
    context: (info) => pluginContext(info, log, { usage: providerUsageStore(db) }),
  });
  for (const l of lines.filter((l) => l.error)) log.warn(`probe ${l.source}: ${l.error}`);
  held.release();
  process.exit(0);
}

if (job === 'daily' && !force && (readStamp('daily') ?? '') >= target) {
  // Done for the day; a heartbeat that failed then is tried again (not the whole run).
  if ((readStamp('heartbeat') ?? '') < target && (await heartbeat()))
    writeStamp('heartbeat', target);
  held.release();
  process.exit(0);
}

// From here on, the jobs that record a run.
let result: Awaited<ReturnType<typeof runJob>> | undefined;
try {
  result = await runJob(db, plugins, {
    job: job === 'verify' ? 'checks' : (job as 'bootstrap' | 'daily' | 'weekly' | 'checks'),
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
    parityDir: join(findRepoRoot(), 'plugins', 'test', 'testfol'),
    beforeRefetch: backup,
    afterDaily: backup,
    onComplete: async () => {
      writeStamp('daily', target);
      const sent = await heartbeat();
      if (sent) writeStamp('heartbeat', target);
      return sent;
    },
  });
} catch (e) {
  log.warn('Run could not start or finish', { error: String(e) });
} finally {
  held.release();
}
process.exit(result?.ok ? 0 : 1);
/** A checked copy of the database, before the weekly refetch and after the daily steps. */
async function backup() {
  const b = await backupDatabase(dbConfigFromEnv().url, backupDir(), localDay(now));
  await pruneBackups(backupDir());
  log.info(`Backup ${b.file} (${(b.bytes / 1e6).toFixed(1)} MB)`);
}

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
        `| ${d.date} | ${d.reason === 'pending' ? 'pending' : d.primaryOk ? 'ok' : d.reason === 'no_run' ? 'FAILED (no run)' : 'FAILED'} | ${sources.map((s) => (d.available[s] ? 'yes' : 'no')).join(' | ')} | ${d.reason === 'pending' ? 'pending' : d.layerBPass ? 'pass' : 'fail'} | ${d.reason === 'pending' || d.layerCPending ? 'pending' : d.layerCPass ? 'pass' : d.layerCReason === 'index_never_arrived' ? 'fail (index result never arrived)' : 'fail'} | ${d.nonGreen.length} |`,
    ),
    '',
    `Judged: ${r.days.length - r.pending} sessions${r.through ? ` through ${r.through}` : ''}. Primary ok: ${r.primaryOkDays}. Without a finished daily run: ${r.days.filter((d) => d.reason === 'no_run' && (!r.through || d.date <= r.through)).length}. Not judged yet (from the first pending session on): ${r.pending}.`,
    `Secondary availability (gate: one >= ${pct(GATE.secondaryAvailability)}): ${sources.map((s) => `${s} ${pct(r.availability[s] ?? 0)}`).join(', ')}.`,
    `Layer B (gate >= ${pct(GATE.layerB)}): ${r.layerB.passed}/${r.layerB.days}. Layer C (gate >= ${pct(GATE.layerC)}): ${r.layerC.passed}/${r.layerC.days}.`,
    ...(r.leftOut
      ? [
          `Counted from ${r.leftOut.from} (--from; ${r.leftOut.sessions} earlier sessions with daily runs left out, ${r.leftOut.failed} of them failed${r.leftOut.notJudged ? `, ${r.leftOut.notJudged} not judged yet` : ''})`,
        ]
      : []),
    `Numeric gate: ${verdict(r)} (every failure must still be explained).`,
  ];
  return lines.join('\n');
}
