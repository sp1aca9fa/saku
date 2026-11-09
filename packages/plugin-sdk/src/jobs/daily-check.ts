// The hourly `pnpm daily` (`cli/jobs.ts`; requirements 04 "Red re-check before execution" and
// "Failure handling" row H): the daily run once the latest session is final, a red re-check run
// while one is open, the session ping tried again when it failed, and the heartbeat keep-alive
// (`keepalive.ts`) when the day is done.
import type { Sessions } from '@saku/data';
import {
  type Db,
  latestDailyRun,
  latestRecheckRun,
  openRechecks as openRechecksOf,
} from '@saku/db';
import type { Logger } from '../types';
import { type KeepAliveCheck, keepAlive, latestRunWhy } from './keepalive';
import { readStamp, writeStamp } from './lock';
import { dailyAction } from './recheck';
import { dailyTarget } from './target';

/**
 * The hourly check's two pings, from the environment (`process.env`): the session ping and the
 * keep-alive both go to `HEALTHCHECK_URL` (requirements 12 "Outside watch"), the keep-alive's
 * failures logged under its own label; never another check's URL (weekly, monthly). No URL (unset
 * or blank): the session ping sends nothing (false) and there is no keep-alive. `send`:
 * `sendHeartbeat`, which never logs the URL.
 */
export function dailyPings(
  env: Record<string, string | undefined>,
  send: (url: string, check: string) => Promise<boolean>,
): Pick<DailyCheckDeps, 'heartbeat' | 'keepAlivePing'> {
  const url = env.HEALTHCHECK_URL?.trim();
  if (!url) return { heartbeat: async () => false };
  return {
    heartbeat: () => send(url, 'HEALTHCHECK_URL'),
    keepAlivePing: () => send(url, 'HEALTHCHECK_URL keep-alive'),
  };
}

export interface DailyCheckDeps {
  sessions: Sessions;
  finalAfter: string;
  /** `pnpm daily --force`: the run again for the target; never a keep-alive. */
  force: boolean;
  /** When the check started: decides the target and the re-check action. */
  now: Date;
  /** Read when the keep-alive is decided, after any run (default: the system clock). */
  clock?: () => Date;
  stampsDir?: string;
  log: Logger;
  /** The session ping (`HEALTHCHECK_URL`); true when answered. */
  heartbeat: () => Promise<boolean>;
  /** The keep-alive ping to the same check; absent when `HEALTHCHECK_URL` is unset. */
  keepAlivePing?: () => Promise<boolean>;
  /** The daily job (`runJob`), which calls `onComplete` on a complete run that is no re-check. */
  run: (o: {
    target: string;
    recheck: boolean;
    onComplete: (job: 'daily' | 'weekly') => Promise<boolean>;
  }) => Promise<{ ok: boolean }>;
  /** The open red re-checks (default: the database's). */
  openRechecks?: (db: Db) => Promise<{ date: string; versionId: string; deadline: string }[]>;
}

/** One hourly check of the daily job; resolves to the process's exit code. */
export async function dailyCheck(db: Db, d: DailyCheckDeps): Promise<number> {
  const { log, force, stampsDir } = d;
  const target = dailyTarget(d.sessions, d.now, d.finalAfter);
  const keep = (check: KeepAliveCheck) =>
    keepAlive(db, {
      sessions: d.sessions,
      finalAfter: d.finalAfter,
      check,
      log,
      ...(d.keepAlivePing && { ping: d.keepAlivePing }),
      ...(stampsDir !== undefined && { stampsDir }),
      ...(d.clock && { clock: d.clock }),
    });
  let recheck = false;
  if (!force && (readStamp('daily', stampsDir) ?? '') >= target) {
    // Done for the day; a session ping that failed then is tried again (not the whole run), but
    // only while the latest daily run (re-check and forced runs included) still succeeded for the
    // target, as for the keep-alive (decisions log 2026-11-09): a later failure stops every ping.
    if ((readStamp('heartbeat', stampsDir) ?? '') < target) {
      const why = latestRunWhy(await latestDailyRun(db), target);
      if (why) log.info('No session ping retry', { why, target });
      else if (await d.heartbeat()) writeStamp('heartbeat', target, stampsDir);
    }
    const open = await (d.openRechecks ?? openRechecksOf)(db);
    const next = dailyAction({
      stamped: true,
      force,
      open,
      now: d.now,
      lastRecheck: await latestRecheckRun(db),
    });
    if (next.action === 'exit') {
      // Stuck: the latest re-check run failed for these versions after their deadlines; its
      // job-failure alert stands, and another full run every hour would only repeat it.
      if (next.why === 'stuck') {
        log.warn(
          `Red re-checks past their deadline cannot close (see the last re-check run's error): ` +
            `${open.map((r) => `${r.date} ${r.versionId}`).join(', ')}; not run again until fixed ` +
            '(then pnpm daily --force)',
        );
      }
      await keep(next);
      return 0;
    }
    recheck = true;
    log.info(`Red re-check: ${open.map((r) => `${r.date} (deadline ${r.deadline})`).join(', ')}`);
  }
  let ok: boolean;
  try {
    ({ ok } = await d.run({
      target,
      recheck,
      onComplete: async () => {
        writeStamp('daily', target, stampsDir);
        const sent = await d.heartbeat();
        if (sent) writeStamp('heartbeat', target, stampsDir);
        return sent;
      },
    }));
  } catch (e) {
    log.warn('Run could not start or finish', { error: String(e) });
    return 1;
  }
  // Only a re-check run's outcome decides here: a daily or forced run either did the day's own
  // session ping or failed, and the next hourly check decides the keep-alive.
  if (recheck) await keep({ action: 'recheck', ok });
  return ok ? 0 : 1;
}
