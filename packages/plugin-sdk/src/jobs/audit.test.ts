// The monthly audit report (stage-a A3, spec 2026-11-01 monthly-audit), on synthetic data: days by
// grade (green, yellow, red, not graded), revisions, quota rows, forward records (chain ok and
// broken, missing days), failed and unfinished runs, stand-ins; the month in the install's time
// zone. No network: the timestamp-token check is a stub.
import type { HealthStatus } from '@saku/core';
import { translator } from '@saku/content';
import { Sessions } from '@saku/data';
import {
  type Db,
  appendForward,
  createUser,
  finishRun,
  pruneProviderUsage,
  registerVersion,
  schema,
  setSetting,
  sha256,
  startRun,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  auditIssues,
  auditParts,
  auditReport,
  auditText,
  auditVerdict,
  declaredLimits,
  isMonth,
  monthReady,
  monthWindow,
  previousMonth,
  relativeChange,
} from './audit';
import { fitMessage } from './alerts';
import { verifyChains } from './chain-verify';
import type { ProviderLimits } from '../types';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const TZ = 'Asia/Tokyo';
const MONTH = '2026-03';
const MARCH = sessions.between('2026-03-01', '2026-03-31');
// April 1, 12:00 in Tokyo: March is over there and its last session (March 31) is final in New
// York (23:00 there); the ledger still holds every day of March (31 days back: March 1).
const NOW = new Date('2026-04-01T03:00:00.000Z');
const t = translator('en');
const token = async () => true;
const strategy = {
  name: 'Trend',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  execution: 'next_open',
  signals: [],
  allocations: [{ name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] }],
};

const options = (o: { now?: Date } = {}) => ({
  month: MONTH,
  timeZone: TZ,
  sessions,
  now: o.now ?? NOW,
  limits: new Map<string, ProviderLimits | undefined>(),
  caFile: '/none',
  token,
});

/** A full-history run over March: every session's overall row (green unless given), AAA covered. */
async function graded(
  db: Db,
  aaa: number,
  o: { skip?: string[]; overall?: Record<string, [HealthStatus, string[]]> } = {},
) {
  const run = await startRun(db, 'checks', new Date('2026-04-01T00:00:00.000Z'));
  await db.insert(schema.bars).values({ symbolId: aaa, date: MARCH[0]!, close: 1, source: 'p' });
  await db
    .insert(schema.healthCoverage)
    .values({ runId: run, symbolId: aaa, fromDate: MARCH[0]!, toDate: MARCH.at(-1)! });
  for (const date of MARCH) {
    if (o.skip?.includes(date)) continue;
    const [status, reasons] = o.overall?.[date] ?? ['green', []];
    await db
      .insert(schema.dataHealth)
      .values({ runId: run, date, symbolId: null, status, reasons });
  }
  await finishRun(db, run, { ok: true, datesProcessed: [MARCH.at(-1)!] });
  return run;
}

/** A complete daily run for `target` (started after March in Tokyo, so not one of its runs). */
async function dailyDone(db: Db, target: string) {
  const id = await startRun(db, 'daily', new Date('2026-04-01T00:30:00.000Z'), target);
  await finishRun(db, id, { ok: true, datesProcessed: [target] });
}

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
  const aaa = (await symbolId(db, 'AAA'))!;
  return { db, aaa };
}

