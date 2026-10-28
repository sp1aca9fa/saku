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
import { activeSymbols, createDb, finishRun, seedSourceRoles, startRun } from '@saku/db';
import { backupDatabase, backupDir, localDay, pruneBackups } from '@saku/db/backup';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { PoliteHttp } from '../http';
import { DAILY_OVERLAP, ingest, type SourceReport } from '../jobs/ingest';
import { lock, readStamp, writeStamp } from '../jobs/lock';
import { jobLogger } from '../jobs/log';
import { dailyTarget } from '../jobs/target';
import { probe } from '../jobs/probe';
import { GATE, type SpikeReport, spikeReport } from '../jobs/spike';
import { anchor } from '../jobs/anchor';
import { forward } from '../jobs/forward';
import { verify } from '../jobs/verify';
import { allInfos, loadPlugins, pluginContext, savePluginInfos } from '../registry';
import { assertServerOnly } from '../server-only';

const DATA_KIND = { bar: 'bars', series: 'series', fx: 'fx' } as const;

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
const run = job as 'bootstrap' | 'daily' | 'checks';
const runId = await startRun(db, run, now);
let ok = false;
let error: string | undefined;
let heartbeatSent = false;
try {
  const infos = allInfos(plugins);
  await savePluginInfos(db, infos, now);
  await seedSourceRoles(
    db,
    infos.flatMap((i) =>
      i.kind in DATA_KIND
        ? [
            {
              key: i.key,
              dataKind: DATA_KIND[i.kind as keyof typeof DATA_KIND],
              suggestedRole: i.suggestedRole,
            },
          ]
        : [],
    ),
  );
  if (plugins.missing.length > 0) log.info(`Not present: ${plugins.missing.join(', ')}`);
  log.info(`${job} for ${target}`, { runId });

  let incomplete: string[] = [];
  if (run !== 'checks') {
    const reports = await ingest(db, plugins, {
      mode: run,
      to: target,
      sessions,
      runId,
      log,
      context: (info) => pluginContext(info, log),
    });
    for (const r of reports) {
      log.info(summary(r), { source: r.source, failed: r.failed, missing: r.missing });
    }
    incomplete = reports.filter((r) => r.stopped || r.failed.length > 0).map((r) => r.source);
  }

  // Checks run whatever the sources did: a missing source is itself a finding.
  const checked = await verify(db, {
    runId,
    sessions,
    to: target,
    ...(job === 'daily'
      ? { mode: 'daily' as const, from: sessions.before(target, DAILY_OVERLAP) }
      : { mode: 'full' as const }),
  });
  log.info(`Checks: ${checked.results} results`, {
    byStatus: checked.byStatus,
    stored: checked.stored,
  });
  log.info(`Data health on ${target}: ${checked.health}`, { standIns: checked.standIns });
  for (const s of checked.standInsOff) {
    log.warn(
      `${s.ticker} ${s.date}: the stand-in was off the primary by ${(100 * s.deviation).toFixed(3)}%`,
    );
  }

  // Forward records (A2; nothing before forward_records_from is set, the A1 gate).
  if (run === 'daily') {
    const f = await forward(db, {
      runId,
      sessions,
      to: target,
      standInsOff: checked.standInsOff,
    });
    if (f.skipped) log.info(`Forward records: ${f.skipped}`);
    else {
      log.info(`Forward records: ${f.appended} new entries, ${f.safeStateDays} on the safe state`, {
        annotations: f.annotations,
      });
      for (const t of f.today) log.info(`${t.version}: ${t.allocation} (${t.dataStatus})`, t);
      const a = await anchor(db, {
        date: target,
        authorities: (process.env.SAKU_TSA_URLS ?? '')
          .split(',')
          .map((u) => u.trim())
          .filter(Boolean),
        ...(process.env.SAKU_TSA_CAFILE?.trim() && { caFile: process.env.SAKU_TSA_CAFILE.trim() }),
      });
      if (a.status === 'anchored') log.info(`Chain heads timestamped by ${a.authority}`);
      else if (a.status === 'skipped') log.warn(`Chain heads not timestamped: ${a.reason}`);
      else {
        log.warn('Timestamping failed', { errors: a.errors });
        incomplete.push('timestamp');
      }
    }
  }

  // The run is done when every source answered for every item.
  ok = incomplete.length === 0;
  if (!ok) error = `incomplete: ${incomplete.join(', ')}`;
  if (run === 'daily') {
    const backup = await backupDatabase(dbConfigFromEnv().url, backupDir(), localDay(now));
    await pruneBackups(backupDir());
    log.info(`Backup ${backup.file} (${(backup.bytes / 1e6).toFixed(1)} MB)`);
  }
  if (ok && run === 'daily') {
    writeStamp('daily', target);
    heartbeatSent = await heartbeat();
  }
} catch (e) {
  error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  log.warn('Run failed', { error });
} finally {
  await finishRun(db, runId, { ok, error, datesProcessed: [target], heartbeatSent });
  held.release();
}
log.info(ok ? `${job} done` : `${job} not complete: ${error}`);
process.exit(ok ? 0 : 1);

function summary(r: SourceReport): string {
  const parts = [`${r.kind} ${r.source}: ${r.ok.length} ok`];
  if (r.failed.length) parts.push(`${r.failed.length} failed`);
  if (r.stopped) parts.push(`stopped (${r.stopped})`);
  parts.push(`${r.inserted} new, ${r.revised} revised, ${r.readjustments} re-adjustments`);
  return parts.join(', ');
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
