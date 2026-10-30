import { Sessions } from '@saku/data';
import {
  addChannel,
  annotate,
  appendForward,
  channelsOf,
  createUser,
  recordAlertSent,
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
  JOB_FAILURE_LINE_LENGTH,
  type DayEntry,
  describeReason,
  jobFailureLines,
  sendDataHealthAdmin,
  sendDayAlert,
  sendJobFailure,
  sendRevisions,
  sendStandInCorrections,
  sendStrategyAlerts,
  sendUpdateFailed,
  standInDetail,
} from './alerts';
import { parseVersion } from './forward';

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

function fakeNotifier(fail = false, maxLength = 1000) {
  const sent: { target: string; text: string }[] = [];
  const notifier: Notifier = {
    info: { key: 'fake', kind: 'notifier', name: 'Fake', termsUrl: 'x', maxLength },
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
    const o = { ...options(notifier, '2026-01-05'), job: 'daily', failures: ['x'] };
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
      failures: ['incomplete: tiingo'],
    };
    expect((await sendJobFailure(db, o)).sent).toBe(1);
    expect((await sendJobFailure(db, o)).sent).toBe(0);
    expect(sent).toEqual([
      {
        target: 'ops',
        text: [
          'Saku: the daily run for 2026-01-05 did not finish',
          'Details (1):',
          '- incomplete: tiingo',
          'It runs again at the next hourly check. The job log on the server has the details.',
          'Data health: unknown (the run did not finish).',
        ].join('\n'),
      },
    ]);
  });

  it('lists 5 failures one per line and counts the rest exactly (EN, JA)', async () => {
    const failures = Array.from({ length: 7 }, (_, i) => `Version ${i + 1} (v${i + 1}): broken`);
    for (const [language, details, more] of [
      [
        'en',
        'Details (7):',
        "...and 2 more. The full list is in the run's error (job_runs.error) and the job log on the server.",
      ],
      [
        'ja',
        '詳細(7 件):',
        'ほか 2 件。全件は実行記録のエラー欄(job_runs.error)とサーバーのジョブログにあります。',
      ],
    ] as const) {
      const { db, owner } = await setup(language);
      await setSetting(db, 'forward_records_from', '2026-01-05');
      await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
      const { notifier, sent } = fakeNotifier(false, 2000);
      const o = { ...options(notifier, '2026-01-05'), job: 'daily', failures };
      expect((await sendJobFailure(db, o)).sent).toBe(1);
      const t = translator(language);
      expect(sent[0]!.text.split('\n')).toEqual([
        t('alerts.jobFailure.title', { job: 'daily', date: '2026-01-05' }),
        details,
        ...failures.slice(0, 5).map((f) => `- ${f}`),
        more,
        t('alerts.jobFailure.body'),
        t('alerts.health.unknown'),
      ]);
    }
  });

  it('cuts a very long reason on its own line with a mark, keeping the next one', () => {
    const t = translator('en');
    const long = `AAA: ${'x'.repeat(500)}\n    at stack line`;
    const lines = jobFailureLines(
      t,
      { job: 'daily', date: '2026-01-05', failures: [long, 'incomplete: s'] },
      Infinity,
    );
    expect(lines[2]).toHaveLength(JOB_FAILURE_LINE_LENGTH);
    expect(lines[2]).toMatch(/^- AAA: x+…$/);
    expect(lines[3]).toBe('- incomplete: s');
    // A newline inside a reason never starts a line of its own; an empty reason is not blank.
    const flat = jobFailureLines(
      t,
      { job: 'daily', date: '2026-01-05', failures: ['a\n  b', '  '] },
      Infinity,
    );
    expect(flat.slice(2, 4)).toEqual(['- a b', '- unknown']);
    // No stated reason: still a failure, never an empty list.
    expect(
      jobFailureLines(t, { job: 'daily', date: '2026-01-05', failures: [] }, Infinity),
    ).toEqual([
      t('alerts.jobFailure.title', { job: 'daily', date: '2026-01-05' }),
      t('alerts.jobFailure.failed', { count: 1 }),
      '- unknown',
      t('alerts.jobFailure.body'),
    ]);
  });

  it('fits the smallest notifier (Discord 2000) as listed, and lists fewer on a smaller one', async () => {
    // Worst case: every line at its longest, the longest health line, both languages.
    const failures = Array.from({ length: 9 }, () => 'x'.repeat(5000));
    for (const language of ['en', 'ja']) {
      const t = translator(language);
      const health = Math.max(
        ...['green', 'yellow', 'red', 'unknown'].map(
          (s) =>
            `${t(`alerts.health.${s}`)} ${t('alerts.healthDate', { date: '2026-01-05' })}`.length,
        ),
      );
      const lines = jobFailureLines(t, { job: 'weekly', date: '2026-01-05', failures }, Infinity);
      expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(5);
      expect(lines.join('\n').length + 1 + health).toBeLessThanOrEqual(2000);
    }
    // A 1000-character channel: fewer lines listed, the rest counted, nothing cut at the end.
    const { db, owner } = await setup();
    await setSetting(db, 'forward_records_from', '2026-01-05');
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier(false, 1000);
    const o = { ...options(notifier, '2026-01-05'), job: 'daily', failures };
    expect((await sendJobFailure(db, o)).sent).toBe(1);
    const text = sent[0]!.text;
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.endsWith('Data health: unknown (the run did not finish).')).toBe(true);
    const shown = text.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(5);
    expect(text).toContain(`...and ${9 - shown} more.`);
  });
});

