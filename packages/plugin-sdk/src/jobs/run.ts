// A job that records a run (requirements 04, 05, 11, 12): bootstrap, daily, weekly or checks.
// Ingest, checks, then for the daily run the forward records, alerts, recompute and timestamp;
// the weekly run refetches the full history (revisions reported), recomputes and runs layer E,
// as `pnpm verify` (the checks job) does over the stored data. The run
// is complete only when every step finished for every item; an incomplete or failed run alerts
// the admins and sends no heartbeat. The CLI (`cli/jobs.ts`) adds the lock, backups and the
// heartbeat through the hooks.
import type { TradingDate } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  type Db,
  activeSymbols,
  finishRun,
  revisionsOfRun,
  seedSourceRoles,
  sourceRolesOf,
  startRun,
} from '@saku/db';
import { type LoadedPlugins, allInfos, savePluginInfos } from '../registry';
import { DATA_KIND, assignedOnly, dataKindOf, unassigned } from '../roles';
import type { Logger, PluginContext, PluginInfo } from '../types';
import {
  type AlertOptions,
  sendDataHealthAdmin,
  sendIntegrityFailed,
  sendJobFailure,
  sendParityFailed,
  sendRecomputeDiffers,
  sendRevisions,
  sendStrategyAlerts,
} from './alerts';
import { anchor } from './anchor';
import { forward, recompute } from './forward';
import {
  DAILY_OVERLAP,
  countsForRun,
  ingest,
  issuerAvailability,
  type SourceReport,
  supportedBy,
} from './ingest';
import { integrity } from './integrity';
import { parity } from './parity';
import { type IssuerAvailability, storeRunChecks, verify } from './verify';

export interface RunOptions {
  job: 'bootstrap' | 'daily' | 'weekly' | 'checks';
  target: TradingDate;
  sessions: Sessions;
  /** The cash series' business days; a run without it fails before any request. */
  seriesSessions: Sessions | undefined;
  now: Date;
  /**
   * The run's clock: the fetch time stored with values (`known_at` of a value without a
   * publication time) and the time the checks look from (values known by then count), read in
   * that order, so a value fetched by the run is known to its checks. Default: the system clock.
   */
  clock?: () => Date;
  log: Logger;
  context: (info: PluginInfo) => PluginContext;
  alerting: AlertOptions;
  tsa: { authorities: string[]; caFile?: string };
  /** The checked-out commit (named in recompute annotations). */
  code: string;
  /** The testfol parity cases (`plugins/test/testfol`); missing or empty: none run. */
  parityDir?: string;
  /** Before the weekly refetch rewrites stored history (the backup); a throw fails the run. */
  beforeRefetch?: () => Promise<void>;
  /** After the steps of a daily run, complete or not (the backup); a throw fails the run. */
  afterDaily?: () => Promise<void>;
  /** On a complete daily run (stamp, heartbeat); returns whether the heartbeat was sent. */
  onComplete?: () => Promise<boolean>;
}

export interface RunResult {
  runId: string;
  ok: boolean;
  error?: string;
}

