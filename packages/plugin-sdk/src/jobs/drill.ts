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
// 5. The day's alerts (the owner's safe-state alert, the admins' data alert) go to the real
//    channels, each marked as a drill in its title with a line saying nothing was recorded.
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
import { type LoadedPlugins, allInfos, issuerPublishesOf } from '../registry';
import { DATA_KIND, assignedOnly } from '../roles';
import { assertServerOnly } from '../server-only';
import type { Logger, Notifier, PluginContext } from '../types';
import { type AlertOptions, type DayEntry, sendDataHealthAdmin, sendDayAlert } from './alerts';
import { healthOf, parseVersion, reader, recordsDay } from './forward';
import { DAILY_OVERLAP, supportedBy } from './ingest';
import { lock } from './lock';
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
  /** Channels that got this version's alert. */
  delivered: number;
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
  /** Where the fault went: the primary's bar of each signal ticker on the target date. */
  faults: { ticker: string; source: string; close: number; faulted: number }[];
  versions: DrillVersion[];
  /** Registered versions that do not record the target date (each makes the drill fail). */
  notDrilled: NotDrilled[];
  alerts: { channel: string; type: string; title: string }[];
  /** Deliveries that failed, versions that do not parse: each makes the drill fail. */
  problems: string[];
  /**
   * Red, every registered version drilled, on its safe state with its alert on at least one
   * channel, no problem.
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
        '(pnpm strategy register <file.json> --user <username>; docs/running.md), then run ' +
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
    } else if (!recordsDay(o.target, from, version.registeredAt)) {
      // The forward step records no entry and sends no alert for it on this day.
      notDrilled.push({
        name: version.name,
        id: version.id,
        reason:
          `registered ${version.registeredAt}, not before the ${o.target} close (16:00 New ` +
          'York); its record starts with the first close after registration',
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
  const checked = await verify(db, {
    runId,
    sessions: o.sessions,
    to: o.target,
    seriesSessions,
    now: o.now,
    issuers: used.issuers.map((source) => ({
      source: source.info.key,
      supported: supportedBy(source, active).supported,
      unavailable: [],
    })),
    sourceCalendars: declaredCalendars(o.plugins, infos, o.log),
    issuerPublishes: issuerPublishesOf(used.issuers),
    mode: 'daily',
    from: o.sessions.before(o.target, DAILY_OVERLAP),
  });
  o.log.info(`Drill: data health on ${o.target}: ${checked.health}`, { reasons: checked.reasons });

  // Each version decides the day as the forward step does, without appending.
  const { symbolIds, loadRows, barsOf } = await reader(db);
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
  const decided: DrillVersion[] = [];
  for (const { version, strategy } of versions) {
    const rows = await loadRows(dependencies(strategy), o.target);
    const decision = forwardDecision(
      strategy,
      o.target,
      barsOf(rows),
      await healthOf(db, symbolIds, rows, o.target),
    );
    const day: DayEntry = {
      date: o.target,
      allocation: decision.allocation,
      holdings: decision.holdings,
      dataStatus: decision.dataStatus,
      safeStateApplied: decision.safeStateApplied,
      reasons: decision.reasons,
    };
    let delivered = 0;
    const sent = await sendDayAlert(
      db,
      { ...alerting(() => delivered++), sessions: o.sessions },
      { version, strategy, day },
    );
    problems.push(...sent.failed);
    decided.push({
      name: version.name,
      id: version.id,
      allocation: decision.allocation,
      safeStateApplied: decision.safeStateApplied,
      dataStatus: decision.dataStatus,
      reasons: decision.reasons,
      delivered,
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

  const ok =
    checked.health === 'red' &&
    problems.length === 0 &&
    notDrilled.length === 0 &&
    decided.every((v) => v.safeStateApplied && v.delivered > 0);
  return {
    target: o.target,
    grade: checked.health,
    reasons: checked.reasons,
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
    ...r.versions.map(
      (v) =>
        `${v.name} (${v.id}): ${v.allocation}${v.safeStateApplied ? ' (safe state applied)' : ' (NOT the safe state)'}, data ${v.dataStatus}${v.reasons.length ? ` (${v.reasons.join('; ')})` : ''}, alert on ${v.delivered} channel(s)`,
    ),
    ...r.notDrilled.map((v) => `Not drilled: ${notDrilledLine(v)}`),
    ...(r.alerts.length
      ? r.alerts.map((a) => `Sent (${a.type}) to ${a.channel}: ${a.title}`)
      : ['No alert was delivered.']),
    ...r.problems.map((p) => `Problem: ${p}`),
  ];
  if (r.ok)
    lines.push('Drill passed: the day was red, the safe state applied and the alert arrived.');
  else {
    const why = [
      ...(r.grade !== 'red' ? [`the day was ${r.grade}, not red`] : []),
      ...r.versions
        .filter((v) => !v.safeStateApplied)
        .map((v) => `${v.name} did not apply its safe state`),
      ...r.notDrilled.map((v) => `${v.name} does not record ${r.target}`),
      ...r.versions
        .filter((v) => v.delivered === 0)
        .map((v) => `no channel got ${v.name}'s alert (pnpm channel list --user <name>)`),
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
