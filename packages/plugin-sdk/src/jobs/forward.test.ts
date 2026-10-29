import type { RawBar } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  addChannel,
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
import { describe, expect, it } from 'vitest';
import type { Notifier } from '../types';
import { sendRecomputeDiffers, sendStrategyAlerts } from './alerts';
import { type Rows, forward, reader, recompute, signalsDiffer, upTo } from './forward';
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
    const { annotationsOf } = await import('@saku/db');
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
