// `pnpm bootstrap` and `pnpm daily` (requirements 04, 12). Runs only on the server.
//
//   pnpm bootstrap         full history from every source (first install, new symbols)
//   pnpm daily             once per trading day, at the first check after the day's data is
//                          final; exits at once when the day is done (the hourly timer calls it)
//   pnpm daily --force     run again for the latest final day
//   pnpm checks            layers A-C over the full history (summaries and non-green results)
import { Sessions } from '@saku/data';
import { createDb, finishRun, seedSourceRoles, startRun } from '@saku/db';
import { dbConfigFromEnv, loadRootEnv } from '@saku/db/env';
import { exitIfUnmigrated } from '@saku/db/migrate';
import { PoliteHttp } from '../http';
import { DAILY_OVERLAP, ingest, type SourceReport } from '../jobs/ingest';
import { lock, readStamp, writeStamp } from '../jobs/lock';
import { jobLogger } from '../jobs/log';
import { dailyTarget } from '../jobs/target';
import { verify } from '../jobs/verify';
import { allInfos, loadPlugins, pluginContext, savePluginInfos } from '../registry';
import { assertServerOnly } from '../server-only';

const DATA_KIND = { bar: 'bars', series: 'series', fx: 'fx' } as const;

assertServerOnly();
loadRootEnv();
const job = process.argv[2];
if (job !== 'bootstrap' && job !== 'daily' && job !== 'checks') {
  console.error('Usage: pnpm bootstrap | pnpm daily [--force] | pnpm checks');
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

if (job === 'daily' && !force && (readStamp('daily') ?? '') >= target) {
  held.release();
  process.exit(0);
}

const runId = await startRun(db, job === 'checks' ? 'checks' : job, now);
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
  if (job !== 'checks') {
    const reports = await ingest(db, plugins, {
      mode: job,
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

  // The run is done when every source answered for every item.
  ok = incomplete.length === 0;
  if (!ok) error = `incomplete: ${incomplete.join(', ')}`;
  if (ok && job === 'daily') {
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