export async function runJob(db: Db, plugins: LoadedPlugins, o: RunOptions): Promise<RunResult> {
  const { job, target, sessions, log, alerting, now } = o;
  const runId = await startRun(db, job, now, target);
  let ok = false;
  let error: string | undefined;
  let heartbeatSent = false;
  let health: string | undefined;
  try {
    const infos = allInfos(plugins);
    await savePluginInfos(db, infos, now);
    await seedSourceRoles(
      db,
      infos.flatMap((i) =>
        dataKindOf(i)
          ? [{ key: i.key, dataKind: dataKindOf(i)!, suggestedRole: i.suggestedRole }]
          : [],
      ),
    );
    if (plugins.missing.length > 0) log.info(`Not present: ${plugins.missing.join(', ')}`);
    // Roles are seeded once per data kind; a plug-in added later is unused (neither fetched nor
    // checked) until the admin assigns it (pnpm sources set).
    const roles = await sourceRolesOf(db);
    const idle = unassigned(infos, roles);
    if (idle.length > 0) {
      log.warn(`Loaded but not used (no role): ${idle.map((i) => i.key).join(', ')}`);
    }
    // An issuer source with a role but no loaded plug-in (the private package absent or failed
    // to load) fetches nothing; verify grades it unavailable (yellow) rather than staying silent.
    const absent = roles.filter(
      (r) =>
        r.dataKind === DATA_KIND.issuer &&
        !infos.some((i) => i.key === r.pluginKey && dataKindOf(i) === r.dataKind),
    );
    if (absent.length > 0) {
      log.warn(
        `Issuer source with a role but no plug-in loaded: ${absent.map((r) => r.pluginKey).join(', ')}`,
      );
    }
    const used = assignedOnly(plugins, roles);
    // The calendars sources declare (expected gaps); a declared one not loaded is warned about
    // and counts no day as closed.
    const loadedCalendars = plugins.calendars.flatMap((c) => c.calendars);
    const sourceCalendars: Record<string, Sessions> = {};
    for (const info of infos) {
      if (!info.calendar || (info.kind !== 'fx' && info.kind !== 'series')) continue;
      const calendar = loadedCalendars.find((c) => c.id === info.calendar);
      if (calendar) sourceCalendars[info.key] = new Sessions(calendar);
      else log.warn(`${info.key} declares calendar ${info.calendar}, which is not loaded`);
    }
    log.info(`${job} for ${target}`, { runId });

    // Before any request: the cash series is checked on this calendar.
    const checkedSessions =
      o.seriesSessions ??
      fail('No us-fed calendar plug-in is loaded (the cash series is checked on it).');
    let incomplete: string[] = [];
    const markIncomplete = (what: string) => {
      if (!incomplete.includes(what)) incomplete.push(what);
    };
    const failures: string[] = [];
    /** Series and FX values the sources now report differently (bar revisions are in the db). */
    let valueRevisions: Parameters<typeof sendRevisions>[1]['revisions'] = [];
    /** The current engine must reproduce the record, or each difference is annotated and told. */
    const recomputeAndTell = async () => {
      const r = await recompute(db, { runId, code: o.code });
      log.info(`Recomputed ${r.checked} recorded days: ${r.differences.length} new differences`);
      if (r.differences.length > 0) {
        log.warn('The engine decides recorded days differently', { differences: r.differences });
      }
      if (r.errors.length > 0) {
        log.warn('Recompute could not evaluate', { errors: r.errors });
        markIncomplete('recompute');
      }
      // Every annotated difference not yet told (also those found by `pnpm strategy recompute`).
      const told = await sendRecomputeDiffers(db, alerting);
      if (told.failed.length > 0) markIncomplete('alerts');
    };
    if (job === 'weekly') await o.beforeRefetch?.();
    // Layer D: what each issuer source supports; a fetching run adds what it did not deliver.
    const tickers = (await activeSymbols(db)).map((s) => s.ticker);
    let issuers: IssuerAvailability[] = used.issuers.map((source) => ({
      source: source.info.key,
      supported: supportedBy(source, tickers).supported,
      unavailable: [],
    }));
    if (job !== 'checks') {
      const reports = await ingest(db, used, {
        // The weekly run refetches the full history; changes go to the revision log.
        mode: job === 'daily' ? 'daily' : 'bootstrap',
        to: target,
        sessions,
        runId,
        log,
        context: o.context,
        ...(o.clock && { now: o.clock }),
      });
      for (const r of reports) {
        log.info(summary(r), {
          source: r.source,
          failed: r.failed,
          missing: r.missing,
          ...(Object.keys(r.revisedValues).length > 0 && { revisedValues: r.revisedValues }),
        });
      }
      valueRevisions = reports.flatMap((r) =>
        Object.entries(r.revisedValues).map(([item, dates]) => ({
          ticker: item,
          source: r.source,
          field: r.kind === 'fx' ? 'rate' : 'value',
          count: dates.length,
          from: dates.reduce((a, b) => (b < a ? b : a)),
          to: dates.reduce((a, b) => (b > a ? b : a)),
        })),
      );
      const failing = reports.filter((r) => r.stopped || r.failed.length > 0);
      incomplete = failing.filter(countsForRun).map((r) => r.source);
      // Best effort (issuer data): logged, graded yellow by verify (the fund's staleness and the
      // day's `issuer_unavailable`, which the admins are told), the run still complete.
      for (const r of failing.filter((x) => !countsForRun(x))) {
        log.warn(`${r.kind} ${r.source} incomplete (best effort; graded yellow, admins told)`, {
          failed: r.failed,
          ...(r.stopped && { stopped: r.stopped }),
        });
      }
      issuers = issuerAvailability(reports);
    }

    // Checks run whatever the sources did: a missing source is itself a finding.
    const checked = await verify(db, {
      runId,
      sessions,
      to: target,
      seriesSessions: checkedSessions,
      now: o.clock?.() ?? new Date(),
      issuers,
      sourceCalendars,
      ...(job === 'daily'
        ? { mode: 'daily' as const, from: sessions.before(target, DAILY_OVERLAP) }
        : { mode: 'full' as const }),
    });
    log.info(`Checks: ${checked.results} results`, {
      byStatus: checked.byStatus,
      stored: checked.stored,
    });
    health = checked.health;
    if (checked.toleranceInvalid) {
      log.warn('issuer_nav_tolerance does not parse: layer D observes premiums only (yellow)');
    }
    if (checked.toleranceUnmatched.length > 0) {
      log.warn(
        `issuer_nav_tolerance names no active symbol: ${checked.toleranceUnmatched.join(', ')}`,
      );
    }
    log.info(`Data health on ${target}: ${checked.health}`, { standIns: checked.standIns });
    for (const s of checked.standInsOff) {
      log.warn(
        `${s.ticker} ${s.date}: the stand-in was off the primary by ${(100 * s.deviation).toFixed(3)}%`,
      );
    }

    // Forward records (A2; nothing before forward_records_from is set, the A1 gate).
    if (job === 'daily') {
      const f = await forward(db, {
        runId,
        sessions,
        to: target,
        standInsOff: checked.standInsOff,
      });
      if (f.skipped) log.info(`Forward records: ${f.skipped}`);
      else {
        log.info(
          `Forward records: ${f.appended} new entries, ${f.safeStateDays} on the safe state`,
          {
            annotations: f.annotations,
          },
        );
        for (const t of f.today) log.info(`${t.version}: ${t.allocation} (${t.dataStatus})`, t);
        // Undelivered alerts are retried at the next check (sent ones are not repeated).
        const sent = await sendStrategyAlerts(db, { ...alerting, sessions });
        log.info(`Alerts: ${sent.sent} sent`, { failed: sent.failed });
        if (sent.failed.length > 0) markIncomplete('alerts');
        await recomputeAndTell();
        const a = await anchor(db, { date: target, ...o.tsa });
        if (a.status === 'anchored') log.info(`Chain heads timestamped by ${a.authority}`);
        else if (a.status === 'skipped') log.warn(`Chain heads not timestamped: ${a.reason}`);
        else {
          log.warn('Timestamping failed', { errors: a.errors });
          markIncomplete('timestamp');
        }
      }
      if (checked.health !== 'green') {
        const sent = await sendDataHealthAdmin(db, {
          ...alerting,
          health: checked.health,
          reasons: checked.reasons,
        });
        if (sent.failed.length > 0) markIncomplete('alerts');
      }
    }

    if (job === 'weekly') {
      // Layer G: the record against the corrected data, then what the full refetch changed.
      await recomputeAndTell();
      const revisions = [...(await revisionsOfRun(db, runId)), ...valueRevisions];
      log.info(`Revisions: ${revisions.reduce((n, r) => n + r.count, 0)}`, { revisions });
      if (revisions.length > 0) {
        const sent = await sendRevisions(db, { ...alerting, runId, revisions });
        if (sent.failed.length > 0) markIncomplete('alerts');
      }
      // A day the refetch turned non-green (told once per day, as the daily run tells it).
      if (checked.health !== 'green') {
        const sent = await sendDataHealthAdmin(db, {
          ...alerting,
          health: checked.health,
          reasons: checked.reasons,
        });
        if (sent.failed.length > 0) markIncomplete('alerts');
      }
    }
    if (job === 'weekly' || job === 'checks') {
      // Layer E on the stored data: core vs reference, incremental vs full, testfol parity.
      const results = await integrity(db, { to: target });
      await storeRunChecks(db, runId, results);
      for (const r of results) {
        log.info(`Layer E ${r.check}: ${r.status}`, { message: r.message });
        if (r.status === 'green') continue;
        failures.push(`${r.check} failed: ${r.message ?? ''}`);
        const sent = await sendIntegrityFailed(db, {
          ...alerting,
          check: r.check,
          versionId: r.versionId,
          detail: r.message ?? '',
        });
        if (sent.failed.length > 0) markIncomplete('alerts');
      }
      // External golden values: the testfol cases the owner exported (requirements 13).
      const cases = await parity(db, { dir: o.parityDir, to: target, sessions });
      if (cases.length === 0) log.info('testfol parity: no cases (none exported yet)');
      // Every case in full, green included (ours, testfol's, difference, window).
      await storeRunChecks(db, runId, cases, { all: true });
      for (const r of cases) {
        log.info(`Layer E ${r.check}: ${r.status}`, { message: r.message });
        if (r.status === 'green') continue;
        failures.push(`${r.check} failed: ${r.message ?? ''}`);
        const sent = await sendParityFailed(db, {
          ...alerting,
          caseName: r.caseName,
          detail: r.message ?? '',
        });
        if (sent.failed.length > 0) markIncomplete('alerts');
      }
    }

    // The run is done when every source answered for every item (issuer sources aside) and the
    // backup was made.
    if (job === 'daily') await o.afterDaily?.();
    ok = incomplete.length === 0 && failures.length === 0;
    if (!ok) {
      error = [
        ...(incomplete.length ? [`incomplete: ${incomplete.join(', ')}`] : []),
        ...failures,
      ].join('; ');
    }
    if (ok && job === 'daily') heartbeatSent = (await o.onComplete?.()) ?? false;
  } catch (e) {
    ok = false;
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    log.warn('Run failed', { error });
  } finally {
    try {
      await finishRun(db, runId, { ok, error, datesProcessed: [target], heartbeatSent });
    } catch (e) {
      // Still tell the admins below; the run row stays as started.
      ok = false;
      log.warn('Run not recorded', { error: String(e) });
    }
    if (!ok) {
      try {
        const sent = await sendJobFailure(db, {
          ...alerting,
          job,
          error: error ?? 'unknown',
          ...(health && { health }),
        });
        if (sent.failed.length) log.warn('Admin alert not delivered', { failed: sent.failed });
      } catch (e) {
        log.warn('Admin alert failed', { error: String(e) });
      }
    }
  }
  log.info(ok ? `${job} done` : `${job} not complete: ${error}`);
  return { runId, ok, ...(error && { error }) };
}

function summary(r: SourceReport): string {
  const parts = [`${r.kind} ${r.source}: ${r.ok.length} ok`];
  if (r.failed.length) parts.push(`${r.failed.length} failed`);
  if (r.stopped) parts.push(`stopped (${r.stopped})`);
  parts.push(`${r.inserted} new, ${r.revised} revised, ${r.readjustments} re-adjustments`);
  return parts.join(', ');
}

function fail(message: string): never {
  throw new Error(message);
}
