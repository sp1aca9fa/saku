import { Sessions } from '@saku/data';
import { finishRun, schema, seedSourceRoles, startRun, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { GATE, spikeFrom, spikeReport, verdict } from './spike';

type Result = typeof schema.checkResults.$inferInsert;

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-12-01',
  validTo: '2026-12-31',
  holidays: [],
});

type Db = Awaited<ReturnType<typeof testDb>>;
let clock = 0;

/** A daily run for `target` storing results per date (its window); started in call order. */
async function runFor(
  db: Db,
  target: string,
  byDate: Record<string, Omit<Result, 'runId' | 'date'>[]>,
  o: { ok?: boolean; finished?: boolean } = {},
) {
  const runId = await startRun(
    db,
    'daily',
    new Date(Date.UTC(2026, 0, 1) + ++clock * 1000),
    target,
  );
  if (o.finished !== false)
    await finishRun(db, runId, { ok: o.ok ?? true, datesProcessed: [target] });
  for (const [date, results] of Object.entries(byDate)) {
    if (results.length)
      await db.insert(schema.checkResults).values(results.map((r) => ({ ...r, runId, date })));
  }
  return runId;
}

const day = (
  db: Db,
  date: string,
  results: Omit<Result, 'runId' | 'date'>[],
  o: { ok?: boolean; finished?: boolean } = {},
) => runFor(db, date, { [date]: results }, o);