describe('months', () => {
  it('the default month is the previous one in the install time zone, not New York', () => {
    // November 1, 00:30 in Tokyo is still October 31 in New York.
    const now = new Date('2026-10-31T15:30:00.000Z');
    expect(previousMonth(now, 'Asia/Tokyo')).toBe('2026-10');
    expect(previousMonth(now, 'America/New_York')).toBe('2026-09');
    expect(previousMonth(new Date('2026-01-10T00:00:00Z'), 'UTC')).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
  });

  it('the window runs from midnight to midnight in the time zone', () => {
    expect(monthWindow('2026-03', TZ)).toEqual({
      month: '2026-03',
      from: '2026-02-28T15:00:00.000Z',
      to: '2026-03-31T15:00:00.000Z',
      firstDay: '2026-03-01',
      lastDay: '2026-03-31',
    });
    expect(monthWindow('2028-02', 'UTC').lastDay).toBe('2028-02-29');
  });

  it('a month is ready once over in the zone and its last trading day is final', async () => {
    const { db } = await setup();
    await dailyDone(db, '2026-03-31');
    const o = { timeZone: TZ, sessions, finalAfter: '20:00' };
    expect(await monthReady(db, MONTH, { ...o, now: NOW })).toEqual({ ok: true });
    // March 31, 23:00 UTC: April 1, 08:00 in Tokyo (March is over there), but 19:00 in New York,
    // so March 31's data is not final yet.
    const early = await monthReady(db, MONTH, { ...o, now: new Date('2026-03-31T23:00:00.000Z') });
    expect(early.ok).toBe(false);
    expect(!early.ok && early.why).toMatch(/2026-03-31.*not final until 20:00 New York/);
    const notOver = await monthReady(db, MONTH, {
      ...o,
      now: new Date('2026-03-31T14:59:00.000Z'),
    });
    expect(!notOver.ok && notOver.why).toMatch(/not over yet in Asia\/Tokyo/);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-3')).toBe(false);
    expect(isMonth('2026-03')).toBe(true);
  });

  it('a month is not ready until a complete daily run has processed its last trading day', async () => {
    const { db } = await setup();
    const o = { now: NOW, timeZone: TZ, sessions, finalAfter: '20:00' };
    // No complete daily run ever: not ready (fails closed).
    const none = await monthReady(db, MONTH, o);
    expect(!none.ok && none.why).toMatch(/No complete daily run has processed 2026-03-31.*none/);
    // The latest complete daily run is behind (March 30), and a failed one for March 31 does not
    // count: the timer's retry days audit the month later.
    await dailyDone(db, '2026-03-30');
    const failed = await startRun(db, 'daily', new Date('2026-04-01T01:00:00.000Z'), '2026-03-31');
    await finishRun(db, failed, { ok: false, datesProcessed: ['2026-03-31'], error: 'down' });
    const behind = await monthReady(db, MONTH, o);
    expect(!behind.ok && behind.why).toMatch(/2026-03-31.*latest: 2026-03-30/);
    await dailyDone(db, '2026-03-31');
    expect(await monthReady(db, MONTH, o)).toEqual({ ok: true });
    // A month the calendar does not cover needs no daily run (its days read "not known").
    expect(await monthReady(db, '2024-06', o)).toEqual({ ok: true });
  });
});

