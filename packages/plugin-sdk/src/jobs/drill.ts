// `pnpm drill red` (stage A2 acceptance: "a simulated red day produces the safe-state alert").
//
// A material data fault on stored data, evaluated by the real pipeline on a throwaway copy of the
// database, with the real alert channels so the owner sees the alert arrive:
// 1. The live database is copied with VACUUM INTO (the backups' method, which only reads it).
// 2. On the copy, the primary bar source's stored bar of each registered strategy's signal
//    tickers on the target date gets a decimal shift (close and high x10, the layer F fault
//    "decimal shift", packages/plugin-sdk/src/jobs/faults.test.ts), stored the way ingest stores
//    a response (the copy's revision log). No source is asked for anything.
// 3. Layers A-C run on the copy for the day as the daily run's checks do (requirements 04).
// 4. Each registered version the forward step would record for the day (its rules: after
//    `forward_records_from`, a close after registration; `recordsDay`) decides the day as that
//    step does (the canonical bars and their grades; red: the strategy's declared safe state), but
//    nothing is appended: no forward record, chain entry, annotation, timestamp, stamp or
//    heartbeat, here or in the live database. A version that would not record the day is not
//    drilled, and the drill does not pass while one is left out.
// 5. The day's alerts go to the real channels, each marked as a drill in its title with a line
//    saying nothing was recorded: the owner's provisional message (requirements 04 "Red re-check
//    before execution": the data problem, the deadline, the fallback safe state) and the admins'
//    data alert.
// 6. The last hourly re-check is simulated at the deadline (the setting, the next session's
//    open): layers A-C again on the copy (the fault is still stored), each version graded again;
//    still red, the owner's final message "the safe state stands" goes out the same way.
// The copy is deleted at the end, also on failure. The drill holds the jobs lock, so no job writes
// while it copies, and it refuses to run on Vercel or in CI (jobs run only on the server).
import {
  type HealthStatus,
  type Strategy,
  type TradingDate,
  dependencies,
  forwardDecision,
  signalTickers,
} from '@saku/core';
import type { Sessions } from '@saku/data';
import {
  type Db,
  activeSymbols,
  allVersions,
  createDb,
  getSetting,
  RECHECK_MAX_MINUTES,
  recheckMinutes,
  schema,
  sourceRolesOf,
  startRun,
  storeRawBars,
  symbolId,
} from '@saku/db';
import { snapshotDatabase } from '@saku/db/backup';
import { pendingMigrations } from '@saku/db/migrate';
import { and, eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LoadedPlugins,
  allInfos,
  dividendListingLagsOf,
  issuerPublishesOf,
} from '../registry';
import { DATA_KIND, assignedOnly } from '../roles';
import { assertServerOnly } from '../server-only';
import type { Logger, Notifier, PluginContext } from '../types';
import {
  type AlertOptions,
  type DayEntry,
  sendDataHealthAdmin,
  sendRecheckMessage,
} from './alerts';
import { healthOf, parseVersion, reader, recordClose, recordsDay } from './forward';
import { DAILY_OVERLAP, supportedBy } from './ingest';
import { lock } from './lock';
import { recheckDeadline, recheckTimeZone, regrade } from './recheck';
import { declaredCalendars } from './run';
import { verify } from './verify';

/** The drill's fault: a decimal shift of the close (and the high, so the bar stays whole). */
export const DRILL_FACTOR = 10;

export interface DrillOptions {
  /** The live database (`file:` URL): only read, by VACUUM INTO. */
  url: string;
  plugins: LoadedPlugins;
  sessions: Sessions;
  /** The cash series' business days (as the daily run, the drill does not check without them). */
  seriesSessions: Sessions | undefined;
  target: TradingDate;
  now: Date;
  log: Logger;
  /** The alert settings but the date; `context` is built on the copy (its usage counts). */
  alerting: Pick<AlertOptions, 'notifiers' | 'authSecret'> & {
    context: (copy: Db) => (notifier: Notifier, channelId: string) => PluginContext;
  };
  /** Checked for VERCEL and CI (default: the process's). */
  env?: NodeJS.ProcessEnv;
  /** The jobs lock's folder (default: the state dir's). */
  lockDir?: string;
  /** Where the temporary copy goes (default: the system's temp folder). */
  workDir?: string;
}

