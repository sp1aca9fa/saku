import { Sessions } from '@saku/data';
import {
  addChannel,
  appendForward,
  channelsOf,
  createUser,
  registerVersion,
  schema,
  setChannelEnabled,
  setSetting,
  startRun,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import type { Notifier } from '../types';
import { translator } from '@saku/content';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeReason,
  sendDataHealthAdmin,
  sendJobFailure,
  sendStrategyAlerts,
  sendUpdateFailed,
} from './alerts';

// Every check id in packages/data, read from its source so a new check needs a text.
const dataSrc = join(dirname(fileURLToPath(import.meta.url)), '../../../data/src');
/** The check names in the data package's files (`issuer.ts`: layer D, with texts of its own). */
const checksIn = (keep: (file: string) => boolean) => [
  ...new Set(
    readdirSync(dataSrc)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && keep(f))
      .flatMap((f) => [...readFileSync(join(dataSrc, f), 'utf8').matchAll(/check: '(\w+)'/g)])
      .map((m) => m[1]!),
  ),
];
const CHECKS = checksIn((f) => f !== 'issuer.ts');
const ISSUER_CHECKS = checksIn((f) => f === 'issuer.ts');

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
        'Details: AAA2: closes differ between sources (s).',
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
    await day('2026-01-06', 'Calm', { status: 'yellow', reasons: ['AAA:C.index_match@idx'] });
    await sendStrategyAlerts(db, options(notifier, '2026-01-06'));
    expect(sent[0]!.text).toContain('目標: 現金(USD) 100%。');
    expect(sent[1]!.text).toBe(
      [
        'Trend: 2026-01-06 のデータ警告',
        'シグナルは計算されましたが、一部のデータに警告があります。配分: Calm。',
        'データ状態: 黄(警告付きで計算)。',
        '詳細: AAA: ファンドが指数に連動していません(idx)。',
      ].join('\n'),
    );
  });

  it('a version that no longer parses gets no alert and is reported; the others are told', async () => {
    const { db, owner, day } = await setup();
    const broken = await registerVersion(db, {
      ownerId: owner,
      name: 'Old',
      strategy: {
        ...strategy,
        safeState: {
          holdings: [
            { ticker: 'AAA', weight: 50 },
            { ticker: 'AAA', weight: 50 },
          ],
        },
      },
    });
    await appendForward(
      db,
      broken,
      {
        date: '2026-01-05',
        allocation: 'Calm',
        holdings: [{ ticker: 'CASH_USD', weight: 100 }],
        safeStateApplied: false,
        dataStatus: 'green',
        equity: 1,
        detail: { reasons: [] },
      },
      null,
    );
    await day('2026-01-05', 'Calm');
    const { notifier, sent } = fakeNotifier();
    const r = await sendStrategyAlerts(db, options(notifier, '2026-01-05'));
    expect(r.sent).toBe(1);
    expect(sent[0]!.text).toMatch(/^Trend: /);
    expect(r.failed).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Old \\(${broken.id}\\): definition does not parse: .*"AAA" is listed twice`,
          's',
        ),
      ),
    ]);
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

describe('admin alerts', () => {
  it('waits for the A1 gate', async () => {
    const { db, owner } = await setup();
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    const o = { ...options(notifier, '2026-01-05'), job: 'daily', error: 'x' };
    expect((await sendJobFailure(db, o)).sent).toBe(0);
    await setSetting(db, 'forward_records_from', '2026-01-05');
    expect((await sendJobFailure(db, o)).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('reports a failed update and a non-green day with the latest data health', async () => {
    const { db, owner } = await setup('ja');
    await setSetting(db, 'forward_records_from', '2026-01-05');
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    const base = options(notifier, '2026-01-05');
    const update = { ...base, from: 'abc1234', to: 'def5678', step: 'check', stuck: false };
    expect((await sendUpdateFailed(db, update)).sent).toBe(1);
    expect((await sendUpdateFailed(db, update)).sent).toBe(0);
    expect(sent[0]!.text).toBe(
      [
        'Saku: def5678 への更新が check の段階で失敗しました',
        'サーバーは abc1234 に戻り、そのまま動作しています。新しいバージョンがプッシュされると再試行します。詳細はサーバーの更新ログにあります。',
        'データ状態: 不明(処理が完了していません)。',
      ].join('\n'),
    );
    await sendDataHealthAdmin(db, {
      ...base,
      health: 'yellow',
      reasons: ['AAA', 'DTB3:stale(3)@fred'],
    });
    expect(sent[1]!.text).toContain(
      '緑でない項目: AAA: 緑ではありません; DTB3: 3 営業日遅れています(fred)。',
    );
    expect(sent[1]!.text).toContain('データ状態: 黄');
    // Only admin channels: the owner's ordinary channel got none of these.
    expect(sent.every((m) => m.target === 'ops')).toBe(true);
  });

  it("states the latest grade of the latest date: a weekly pass's green over an older daily red", async () => {
    const { db, owner } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const T = '2026-01-06';
    const daily = await startRun(db, 'daily', new Date('2026-01-07T01:00:00Z'));
    await db.insert(schema.dataHealth).values([
      { runId: daily, date: '2026-01-05', symbolId: null, status: 'green', reasons: [] },
      { runId: daily, date: T, symbolId: null, status: 'red', reasons: ['AAA'] },
    ]);
    // The weekly refetch corrected the data: full passes store the overall row, green included.
    const weekly = await startRun(db, 'weekly', new Date('2026-01-10T15:00:00Z'));
    await db.insert(schema.dataHealth).values([
      { runId: weekly, date: '2026-01-05', symbolId: null, status: 'green', reasons: [] },
      { runId: weekly, date: T, symbolId: null, status: 'green', reasons: [] },
    ]);
    const { notifier, sent } = fakeNotifier();
    const update = {
      ...options(notifier, T),
      from: 'abc1234',
      to: 'def5678',
      step: 'check',
      stuck: false,
    };
    expect((await sendUpdateFailed(db, update)).sent).toBe(1);
    const t = translator('en');
    expect(sent[0]!.text.split('\n').at(-1)).toBe(
      `${t('alerts.health.green')} ${t('alerts.healthDate', { date: T })}`,
    );
  });

  it('goes to admin channels once per job and day', async () => {
    const { db, owner } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
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

describe('reason codes in words', () => {
  const t = translator('en');
  it('covers the codes the checks and the forward record produce', () => {
    expect(describeReason(t, 'SPY:B.close_match@alpaca')).toBe(
      'SPY: closes differ between sources (alpaca)',
    );
    // A secondary without a bar is not a disagreement.
    expect(describeReason(t, 'SPY:B.secondary_missing@alpaca')).toBe(
      'SPY: no bar from alpaca for this day',
    );
    expect(describeReason(translator('ja'), 'SPY:B.secondary_missing@alpaca')).toBe(
      'SPY: alpaca にこの日のデータがありません',
    );
    expect(describeReason(t, 'stand_in@yahoo')).toBe(
      'the main source was missing; yahoo stands in',
    );
    expect(describeReason(t, 'UPRO:stand_in_refused:layer_c')).toBe(
      'UPRO: the main source was missing and no stand-in passed the checks',
    );
    expect(describeReason(t, 'DTB3:missing@none')).toBe('DTB3: no value yet (none)');
    expect(describeReason(t, 'SSO:decision_margin')).toBe(
      'SSO: a stand-in price is too close to a signal threshold',
    );
    expect(describeReason(t, 'evaluation:no bar for SPY')).toBe(
      'the strategy could not be evaluated (no bar for SPY)',
    );
    expect(describeReason(t, 'SPY')).toBe('SPY: not green');
    expect(describeReason(t, 'SPY:Z.unknown@x')).toBe('SPY:Z.unknown@x');
  });

  it('has a text for every check the data package runs', async () => {
    const { hasText } = await import('@saku/content');
    expect(CHECKS.length).toBeGreaterThan(5);
    for (const check of CHECKS) expect(hasText(`alerts.reason.check.${check}`), check).toBe(true);
    expect(ISSUER_CHECKS.sort()).toEqual([
      'distribution_match',
      'issuer_stale',
      'nav_premium',
      'nav_tolerance_invalid',
      'split_match',
    ]);
    for (const check of ISSUER_CHECKS) {
      expect(hasText(`alerts.reason.issuer.${check}`), check).toBe(true);
    }
  });

  it('words layer D (issuer data) reasons as issuer checks', () => {
    expect(describeReason(t, 'SPY:D.nav_premium@iss')).toBe(
      "SPY: the market close is further from the issuer's NAV than usual (iss)",
    );
    expect(describeReason(t, 'SSO:D.split_match@iss')).toBe(
      "SSO: splits differ from the issuer's records (iss)",
    );
    expect(describeReason(t, 'SPY:D.issuer_stale@iss')).toBe(
      "SPY: the issuer's NAV is missing or more than one trading day old (iss)",
    );
    // Layer B keeps its own text for the same check name; an unknown layer D check stays a code.
    expect(describeReason(t, 'SSO:B.split_match@s1')).toBe(
      'SSO: splits differ between sources (s1)',
    );
    expect(describeReason(t, 'SPY:D.close_match@iss')).toBe('SPY:D.close_match@iss');
    expect(describeReason(t, 'issuer_unavailable@iss')).toBe(
      'issuer data could not be fetched (iss)',
    );
    expect(describeReason(t, 'issuer_nav_tolerance_invalid')).toMatch(/setting is invalid/);
    expect(describeReason(t, 'SPY:D.nav_tolerance_invalid@iss')).toMatch(/only observed \(iss\)$/);
    expect(describeReason(translator('ja'), 'SPY:D.distribution_match@iss')).toBe(
      'SPY: 分配金が発行体の記録と異なります(iss)',
    );
  });
});