describe('the audit report', () => {
  it('a month with every kind of finding: each section and the verdict say it', async () => {
    const { db, aaa } = await setup();
    // 1. Days: March 4 yellow, March 5 red (AAA), March 10 graded by nobody.
    const run = await graded(db, aaa, {
      skip: ['2026-03-10'],
      overall: { '2026-03-04': ['yellow', ['single_source']], '2026-03-05': ['red', ['AAA']] },
    });
    await db.insert(schema.dataHealth).values({
      runId: run,
      date: '2026-03-05',
      symbolId: aaa,
      status: 'red',
      reasons: ['B.close_match@s2'],
    });

    // 2. Revisions: the month starts at 2026-02-28T15:00Z (Tokyo midnight).
    const revision = (
      field: string,
      oldValue: number | null,
      newValue: number | null,
      at: string,
    ) =>
      db.insert(schema.barRevisions).values({
        symbolId: aaa,
        date: '2026-03-02',
        source: 'p',
        field: field as 'close',
        oldValue,
        newValue,
        detectedAt: at,
      });
    await revision('close', 100, 101, '2026-03-05T00:00:00.000Z');
    await revision('close', 50, 55, '2026-03-06T00:00:00.000Z');
    await revision('div_cash', 0, 0.5, '2026-03-20T00:00:00.000Z');
    await revision('volume', 1000, 800, '2026-02-28T15:00:00.000Z');
    await revision('close', 1, 2, '2026-02-28T14:59:59.999Z'); // February in Tokyo
    await revision('close', 1, 2, '2026-03-31T15:00:00.000Z'); // April in Tokyo
    await db.insert(schema.readjustments).values({
      symbolId: aaa,
      source: 'p',
      fromDate: '2010-01-04',
      toDate: '2026-03-13',
      factor: 0.98,
      detectedAt: '2026-03-15T00:00:00.000Z',
    });

    // 3. Quota: alpha's peak day is 90% of its daily limit; beta has no loaded plug-in.
    const day = (provider: string, windowStart: string, requestCount: number, symbols: string[]) =>
      db
        .insert(schema.providerUsage)
        .values({ provider, windowType: 'day', windowStart, requestCount, symbols });
    await day('alpha', '2026-03-02', 100, ['AAA']);
    await day('alpha', '2026-03-03', 450, ['AAA', 'BBB']);
    await day('alpha', '2026-02-28', 999, ['CCC']);
    await day('beta', '2026-03-04', 5, []);
    const limits = declaredLimits([
      {
        key: 'alpha-bars',
        kind: 'bars',
        provider: 'alpha',
        limits: { perDay: 500, symbolsPerMonth: 10 },
      },
      {
        key: 'alpha-fx',
        kind: 'fx',
        provider: 'alpha',
        limits: { perDay: 500, symbolsPerMonth: 10 },
      },
      { key: 'gamma', kind: 'series', limits: { perDay: 100 } },
      { key: 'xnys', kind: 'calendar' },
    ]);

    // 4. Forward records: entries on every March session but March 16, one a safe-state day.
    const owner = await createUser(db, {
      username: 'ada',
      passwordHash: 'x',
      totpSecretEnc: 'x',
      totpLastStep: 1,
      backupCodeHashes: ['a'],
      isAdmin: true,
    });
    const version = await registerVersion(db, {
      ownerId: owner,
      name: 'Trend',
      strategy,
      at: new Date('2026-02-01T00:00:00.000Z'),
    });
    for (const date of ['2026-02-27', ...MARCH.filter((d) => d !== '2026-03-16')]) {
      const red = date === '2026-03-05';
      await appendForward(
        db,
        version,
        {
          date,
          allocation: red ? 'Safe state' : 'Calm',
          holdings: [{ ticker: red ? 'AAA' : 'CASH_USD', weight: 100 }],
          safeStateApplied: red,
          dataStatus: red ? 'red' : date === '2026-03-04' ? 'yellow' : 'green',
          equity: 1,
          detail: { reasons: [] },
        },
        null,
      );
    }
    // A version registered after March is not part of it.
    await registerVersion(db, {
      ownerId: owner,
      name: 'Later',
      strategy,
      at: new Date('2026-04-01T00:00:00.000Z'),
    });
    for (const [kind, createdAt] of [
      ['recomputed', '2026-03-10T00:00:00.000Z'],
      ['recomputed', '2026-03-11T00:00:00.000Z'],
      ['stand_in_corrected', '2026-03-12T00:00:00.000Z'],
      ['recomputed', '2026-04-10T00:00:00.000Z'],
    ] as const) {
      await db
        .insert(schema.forwardAnnotations)
        .values({ versionId: version.id, date: '2026-03-02', kind, detail: {}, createdAt });
    }

    // 5. Runs started in March: one failed, one never finished, one fine.
    const failed = await startRun(db, 'daily', new Date('2026-03-10T12:00:00.000Z'), '2026-03-09');
    await finishRun(db, failed, {
      ok: false,
      datesProcessed: ['2026-03-09'],
      error: 'incomplete: source s2 failed\nsecond line',
    });
    await startRun(db, 'daily', new Date('2026-03-11T12:00:00.000Z'), '2026-03-10');
    const fine = await startRun(db, 'daily', new Date('2026-03-12T12:00:00.000Z'), '2026-03-11');
    await finishRun(db, fine, { ok: true, datesProcessed: ['2026-03-11'] });

    // 6. Stand-ins: resolved, open, closed (still the canonical bar), reopened (bar changed since).
    const standIn = (date: string, over: Partial<typeof schema.standIns.$inferInsert> = {}) =>
      db.insert(schema.standIns).values({
        symbolId: aaa,
        date,
        source: 's',
        close: 100,
        band: 0.001,
        basis: 'index',
        ...over,
      });
    await standIn('2026-03-06', { resolvedAt: '2026-03-09T21:00:00.000Z', deviation: 0.001 });
    await standIn('2026-03-09');
    await standIn('2026-03-12');
    await standIn('2026-03-13');
    await standIn('2026-02-27'); // February: not counted
    for (const [date, close] of [
      ['2026-03-12', 100],
      ['2026-03-13', 101],
    ] as const) {
      await db
        .insert(schema.bars)
        .values({ symbolId: aaa, date, close, source: 's', standIn: true });
      await db.insert(schema.standInCloses).values({
        symbolId: aaa,
        date,
        source: 's',
        close: 100,
        band: 0.001,
        basis: 'index',
        closedBy: owner,
        reason: 'primary will not deliver',
        closedAt: '2026-03-20T00:00:00.000Z',
      });
    }

    const r = await auditReport(db, { ...options(), limits });

    expect(r.days.known && r.days.counts).toEqual({ green: 19, yellow: 1, red: 1, notGraded: 1 });
    expect(r.revisions.count).toBe(4);
    expect(r.revisions.groups).toEqual([{ ticker: 'AAA', source: 'p', count: 4 }]);
    expect(r.revisions.largest.map((l) => [l.field, l.change])).toEqual([
      ['div_cash', null],
      ['volume', expect.closeTo(-0.2, 12)],
      ['close', expect.closeTo(0.1, 12)],
      ['close', expect.closeTo(0.01, 12)],
    ]);
    expect(r.revisions.readjustments).toHaveLength(1);
    expect(r.quota.complete).toBe(true);
    expect(
      r.quota.providers.map((p) => [
        p.provider,
        p.requests,
        p.peak?.requests,
        p.symbols,
        p.known,
        p.over,
      ]),
    ).toEqual([
      ['alpha', 550, 450, 2, true, ['per day']],
      ['beta', 5, 5, 0, false, []],
      ['gamma', 0, undefined, 0, true, []],
    ]);
    expect(r.forward.chain.versions.every((v) => v.problems.length === 0)).toBe(true);
    expect(r.forward.versions).toEqual([
      {
        id: version.id,
        name: 'Trend',
        entries: 21,
        safe: 1,
        statuses: { green: 19, yellow: 1, red: 1 },
        missing: ['2026-03-16'],
      },
    ]);
    expect(r.forward.annotations).toEqual([
      { kind: 'recomputed', count: 2 },
      { kind: 'stand_in_corrected', count: 1 },
    ]);
    expect(r.runs.groups).toEqual([
      { jobType: 'daily', status: 'failed', count: 1 },
      { jobType: 'daily', status: 'running', count: 1 },
      { jobType: 'daily', status: 'success', count: 1 },
    ]);
    expect(r.runs.problems.map((p) => [p.status, p.error])).toEqual([
      ['failed', 'incomplete: source s2 failed'],
      ['running', undefined],
    ]);
    expect(r.standIns).toEqual({
      count: 4,
      resolved: 1,
      closed: 1,
      open: 1,
      reopened: 1,
      unsettled: [
        { ticker: 'AAA', date: '2026-03-09', reopened: false },
        { ticker: 'AAA', date: '2026-03-13', reopened: true },
      ],
    });

    const verdict =
      'Verdict: needs attention (1 trading day red, 1 trading day yellow, 1 trading day not ' +
      'graded, 1 forward record day missing, 2 runs failed or unfinished, quota limits not known ' +
      'for 1 provider, 1 provider above 80% of a limit, 2 stand-ins open).';
    expect(auditVerdict(r)).toBe(verdict);
    const text = auditText(t, r).split('\n');
    expect(text.at(-1)).toBe(verdict);
    expect(text).toContain('Trading days: 22. Green 19, yellow 1, red 1, not graded 1.');
    expect(text).toContain('2026-03-10  not graded  (checks run for 2026-03-31)');
    expect(text).toContain('  AAA  red: closes differ between sources (s2)');
    expect(text).toContain('  AAA 2026-03-02 div_cash@p: 0 -> 0.5 (from 0)');
    expect(text).toContain('  AAA 2026-03-02 volume@p: 1000 -> 800 (-20.0%)');
    expect(text).toContain(
      '  alpha: 550 requests on 2 days; peak 2026-03-03 with 450 (90.0% of 500 a day); 2 symbols (20.0% of 10 a month); ABOVE 80% of the per day limit.',
    );
    expect(text).toContain(
      '  beta: 5 requests on 1 day; peak 2026-03-04 with 5; 0 symbols; limits not known (no loaded plug-in uses this provider id).',
    );
    expect(text).toContain(
      '  2026-03-10 21:00 daily for 2026-03-09: failed: incomplete: source s2 failed',
    );
    expect(text).toContain(
      '  2026-03-11 21:00 daily for 2026-03-10: never finished (interrupted, or still running)',
    );
    expect(text).toContain('4: 1 resolved, 1 closed, 1 open, 1 reopened.');
    expect(text).toContain('  AAA 2026-03-13 (reopened)');

    // The alert's short form fits a small channel whole, in both install languages.
    for (const language of ['en', 'ja']) {
      const fitted = fitMessage(auditParts(translator(language), r), 2000);
      expect(fitted.fits).toBe(true);
      expect(fitted.text).toContain('pnpm audit-report --month 2026-03');
    }
    expect(fitMessage(auditParts(t, r), 2000).text.split('\n').slice(0, 3)).toEqual([
      'Saku: audit report for 2026-03',
      'Verdict: needs attention.',
      'Trading days: 19 green, 1 yellow, 1 red, 1 not graded.',
    ]);
  });

  it('a clean month is all clear; nothing graded is never green', async () => {
    const { db, aaa } = await setup();
    const empty = await auditReport(db, options());
    expect(empty.days.known && empty.days.counts).toEqual({
      green: 0,
      yellow: 0,
      red: 0,
      notGraded: 22,
    });
    expect(auditVerdict(empty)).toBe('Verdict: needs attention (22 trading days not graded).');

    await graded(db, aaa);
    const r = await auditReport(db, options());
    expect(auditIssues(r)).toEqual([]);
    expect(auditVerdict(r)).toBe('Verdict: all clear.');
    const text = auditText(t, r);
    expect(text).toContain('No provider declares limits or sent requests.');
    expect(text).toContain('No run started in the month.');
    expect(fitMessage(auditParts(t, r), 2000).text).toContain('Verdict: all clear.');
  });

  it('a broken chain or anchor is reported, and the verdict is not clear', async () => {
    const { db, aaa } = await setup();
    await graded(db, aaa);
    const version = await registerVersion(db, {
      ownerId: null,
      name: 'Library',
      strategy,
      at: new Date('2026-02-01T00:00:00.000Z'),
    });
    const entry = await appendForward(
      db,
      version,
      {
        date: '2026-03-02',
        allocation: 'Calm',
        holdings: [{ ticker: 'CASH_USD', weight: 100 }],
        safeStateApplied: false,
        dataStatus: 'green',
        equity: 1,
        detail: { reasons: [] },
      },
      null,
    );
    // Missing days are counted from the first entry; fill them so the chain is the only finding.
    for (const date of MARCH.slice(1)) {
      await appendForward(
        db,
        version,
        {
          date,
          allocation: 'Calm',
          holdings: [{ ticker: 'CASH_USD', weight: 100 }],
          safeStateApplied: false,
          dataStatus: 'green',
          equity: 1,
          detail: { reasons: [] },
        },
        null,
      );
    }
    const ok = await auditReport(db, options());
    expect(auditVerdict(ok)).toBe('Verdict: all clear.');
    expect(auditText(t, ok)).toContain('Chain verification now: 1 version, 0 anchors; all ok.');

    // An entry whose stored text does not hash to its hash (appended after the last one).
    await db.insert(schema.forwardEntries).values({
      versionId: version.id,
      date: '2026-04-01',
      payload: entry.payload,
      allocation: 'Calm',
      holdings: [],
      safeStateApplied: false,
      dataStatus: 'green',
      equity: 1,
      prevHash: 'not-the-previous-hash',
      hash: 'forged',
    });
    await db.insert(schema.chainAnchors).values({
      chainHeadHash: 'not-the-hash',
      heads: JSON.stringify({ date: '2026-03-31', heads: { [version.id]: 'unknown-head' } }),
      anchoredAt: '2026-04-01T00:00:00.000Z',
      method: 'rfc3161',
      authority: 'tsa.example',
    });
    const broken = await auditReport(db, options());
    expect(broken.forward.chain.versions[0]!.problems).toEqual(
      expect.arrayContaining(['2026-04-01: hash', '2026-04-01: link']),
    );
    expect(broken.forward.chain.anchors[0]!.problems).toEqual([
      'hash',
      `head of ${version.id} not in the record`,
      'timestamp token',
    ]);
    expect(auditVerdict(broken)).toBe(
      'Verdict: needs attention (forward record chain problems in 2 items).',
    );
    const text = auditText(t, broken);
    expect(text).toContain('Chain verification now: 1 version, 1 anchor; 2 with problems:');
    expect(text).toContain(
      `  Anchor 2026-03-31 (tsa.example): hash; head of ${version.id} not in the record; timestamp token`,
    );
    expect(fitMessage(auditParts(t, broken), 2000).text).toContain(
      'chain verification found 2 problems',
    );
  });

  it('quota days the ledger may have pruned make the counts a lower bound, never complete', async () => {
    const { db, aaa } = await setup();
    await graded(db, aaa);
    await db.insert(schema.providerUsage).values({
      provider: 'alpha',
      windowType: 'day',
      windowStart: '2026-03-20',
      requestCount: 3,
      symbols: [],
    });
    const limits = declaredLimits([{ key: 'alpha', kind: 'bars', limits: { perDay: 100 } }]);
    // April 15: the ledger surely keeps days from March 15 only.
    const r = await auditReport(db, {
      ...options({ now: new Date('2026-04-15T03:00:00.000Z') }),
      limits,
    });
    expect(r.quota).toMatchObject({ complete: false, keptFrom: '2026-03-15' });
    expect(auditVerdict(r)).toBe('Verdict: needs attention (quota use not fully known).');
    const text = auditText(t, r);
    expect(text).toContain(
      '  alpha: at least 3 requests on 1 day; peak 2026-03-20 with 3 (3.0% of 100 a day); at least 0 symbols.',
    );
    expect(fitMessage(auditParts(t, r), 2000).text).toContain('the counts are incomplete');
  });

  it('quota of a month whose last UTC day is still going is partial, never complete', async () => {
    const { db } = await setup();
    await db.insert(schema.providerUsage).values({
      provider: 'alpha',
      windowType: 'day',
      windowStart: '2026-10-30',
      requestCount: 7,
      symbols: [],
    });
    const limits = declaredLimits([{ key: 'alpha', kind: 'bars', limits: { perDay: 100 } }]);
    // November 1, 00:30 in Tokyo: October is over there, but October 31 runs in UTC until 09:00.
    const r = await auditReport(db, {
      ...options({ now: new Date('2026-10-31T15:30:00.000Z') }),
      month: '2026-10',
      limits,
    });
    expect(r.quota).toMatchObject({ complete: false, utcOver: false, keptFrom: '2026-09-30' });
    expect(auditIssues(r)).toContain('quota use not fully known');
    const text = auditText(t, r);
    expect(text).toContain(
      "The month's last UTC day is not over yet (until 2026-11-01 09:00 Asia/Tokyo), so the " +
        'counts below are partial: at least these.',
    );
    expect(text).not.toContain('The ledger keeps days from');
    expect(text).toContain('  alpha: at least 7 requests on 1 day;');
    expect(fitMessage(auditParts(t, r), 2000).text).toContain('the counts are incomplete');
  });

  it('quota at the timer (Nov 1 11:47 Tokyo) after the real prune: October 1 still counted, complete', async () => {
    const { db } = await setup();
    const now = new Date('2026-11-01T02:47:00.000Z');
    for (const [windowStart, requestCount] of [
      ['2026-09-30', 50],
      ['2026-10-01', 3],
      ['2026-10-31', 4],
    ] as const) {
      await db
        .insert(schema.providerUsage)
        .values({ provider: 'alpha', windowType: 'day', windowStart, requestCount, symbols: [] });
    }
    // The ledger prune each run does: day rows before 31 days back (October 1) go.
    await pruneProviderUsage(db, now.getTime());
    const days = await db.select().from(schema.providerUsage);
    expect(days.map((d) => d.windowStart).sort()).toEqual(['2026-10-01', '2026-10-31']);
    const limits = declaredLimits([{ key: 'alpha', kind: 'bars', limits: { perDay: 100 } }]);
    const r = await auditReport(db, { ...options({ now }), month: '2026-10', limits });
    expect(r.quota).toMatchObject({ complete: true, utcOver: true, keptFrom: '2026-10-01' });
    expect(r.quota.providers).toMatchObject([{ provider: 'alpha', requests: 7, days: 2 }]);
    expect(auditIssues(r)).not.toContain('quota use not fully known');
    expect(auditText(t, r)).toContain('  alpha: 7 requests on 2 days;');
  });

  it('after the gate, a version without any entry has every day it should record missing', async () => {
    const { db, aaa } = await setup();
    await graded(db, aaa);
    await setSetting(db, 'forward_records_from', '2026-03-02');
    // Registered March 9 before the close (16:00 New York, 20:00 UTC): records March 9 on.
    const version = await registerVersion(db, {
      ownerId: null,
      name: 'Silent',
      strategy,
      at: new Date('2026-03-09T12:00:00.000Z'),
    });
    // Registered after March: not part of it.
    await registerVersion(db, {
      ownerId: null,
      name: 'Later',
      strategy,
      at: new Date('2026-04-01T00:00:00.000Z'),
    });
    const r = await auditReport(db, options());
    const expected = MARCH.filter((d) => d >= '2026-03-09');
    expect(expected).toHaveLength(17);
    expect(r.forward.versions).toEqual([
      {
        id: version.id,
        name: 'Silent',
        entries: 0,
        safe: 0,
        statuses: { green: 0, yellow: 0, red: 0 },
        missing: expected,
      },
    ]);
    expect(auditVerdict(r)).toBe('Verdict: needs attention (17 forward record days missing).');
    expect(auditText(t, r)).toContain(
      `  Silent (${version.id}): 0 entries (green 0, yellow 0, red 0), 0 safe-state days, MISSING 17 (2026-03-09, 2026-03-10,`,
    );

    // The month before the gate and registration has nothing due: the version is not listed.
    const february = await auditReport(db, {
      ...options(),
      month: '2026-02',
    });
    expect(february.forward.versions).toEqual([]);
  });

  it('chain verification: an unreadable entry and anchor heads that are null are problems, never a crash', async () => {
    const { db } = await setup();
    const version = await registerVersion(db, {
      ownerId: null,
      name: 'Library',
      strategy,
      at: new Date('2026-02-01T00:00:00.000Z'),
    });
    await db.insert(schema.forwardEntries).values({
      versionId: version.id,
      date: '2026-03-02',
      payload: 'not json',
      allocation: 'Calm',
      holdings: [],
      safeStateApplied: false,
      dataStatus: 'green',
      equity: 1,
      prevHash: version.hash,
      hash: sha256('not json'),
    });
    const anchor = (heads: string, date: string) =>
      db.insert(schema.chainAnchors).values({
        chainHeadHash: sha256(heads),
        heads,
        anchoredAt: `${date}T00:00:00.000Z`,
        method: 'rfc3161',
        authority: 'tsa.example',
        proof: new Uint8Array([1]),
      });
    await anchor('null', '2026-03-03');
    await anchor('{"date":"2026-03-04","heads":null}', '2026-03-04');
    await anchor('not json', '2026-03-05');
    const c = await verifyChains(db, { caFile: '/none', token });
    expect(c.versions).toEqual([
      { id: version.id, name: 'Library', problems: ['entries not readable'] },
    ]);
    expect(c.anchors.map((a) => [a.date, a.problems])).toEqual([
      ['unknown date', ['no heads']],
      ['2026-03-04', ['no heads']],
      // Text that does not parse is reported once, not also as "no heads".
      ['unknown date', ['heads not readable']],
    ]);
  });

  it('a month the calendar does not cover has days not known, never green', async () => {
    const { db } = await setup();
    const r = await auditReport(db, { ...options(), month: '2027-01' });
    expect(r.days.known).toBe(false);
    expect(auditIssues(r)).toContain('trading days not known');
    expect(auditText(t, r)).toMatch(/Not known: .*outside calendar/);
  });

  it('relative changes: none for a missing value or from 0', () => {
    expect(relativeChange(100, 110)).toBeCloseTo(0.1, 12);
    expect(relativeChange(null, 1)).toBeNull();
    expect(relativeChange(1, null)).toBeNull();
    expect(relativeChange(0, 1)).toBeNull();
    expect(relativeChange(Number.NaN, 1)).toBeNull();
  });
});
