import { Sessions } from '@saku/data';
import {
  addChannel,
  appendForward,
  channelsOf,
  createUser,
  registerVersion,
  setChannelEnabled,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import type { Notifier } from '../types';
import { sendJobFailure, sendStrategyAlerts } from './alerts';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const SECRET = 'test-secret-test-secret-test-secret';
const strategy = {
  name: 'Trend',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  execution: 'next_open',
  signals: [],
  allocations: [{ name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] }],
};

function fakeNotifier(fail = false) {
  const sent: { target: string; text: string }[] = [];
  const notifier: Notifier = {
    info: { key: 'fake', kind: 'notifier', name: 'Fake', termsUrl: 'x', maxLength: 1000 },
    validTarget: () => true,
    send: async (target, text) => {
      if (fail) throw new Error('Fake: HTTP 500');
      sent.push({ target, text });
    },
  };
  return { notifier, sent };
}

async function setup(language: string | null = null) {
  const db = await testDb();
  const owner = await createUser(db, {
    username: 'alex',
    passwordHash: 'x',
    totpSecretEnc: 'x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  if (language) {
    const { schema } = await import('@saku/db');
    await db.update(schema.users).set({ language });
  }
  const version = await registerVersion(db, { ownerId: owner, name: 'Trend', strategy });
  await addChannel(db, owner, { type: 'fake', target: 'chat-1', authSecret: SECRET });
  const day = async (
    date: string,
    allocation: string,
    o: { status?: 'green' | 'yellow' | 'red'; safe?: boolean; reasons?: string[] } = {},
  ) =>
    appendForward(
      db,
      version,
      {
        date,
        allocation,
        holdings: o.safe
          ? [{ ticker: 'AAA', weight: 100 }]
          : [{ ticker: allocation === 'Calm' ? 'CASH_USD' : 'AAA2', weight: 100 }],
        safeStateApplied: o.safe ?? false,
        dataStatus: o.status ?? 'green',
        equity: 1,
        detail: { reasons: o.reasons ?? [] },
      },
      null,
    );
  return { db, owner, version, day };
}

const options = (notifier: Notifier, date: string) => ({
  date,
  sessions,
  notifiers: [notifier],
  authSecret: SECRET,
  context: () => ({ http: null as never, now: new Date(), log: { info() {}, warn() {} } }),
  log: { info() {}, warn() {} },
});

describe('strategy alerts', () => {
  it('tells a new channel the state, then only changes, once per day', async () => {
    const { db, day } = await setup();
    const { notifier, sent } = fakeNotifier();
    await day('2026-01-05', 'Calm');
    expect(await sendStrategyAlerts(db, options(notifier, '2026-01-05'))).toEqual({
      sent: 1,
      failed: [],
    });
    expect(sent[0]!.target).toBe('chat-1');
    expect(sent[0]!.text).toBe(
      [
        'Trend: new allocation',
        'First recorded allocation: Calm (signal of 2026-01-05).',
        'Target: Cash (USD) 100%.',
        'Trade at the US open on 2026-01-06.',
        'Data health: green.',
      ].join('\n'),
    );
    expect((await sendStrategyAlerts(db, options(notifier, '2026-01-05'))).sent).toBe(0);
    await day('2026-01-06', 'Calm');
    expect((await sendStrategyAlerts(db, options(notifier, '2026-01-06'))).sent).toBe(0);
    // Two days caught up in one run (Friday then Monday): the change is still reported.
    await day('2026-01-09', 'Risk on');
    await day('2026-01-12', 'Risk on');
    await sendStrategyAlerts(db, options(notifier, '2026-01-12'));
    expect(sent[1]!.text).toContain('Calm → Risk on (signal of 2026-01-12).');
    expect(sent[1]!.text).toContain('Trade at the US open on 2026-01-13.');
  });

  it('gives the safe state with exact instructions on a red day, then the way back', async () => {
    const { db, day } = await setup();
    const { notifier, sent } = fakeNotifier();
    await day('2026-01-05', 'Risk on');
    await sendStrategyAlerts(db, options(notifier, '2026-01-05'));
    await day('2026-01-06', 'Safe state', {
      status: 'red',
      safe: true,
      reasons: ['AAA2:B.close_match@s'],
    });
    await sendStrategyAlerts(db, options(notifier, '2026-01-06'));
    expect(sent[1]!.text).toBe(
      [
        'Trend: safe state for 2026-01-06',
        "Data is not reliable enough for a normal signal, so the strategy's safe state applies.",
        'Target: AAA 100%.',
        'Trade at the US open on 2026-01-07.',
        'Data health: red (no normal signal).',
        'Details: AAA2:B.close_match@s.',
      ].join('\n'),
    );
    await day('2026-01-07', 'Risk on');
    await sendStrategyAlerts(db, options(notifier, '2026-01-07'));
    expect(sent[2]!.text).toContain('Safe state → Risk on');
  });

  it('warns on yellow without a change, in the owner language', async () => {
    const { db, day } = await setup('ja');
    const { notifier, sent } = fakeNotifier();
    await day('2026-01-05', 'Calm');
    await sendStrategyAlerts(db, options(notifier, '2026-01-05'));
    await day('2026-01-06', 'Calm', { status: 'yellow', reasons: ['AAA:C.tracking'] });
    await sendStrategyAlerts(db, options(notifier, '2026-01-06'));
    expect(sent[0]!.text).toContain('目標: 現金(USD) 100%。');
    expect(sent[1]!.text).toBe(
      [
        'Trend: 2026-01-06 のデータ警告',
        'シグナルは計算されましたが、一部のデータに警告があります。配分: Calm。',
        'データ状態: 黄(警告付きで計算)。',
        '詳細: AAA:C.tracking。',
      ].join('\n'),
    );
  });

  it('retries a failed delivery on the next run and skips disabled channels', async () => {
    const { db, owner, day } = await setup();
    await day('2026-01-05', 'Calm');
    const broken = fakeNotifier(true);
    const r = await sendStrategyAlerts(db, options(broken.notifier, '2026-01-05'));
    expect(r.sent).toBe(0);
    expect(r.failed[0]).toMatch(/Fake: HTTP 500$/);
    const { notifier, sent } = fakeNotifier();
    expect((await sendStrategyAlerts(db, options(notifier, '2026-01-05'))).sent).toBe(1);
    const [channel] = await channelsOf(db, owner);
    await setChannelEnabled(db, owner, channel!.id, false);
    await day('2026-01-06', 'Risk on');
    expect((await sendStrategyAlerts(db, options(notifier, '2026-01-06'))).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe('channels', () => {
  it('stores targets encrypted and scopes them to the owner', async () => {
    const { db, owner } = await setup();
    const other = await createUser(db, {
      username: 'blake',
      passwordHash: 'x',
      totpSecretEnc: 'x',
      totpLastStep: 1,
      backupCodeHashes: ['b'],
      isAdmin: false,
    });
    const { schema } = await import('@saku/db');
    const [row] = await db.select().from(schema.notificationChannels);
    expect(row!.targetEnc).not.toContain('chat-1');
    expect(await channelsOf(db, other)).toEqual([]);
    await expect(setChannelEnabled(db, other, row!.id, false)).rejects.toThrow();
    await expect(
      addChannel(db, other, { type: 'fake', target: 'x', admin: true, authSecret: SECRET }),
    ).rejects.toThrow(/admins/);
    expect((await channelsOf(db, owner))[0]!.enabled).toBe(true);
  });
});

describe('job failure alerts', () => {
  it('goes to admin channels once per job and day', async () => {
    const { db, owner } = await setup();
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    const o = {
      ...options(notifier, '2026-01-05'),
      job: 'daily',
      error: 'incomplete: tiingo\nstack',
    };
    expect((await sendJobFailure(db, o)).sent).toBe(1);
    expect((await sendJobFailure(db, o)).sent).toBe(0);
    expect(sent).toEqual([
      {
        target: 'ops',
        text: [
          'Saku: the daily run for 2026-01-05 did not finish',
          'Reason: incomplete: tiingo. It runs again at the next hourly check. The job log on the server has the details.',
          'Data health: unknown (the run did not finish).',
        ].join('\n'),
      },
    ]);
  });
});