export interface DrillVersion {
  name: string;
  id: string;
  allocation: string;
  safeStateApplied: boolean;
  dataStatus: string;
  reasons: string[];
  /** Channels that got this version's provisional message. */
  provisional: number;
  /** The last re-check before the deadline (`regrade`): `safe_state` when still red. */
  outcome?: 'pending' | 'cleared' | 'safe_state' | 'late';
  /** Channels that got this version's final message ("the safe state stands"). */
  final: number;
}

/** A registered version the forward step would not record on the target date: not drilled. */
export interface NotDrilled {
  name: string;
  id: string;
  reason: string;
}

export interface DrillReport {
  target: TradingDate;
  /** The day's overall grade on the copy, after the fault. */
  grade: HealthStatus;
  reasons: string[];
  /** The re-check deadline (ISO 8601 instant) the drill's last re-check is simulated at. */
  deadline: string;
  /** The install's time zone the messages show the deadline in. */
  timeZone: string;
  /** Where the fault went: the primary's bar of each signal ticker on the target date. */
  faults: { ticker: string; source: string; close: number; faulted: number }[];
  versions: DrillVersion[];
  /** Registered versions that do not record the target date (each makes the drill fail). */
  notDrilled: NotDrilled[];
  alerts: { channel: string; type: string; title: string }[];
  /** Deliveries that failed, versions that do not parse: each makes the drill fail. */
  problems: string[];
  /**
   * Red, every registered version drilled, on its safe state, still red at the last re-check, its
   * provisional and final messages each on at least one channel, no problem.
   */
  ok: boolean;
}

export type DrillResult = { refused: string } | { failed: string } | DrillReport;