describe('revisions alert', () => {
  const revision = {
    source: 'fred',
    field: 'value',
    count: 1,
    from: '2026-01-05',
    to: '2026-01-05',
  };

  it.each(['en', 'ja'])(
    'tells a withdrawn value as its own kind, never as a changed one (%s)',
    async (language) => {
      const { db, owner } = await setup(language);
      await setSetting(db, 'forward_records_from', '2026-01-05');
      await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
      const { notifier, sent } = fakeNotifier();
      const t = translator(language);
      const base = options(notifier, '2026-01-06');
      const withdrawn = { ...revision, ticker: 'CASH', kind: 'withdrawn' as const };
      // Withdrawals only: no "changed ... recomputed with the new ones" line.
      expect((await sendRevisions(db, { ...base, runId: 'r1', revisions: [withdrawn] })).sent).toBe(
        1,
      );
      const items = 'CASH value@fred 1 (2026-01-05)';
      expect(sent[0]!.text.split('\n').slice(0, 2)).toEqual([
        t('alerts.revisions.title', { count: 1 }),
        t('alerts.revisions.withdrawn', { items }),
      ]);
      // Both kinds: each in its own line.
      const changed = { ...revision, ticker: 'IDX' };
      await sendRevisions(db, { ...base, runId: 'r2', revisions: [changed, withdrawn] });
      expect(sent[1]!.text.split('\n').slice(0, 3)).toEqual([
        t('alerts.revisions.title', { count: 2 }),
        t('alerts.revisions.body', { items: 'IDX value@fred 1 (2026-01-05)' }),
        t('alerts.revisions.withdrawn', { items }),
      ]);
    },
  );

  it('says the source no longer has a value, in both languages', () => {
    expect(translator('en')('alerts.revisions.withdrawn', { items: 'X' })).toMatch(
      /no longer has a value/,
    );
    expect(translator('ja')('alerts.revisions.withdrawn', { items: 'X' })).toMatch(
      /値がもうありません/,
    );
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

describe('drill messages (pnpm drill)', () => {
  const DATE = '2026-01-05';
  const red: DayEntry = {
    date: DATE,
    allocation: 'Safe state',
    holdings: [{ ticker: 'CASH_USD', weight: 100 }],
    dataStatus: 'red',
    safeStateApplied: true,
    reasons: ['AAA:A.large_move@p'],
  };
  const sentRows = async (db: Awaited<ReturnType<typeof setup>>['db']) =>
    (await db.select().from(schema.alertsSent)).length;

  it('delivers although the day was already told, and records nothing', async () => {
    const { db, owner, version } = await setup();
    await setSetting(db, 'forward_records_from', DATE);
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const channels = await channelsOf(db, owner);
    // The day's alerts were already sent and recorded on both channels.
    for (const channel of channels) {
      await recordAlertSent(db, channel, { subject: version.id, date: DATE, type: 'data_red' });
    }
    const ops = channels.find((c) => c.admin)!;
    await recordAlertSent(db, ops, { subject: 'data', date: DATE, type: 'data_health' });
    expect(await sentRows(db)).toBe(3);
    const parsed = parseVersion(version);
    if ('error' in parsed) throw new Error(parsed.error);
    const d = { version, strategy: parsed.strategy, day: red };

    // Without the drill flag the rows hold: nothing is sent again.
    const real = fakeNotifier();
    const o = options(real.notifier, DATE);
    expect(await sendDayAlert(db, o, d)).toEqual({ sent: 0, failed: [] });
    expect(await sendDataHealthAdmin(db, { ...o, health: 'red', reasons: ['AAA'] })).toEqual({
      sent: 0,
      failed: [],
    });

    // The drill sends to both channels anyway, marked, and the rows are as they were.
    const { notifier, sent } = fakeNotifier();
    const drill = { ...options(notifier, DATE), drill: true };
    expect(await sendDayAlert(db, drill, d)).toEqual({ sent: 2, failed: [] });
    expect(await sendDataHealthAdmin(db, { ...drill, health: 'red', reasons: ['AAA'] })).toEqual({
      sent: 1,
      failed: [],
    });
    expect(sent.map((m) => m.target).sort()).toEqual(['chat-1', 'ops', 'ops']);
    expect(sent.every((m) => m.text.startsWith('[DRILL] '))).toBe(true);
    expect(await sentRows(db)).toBe(3);
  });

  it('fits the channel with the mark, keeping the count line and the health line', async () => {
    const t = translator('en');
    const { db, owner } = await setup();
    await setSetting(db, 'forward_records_from', DATE);
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const failures = Array.from({ length: 9 }, () => 'x'.repeat(5000));
    const { notifier, sent } = fakeNotifier(false, 1000);
    const o = { ...options(notifier, DATE), drill: true, job: 'daily', failures };
    expect((await sendJobFailure(db, o)).sent).toBe(1);
    const text = sent[0]!.text;
    const lines = text.split('\n');
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(lines[0]).toBe(`[DRILL] Saku: the daily run for ${DATE} did not finish`);
    expect(lines[1]).toBe(t('alerts.drill.body'));
    expect(text.endsWith('Data health: unknown (the run did not finish).')).toBe(true);
    const shown = lines.filter((l) => l.startsWith('- ')).length;
    expect(shown).toBeGreaterThan(0);
    expect(text).toContain(`...and ${9 - shown} more.`);
  });

  it('cuts the alert, not the mark, on a small channel', async () => {
    const t = translator('en');
    const { db, version } = await setup();
    const parsed = parseVersion(version);
    if ('error' in parsed) throw new Error(parsed.error);
    const day = { ...red, reasons: Array.from({ length: 40 }, (_, i) => `T${i}:A.large_move@p`) };
    for (const max of [300, 40]) {
      const { notifier, sent } = fakeNotifier(false, max);
      const drill = { ...options(notifier, DATE), drill: true };
      expect(
        (await sendDayAlert(db, drill, { version, strategy: parsed.strategy, day })).sent,
      ).toBe(1);
      const text = sent[0]!.text;
      expect(text.length).toBeLessThanOrEqual(max);
      expect(text.startsWith('[DRILL] ')).toBe(true);
      expect(text.endsWith('…')).toBe(true);
      // Room for the mark and its line: both whole, the alert cut after them.
      if (max === 300) expect(text.split('\n')[1]).toBe(t('alerts.drill.body'));
    }
  });
});

describe('stand-in correction alerts (requirements 04, the stand-in rule 4)', () => {
  const DAY = '2026-01-05';
  type TestDb = Awaited<ReturnType<typeof setup>>['db'];
  const note = (db: TestDb, versionId: string, detail: Record<string, unknown> = {}, date = DAY) =>
    annotate(db, {
      versionId,
      date,
      kind: 'stand_in_corrected',
      detail: {
        ticker: 'AAA',
        deviation: 1 / 0.99 - 1,
        recordedAllocation: 'Calm',
        correctedAllocation: 'Risk on',
        differs: true,
        ...detail,
      } as never,
      runId: null,
    });

  it("tells the version's owner once, in English, with the latest day's data health", async () => {
    const { db, version, day } = await setup();
    await day(DAY, 'Calm', { status: 'yellow', reasons: ['AAA:stand_in@s'] });
    await day('2026-01-06', 'Risk on');
    await note(db, version.id);
    const { notifier, sent } = fakeNotifier();
    expect(await sendStandInCorrections(db, options(notifier, '2026-01-06'))).toEqual({
      sent: 1,
      failed: [],
      errors: [],
    });
    expect(sent).toEqual([
      {
        target: 'chat-1',
        text: [
          'Trend: correction to the signal of 2026-01-05',
          "The signal of 2026-01-05 used a secondary price for AAA that was off by 1.01% from the primary's price, which arrived later.",
          'Recorded allocation: Calm. With the corrected price it would have been Risk on. The record is annotated, not changed.',
          'This is about a past day, not a new signal: the latest signal gives the current allocation.',
          'Data health: green. (Latest recorded day, 2026-01-06.)',
        ].join('\n'),
      },
    ]);
    // Not repeated, also when a later run reads the same annotation.
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-07'))).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('in Japanese; an unchanged signal is said to be unchanged, the safe state by its name', async () => {
    const { db, version, day } = await setup('ja');
    await day(DAY, 'Calm', { status: 'yellow' });
    await note(db, version.id, {
      ticker: 'BBB',
      deviation: 0.0006,
      correctedAllocation: 'Calm',
      differs: false,
    });
    await note(db, version.id, { recordedAllocation: 'Safe state', correctedAllocation: 'Calm' });
    const { notifier, sent } = fakeNotifier();
    expect((await sendStandInCorrections(db, options(notifier, DAY))).sent).toBe(2);
    expect(sent[0]!.text).toBe(
      [
        'Trend: 2026-01-05 のシグナルの訂正',
        '2026-01-05 のシグナルは BBB の代替価格(副ソース)を使いましたが、後から届いた主ソースの価格と 0.06% ずれていました。',
        '記録された配分: Calm。訂正後の価格でも同じで、シグナルは変わりませんでした。',
        '過去の日についてのお知らせで、新しいシグナルではありません。現在の配分は最新のシグナルのとおりです。',
        'データ状態: 黄(警告付きで計算)。 (最新の記録日 2026-01-05)',
      ].join('\n'),
    );
    // Per ticker: the same version and date for another ticker is its own alert.
    expect(sent[1]!.text.split('\n')[2]).toBe(
      '記録された配分: セーフステート。訂正後の価格なら Calm になっていました。記録は変更せず、注記を付けました。',
    );
    // The English text for an unchanged signal.
    const en = await setup();
    await en.day(DAY, 'Calm');
    await note(en.db, en.version.id, { correctedAllocation: 'Calm', differs: false });
    const other = fakeNotifier();
    await sendStandInCorrections(en.db, options(other.notifier, DAY));
    expect(other.sent[0]!.text.split('\n')[2]).toBe(
      'Recorded allocation: Calm. With the corrected price it would have been the same: the signal would not have changed.',
    );
  });

  it('a failed delivery is caught up at the next call, then not repeated', async () => {
    const { db, version, day } = await setup();
    await day(DAY, 'Calm');
    await note(db, version.id);
    const broken = fakeNotifier(true);
    const r = await sendStandInCorrections(db, options(broken.notifier, DAY));
    expect(r.sent).toBe(0);
    expect(r.failed[0]).toMatch(/Fake: HTTP 500$/);
    expect(await db.select().from(schema.alertsSent)).toEqual([]);
    const { notifier, sent } = fakeNotifier();
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-06'))).sent).toBe(1);
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-06'))).sent).toBe(0);
    expect(sent).toHaveLength(1);
    const [row] = await db.select().from(schema.alertsSent);
    expect(row).toMatchObject({
      subject: `stand_in:${version.id}:AAA`,
      date: DAY,
      type: 'stand_in_corrected',
    });
  });

  it("a library version's correction goes to the admins' channels only", async () => {
    const { db, owner } = await setup('ja');
    await setSetting(db, 'forward_records_from', DAY);
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const library = await registerVersion(db, { ownerId: null, name: 'Library', strategy });
    await appendForward(
      db,
      library,
      {
        date: DAY,
        allocation: 'Calm',
        holdings: [{ ticker: 'CASH_USD', weight: 100 }],
        safeStateApplied: false,
        dataStatus: 'yellow',
        equity: 1,
        detail: { reasons: [] },
      },
      null,
    );
    await note(db, library.id);
    const { notifier, sent } = fakeNotifier();
    expect((await sendStandInCorrections(db, options(notifier, DAY))).sent).toBe(1);
    expect(sent.map((m) => m.target)).toEqual(['ops']);
    expect(sent[0]!.text.split('\n')[0]).toBe('Library: 2026-01-05 のシグナルの訂正');
    expect(sent[0]!.text.split('\n').at(-1)).toBe(
      'データ状態: 黄(警告付きで計算)。 (最新の記録日 2026-01-05)',
    );
    expect((await sendStandInCorrections(db, options(notifier, DAY))).sent).toBe(0);
  });

  it('fits the channel: the first lines kept, the health line whole at the end', async () => {
    const { db, version, day } = await setup();
    await day(DAY, 'Calm');
    await note(db, version.id, { correctedAllocation: 'R'.repeat(3000) });
    for (const max of [2000, 200]) {
      const { notifier, sent } = fakeNotifier(false, max);
      await db.delete(schema.alertsSent);
      expect((await sendStandInCorrections(db, options(notifier, DAY))).sent).toBe(1);
      const text = sent[0]!.text;
      const lines = text.split('\n');
      expect(text.length).toBeLessThanOrEqual(max);
      expect(lines[0]).toBe('Trend: correction to the signal of 2026-01-05');
      expect(lines.at(-1)).toBe('Data health: green. (Latest recorded day, 2026-01-05.)');
      expect(lines.at(-2)!.endsWith('…')).toBe(true);
    }
  });

  it('a detail that does not read back is reported, never told with a guessed value', async () => {
    const { db, version, day } = await setup();
    await day(DAY, 'Calm');
    await note(db, version.id, { deviation: null });
    await note(db, version.id, { ticker: 'BBB', differs: false });
    const { notifier, sent } = fakeNotifier();
    const r = await sendStandInCorrections(db, options(notifier, DAY));
    expect(r.sent).toBe(0);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(
      /^Trend \(.+\) 2026-01-05: stand-in correction annotation \d+ does not read back; not told$/,
    );
    expect(sent).toEqual([]);
    expect(
      standInDetail({
        ticker: 'A',
        deviation: -0.1,
        recordedAllocation: 'x',
        correctedAllocation: 'y',
        differs: true,
      }),
    ).toBeNull();
    expect(
      standInDetail({
        ticker: 'A',
        deviation: Number.NaN,
        recordedAllocation: 'x',
        correctedAllocation: 'y',
        differs: true,
      }),
    ).toBeNull();
    expect(standInDetail(null)).toBeNull();
  });

  it('a drill sends none and records nothing', async () => {
    const { db, version, day } = await setup();
    await day(DAY, 'Calm');
    await note(db, version.id);
    const { notifier, sent } = fakeNotifier();
    const drill = { ...options(notifier, DAY), drill: true };
    expect(await sendStandInCorrections(db, drill)).toEqual({ sent: 0, failed: [], errors: [] });
    expect(sent).toEqual([]);
    expect(await db.select().from(schema.alertsSent)).toEqual([]);
  });
});
