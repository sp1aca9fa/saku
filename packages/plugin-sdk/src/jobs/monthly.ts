// The monthly job (`pnpm monthly`; stage-a A3, system design `saku-monthly`, the 1st at 11:47):
// the audit report (jobs/audit.ts) of the latest month that can be audited (`monthReady`: over in
// the install's time zone and in UTC, its last trading day final and processed by a complete daily
// run),
// stored and sent in short form to the admin channels. The CLI adds the jobs lock and the
// heartbeat (`onComplete`).
//
// - A month is done once a monthly run stored its report and delivered its alert to every admin
//   channel (or the alert waits for the A1 gate): the run lists it in `dates_processed`. A done
//   month is not produced again (a rerun or the timer's retry days change nothing); `pnpm
//   audit-report` prints a fresh one at any time.
// - Catch-up: every month not done, from the month of the first recorded run (other than a
//   monthly one), at most CATCH_UP months back, oldest first, so a month missed (the machine off,
//   another job holding the lock, a timer in another zone than the install's) is still audited.
// - Stored in the activity log (action `audit.monthly`, actor `system`; detail: month, verdict,
//   whether clear, the full text, the run): an admin record that is only ever appended to, so no
//   table is added. A month produced again (its alert was not delivered) is stored again only
//   when its text differs from the latest stored one: kept beside the earlier, never over it.
// - Sent through `sendMonthlyAudit`: once per month and admin channel (`alerts_sent`), after the
//   A1 gate only, like every alert about data. A month done before the gate is not sent later,
//   and a month that ended before the gate (its last day before `forward_records_from`, or any
//   month while that is unset) is stored and done without an alert, so a catch-up after the gate
//   never sends pre-gate months.
// - Complete when every due month is done; then the heartbeat. Otherwise the run failed, and the
//   admins are told (a failed run, allowed before the gate).
// - A latest month held back only by the clock (not over yet, its last trading day not final yet)
//   is the normal wait: the run completes and pings. One held back because no complete daily run
//   has processed its last trading day (`monthReady` kind `daily`) while this run did no month
//   completes without the heartbeat and logs the reason as a warning, so the healthcheck's grace
//   period alerts when the daily job stays stuck.
import type { Sessions } from '@saku/data';
import { type Db, finishRun, getSetting, schema, startRun } from '@saku/db';
import { languages, translator } from '@saku/content';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Logger } from '../types';
import { type AlertOptions, sendJobFailure, sendMonthlyAudit } from './alerts';
import {
  type AuditOptions,
  addMonths,
  auditIssues,
  auditParts,
  auditReport,
  auditText,
  auditVerdict,
  localTime,
  monthOf,
  type NotReady,
  monthReady,
  monthWindow,
  previousMonth,
} from './audit';

/** Earlier months caught up at most, counted back from the month audited. */
export const CATCH_UP = 12;
export const AUDIT_ACTION = 'audit.monthly';

export interface MonthlyOptions extends Omit<AuditOptions, 'month'> {
  finalAfter: string;
  /** The alert options but the date (each month's alert is keyed by its last day). */
  alerting: Omit<AlertOptions, 'date'>;
  log: Logger;
  /** On a complete run (the heartbeat); returns whether it was sent. */
  onComplete?: () => Promise<boolean>;
}

export interface MonthlyResult {
  runId: string;
  ok: boolean;
  months: string[];
  error?: string;
}

export interface StoredAudit {
  id: number;
  at: string;
  month: string;
  verdict: string;
  clear: boolean;
  text: string;
  runId: string | null;
}

/** Every stored report, oldest first (rows whose detail does not read are left out). */
export async function storedAudits(db: Db): Promise<StoredAudit[]> {
  const rows = await db
    .select()
    .from(schema.activityLog)
    .where(eq(schema.activityLog.action, AUDIT_ACTION))
    .orderBy(asc(schema.activityLog.id));
  return rows.flatMap((r) => {
    const d = r.detail as Partial<StoredAudit> | null;
    if (!d || typeof d.month !== 'string' || typeof d.text !== 'string') return [];
    return [
      {
        id: r.id,
        at: r.at,
        month: d.month,
        verdict: String(d.verdict ?? ''),
        clear: d.clear === true,
        text: d.text,
        runId: typeof d.runId === 'string' ? d.runId : null,
      },
    ];
  });
}

/**
 * The months a finished monthly run did (its `dates_processed`, `YYYY-MM`). A run that never
 * finished is left out: its `dates_processed` is the target it started for, not a month done.
 */
async function doneMonths(db: Db): Promise<Set<string>> {
  const runs = await db
    .select({ dates: schema.jobRuns.datesProcessed })
    .from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.jobType, 'monthly'), isNotNull(schema.jobRuns.finishedAt)));
  return new Set(runs.flatMap((r) => (Array.isArray(r.dates) ? r.dates : [])));
}