export async function redDrill(o: DrillOptions): Promise<DrillResult> {
  try {
    assertServerOnly(o.env ?? process.env);
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
  // No job writes while the copy is made, and no two drills at once.
  const held = o.lockDir ? lock('jobs', o.lockDir) : lock('jobs');
  if ('heldBy' in held) {
    return {
      refused: `Another job is running (process ${held.heldBy}); run the drill when it has finished.`,
    };
  }
  let work: string | undefined;
  let copy: Db | undefined;
  try {
    work = await mkdtemp(join(o.workDir ?? tmpdir(), 'saku-drill-'));
    const file = join(work, 'saku.db');
    await snapshotDatabase(o.url, file);
    o.log.info('Drill: copied the database (the live one is not written)');
    copy = createDb({ url: `file:${file}` });
    return await onCopy(copy, o);
  } catch (e) {
    return { failed: e instanceof Error ? e.message : String(e) };
  } finally {
    copy?.$client.close();
    if (work) await rm(work, { recursive: true, force: true });
    held.release();
  }
}

/** The close the forward step cuts at on `date`, as the drill tells it. */
function closeLabel(date: TradingDate, sessions: Sessions): string {
  const { time, kind } = recordClose(date, sessions);
  if (kind === 'regular') return `${time} New York`;
  if (kind === 'early') return `${time} New York, an early close`;
  return `${time} New York, the earliest it could close: the calendar does not say whether it closed early`;
}

async function onCopy(db: Db, o: DrillOptions): Promise<DrillResult> {
  const pending = await pendingMigrations(db);
  if (pending.length > 0) {
    return {
      refused: `The database is missing migration(s): ${pending.join(', ')}. Run pnpm db:migrate first.`,
    };
  }
  // The forward step's gate (requirements 05, A1): nothing is recorded or alerted before it.
  const from = await getSetting(db, 'forward_records_from');
  if (!from) {
    return {
      refused:
        'Forward records have not started (forward_records_from is not set; the A1 gate), so ' +
        'the daily run records and alerts nothing yet and there is nothing to drill.',
    };
  }
  if (from > o.target) {
    return {
      refused:
        `Forward records start on ${from}, after ${o.target}, so the daily run records nothing ` +
        `for that day. Choose a later date: pnpm drill red --date <YYYY-MM-DD>.`,
    };
  }
  // The versions that alert someone (library versions have no recipient).
  const registered = (await allVersions(db)).filter((v) => v.ownerId);
  if (registered.length === 0) {
    return {
      refused:
        'No strategy is registered, so there is nothing to drill. Register one first ' +
        '(pnpm strategy register <file.yaml> --user <username>; docs/running.md), then run ' +
        'pnpm drill red again.',
    };
  }
  const problems: string[] = [];
  const versions: { version: (typeof registered)[number]; strategy: Strategy }[] = [];
  const notDrilled: NotDrilled[] = [];
  for (const version of registered) {
    const parsed = parseVersion(version);
    if ('error' in parsed) {
      problems.push(`${version.name} (${version.id}): definition does not parse: ${parsed.error}`);
    } else if (!recordsDay(o.target, from, version.registeredAt, o.sessions)) {
      // The forward step records no entry and sends no alert for it on this day.
      notDrilled.push({
        name: version.name,
        id: version.id,
        reason:
          `registered ${version.registeredAt}, not before the ${o.target} close (` +
          `${closeLabel(o.target, o.sessions)}); its record starts with the first close after ` +
          'registration',
      });
    } else versions.push({ version, strategy: parsed.strategy });
  }
  if (versions.length === 0) {
    if (problems.length > 0) {
      return { failed: [...problems, ...notDrilled.map(notDrilledLine)].join('\n') };
    }
    return {
      refused:
        `No registered version records ${o.target}: ${notDrilled.map(notDrilledLine).join('; ')}. ` +
        'Choose a later date: pnpm drill red --date <YYYY-MM-DD>.',
    };
  }
  const seriesSessions =
    o.seriesSessions ??
    fail('No us-fed calendar plug-in is loaded (the cash series is checked on it).');

  const roles = await sourceRolesOf(db);
  const primary =
    roles.find((r) => r.dataKind === DATA_KIND.bar && r.role === 'primary')?.pluginKey ??
    fail('No primary bar source is assigned (pnpm sources).');
  const runId = await startRun(db, 'checks', o.now, o.target);

  // The fault: each signal ticker's primary bar on the target date (a strategy without signals:
  // the tickers it depends on), as the primary would have sent it with a decimal shift.
  const tickers = [
    ...new Set(
      versions.flatMap(({ strategy }) => {
        const signals = signalTickers(strategy);
        return signals.length > 0 ? signals : dependencies(strategy);
      }),
    ),
  ].sort();
  const faults: DrillReport['faults'] = [];
  for (const ticker of tickers) {
    const id = (await symbolId(db, ticker)) ?? fail(`${ticker} is not in the universe.`);
    const [row] = await db
      .select()
      .from(schema.barsRaw)
      .where(
        and(
          eq(schema.barsRaw.symbolId, id),
          eq(schema.barsRaw.source, primary),
          eq(schema.barsRaw.date, o.target),
        ),
      );
    if (!row) {
      return {
        failed:
          `No ${ticker} bar from the primary (${primary}) is stored for ${o.target}, so the ` +
          'fault cannot be injected. Choose a date the daily run fetched: pnpm drill red --date ' +
          '<YYYY-MM-DD>.',
      };
    }
    const faulted = row.close * DRILL_FACTOR;
    await storeRawBars(db, {
      symbolId: id,
      source: primary,
      runId,
      fetchedAt: o.now.toISOString(),
      bars: [
        {
          date: row.date,
          ...(row.open !== null && { open: row.open }),
          ...(row.high !== null && { high: row.high * DRILL_FACTOR }),
          ...(row.low !== null && { low: row.low }),
          close: faulted,
          closeIsSplitAdjusted: row.closeIsSplitAdjusted,
          ...(row.volume !== null && { volume: row.volume }),
          divCash: row.divCash,
          splitFactor: row.splitFactor,
          ...(row.providerAdjClose !== null && { providerAdjClose: row.providerAdjClose }),
        },
      ],
    });
    faults.push({ ticker, source: primary, close: row.close, faulted });
  }
  o.log.info('Drill: fault injected on the copy', { faults });

  // Layers A-C on the copy as the daily run checks (no fetch: the sources' availability is that of
  // `pnpm verify`, which also checks stored data).
  const infos = allInfos(o.plugins);
  const used = assignedOnly(o.plugins, roles);
  const active = (await activeSymbols(db)).map((s) => s.ticker);
  const check = (now: Date) =>
    verify(db, {
      runId,
      sessions: o.sessions,
      to: o.target,
      seriesSessions,
      now,
      issuers: used.issuers.map((source) => ({
        source: source.info.key,
        supported: supportedBy(source, active).supported,
        unavailable: [],
      })),
      sourceCalendars: declaredCalendars(o.plugins, infos, o.log),
      issuerPublishes: issuerPublishesOf(used.issuers),
      dividendListingLags: dividendListingLagsOf(o.plugins.bars),
      mode: 'daily',
      from: o.sessions.before(o.target, DAILY_OVERLAP),
    });
  const checked = await check(o.now);
  o.log.info(`Drill: data health on ${o.target}: ${checked.health}`, { reasons: checked.reasons });
  if (checked.removedCanonical.length > 0) {
    o.log.info('Drill: canonical bars the checks no longer build (removed on the copy)', {
      removed: checked.removedCanonical.map((r) => `${r.ticker} ${r.date}`),
    });
  }

  // The red re-check (requirements 04 "Red re-check before execution"): the deadline as the
  // forward step computes it. A setting that does not parse, or a calendar that does not cover the
  // next session, leaves it unknown: the drill fails (the daily run would open no re-check).
  const minutes = await recheckMinutes(db);
  const deadline =
    'minutes' in minutes ? recheckDeadline(o.target, o.sessions, minutes.minutes) : undefined;
  if (deadline === undefined) {
    return {
      failed:
        'minutes' in minutes
          ? `The calendar does not cover the session after ${o.target}, so its re-check deadline is unknown.`
          : `red_recheck_minutes_before_open is ${minutes.invalid}, not whole minutes from 0 to ` +
            `${RECHECK_MAX_MINUTES}; set it again (pnpm settings set; docs/setup.md).`,
    };
  }
  const timeZone = await recheckTimeZone(db);

  const { symbolIds, loadRows, barsOf } = await reader(db, o.sessions);
  const decide = async (strategy: Strategy) => {
    const rows = await loadRows(dependencies(strategy), o.target);
    return forwardDecision(
      strategy,
      o.target,
      barsOf(rows),
      await healthOf(db, symbolIds, rows, o.target, o.sessions),
    );
  };
  const dayOf = (d: Awaited<ReturnType<typeof decide>>): DayEntry => ({
    date: o.target,
    allocation: d.allocation,
    holdings: d.holdings,
    dataStatus: d.dataStatus,
    safeStateApplied: d.safeStateApplied,
    reasons: d.reasons,
  });
  const alerts: DrillReport['alerts'] = [];
  // One context for the whole drill, as the daily run has one per run: a notifier's channels
  // share its pacing and counts across versions.
  const context = o.alerting.context(db);
  const alerting = (onDelivered: AlertOptions['onDelivered']): AlertOptions => ({
    date: o.target,
    notifiers: o.alerting.notifiers,
    authSecret: o.alerting.authSecret,
    context,
    log: o.log,
    drill: true,
    onDelivered: (d) => {
      alerts.push(d);
      onDelivered?.(d);
    },
  });

  // 1. The first grading: each version decides the day as the forward step does, without
  // appending; red, the provisional message (the fallback safe state and the deadline).
  const first = new Map<string, Awaited<ReturnType<typeof decide>>>();
  const decided: DrillVersion[] = [];
  for (const { version, strategy } of versions) {
    const decision = await decide(strategy);
    first.set(version.id, decision);
    let provisional = 0;
    if (decision.safeStateApplied) {
      const sent = await sendRecheckMessage(
        db,
        { ...alerting(() => provisional++), sessions: o.sessions },
        {
          version,
          strategy,
          message: { kind: 'provisional', day: dayOf(decision) },
          deadline,
          timeZone,
        },
      );
      problems.push(...sent.failed);
    }
    decided.push({
      name: version.name,
      id: version.id,
      allocation: decision.allocation,
      safeStateApplied: decision.safeStateApplied,
      dataStatus: decision.dataStatus,
      reasons: decision.reasons,
      provisional,
      final: 0,
    });
  }
  // The admins' data alert, as the daily run sends it on a day that is not green.
  if (checked.health !== 'green') {
    const sent = await sendDataHealthAdmin(db, {
      ...alerting(undefined),
      health: checked.health,
      reasons: checked.reasons,
    });
    problems.push(...sent.failed);
  }

  // 2. The last hourly re-check, its simulated clock at the deadline: the checks again on the copy
  // (the fault is still stored), each red version graded again; still red, the final "safe state
  // stands" (as the forward step records it then).
  const at = new Date(deadline);
  const regraded = await check(at);
  o.log.info(`Drill: re-check at the deadline ${deadline}: ${regraded.health}`);
  for (const [i, { version, strategy }] of versions.entries()) {
    const v = decided[i]!;
    if (!first.get(version.id)!.safeStateApplied) continue;
    const decision = await decide(strategy);
    const outcome = regrade({
      red: decision.safeStateApplied,
      clock: at.getTime(),
      deadline: at.getTime(),
    });
    v.outcome = outcome;
    if (outcome !== 'safe_state') continue;
    const sent = await sendRecheckMessage(
      db,
      { ...alerting(() => v.final++), sessions: o.sessions },
      {
        version,
        strategy,
        message: { kind: 'final', outcome, day: dayOf(decision) },
        deadline,
        timeZone,
      },
    );
    problems.push(...sent.failed);
  }

  const ok =
    checked.health === 'red' &&
    problems.length === 0 &&
    notDrilled.length === 0 &&
    decided.every(
      (v) => v.safeStateApplied && v.outcome === 'safe_state' && v.provisional > 0 && v.final > 0,
    );
  return {
    target: o.target,
    grade: checked.health,
    reasons: checked.reasons,
    deadline,
    timeZone,
    faults,
    versions: decided,
    notDrilled,
    alerts,
    problems,
    ok,
  };
}

/** The drill's outcome for the terminal (the CLI exits 0 only when `ok`). */
export function drillSummary(r: DrillResult): string {
  if ('refused' in r) return `Drill refused: ${r.refused}`;
  if ('failed' in r) return `Drill failed: ${r.failed}`;
  const lines = [
    `Red-day drill for ${r.target} (on a temporary copy; nothing was recorded and the copy is deleted)`,
    ...r.faults.map(
      (f) =>
        `Fault: ${f.ticker} close from ${f.source} ${f.close} -> ${f.faulted} (x${DRILL_FACTOR})`,
    ),
    `Day's grade: ${r.grade}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}`,
    `Re-check deadline: ${r.deadline} (the last re-check is simulated there; shown in ${r.timeZone})`,
    ...r.versions.map(
      (v) =>
        `${v.name} (${v.id}): ${v.allocation}${v.safeStateApplied ? ' (safe state applied)' : ' (NOT the safe state)'}, data ${v.dataStatus}${v.reasons.length ? ` (${v.reasons.join('; ')})` : ''}, provisional message on ${v.provisional} channel(s), re-check at the deadline: ${v.outcome ?? 'not run'}, final message on ${v.final} channel(s)`,
    ),
    ...r.notDrilled.map((v) => `Not drilled: ${notDrilledLine(v)}`),
    ...(r.alerts.length
      ? r.alerts.map((a) => `Sent (${a.type}) to ${a.channel}: ${a.title}`)
      : ['No alert was delivered.']),
    ...r.problems.map((p) => `Problem: ${p}`),
  ];
  if (r.ok)
    lines.push(
      'Drill passed: the day was red, the safe state applied, the provisional message arrived, ' +
        'and at the deadline the final "safe state stands" arrived.',
    );
  else {
    const why = [
      ...(r.grade !== 'red' ? [`the day was ${r.grade}, not red`] : []),
      ...r.versions
        .filter((v) => !v.safeStateApplied)
        .map((v) => `${v.name} did not apply its safe state`),
      ...r.versions
        .filter((v) => v.safeStateApplied && v.outcome !== 'safe_state')
        .map(
          (v) => `${v.name} was ${v.outcome ?? 'not re-checked'} at the deadline, not still red`,
        ),
      ...r.notDrilled.map((v) => `${v.name} does not record ${r.target}`),
      ...r.versions
        .filter((v) => v.safeStateApplied && v.provisional === 0)
        .map(
          (v) => `no channel got ${v.name}'s provisional message (pnpm channel list --user <name>)`,
        ),
      ...r.versions
        .filter((v) => v.safeStateApplied && v.outcome === 'safe_state' && v.final === 0)
        .map((v) => `no channel got ${v.name}'s final message (pnpm channel list --user <name>)`),
      ...(r.problems.length ? ['see the problems above'] : []),
    ];
    lines.push(`Drill FAILED: ${why.join('; ')}.`);
  }
  return lines.join('\n');
}

function notDrilledLine(v: NotDrilled): string {
  return `${v.name} (${v.id}): ${v.reason}`;
}

function fail(message: string): never {
  throw new Error(message);
}
