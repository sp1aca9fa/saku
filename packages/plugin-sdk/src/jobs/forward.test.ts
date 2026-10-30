import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  addChannel,
  annotate,
  annotationsOf,
  createUser,
  forwardRecord,
  registerVersion,
  schema,
  seedSourceRoles,
  setSetting,
  startRun,
  storeRawBars,
  symbolId,
  upsertSymbols,
  verifyChain,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Notifier } from '../types';
import { sendRecomputeDiffers, sendStrategyAlerts } from './alerts';
import {
  type ResolvedStandIn,
  type Rows,
  annotateStandInCorrections,
  forward,
  instantOf,
  reader,
  recompute,
  signalsDiffer,
  standInCorrections,
  upTo,
} from './forward';
import { verify } from './verify';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
const bars = (closes: number[]): RawBar[] =>
  closes.map((close, i) => ({
    date: D[i]!,
    open: close,
    high: close,
    low: close,
    close,
    closeIsSplitAdjusted: false,
    volume: 1000,
    divCash: 0,
    splitFactor: 1,
  }));

const strategy = {
  name: 'Trend',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'A',
      type: 'compare',
      left: { indicator: 'price', ticker: 'AAA' },
      op: '>',
      right: { indicator: 'sma', ticker: 'AAA', length: 2 },
    },
  ],
  allocations: [
    { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'AAA2', weight: 100 }] },
    { name: 'Calm', holdings: [{ ticker: 'AAA', weight: 100 }] },
  ],
};

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    {
      ticker: 'AAA2',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      leverageFactor: 2,
      underlying: 'AAA',
    },
  ]);
  await seedSourceRoles(db, [
    { key: 'p', dataKind: 'bars', suggestedRole: 'primary' },
    { key: 's', dataKind: 'bars', suggestedRole: 'secondary' },
  ]);
  const store = async (ticker: string, source: string, list: RawBar[]) =>
    storeRawBars(db, {
      symbolId: (await symbolId(db, ticker))!,
      source,
      bars: list,
      runId: null,
      fetchedAt: 't',
    });
  const aaa = [100, 101, 102, 103, 104];
  const aaa2 = [50, 51, 52.0198, 53.0398, 54.0594];
  await store('AAA', 'p', bars(aaa));
  await store('AAA', 's', bars(aaa));
  await store('AAA2', 'p', bars(aaa2));
  // The secondary disagrees on the last day: AAA2 is red there.
  await store('AAA2', 's', bars(aaa2.map((c, i) => (i === 4 ? c * 1.01 : c))));
  const owner = await createUser(db, {
    username: 'alex',
    passwordHash: 'scrypt:x',
    totpSecretEnc: 'v1.x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  // Registered after 01-06's close (21:00 UTC): the record starts with 01-07.
  const version = await registerVersion(db, {
    ownerId: owner,
    name: 'Trend',
    strategy,
    at: new Date('2026-01-06T22:00:00Z'),
  });
  const runId = await startRun(db, 'daily');
  await verify(db, { runId, sessions, mode: 'full', to: D[4]! });
  return { db, version, runId, store };
}

describe('forward', () => {
  it('does nothing before forward records are started', async () => {
    const { db, runId } = await setup();
    expect(await forward(db, { runId, sessions, to: D[3]! })).toMatchObject({
      appended: 0,
      skipped: expect.any(String),
    });
  });

  it('records each day after registration once, catching up, chained', async () => {
    const { db, version, runId } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    expect((await forward(db, { runId, sessions, to: D[3]! })).appended).toBe(2);
    expect((await forward(db, { runId, sessions, to: D[3]! })).appended).toBe(0);
    const record = await forwardRecord(db, version.id);
    expect(record.map((e) => [e.date, e.allocation, e.dataStatus])).toEqual([
      ['2026-01-07', 'Risk on', 'green'],
      ['2026-01-08', 'Risk on', 'green'],
    ]);
    // Bought at 01-08's open (= its close here): no change on 01-08.
    expect(record.map((e) => e.equity)).toEqual([1, 1]);
    expect(await verifyChain(db, version)).toEqual([]);
  });

  it('a stored version that no longer parses is reported and skipped; the others still run', async () => {
    const { db, version, runId } = await setup();
    // Registered before the good one (so read first), with a rule added later: a ticker twice.
    const broken = await registerVersion(db, {
      ownerId: version.ownerId,
      name: 'Old',
      strategy: {
        ...strategy,
        allocations: [
          strategy.allocations[0]!,
          {
            name: 'Calm',
            holdings: [
              { ticker: 'AAA', weight: 50 },
              { ticker: 'AAA', weight: 50 },
            ],
          },
        ],
      },
      at: new Date('2026-01-06T21:30:00Z'),
    });
    await setSetting(db, 'forward_records_from', '2026-01-05');
    const f = await forward(db, { runId, sessions, to: D[3]! });
    expect(f.appended).toBe(2);
    expect(f.errors).toEqual([
      { version: `Old (${broken.id})`, error: expect.stringContaining('"AAA" is listed twice') },
    ]);
    // Nothing is appended for it: no decision is guessed.
    expect(await forwardRecord(db, broken.id)).toEqual([]);
    expect((await forwardRecord(db, version.id)).map((e) => e.date)).toEqual([D[2], D[3]]);
    // Recompute reports it too (it has no record yet), and still checks the good one.
    const r = await recompute(db, { runId, code: 'c1' });
    expect(r.checked).toBe(2);
    expect(r.errors).toEqual([
      {
        version: `Old (${broken.id})`,
        kind: 'parse',
        error: expect.stringContaining('"AAA" is listed twice'),
      },
    ]);
  });

  it('recompute skips a day a correction explains only when it now decides that allocation', async () => {
    for (const corrected of ['Calm', 'Risk on']) {
      const { db, version, runId, store } = await setup();
      await setSetting(db, 'forward_records_from', '2026-01-05');
      await forward(db, { runId, sessions, to: D[3]! });
      // The engine now decides 01-08 Calm (its close corrected below the 2-day average).
      const revised = bars([100, 101, 102, 100]);
      await store('AAA', 'p', revised);
      await store('AAA', 's', revised);
      await verify(db, { runId: await startRun(db, 'checks'), sessions, mode: 'full', to: D[3]! });
      await annotate(db, {
        versionId: version.id,
        date: '2026-01-08',
        kind: 'stand_in_corrected',
        detail: {
          ticker: 'AAA',
          standInDate: '2026-01-08',
          deviation: 0.01,
          recordedAllocation: 'Risk on',
          correctedAllocation: corrected,
          differs: corrected !== 'Risk on',
        },
        runId,
      });
      const r = await recompute(db, { runId, code: 'c2' });
      // Explained: not a difference. Not explained (the correction said otherwise): compared.
      expect(r.differences.map((d) => [d.date, d.now])).toEqual(
        corrected === 'Calm' ? [] : [['2026-01-08', 'Calm']],
      );
      expect(r.checked).toBe(corrected === 'Calm' ? 1 : 2);
    }
  });

  it('recompute: the record reproduces, and a difference is annotated once', async () => {
    const { db, version, runId, store } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    await forward(db, { runId, sessions, to: D[3]! });
    expect(await recompute(db, { runId, code: 'c1' })).toEqual({
      checked: 2,
      differences: [],
      errors: [],
    });
    // A corrected close on 01-08 (below its 2-day average) turns that day's signal off.
    const revised = bars([100, 101, 102, 100]);
    await store('AAA', 'p', revised);
    await store('AAA', 's', revised);
    await verify(db, { runId: await startRun(db, 'checks'), sessions, mode: 'full', to: D[3]! });
    const r = await recompute(db, { runId, code: 'c2' });
    expect(r.differences).toEqual([
      { version: 'Trend', date: '2026-01-08', recorded: 'Risk on', now: 'Calm' },
    ]);
    expect((await recompute(db, { runId, code: 'c2' })).differences).toEqual([]);
    const [note] = await annotationsOf(db, version.id, 'recomputed');
    expect(note!.detail).toMatchObject({ code: 'c2', signalsDiffer: ['A'] });
    // The admins hear of it; an undelivered alert is tried again on the next run.
    const owner = version.ownerId!;
    await addChannel(db, owner, {
      type: 'fake',
      target: 'ops',
      admin: true,
      authSecret: 'k'.repeat(32),
    });
    const texts: string[] = [];
    let up = false;
    const notifier: Notifier = {
      info: { key: 'fake', kind: 'notifier', name: 'Fake', termsUrl: 'x', maxLength: 1000 },
      validTarget: () => true,
      send: async (_t, text) => {
        if (!up) throw new Error('Fake: HTTP 500');
        texts.push(text);
      },
    };
    const quiet = { info() {}, warn() {} };
    const alerting = {
      date: D[3]!,
      notifiers: [notifier],
      authSecret: 'k'.repeat(32),
      context: () => ({ http: null as never, now: new Date(), log: quiet }),
      log: quiet,
    };
    expect((await sendRecomputeDiffers(db, alerting)).failed).toHaveLength(1);
    up = true;
    expect((await sendRecomputeDiffers(db, alerting)).sent).toBe(1);
    expect((await sendRecomputeDiffers(db, alerting)).sent).toBe(0);
    expect(texts[0]).toContain(
      'Trend on 2026-01-08, recorded Risk on, now Calm; signals that differ: A.',
    );
    // The record itself is untouched.
    expect((await forwardRecord(db, version.id)).map((e) => e.allocation)).toEqual([
      'Risk on',
      'Risk on',
    ]);
  });

  it('annotates a corrected stand-in once, also for a version skipped in the resolving run', async () => {
    const { db, version, runId } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    const aaa = (await symbolId(db, 'AAA'))!;
    const aaa2 = (await symbolId(db, 'AAA2'))!;
    // Stand-ins recorded before the entries are appended (the canonical bars themselves are not
    // needed for the annotation): 01-07's AAA will be corrected 0.5% off, 01-08's AAA2 within
    // the close tolerance.
    const early = '2026-01-07T21:30:00.000Z';
    const standIn = { source: 's', band: 0.001, basis: 'index', createdAt: early };
    await db.insert(schema.standIns).values([
      { ...standIn, symbolId: aaa, date: D[2]!, close: 102.51 },
      { ...standIn, symbolId: aaa2, date: D[3]!, close: 53.0398 },
    ]);
    expect((await forward(db, { runId, sessions, to: D[3]! })).appended).toBe(2);
    const record = await forwardRecord(db, version.id);
    // Run 1 resolves both (after the entries were appended) while the version does not parse:
    // as if a stricter schema refused it (registered versions are immutable; only the test
    // lifts the trigger to simulate it).
    const resolvedAt = new Date(
      Math.max(...record.map((e) => instantOf(e.createdAt))) + 1,
    ).toISOString();
    await db
      .update(schema.standIns)
      .set({ primaryClose: 102, deviation: 102.51 / 102 - 1, resolvedAt })
      .where(eq(schema.standIns.symbolId, aaa));
    await db
      .update(schema.standIns)
      .set({ primaryClose: 53.0398, deviation: 0, resolvedAt })
      .where(eq(schema.standIns.symbolId, aaa2));
    const [row] = await db
      .select()
      .from(schema.strategyVersions)
      .where(eq(schema.strategyVersions.id, version.id));
    const stored = JSON.parse(row!.canonicalJson) as { strategy: typeof strategy };
    const twice = [
      { ticker: 'AAA', weight: 50 },
      { ticker: 'AAA', weight: 50 },
    ];
    const broken = {
      ...stored,
      strategy: {
        ...stored.strategy,
        allocations: [stored.strategy.allocations[0]!, { name: 'Calm', holdings: twice }],
      },
    };
    await db.run(sql`DROP TRIGGER strategy_versions_no_update`);
    const setJson = (json: string) =>
      db
        .update(schema.strategyVersions)
        .set({ canonicalJson: json })
        .where(eq(schema.strategyVersions.id, version.id));
    await setJson(JSON.stringify(broken));
    expect((await forward(db, { runId, sessions, to: D[3]! })).errors).toHaveLength(1);
    expect(await annotateStandInCorrections(db, runId)).toEqual({
      annotations: 0,
      deferred: 0,
      errors: [],
    });
    expect(await annotationsOf(db, version.id, 'stand_in_corrected')).toEqual([]);

    // Run 2: it parses again, and the correction is caught up from the database, once.
    await setJson(row!.canonicalJson);
    expect((await forward(db, { runId, sessions, to: D[3]! })).errors).toEqual([]);
    // The stand-in day's entry and the next one, appended while it was unresolved (its lookback
    // reads the stand-in's close).
    expect(await annotateStandInCorrections(db, runId)).toEqual({
      annotations: 2,
      deferred: 0,
      errors: [],
    });
    const notes = await annotationsOf(db, version.id, 'stand_in_corrected');
    const detail = (recorded: string) => ({
      ticker: 'AAA',
      standInDate: D[2],
      deviation: 102.51 / 102 - 1,
      recordedAllocation: recorded,
      correctedAllocation: recorded,
      differs: false,
    });
    expect(notes.map((n) => [n.date, n.detail])).toEqual([
      [D[2], detail(record[0]!.allocation)],
      [D[3], detail(record[1]!.allocation)],
    ]);
    expect(record.map((e) => e.date)).toEqual([D[2], D[3]]);
    expect((await annotateStandInCorrections(db, runId)).annotations).toBe(0);
    expect(await annotationsOf(db, version.id, 'stand_in_corrected')).toHaveLength(2);
    // The record itself is untouched.
    expect(await forwardRecord(db, version.id)).toEqual(record);
  });

  it('an entry appended after the stand-in was resolved used the primary: no annotation', async () => {
    const { db, version, runId } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    const aaa = (await symbolId(db, 'AAA'))!;
    // Recorded and resolved (1% off) before the forward step ran: the entries used the primary.
    await db.insert(schema.standIns).values({
      symbolId: aaa,
      date: D[2]!,
      source: 's',
      close: 103.02,
      band: 0.001,
      basis: 'index',
      createdAt: '2026-01-07T21:30:00.000Z',
      primaryClose: 102,
      deviation: 103.02 / 102 - 1,
      resolvedAt: '2026-01-08T21:30:00.000Z',
    });
    expect((await forward(db, { runId, sessions, to: D[3]! })).appended).toBe(2);
    expect(await annotateStandInCorrections(db, runId)).toEqual({
      annotations: 0,
      deferred: 0,
      errors: [],
    });
    expect(await annotationsOf(db, version.id, 'stand_in_corrected')).toEqual([]);
  });

  it('stand-in corrections: which entries used the stand-in, compared as instants', () => {
    const s = (over: Partial<ResolvedStandIn> = {}): ResolvedStandIn => ({
      ticker: 'AAA',
      date: '2026-01-07',
      deviation: 0.01,
      runId: 'r1',
      createdAt: '2026-01-07T21:30:00.000Z',
      resolvedRunId: 'r2',
      resolvedAt: '2026-01-08T21:30:00.000Z',
      ...over,
    });
    const entry = (createdAt: string, runId: string | null) => ({
      date: '2026-01-07',
      allocation: 'Risk on',
      createdAt,
      runId,
    });
    // An entry from another run (`r0`) unless named: placed by time.
    const run = (
      createdAt: string,
      corrected: ResolvedStandIn[],
      annotated: { date: string; ticker: unknown; standInDate?: unknown }[] = [],
      runId: string | null = 'r0',
    ) =>
      standInCorrections({
        version: 'Trend (v1)',
        deps: ['AAA', 'AAA2'],
        record: [entry(createdAt, runId)],
        corrected,
        unresolved: [],
        annotated: annotated.map((a) => ({ standInDate: a.date, ...a })),
      });
    const used = '2026-01-08T00:00:00.000Z';
    const after = '2026-01-09T00:00:00.000Z';
    // Run ids first: appended in the resolving run, the primary's bar (even inside the window);
    // in the recording run, the stand-in (even outside it).
    expect(run(used, [s()], [], 'r2')).toEqual({ annotate: [], deferred: 0, errors: [] });
    expect(run(after, [s()], [], 'r1').annotate).toHaveLength(1);
    // Run ids decide without reading the timestamps, so a bad one does not block them.
    const unreadable = s({ createdAt: 'x', resolvedAt: '2026-01-08 21:30:00' });
    expect(run('y', [unreadable], [], 'r1')).toMatchObject({ errors: [] });
    expect(run('y', [unreadable], [], 'r1').annotate).toHaveLength(1);
    expect(run('y', [unreadable], [], 'r2')).toEqual({ annotate: [], deferred: 0, errors: [] });
    // No run on either side is not the same run: placed by time.
    expect(run(after, [s({ runId: null, resolvedRunId: null })], [], null).annotate).toEqual([]);
    expect(run(used, [s({ runId: null, resolvedRunId: null })], [], null).annotate).toHaveLength(1);
    expect(run(after, [s()], [], null).annotate).toEqual([]);
    expect(run(used, [s()]).annotate).toHaveLength(1);
    // The same instant written with an offset.
    expect(run('2026-01-07T19:00:00.000-05:00', [s()]).annotate).toHaveLength(1);
    // Appended before the stand-in existed, at or after its resolution: the primary's bar.
    expect(run('2026-01-07T21:29:59.999Z', [s()]).annotate).toEqual([]);
    expect(run('2026-01-08T21:30:00.000Z', [s()]).annotate).toEqual([]);
    expect(run('2026-01-08T16:30:00.000-05:00', [s()]).annotate).toEqual([]);
    // Not a dependency, only entries before the stand-in's date, already annotated (for this
    // entry date, ticker and stand-in date).
    expect(run(used, [s({ ticker: 'BBB' })]).annotate).toEqual([]);
    expect(run(used, [s({ date: '2026-01-08' })]).annotate).toEqual([]);
    expect(run(used, [s()], [{ date: '2026-01-07', ticker: 'AAA' }]).annotate).toEqual([]);
    expect(run(used, [s()], [{ date: '2026-01-07', ticker: 'AAA2' }]).annotate).toHaveLength(1);
    expect(
      run(used, [s()], [{ date: '2026-01-07', ticker: 'AAA', standInDate: '2026-01-06' }]).annotate,
    ).toHaveLength(1);
    // A later entry appended while the stand-in was unresolved (its lookback may read it).
    const later = run(used, [s({ date: '2026-01-06' })]);
    expect(later.annotate.map((a) => [a.recorded.date, a.standIn.date])).toEqual([
      ['2026-01-07', '2026-01-06'],
    ]);
    // A timestamp that is not an instant: unknown, an error, nothing annotated on a guess.
    for (const bad of [s({ resolvedAt: '2026-01-08 21:30:00' }), s({ createdAt: 'x' })]) {
      const r = run(used, [bad]);
      expect(r.annotate).toEqual([]);
      expect(r.errors).toEqual([expect.stringContaining('AAA 2026-01-07')]);
    }
    const r = run('2026-01-08 00:00:00', [s()]);
    expect(r.annotate).toEqual([]);
    expect(r.errors).toEqual([expect.stringContaining('Trend (v1) 2026-01-07')]);
    expect(run(used, []).annotate).toEqual([]);
  });

  it('stand-in corrections: every entry that used it, waiting for unresolved stand-ins', () => {
    const standIn: ResolvedStandIn = {
      ticker: 'AAA',
      date: '2026-01-07',
      deviation: 0.01,
      runId: 'r1',
      createdAt: '2026-01-07T21:30:00.000Z',
      resolvedRunId: 'r3',
      resolvedAt: '2026-01-09T21:30:00.000Z',
    };
    const e = (date: string, runId: string) => ({
      date,
      allocation: 'Risk on',
      createdAt: '2026-01-01T00:00:00.000Z',
      runId,
    });
    // D in the recording run, D+1 in the run between, D+2 in the resolving run.
    const record = [e('2026-01-06', 'r0'), e('2026-01-07', 'r1'), e('2026-01-08', 'r2')];
    record[2]!.createdAt = '2026-01-08T21:30:00.000Z';
    record.push(e('2026-01-09', 'r3'));
    const run = (unresolved: { ticker: string; date: string }[]) =>
      standInCorrections({
        version: 'Trend (v1)',
        deps: ['AAA', 'AAA2'],
        record,
        corrected: [standIn],
        unresolved,
        annotated: [],
      });
    expect(run([]).annotate.map((a) => a.recorded.date)).toEqual(['2026-01-07', '2026-01-08']);
    // Another dependency's stand-in still unresolved on D+1: D is annotated, D+1 waits.
    const waiting = run([{ ticker: 'AAA2', date: '2026-01-08' }]);
    expect(waiting.annotate.map((a) => a.recorded.date)).toEqual(['2026-01-07']);
    expect(waiting.deferred).toBe(1);
    // On or before D: both wait. A ticker the version does not read: none waits.
    expect(run([{ ticker: 'AAA2', date: '2026-01-02' }])).toMatchObject({
      annotate: [],
      deferred: 2,
    });
    expect(run([{ ticker: 'BBB', date: '2026-01-02' }]).annotate).toHaveLength(2);
  });

  it('reads only ISO 8601 instants with a zone', () => {
    expect(instantOf('2026-01-08T21:30:00.000Z')).toBe(Date.UTC(2026, 0, 8, 21, 30));
    expect(instantOf('2026-01-08T16:30:00-05:00')).toBe(Date.UTC(2026, 0, 8, 21, 30));
    expect(instantOf('2026-01-08 21:30:00')).toBeNaN();
    expect(instantOf('2026-01-08T21:30:00')).toBeNaN();
    expect(instantOf('2026-01-08')).toBeNaN();
    expect(instantOf(null)).toBeNaN();
    expect(instantOf('')).toBeNaN();
  });

  it('a multi-day catch-up records the same entries as one run per day', async () => {
    // The entries' text, with the random ids (version, registration hash) and the chain's own
    // hashes named by position: equal text then means equal hashes for equal ids.
    const record = async (
      db: Awaited<ReturnType<typeof setup>>['db'],
      v: { id: string; hash: string },
    ) => {
      const list = await forwardRecord(db, v.id);
      const names = new Map([
        [v.hash, 'H0'],
        ...list.map((e, i) => [e.hash, `H${i + 1}`] as const),
      ]);
      return list.map((e) => {
        let text = e.payload.split(v.id).join('V');
        for (const [h, n] of names) text = text.split(h).join(n);
        return { text, prevHash: names.get(e.prevHash) };
      });
    };
    const once = await setup();
    await setSetting(once.db, 'forward_records_from', '2026-01-05');
    expect((await forward(once.db, { runId: once.runId, sessions, to: D[4]! })).appended).toBe(3);
    const daily = await setup();
    await setSetting(daily.db, 'forward_records_from', '2026-01-05');
    for (const d of D) await forward(daily.db, { runId: daily.runId, sessions, to: d });
    const a = await record(once.db, once.version);
    expect(a.map((e) => JSON.parse(e.text).date)).toEqual(D.slice(2));
    expect(a).toEqual(await record(daily.db, daily.version));
    expect(await verifyChain(once.db, once.version)).toEqual([]);
    expect(await verifyChain(daily.db, daily.version)).toEqual([]);
  });

  it('a prefix of one read holds the same rows as a read up to that date', async () => {
    const { db } = await setup();
    const { loadRows } = await reader(db);
    const deps = ['AAA', 'AAA2'];
    const all = await loadRows(deps, D[4]!);
    for (const d of D) expect(upTo(all, d)).toEqual(await loadRows(deps, d));
  });

  it('a date never sees a later bar', () => {
    const row = (date: string) => ({ date }) as Rows[string][number];
    const rows: Rows = {
      A: D.map(row),
      B: [row(D[0]!), row(D[3]!)],
      C: [],
      L: [row(D[4]!)],
    };
    const dates = (r: Rows) =>
      Object.fromEntries(Object.entries(r).map(([t, l]) => [t, l.map((b) => b.date)]));
    expect(dates(upTo(rows, D[2]!))).toEqual({ A: D.slice(0, 3), B: [D[0]], C: [], L: [] });
    // A date between two bars, before the first and after the last.
    expect(dates(upTo(rows, '2026-01-07')).B).toEqual([D[0]]);
    expect(dates(upTo(rows, '2026-01-01'))).toEqual({ A: [], B: [], C: [], L: [] });
    expect(dates(upTo(rows, '2026-02-01'))).toEqual(dates(rows));
  });

  it('compares signals exactly, numbers within the near-tie rule', () => {
    expect(signalsDiffer({ a: true, v: 1 }, { a: true, v: 1 + 1e-12 })).toEqual([]);
    expect(signalsDiffer({ a: true, v: 1 }, { a: false, v: 1.1 })).toEqual(['a', 'v']);
    expect(signalsDiffer(null, { a: true })).toEqual(['*']);
  });

  it('applies the safe state on a red day', async () => {
    const { db, version, runId } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    const s = await forward(db, { runId, sessions, to: D[4]! });
    expect(s).toMatchObject({ appended: 3, safeStateDays: 1 });
    expect(s.today[0]).toMatchObject({ allocation: 'Safe state', dataStatus: 'red' });
    const last = (await forwardRecord(db, version.id)).at(-1)!;
    expect(last).toMatchObject({
      date: '2026-01-09',
      safeStateApplied: true,
      holdings: [{ ticker: 'AAA', weight: 100 }],
    });
    expect(JSON.parse(last.payload).reasons).toContain('AAA2:B.close_match@s');
  });

  it('acceptance: a simulated red day reaches the owner as the safe-state alert', async () => {
    const { db, runId } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    const [owner] = await db.select().from(schema.users);
    await addChannel(db, owner!.id, { type: 'fake', target: 't', authSecret: 's'.repeat(32) });
    const texts: string[] = [];
    const notifier: Notifier = {
      info: { key: 'fake', kind: 'notifier', name: 'Fake', termsUrl: 'x', maxLength: 1000 },
      validTarget: () => true,
      send: async (_target, text) => void texts.push(text),
    };
    await forward(db, { runId, sessions, to: D[4]! });
    const quiet = { info() {}, warn() {} };
    await sendStrategyAlerts(db, {
      date: D[4]!,
      sessions,
      notifiers: [notifier],
      authSecret: 's'.repeat(32),
      context: () => ({ http: null as never, now: new Date(), log: quiet }),
      log: quiet,
    });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Trend: safe state for 2026-01-09');
    expect(texts[0]).toContain('Target: AAA 100%.');
    expect(texts[0]).toContain('Trade at the US open on 2026-01-12.');
    expect(texts[0]).toContain('Data health: red');
  });
});