/**
 * The months to audit now, oldest first: the latest ready month and each earlier one back to the
 * first recorded run's month (at most CATCH_UP back), each unless done. `why`: why the latest
 * month is not ready yet (the one before is then the latest); `waiting`: its kind (`daily` also
 * when the month before is not ready for want of a daily run).
 */
export async function monthsDue(
  db: Db,
  o: { now: Date; timeZone: string; sessions: Sessions; finalAfter: string },
): Promise<{ months: string[]; why?: string; waiting?: NotReady['kind'] }> {
  let latest = previousMonth(o.now, o.timeZone);
  const ready = await monthReady(db, latest, o);
  let why: string | undefined;
  let waiting: NotReady['kind'] | undefined;
  if (!ready.ok) {
    why = ready.why;
    waiting = ready.kind;
    latest = addMonths(latest, -1);
    const before = await monthReady(db, latest, o);
    if (!before.ok) {
      if (before.kind === 'daily' && waiting !== 'daily') {
        why = `${why} ${before.why}`;
        waiting = 'daily';
      }
      return { months: [], why, waiting };
    }
  }
  const firstRun = (await db.select().from(schema.jobRuns))
    .filter((r) => r.jobType !== 'monthly' && Number.isFinite(Date.parse(r.startedAt)))
    .map((r) => r.startedAt)
    .sort()[0];
  const done = await doneMonths(db);
  const months: string[] = [];
  if (firstRun !== undefined) {
    const first = monthOf(new Date(firstRun), o.timeZone);
    for (let k = CATCH_UP; k >= 1; k--) {
      const m = addMonths(latest, -k);
      if (m >= first && !done.has(m)) months.push(m);
    }
  }
  if (!done.has(latest)) months.push(latest);
  return { months, ...(why && { why }), ...(waiting && { waiting }) };
}

export async function runMonthly(db: Db, o: MonthlyOptions): Promise<MonthlyResult> {
  const { log } = o;
  const due = await monthsDue(db, o);
  // Held back by the daily run (not by the clock): the daily job may be stuck.
  const stuck = due.waiting === 'daily';
  if (due.why) {
    if (stuck) log.warn(due.why);
    else log.info(due.why);
  }
  const runId = await startRun(db, 'monthly', o.now, due.months.at(-1));
  const failures: string[] = [];
  const done: string[] = [];
  try {
    const primary = (await getSetting(db, 'primary_language')) ?? 'en';
    const t = translator(languages().includes(primary) ? primary : 'en');
    const stored = await storedAudits(db);
    const gate = await getSetting(db, 'forward_records_from');
    for (const month of due.months) {
      try {
        const report = await auditReport(db, { ...o, month });
        const text = auditText(t, report);
        const verdict = auditVerdict(report);
        const latest = stored.filter((a) => a.month === month).at(-1);
        if (latest?.text !== text) {
          await db.insert(schema.activityLog).values({
            at: o.now.toISOString(),
            actor: 'system',
            action: AUDIT_ACTION,
            detail: { month, verdict, clear: auditIssues(report).length === 0, text, runId },
          });
        }
        log.info(`Audit ${month}: ${verdict}`);
        const lastDay = monthWindow(month, o.timeZone).lastDay;
        if (gate === undefined || lastDay < gate) {
          // Before the A1 gate: stored and done, never sent (not now, not after the gate).
          done.push(month);
          continue;
        }
        const sent = await sendMonthlyAudit(db, {
          ...o.alerting,
          date: lastDay,
          month,
          lines: (tr) => auditParts(tr, report),
        });
        for (const f of sent.failed) failures.push(`${month}: alert not delivered: ${f}`);
        // Done only when every admin channel has it (or it waits for the gate).
        if (sent.failed.length === 0) done.push(month);
      } catch (e) {
        failures.push(`${month}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  }
  const ok = failures.length === 0;
  let heartbeatSent = false;
  // No heartbeat when this run did no month and the latest waits for a daily run: the
  // healthcheck's grace period then alerts if the daily job stays stuck.
  const held = stuck && done.length === 0;
  if (ok && !held) heartbeatSent = (await o.onComplete?.()) ?? false;
  const error = ok ? undefined : failures.join('\n');
  await finishRun(db, runId, {
    ok,
    datesProcessed: done,
    ...(error && { error }),
    heartbeatSent,
  });
  if (!ok) {
    log.warn('monthly not complete', { failures });
    try {
      const sent = await sendJobFailure(db, {
        ...o.alerting,
        date: localTime(o.now.toISOString(), o.timeZone).slice(0, 10),
        job: 'monthly',
        failures,
      });
      if (sent.failed.length) log.warn('Admin alert not delivered', { failed: sent.failed });
    } catch (e) {
      log.warn('Admin alert failed', { error: String(e) });
    }
  } else if (held) {
    log.warn('monthly done without the heartbeat: the latest month waits for a complete daily run');
  } else log.info(`monthly done: ${done.join(', ') || 'no month due'}`);
  return { runId, ok, months: done, ...(error && { error }) };
}