async function setup(o: { indexed?: boolean } = {}) {
  const db = await testDb();
  await upsertSymbols(db, [
    {
      ticker: 'AAA',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      ...(o.indexed && { indexSeries: 'IDX' }),
    },
  ]);
  await seedSourceRoles(db, [
    { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
    { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
  ]);
  return { db, aaa: (await symbolId(db, 'AAA'))! };
}

const ok = (
  layer: 'A' | 'B' | 'C',
  checkName: string,
  source: string | null = null,
): Omit<Result, 'runId' | 'date'> => ({
  layer,
  checkName,
  source,
  status: 'green',
});

describe('spikeReport', () => {
  it('computes the gate from each day’s latest daily run', async () => {
    const db = await testDb();
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await seedSourceRoles(db, [
      { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    await day(db, '2026-01-05', good);
    // The secondary missed a day: not available, and B is not counted for that day.
    const missed = await day(db, '2026-01-06', [
      ok('A', 'bar_valid', 'p'),
      {
        layer: 'B',
        checkName: 'close_match',
        source: 's',
        status: 'yellow',
        message: 'no secondary bar',
      },
      ok('C', 'leverage_track'),
    ]);
    // A run that stored nothing, then a later rerun for the same date: the rerun counts.
    await day(db, '2026-01-07', []);
    await day(db, '2026-01-07', good);

    const report = await spikeReport(db, { sessions });
    expect(report.days.map((d) => [d.date, d.primaryOk, d.available.s])).toEqual([
      ['2026-01-05', true, true],
      ['2026-01-06', true, false],
      ['2026-01-07', true, true],
    ]);
    expect(report.availability.s).toBeCloseTo(2 / 3, 12);
    expect(report.layerB).toEqual({ days: 2, passed: 2 });
    expect(report.layerC).toEqual({ days: 3, passed: 3 });
    expect(report.passed).toBe(false); // 67% availability is below 95%
    expect(report.days[1]!.nonGreen).toEqual([
      {
        layer: 'B',
        check: 'close_match',
        source: 's',
        status: 'yellow',
        message: 'no secondary bar',
        runId: missed,
      },
    ]);
  });

  // A missing secondary bar is `secondary_missing` now; results stored before carry it as a
  // `close_match` with the message 'no secondary bar'. Both count the same: the secondary is not
  // available that day (also when another symbol's close was compared), and layer B is not passed.
  const missingBar = {
    current: { checkName: 'secondary_missing', message: 'no secondary bar' },
    stored: { checkName: 'close_match', message: 'no secondary bar' },
  };
  for (const [form, m] of Object.entries(missingBar)) {
    it(`counts a missing secondary bar the same way (${form} form)`, async () => {
      const { db, aaa } = await setup();
      await upsertSymbols(db, [{ ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' }]);
      const bbb = (await symbolId(db, 'BBB'))!;
      const both = (r: Omit<Result, 'runId' | 'date'>) => [
        { ...r, symbolId: aaa },
        { ...r, symbolId: bbb },
      ];
      const good = [
        ...both(ok('A', 'bar_valid', 'p')),
        ...both(ok('B', 'close_match', 's')),
        ...both(ok('C', 'leverage_track')),
      ];
      const missing = { layer: 'B' as const, source: 's', status: 'yellow' as const, ...m };
      await day(db, '2026-01-05', good);
      // Every symbol's secondary bar missing.
      await day(db, '2026-01-06', [
        ...both(ok('A', 'bar_valid', 'p')),
        ...both(missing),
        ...both(ok('C', 'leverage_track')),
      ]);
      // One symbol's close compared, the other's bar missing.
      await day(db, '2026-01-07', [
        ...both(ok('A', 'bar_valid', 'p')),
        { ...ok('B', 'close_match', 's'), symbolId: aaa },
        { ...missing, symbolId: bbb },
        ...both(ok('C', 'leverage_track')),
      ]);
      const report = await spikeReport(db, { sessions });
      expect(report.days.map((d) => [d.date, d.available.s, d.layerBPass])).toEqual([
        ['2026-01-05', true, true],
        ['2026-01-06', false, false],
        ['2026-01-07', false, false],
      ]);
      expect(report.availability.s).toBeCloseTo(1 / 3, 12);
      expect(report.layerB).toEqual({ days: 1, passed: 1 });
      expect(report.days[2]!.nonGreen.map((r) => [r.check, r.status, r.message])).toEqual([
        [m.checkName, 'yellow', 'no secondary bar'],
      ]);
    });
  }

  it('counts every session in the range; one without a finished run fails (no run)', async () => {
    const db = await testDb();
    await upsertSymbols(db, [{ ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' }]);
    await seedSourceRoles(db, [
      { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
      { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
    ]);
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    await day(db, '2026-01-05', good);
    // 01-06: no run at all. 01-07: a run still going (or crashed): not finished, no run.
    await day(db, '2026-01-07', good, { finished: false });
    // 01-08: a run that finished failed (a source incomplete) counts by what it stored.
    await day(db, '2026-01-08', good, { ok: false });
    // 01-09 and 01-12 (a weekend between): no run, inside the range the caller names.

    const report = await spikeReport(db, { sessions, to: '2026-01-12' });
    expect(report.days.map((d) => [d.date, d.primaryOk, d.reason ?? null])).toEqual([
      ['2026-01-05', true, null],
      ['2026-01-06', false, 'no_run'],
      ['2026-01-07', false, 'no_run'],
      ['2026-01-08', true, null],
      ['2026-01-09', false, 'no_run'],
      ['2026-01-12', false, 'no_run'],
    ]);
    const missing = report.days[1]!;
    expect(missing).toMatchObject({
      runId: null,
      available: { s: false },
      layerBPass: false,
      layerCPass: false,
    });
    expect(report.primaryOkDays).toBe(2);
    expect(report.availability.s).toBeCloseTo(2 / 6, 12);
    expect(report.layerB).toEqual({ days: 2, passed: 2 });
    expect(report.layerC).toEqual({ days: 6, passed: 2 });
    expect(report.passed).toBe(false);
  });

  it('reports nothing measured as not passed', async () => {
    const db = await testDb();
    const report = await spikeReport(db, { sessions });
    expect(report).toMatchObject({ days: [], primaryOkDays: 0, passed: false });
  });

  it('starts at the earliest daily run of any status (a crashed first run counts as no run)', async () => {
    const { db } = await setup();
    const good = [ok('A', 'bar_valid', 'p'), ok('B', 'close_match', 's')];
    await day(db, '2026-01-02', good, { finished: false });
    await day(db, '2026-01-05', good);
    const report = await spikeReport(db, { sessions });
    expect(report.days.map((d) => [d.date, d.reason ?? null])).toEqual([
      ['2026-01-02', 'no_run'],
      ['2026-01-05', null],
    ]);
  });

  it('a secondary is available when any finished run for the day got its bars', async () => {
    const { db } = await setup();
    await day(db, '2026-01-05', [ok('A', 'bar_valid', 'p'), ok('B', 'close_match', 's')], {
      ok: false,
    });
    // A rerun the same day no longer gets the secondary's bar: it was available that day.
    await day(db, '2026-01-05', [
      ok('A', 'bar_valid', 'p'),
      {
        layer: 'B',
        checkName: 'close_match',
        source: 's',
        status: 'yellow',
        message: 'no secondary bar',
      },
    ]);
    const report = await spikeReport(db, { sessions });
    expect(report.days[0]).toMatchObject({ available: { s: true }, layerBPass: false });
    expect(report.availability.s).toBe(1);
  });

  it('the open session is pending, not failed, until its run finishes', async () => {
    const { db } = await setup();
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    await day(db, '2026-01-05', good);
    // The target's run is still going.
    await day(db, '2026-01-06', good, { finished: false });
    const report = await spikeReport(db, { sessions, to: '2026-01-06', open: '2026-01-06' });
    expect(report.days.map((d) => [d.date, d.reason ?? null])).toEqual([
      ['2026-01-05', null],
      ['2026-01-06', 'pending'],
    ]);
    // The verdict covers the judged sessions; the pending one is listed, never counted.
    expect(report.primaryOkDays).toBe(1);
    expect(report.layerC).toEqual({ days: 1, passed: 1 });
    // The ratios hold, but one judged session is far from the 20 the gate needs.
    expect(report).toMatchObject({
      pending: 1,
      through: '2026-01-05',
      judged: 1,
      ratiosMet: true,
      passed: false,
    });
    // Once the window closed (the next target), the same session is a failure.
    const later = await spikeReport(db, { sessions, to: '2026-01-07', open: '2026-01-07' });
    expect(later.days[1]).toMatchObject({ date: '2026-01-06', reason: 'no_run' });
  });

  it("reads layer C from the latest run covering the date, so the next run's index check counts", async () => {
    const { db, aaa } = await setup({ indexed: true });
    const base = [
      { ...ok('A', 'bar_valid', 'p'), symbolId: aaa },
      { ...ok('B', 'close_match', 's'), symbolId: aaa },
    ];
    const index = { ...ok('C', 'index_match', 'idx'), symbolId: aaa };
    // The run for 01-05 has no index value for it yet (published after the run).
    await day(db, '2026-01-05', base);
    // The next daily target (01-06) is open: its run can still check 01-05.
    let report = await spikeReport(db, { sessions, open: '2026-01-06' });
    expect(report.days[0]).toMatchObject({ layerCPass: false, layerCPending: true });
    expect(report).toMatchObject({ pending: 1, passed: false, layerC: { days: 0, passed: 0 } });
    expect(report.through).toBeUndefined();
    // Left out by --from while its index can still arrive: not judged yet, never counted as clean.
    const later = await spikeReport(db, { sessions, open: '2026-01-06', from: '2026-01-06' });
    expect(later.leftOut).toEqual({ from: '2026-01-06', sessions: 1, failed: 0, notJudged: 1 });

    // The next run checks 01-05 in its window; 01-06 now waits for the index.
    const next = await runFor(db, '2026-01-06', {
      '2026-01-05': [...base, index],
      '2026-01-06': base,
    });
    report = await spikeReport(db, { sessions, open: '2026-01-07' });
    expect(report.days.map((d) => [d.date, d.layerCPass, d.layerCPending ?? false])).toEqual([
      ['2026-01-05', true, false],
      ['2026-01-06', false, true],
    ]);
    expect(report.days[0]!.layerCRunId).toBe(next);
    expect(report.layerC).toEqual({ days: 1, passed: 1 });
    expect(report).toMatchObject({ through: '2026-01-05', ratiosMet: true, pending: 1 });

    // A later run that stored nothing for 01-06 did not check it: still pending.
    await runFor(db, '2026-01-07', { '2026-01-07': [...base, index] });
    report = await spikeReport(db, { sessions, open: '2026-01-08' });
    expect(report.days[1]).toMatchObject({ date: '2026-01-06', layerCPending: true });
    // Pending from 01-06 on: 01-07 is listed, not judged, though its own layer C is green.
    expect(report).toMatchObject({ through: '2026-01-05', pending: 2 });

    // A later run that stored 01-06 without an index result: no longer pending, not passed.
    await runFor(db, '2026-01-08', { '2026-01-06': base, '2026-01-08': [...base, index] });
    report = await spikeReport(db, { sessions, open: '2026-01-09' });
    expect(report.days[1]).toMatchObject({
      date: '2026-01-06',
      layerCPass: false,
      layerCReason: 'index_never_arrived',
    });
    expect(report.days[1]!.layerCPending).toBeUndefined();
    // 01-08's own run had its index (the test's simplification): judged through 01-08.
    expect(report.layerC).toEqual({ days: 4, passed: 3 });
    expect(report).toMatchObject({ through: '2026-01-08', pending: 0, passed: false });
  });

  it('a failure at decision time is never dropped by a later index check', async () => {
    const { db, aaa } = await setup({ indexed: true });
    const base = [
      { ...ok('A', 'bar_valid', 'p'), symbolId: aaa },
      { ...ok('B', 'close_match', 's'), symbolId: aaa },
    ];
    const green = { ...ok('C', 'index_match', 'idx'), symbolId: aaa };
    const stale = { ...green, checkName: 'index_unavailable', status: 'yellow' as const };
    // The day's own run could not check the index (yellow); the next run's check is green.
    const own = await day(db, '2026-01-05', [...base, stale]);
    await runFor(db, '2026-01-06', {
      '2026-01-05': [...base, green],
      '2026-01-06': [...base, green],
    });
    let report = await spikeReport(db, { sessions });
    expect(report.days[0]).toMatchObject({ layerCPass: false });
    expect(report.days[0]!.nonGreen).toEqual([
      expect.objectContaining({ check: 'index_unavailable', status: 'yellow', runId: own }),
    ]);

    // Green at decision time, the later index check red: not passed, listed with its run.
    const db2 = (await setup({ indexed: true })).db;
    await day(db2, '2026-01-05', [...base, green]);
    const later = await runFor(db2, '2026-01-06', {
      '2026-01-05': [...base, { ...green, status: 'red' as const }],
      '2026-01-06': [...base, green],
    });
    report = await spikeReport(db2, { sessions });
    expect(report.days[0]).toMatchObject({ layerCPass: false, layerCRunId: later });
    expect(report.days[0]!.nonGreen).toEqual([
      expect.objectContaining({ check: 'index_match', status: 'red', runId: later }),
    ]);
  });

  it('a pending index result stops waiting once no future run can cover the date', async () => {
    const { db, aaa } = await setup({ indexed: true });
    const base = [
      { ...ok('A', 'bar_valid', 'p'), symbolId: aaa },
      { ...ok('B', 'close_match', 's'), symbolId: aaa },
    ];
    const index = { ...ok('C', 'index_match', 'idx'), symbolId: aaa };
    // 01-05 has no index result; 01-06's run stored only its own date; then an outage.
    await day(db, '2026-01-05', base);
    await day(db, '2026-01-06', [...base, index]);

    // Open 01-19: its window (10 sessions before, 01-05, through 01-19) still covers 01-05.
    let report = await spikeReport(db, { sessions, to: '2026-01-19', open: '2026-01-19' });
    expect(report.days[0]).toMatchObject({ date: '2026-01-05', layerCPending: true });
    expect(report.days[0]!.layerCReason).toBeUndefined();
    expect(report).toMatchObject({ judged: 0, pending: 11, passed: false });
    expect(report.through).toBeUndefined();

    // Open 01-20: the earliest any future run reaches is 01-06, so 01-05 is judged not passed,
    // and the later sessions are judged normally (the outage days fail as no run).
    report = await spikeReport(db, { sessions, to: '2026-01-20', open: '2026-01-20' });
    expect(report.days[0]).toMatchObject({
      date: '2026-01-05',
      layerCPass: false,
      layerCReason: 'index_never_arrived',
    });
    expect(report.days[0]!.layerCPending).toBeUndefined();
    expect(report.days[1]).toMatchObject({ date: '2026-01-06', layerCPass: true });
    expect(report.days.slice(2, -1).every((d) => d.reason === 'no_run')).toBe(true);
    expect(report.days.at(-1)).toMatchObject({ date: '2026-01-20', reason: 'pending' });
    expect(report).toMatchObject({
      through: '2026-01-19',
      judged: 11,
      pending: 1,
      layerC: { days: 11, passed: 1 },
      passed: false,
    });

    // Without an open session no future run is known: nothing waits.
    report = await spikeReport(db, { sessions, to: '2026-01-06' });
    expect(report.days[0]).toMatchObject({ layerCReason: 'index_never_arrived' });
    expect(report).toMatchObject({ judged: 2, pending: 0 });
  });

  it('passes only with at least 20 judged sessions', async () => {
    expect(GATE.sessions).toBe(20);
    const { db } = await setup();
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    const dates = sessions.between('2026-01-05', '2026-01-30');
    expect(dates).toHaveLength(20);
    const after = async (n: number) => {
      const to = dates[n - 1]!;
      return spikeReport(db, { sessions, to, open: sessions.after(to) });
    };
    for (const d of dates) await day(db, d, good);
    // Three green sessions: every ratio met, not passed.
    expect(await after(3)).toMatchObject({ judged: 3, ratiosMet: true, passed: false });
    expect(await after(19)).toMatchObject({ judged: 19, ratiosMet: true, passed: false });
    expect(await after(20)).toMatchObject({
      judged: 20,
      ratiosMet: true,
      passed: true,
      through: '2026-01-30',
    });
  });

  it('--from starts the count at the first session on or after it; earlier ones are left out', async () => {
    const { db } = await setup();
    const good = [
      ok('A', 'bar_valid', 'p'),
      ok('B', 'close_match', 's'),
      ok('C', 'leverage_track'),
    ];
    // An earlier failing stretch (01-05 without a run, 01-06 primary failed) before the count.
    await day(db, '2026-01-02', good, { finished: false });
    await day(db, '2026-01-06', [ok('B', 'close_match', 's')]);
    await day(db, '2026-01-12', good);
    await day(db, '2026-01-13', good);

    // A Saturday: the count starts at the Monday after.
    const from = spikeFrom(sessions, '2026-01-10', '2026-01-13');
    expect(from).toEqual({ date: '2026-01-12' });
    const report = await spikeReport(db, {
      sessions,
      to: '2026-01-13',
      open: '2026-01-13',
      from: (from as { date: string }).date,
    });
    expect(report.days.map((d) => d.date)).toEqual(['2026-01-12', '2026-01-13']);
    expect(report).toMatchObject({ judged: 2, primaryOkDays: 2, ratiosMet: true });
    // What it left out: the sessions earlier daily runs targeted (01-02 crashed, 01-06 primary
    // failed), both failed.
    expect(report.leftOut).toEqual({ from: '2026-01-12', sessions: 2, failed: 2, notJudged: 0 });
    // Without --from nothing is left out.
    expect((await spikeReport(db, { sessions, to: '2026-01-13' })).leftOut).toBeUndefined();

    // Refused: not a date, outside the calendar, after the target.
    expect(spikeFrom(sessions, '2026-1-12', '2026-01-13')).toHaveProperty('error');
    expect(spikeFrom(sessions, '2026-02-30', '2026-01-13')).toHaveProperty('error');
    expect(spikeFrom(sessions, '2025-06-01', '2026-01-13')).toHaveProperty('error');
    expect(spikeFrom(sessions, '2026-01-14', '2026-01-13')).toHaveProperty('error');
    expect(spikeFrom(sessions, '2026-01-13', '2026-01-13')).toEqual({ date: '2026-01-13' });
  });

  it('words the verdict with the judged count and any ratio unmet so far', () => {
    const met = {
      primaryOkDays: 0,
      availability: { s: 1 },
      layerB: { days: 0, passed: 0 },
      layerC: { days: 0, passed: 0 },
      passed: false,
    };
    const all = (n: number) => ({
      ...met,
      judged: n,
      primaryOkDays: n,
      layerB: { days: n, passed: n },
      layerC: { days: n, passed: n },
    });
    expect(verdict({ ...met, judged: 0 })).toBe('not passed yet: 0 of 20 sessions judged');
    expect(verdict({ ...all(3), through: '2026-01-07' })).toBe(
      'not passed yet: 3 of 20 sessions judged',
    );
    // Ten sessions, the secondary available on 9, layer C passed on 9: named, shares rounded down.
    expect(
      verdict({
        ...all(10),
        availability: { s: 0.9, t: 0.5 },
        layerB: { days: 9, passed: 9 },
        layerC: { days: 10, passed: 9 },
        through: '2026-01-16',
      }),
    ).toBe(
      'not passed yet: 10 of 20 sessions judged (secondary available 90% < 95%, layer C 90% < 99% so far)',
    );
    expect(verdict({ ...all(10), primaryOkDays: 9, layerB: { days: 0, passed: 0 } })).toBe(
      'not passed yet: 10 of 20 sessions judged (primary ok 90% < 100%, layer B not measured (no session with a secondary) so far)',
    );
    // A share just under its threshold never reads as reaching it.
    expect(
      verdict({ ...all(10), layerB: { days: 10, passed: 9.899 }, through: '2026-01-16' }),
    ).toBe('not passed yet: 10 of 20 sessions judged (layer B 98.9% < 99% so far)');
    expect(verdict({ ...all(20), passed: true, through: '2026-01-30' })).toBe(
      'passed through 2026-01-30 (20 sessions judged, gate needs 20)',
    );
    expect(verdict({ ...all(35), layerC: { days: 35, passed: 34 }, through: '2026-02-20' })).toBe(
      'not passed (35 sessions judged, gate needs 20; layer C 97.1% < 99%)',
    );
  });
});
