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
  upsertSymbols,
} from '@saku/db';
import { and, eq } from 'drizzle-orm';
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
  REVISION_ITEMS,
  describeReason,
  fitMessage,
  jobFailureParts,
  sendDataHealthAdmin,
  sendDayAlert,
  sendDiskSpace,
  sendIntegrityFailed,
  sendJobFailure,
  sendParityFailed,
  sendRecomputeDiffers,
  sendRevisions,
  sendStandInClosures,
  sendStandInReopened,
  sendStandInCorrections,
  sendStrategyAlerts,
  sendUpdateFailed,
  standInClosedDetail,
  standInClosedText,
  standInDetail,
  strategyAlert,
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

/** The job-failure lines fitted to `room` (no health line). */
const jobLines = (
  t: ReturnType<typeof translator>,
  o: Parameters<typeof jobFailureParts>[1],
  room: number,
) => fitMessage(jobFailureParts(t, o), room).text.split('\n');

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
  // Stage-a A2 (2026-11-01): admin-only operational alerts go out before the A1 gate.
  const disk = { databaseBytes: 2048, totalBytes: 1000, freeBytes: 250, usedPercent: 75 };
  const update = { from: 'abc1234', to: 'def5678', step: 'check', stuck: false };

  it.each([
    ['en', 'Data health: red.', 'Data health: red. (As of the last check, 2026-01-05.)'],
    ['ja', 'データ状態: 赤。', 'データ状態: 赤。 (最後のチェック 2026-01-05 時点)'],
  ])(
    'before the A1 gate: a failed run, a failed update and disk space reach admin channels once a day, the health line a grade only (%s)',
    async (language, given, latest) => {
      const { db, owner } = await setup(language);
      await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
      const run = await startRun(db, 'daily', new Date('2026-01-06T01:00:00Z'));
      await db
        .insert(schema.dataHealth)
        .values({ runId: run, date: '2026-01-05', symbolId: null, status: 'red', reasons: [] });
      const { notifier, sent } = fakeNotifier();
      const o = options(notifier, '2026-01-05');
      const job = { ...o, job: 'daily', failures: ['x'], health: 'red' };
      for (const send of [
        () => sendJobFailure(db, job),
        () => sendUpdateFailed(db, { ...o, ...update }),
        () => sendDiskSpace(db, { ...o, disk }),
      ]) {
        expect(await send()).toEqual({ sent: 1, failed: [] });
        expect(await send()).toEqual({ sent: 0, failed: [] });
      }
      // Only the admin channel; the owner's ordinary channel got none.
      expect(sent.map((m) => m.target)).toEqual(['ops', 'ops', 'ops']);
      // The grade as given or on record, never "no normal signal" before any signal is live.
      expect(sent.map((m) => m.text.split('\n').at(-1))).toEqual([given, latest, latest]);
      const t = translator(language);
      for (const m of sent) {
        expect(m.text).not.toContain(t('alerts.health.red'));
      }
      expect((await db.select().from(schema.alertsSent)).map((r) => r.type).sort()).toEqual([
        'disk_space',
        'job_failure',
        'update_failed',
      ]);
    },
  );

  it('before the A1 gate: no grade on record stays unknown', async () => {
    const { db, owner } = await setup();
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    expect((await sendDiskSpace(db, { ...options(notifier, '2026-01-05'), disk })).sent).toBe(1);
    expect(sent[0]!.text.split('\n').at(-1)).toBe(translator('en')('alerts.healthGrade.unknown'));
  });

  it('before the A1 gate: an undelivered operational alert is reported, not recorded, and retried', async () => {
    const { db, owner } = await setup();
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const down = fakeNotifier(true);
    const r = await sendDiskSpace(db, { ...options(down.notifier, '2026-01-05'), disk });
    expect(r.sent).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(await db.select().from(schema.alertsSent)).toEqual([]);
    const { notifier, sent } = fakeNotifier();
    expect((await sendDiskSpace(db, { ...options(notifier, '2026-01-05'), disk })).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('before the A1 gate every other admin alert waits; after it each one is sent', async () => {
    const { db, owner, version } = await setup();
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const DAY = '2026-01-05';
    const library = await registerVersion(db, { ownerId: null, name: 'Library', strategy });
    await appendForward(
      db,
      library,
      {
        date: DAY,
        allocation: 'Calm',
        holdings: [{ ticker: 'CASH_USD', weight: 100 }],
        safeStateApplied: false,
        dataStatus: 'green',
        equity: 1,
        detail: { reasons: [] },
      },
      null,
    );
    await annotate(db, {
      versionId: library.id,
      date: DAY,
      kind: 'stand_in_corrected',
      detail: {
        ticker: 'AAA',
        standInDate: DAY,
        deviation: 0.01,
        recordedAllocation: 'Calm',
        correctedAllocation: 'Risk on',
        differs: true,
      } as never,
      runId: null,
    });
    await annotate(db, {
      versionId: version.id,
      date: DAY,
      kind: 'recomputed',
      detail: { recordedAllocation: 'Calm', recomputedAllocation: 'Risk on', signalsDiffer: ['s'] },
      runId: null,
    });
    const revisions = [
      {
        ticker: 'IDX',
        source: 'fred',
        field: 'value',
        count: 1,
        from: DAY,
        to: DAY,
        kind: 'changed' as const,
      },
    ];
    const { notifier, sent } = fakeNotifier(false, 5000);
    const o = options(notifier, DAY);
    const gated = {
      dataHealth: () => sendDataHealthAdmin(db, { ...o, health: 'red', reasons: ['AAA'] }),
      revisions: () => sendRevisions(db, { ...o, runId: 'r', revisions }),
      integrity: () =>
        sendIntegrityFailed(db, {
          ...o,
          check: 'core_reference',
          versionId: version.id,
          detail: 'x',
        }),
      parity: () => sendParityFailed(db, { ...o, caseName: 'c', detail: 'x' }),
      recompute: () => sendRecomputeDiffers(db, o),
      standIn: () => sendStandInCorrections(db, o),
    };
    for (const send of Object.values(gated)) {
      expect(await send()).toMatchObject({ sent: 0, failed: [] });
    }
    expect(sent).toEqual([]);
    expect(await db.select().from(schema.alertsSent)).toEqual([]);
    // The same calls after the gate: each delivered, so the test above is not vacuous.
    await setSetting(db, 'forward_records_from', DAY);
    for (const send of Object.values(gated)) {
      expect(await send()).toMatchObject({ sent: 1, failed: [] });
    }
    expect(sent.map((m) => m.target)).toEqual(Array(6).fill('ops'));
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
    const lines = jobLines(
      t,
      { job: 'daily', date: '2026-01-05', failures: [long, 'incomplete: s'] },
      Infinity,
    );
    expect(lines[2]).toHaveLength(JOB_FAILURE_LINE_LENGTH);
    expect(lines[2]).toMatch(/^- AAA: x+…$/);
    expect(lines[3]).toBe('- incomplete: s');
    // A newline inside a reason never starts a line of its own; an empty reason is not blank.
    const flat = jobLines(
      t,
      { job: 'daily', date: '2026-01-05', failures: ['a\n  b', '  '] },
      Infinity,
    );
    expect(flat.slice(2, 4)).toEqual(['- a b', '- unknown']);
    // No stated reason: still a failure, never an empty list.
    expect(jobLines(t, { job: 'daily', date: '2026-01-05', failures: [] }, Infinity)).toEqual([
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
      const lines = jobLines(t, { job: 'weekly', date: '2026-01-05', failures }, Infinity);
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
    // A day without a decision names the operand and the day at fault (core `whyUndecided`).
    expect(describeReason(t, 'AAA:range_missing(parkinson)@2026-01-07')).toBe(
      'AAA: Parkinson volatility has no value: the open, high or low of 2026-01-07 is missing (never estimated)',
    );
    expect(describeReason(t, 'AAA:range_invalid(yang_zhang)@2026-01-07')).toMatch(
      /^AAA: Yang-Zhang volatility has no value: .* 2026-01-07 do not fit together/,
    );
    expect(describeReason(t, 'AAA:value_invalid(return)@2026-01-07')).toBe(
      'AAA: Return over N days has no value: a price of 2026-01-07 it reads is not positive or not a number',
    );
    expect(describeReason(t, 'AAA:warm_up(ema)')).toBe(
      'AAA: Exponential moving average (EMA) has no value yet: not enough history (warm-up)',
    );
    expect(describeReason(translator('ja'), 'AAA:range_missing(garman_klass)@2026-01-07')).toBe(
      'AAA: ガーマン・クラス・ボラティリティの値がありません: 2026-01-07 の始値・高値・安値のいずれかが欠けています(推定はしません)',
    );
    // What the signals read before the day (requirements 04 "Red in the lookback", stand-in 6).
    expect(describeReason(t, 'SPY:lookback_red@2026-11-03')).toBe(
      'SPY: the data of 2026-11-03, which the signals still read, is red (unreliable)',
    );
    expect(describeReason(t, 'SPY:lookback_missing@2026-11-03')).toBe(
      'SPY: the price of 2026-11-03, which the signals still read, is missing',
    );
    expect(describeReason(translator('ja'), 'SPY:lookback_missing@2026-11-03')).toBe(
      'SPY: シグナルがまだ参照している 2026-11-03 の価格がありません',
    );
    expect(describeReason(t, 'SPY:lookback_ungraded@2026-11-03')).toBe(
      'SPY: the data of 2026-11-03, which the signals still read, has not been checked',
    );
    // A dividend or split on a closed-day bar (requirements 04 "Closed-day bars").
    // It stays red from the next session on until corrected or resolved (C19).
    expect(describeReason(t, 'SPY:closed_day_event@2026-11-01')).toBe(
      'SPY: a dividend or split is dated 2026-11-01, a day the market was closed; it is in no ' +
        "price the signals read, so the fund's returns from then on cannot be trusted until the " +
        'source corrects it or an admin resolves it',
    );
    // A dividend a late-listing source has not listed yet, unconfirmed (C20).
    expect(describeReason(t, 'SPY:B.dividend_pending@alpaca')).toBe(
      'SPY: a dividend is not listed by alpaca yet and no other secondary source confirmed it',
    );
    expect(describeReason(translator('ja'), 'SPY:B.dividend_pending@alpaca')).toBe(
      'SPY: alpaca はこの分配金をまだ掲載しておらず、ほかの副ソースでも確認できていません',
    );
    expect(describeReason(translator('ja'), 'SPY:closed_day_event@2026-11-01')).toMatch(
      /^SPY: 市場の休場日である 2026-11-01 に配当または株式分割/,
    );
    expect(describeReason(t, 'SPY:stand_in_lookback@2026-11-03')).toBe(
      "SPY: the signals read a secondary source's price for 2026-11-03, not yet confirmed by the main source",
    );
    expect(describeReason(translator('ja'), 'SPY:lookback_red@2026-11-03')).toBe(
      'SPY: シグナルがまだ参照している 2026-11-03 のデータが赤(信頼できない)です',
    );
    expect(describeReason(translator('ja'), 'SPY:stand_in_lookback@2026-11-03')).toBe(
      'SPY: シグナルが参照する 2026-11-03 の価格は副ソースの値で、主ソースでまだ確認されていません',
    );
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

  it('counts the mark and its line: the alert whole with them, or not sent and reported', async () => {
    const t = translator('en');
    const { db, owner, version } = await setup();
    const parsed = parseVersion(version);
    if ('error' in parsed) throw new Error(parsed.error);
    // Without reasons: every line is one never cut.
    const d = { version, strategy: parsed.strategy, day: { ...red, reasons: [] } };
    const send = async (max: number) => {
      const { notifier, sent } = fakeNotifier(false, max);
      const summary = await sendDayAlert(db, { ...options(notifier, DATE), drill: true }, d);
      return { summary, sent };
    };
    const { sent: whole } = await send(100_000);
    const size = whole[0]!.text.length;
    const fits = await send(size);
    expect(fits.sent[0]!.text).toBe(whole[0]!.text);
    expect(fits.sent[0]!.text.split('\n')[1]).toBe(t('alerts.drill.body'));
    const small = await send(size - 1);
    expect(small.sent).toEqual([]);
    expect(small.summary.failed).toEqual([
      `fake channel ${(await channelsOf(db, owner))[0]!.id}: channel too small for the alert (${size} characters needed)`,
    ]);
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
        standInDate: date,
        deviation: 1 / 0.99 - 1,
        recordedAllocation: 'Calm',
        correctedAllocation: 'Risk on',
        differs: true,
        ...detail,
      } as never,
      runId: null,
    });
  const EN_LAST = [
    'This is about a past day, not a new signal: the latest signal gives the current allocation.',
  ];

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
          "The signal of 2026-01-05 used a secondary price for AAA; the primary's price, which arrived later, differed from it by 1.01%.",
          'Recorded allocation: Calm. With the corrected price it would have been Risk on. The record is annotated, not changed.',
          ...EN_LAST,
          'Data health: green. (Latest recorded day, 2026-01-06.)',
        ].join('\n'),
      },
    ]);
    // Not repeated, also when a later run reads the same annotation.
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-07'))).sent).toBe(0);
    expect(sent).toHaveLength(1);
    const [row] = await db.select().from(schema.alertsSent);
    expect(row).toMatchObject({
      subject: `stand_in:${version.id}:AAA`,
      date: DAY,
      type: 'stand_in_corrected',
    });
  });

  it('in Japanese; an unchanged signal is said to be unchanged', async () => {
    const { db, version, day } = await setup('ja');
    await day(DAY, 'Calm', { status: 'yellow' });
    await note(db, version.id, {
      ticker: 'BBB',
      deviation: 0.0006,
      correctedAllocation: 'Calm',
      differs: false,
    });
    const { notifier, sent } = fakeNotifier();
    expect((await sendStandInCorrections(db, options(notifier, DAY))).sent).toBe(1);
    expect(sent[0]!.text).toBe(
      [
        'Trend: 2026-01-05 のシグナルの訂正',
        '2026-01-05 のシグナルは BBB の代替価格(副ソース)を使いました。後から届いた主ソースの価格は、それと 0.06% 異なっていました。',
        '記録された配分: Calm。訂正後の価格でも同じで、シグナルは変わりませんでした。',
        '過去の日についてのお知らせで、新しいシグナルではありません。現在の配分は最新のシグナルのとおりです。',
        'データ状態: 黄(警告付きで計算)。 (最新の記録日 2026-01-05)',
      ].join('\n'),
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

  it('one message per channel and version: the others that change the signal listed, the rest counted', async () => {
    const { db, owner, version, day } = await setup('ja');
    await day(DAY, 'Calm');
    await day('2026-01-06', 'Calm');
    await note(db, version.id, { ticker: 'BBB', correctedAllocation: 'Calm', differs: false });
    await note(db, version.id);
    // The next day read the 01-05 stand-in in its lookback; the safe state by its name.
    await note(
      db,
      version.id,
      { standInDate: DAY, recordedAllocation: 'Safe state', correctedAllocation: 'Calm' },
      '2026-01-06',
    );
    const { notifier, sent } = fakeNotifier();
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-06'))).sent).toBe(1);
    const told = [
      'Trend: 2026-01-06 のシグナルの訂正',
      '2026-01-06 のシグナルは AAA の 2026-01-05 の代替価格(副ソース)を参照しました。後から届いた主ソースの価格は、それと 1.01% 異なっていました。',
      '記録された配分: セーフステート。訂正後の価格なら Calm になっていました。記録は変更せず、注記を付けました。',
      '訂正後の価格なら配分が変わっていたほかの日:',
      '2026-01-05 AAA: Calm → Risk on',
      'この戦略のほかの訂正で、シグナルが変わらなかったもの: 1 件(それぞれ記録に注記済み)。',
      '過去の日についてのお知らせで、新しいシグナルではありません。現在の配分は最新のシグナルのとおりです。',
      'データ状態: 緑。 (最新の記録日 2026-01-06)',
    ].join('\n');
    expect(sent[0]!.text).toBe(told);
    // Every key recorded: nothing repeated.
    const subjects = (await db.select().from(schema.alertsSent)).map((r) => [r.subject, r.date]);
    expect(subjects.sort()).toEqual(
      [
        [`stand_in:${version.id}:AAA`, DAY],
        [`stand_in:${version.id}:AAA@${DAY}`, '2026-01-06'],
        [`stand_in:${version.id}:BBB`, DAY],
      ].sort(),
    );
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-06'))).sent).toBe(0);
    // A channel added later gets the corrections not told on it, in one message.
    await addChannel(db, owner, { type: 'fake', target: 'chat-2', authSecret: SECRET });
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-07'))).sent).toBe(1);
    expect(sent[1]).toEqual({ target: 'chat-2', text: told });
    // A new correction alone: no other lines.
    await day('2026-01-07', 'Calm');
    await note(db, version.id, { ticker: 'CCC' }, '2026-01-07');
    await sendStandInCorrections(db, options(notifier, '2026-01-07'));
    expect(sent.slice(2).map((m) => m.target)).toEqual(['chat-1', 'chat-2']);
    expect(sent[2]!.text).not.toContain('ほかの');
  });

  it('D changes the signal, D+1 does not: D in full, D+1 counted', async () => {
    const { db, version, day } = await setup();
    await day(DAY, 'Calm');
    await day('2026-01-06', 'Risk on');
    await note(db, version.id);
    await note(
      db,
      version.id,
      {
        standInDate: DAY,
        recordedAllocation: 'Risk on',
        correctedAllocation: 'Risk on',
        differs: false,
      },
      '2026-01-06',
    );
    const { notifier, sent } = fakeNotifier();
    expect((await sendStandInCorrections(db, options(notifier, '2026-01-06'))).sent).toBe(1);
    expect(sent[0]!.text).toBe(
      [
        'Trend: correction to the signal of 2026-01-05',
        "The signal of 2026-01-05 used a secondary price for AAA; the primary's price, which arrived later, differed from it by 1.01%.",
        'Recorded allocation: Calm. With the corrected price it would have been Risk on. The record is annotated, not changed.',
        'Other corrections of this strategy that would not have changed the signal: 1 (each is annotated in the record).',
        ...EN_LAST,
        'Data health: green. (Latest recorded day, 2026-01-06.)',
      ].join('\n'),
    );
    expect(await db.select().from(schema.alertsSent)).toHaveLength(2);
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

  it('a correction too long for the channel is not sent, not recorded, and reported', async () => {
    const { db, version, day } = await setup();
    await day(DAY, 'Calm');
    await note(db, version.id, { correctedAllocation: 'R'.repeat(3000) });
    const small = fakeNotifier(false, 2000);
    const r = await sendStandInCorrections(db, options(small.notifier, DAY));
    expect(r.sent).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatch(/: channel too small for the alert \(\d+ characters needed\)$/);
    expect(small.sent).toEqual([]);
    expect(await db.select().from(schema.alertsSent)).toEqual([]);
    // A channel with room: told whole, then recorded.
    const big = fakeNotifier(false, 10_000);
    expect((await sendStandInCorrections(db, options(big.notifier, DAY))).sent).toBe(1);
    expect(big.sent[0]!.text).toContain('R'.repeat(3000));
    expect(await db.select().from(schema.alertsSent)).toHaveLength(1);
  });

  it('an unreadable detail is told to the admins once, never with a guessed value', async () => {
    const { db, owner, version, day } = await setup();
    await day(DAY, 'Calm');
    const id = async () => (await db.select().from(schema.forwardAnnotations)).at(-1)!.id;
    await note(db, version.id, { deviation: null });
    const bad = await id();
    // Before the A1 gate and without an admin channel nothing can tell it: an error each time.
    const { notifier, sent } = fakeNotifier();
    const label = `Trend (${version.id}) ${DAY}: stand-in correction annotation ${bad} does not read back; not told, and the admins not told yet`;
    expect(await sendStandInCorrections(db, options(notifier, DAY))).toEqual({
      sent: 0,
      failed: [],
      errors: [label],
    });
    await setSetting(db, 'forward_records_from', DAY);
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const down = fakeNotifier(true);
    const r = await sendStandInCorrections(db, options(down.notifier, DAY));
    expect(r.errors).toEqual([label]);
    expect(r.failed).not.toEqual([]);
    expect(await sendStandInCorrections(db, options(notifier, DAY))).toEqual({
      sent: 1,
      failed: [],
      errors: [],
    });
    expect(sent).toEqual([
      {
        target: 'ops',
        text: [
          'Saku: a stand-in correction annotation cannot be read',
          `Trend (${version.id}), ${DAY}: annotation ${bad} does not read back, so its correction is not told. The record is unchanged; find the cause.`,
          'Data health: unknown (the run did not finish).',
        ].join('\n'),
      },
    ]);
    expect(await sendStandInCorrections(db, options(notifier, DAY))).toEqual({
      sent: 0,
      failed: [],
      errors: [],
    });
  });

  it('reads a detail back only when it is one the correction step writes', () => {
    const ok = {
      ticker: 'A',
      deviation: 0.01,
      recordedAllocation: 'x',
      correctedAllocation: 'y',
      differs: true,
    };
    // Written before `standInDate` existed: the entry's own date.
    expect(standInDetail(ok, DAY)).toEqual({ ...ok, standInDate: DAY });
    expect(standInDetail({ ...ok, standInDate: '2026-01-02' }, DAY)?.standInDate).toBe(
      '2026-01-02',
    );
    for (const bad of [
      { ...ok, deviation: -0.1 },
      { ...ok, deviation: Number.NaN },
      { ...ok, deviation: null },
      { ...ok, differs: false },
      { ...ok, recordedAllocation: '' },
      { ...ok, ticker: 1 },
      { ...ok, standInDate: '2026-01-06' },
      { ...ok, standInDate: '5 Jan' },
      null,
    ]) {
      expect(standInDetail(bad, DAY)).toBeNull();
    }
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

describe('fitting the channel (one way for every alert)', () => {
  const list = (n: number) => ({
    items: Array.from({ length: n }, (_, i) => `a${i + 1}`),
    more: (c: number) => `+${c}`,
  });
  const inline = {
    items: ['b1', 'b2'],
    more: (c: number) => `+${c}`,
    inline: { join: ',', line: (s: string) => `B: ${s}` },
  };

  it('shortens the list with the most items first (on a tie the later one), counting exactly', () => {
    const parts = ['T', list(5), inline, { keep: 'H' }];
    expect(fitMessage(parts, Infinity)).toMatchObject({
      text: 'T\na1\na2\na3\na4\na5\nB: b1,b2\nH',
      shown: [1, 5, 2, 1],
      fits: true,
    });
    expect(fitMessage(parts, 21)).toMatchObject({
      text: 'T\na1\na2\n+3\nB: b1,b2\nH',
      shown: [1, 2, 2, 1],
    });
    // 2 and 2: the later list first, then the other.
    expect(fitMessage(parts, 20)).toMatchObject({
      text: 'T\na1\n+4\nB: b1,+1\nH',
      shown: [1, 1, 1, 1],
    });
    // A limit lists no more whatever the room; an empty list is no line.
    expect(fitMessage(['T', { ...list(5), limit: 2 }, list(0)], Infinity).text).toBe(
      'T\na1\na2\n+3',
    );
  });

  it('a long list is shortened from the item lengths, the count exact', () => {
    const items = Array.from({ length: 100_000 }, (_, i) => `item ${i}`);
    const start = performance.now();
    const fit = fitMessage(
      [
        { keep: 'T' },
        { items, more: (c) => `and ${c} more`, inline: { join: '; ', line: (s) => `L: ${s}.` } },
        { keep: 'H' },
      ],
      1000,
    );
    expect(performance.now() - start).toBeLessThan(2000);
    expect(fit.text.length).toBeLessThanOrEqual(1000);
    const shown = fit.text.match(/item \d+/g)!.length;
    expect(fit.shown[1]).toBe(shown);
    expect(fit.text).toContain(`and ${100_000 - shown} more.`);
    // The next item would not have fit.
    expect(fit.text.length + `item ${shown}; `.length).toBeGreaterThan(1000);
  });

  it('then drops whole lines from the end of each run, cutting a first line only when it alone does not fit', () => {
    const parts = ['title', 'second line', { keep: 'HEALTH' }, 'reasons-long', 'more'];
    const fit = (max: number) => fitMessage(parts, max);
    expect(fit(42).text).toBe('title\nsecond line\nHEALTH\nreasons-long\nmore');
    expect(fit(39)).toEqual({
      text: 'title\nsecond line\nHEALTH\nreasons-long\n…',
      shown: [1, 1, 1, 1, 0],
      fits: true,
      needed: 10,
    });
    expect(fit(38).text).toBe('title\nsecond line\nHEALTH\nreasons-lon…');
    expect(fit(30)).toMatchObject({
      text: 'title\nsecond line\nHEALTH\nreas…',
      shown: [1, 1, 1, 0, 0],
    });
    expect(fit(26).text).toBe('title\nsecond line\nHEALTH\n…');
    expect(fit(20)).toMatchObject({ text: 'title\n…\nHEALTH\n…', shown: [1, 0, 1, 0, 0] });
    expect(fit(10)).toMatchObject({ text: '…\nHEALTH\n…', fits: true });
    // No room for the kept line and one "…" per run: nothing to send.
    expect(fit(9)).toMatchObject({ fits: false, needed: 10, shown: [0, 0, 0, 0, 0] });
    expect(fit(0)).toMatchObject({ fits: false });
  });

  it('never cuts a count in its text, and never cuts a kept list', () => {
    expect(fitMessage(['T', { keep: 'H' }, { count: 'Other: 12 more' }], 10)).toMatchObject({
      text: 'T\nH\n…',
      shown: [1, 1, 0],
    });
    const counted = {
      items: ['aaaa', 'bbbb'],
      more: (n: number) => `and ${n} more`,
      inline: { join: ', ', line: (s: string) => `L: ${s}` },
    };
    expect(fitMessage(['T', { keep: 'H' }, counted], 10).text).toBe('T\nH\n…');
    const kept = { items: ['a', 'b', 'c'], more: (n: number) => `+${n}`, keep: true };
    expect(fitMessage([{ keep: 'T' }, kept, { keep: 'H' }], 6)).toMatchObject({
      text: 'T\n+3\nH',
      fits: true,
    });
    expect(fitMessage([{ keep: 'T' }, kept, { keep: 'H' }], 5)).toMatchObject({
      fits: false,
      needed: 6,
    });
  });
});

describe('every alert fits a small channel: title and health line whole, the count exact', () => {
  const DATE = '2026-01-05';
  const moreOf = (text: string) =>
    Number(/(?:\.\.\.and (\d+) more|ほか (\d+) 件)/.exec(text)?.slice(1).find(Boolean) ?? 0);
  const tooSmall = (needed: number) =>
    new RegExp(`: channel too small for the alert \\(${needed} characters needed\\)$`);
  const admin = async (language: string, max: number) => {
    const s = await setup(language);
    await setSetting(s.db, 'forward_records_from', DATE);
    await addChannel(s.db, s.owner, {
      type: 'fake',
      target: 'ops',
      admin: true,
      authSecret: SECRET,
    });
    const n = fakeNotifier(false, max);
    return { ...s, ...n, o: options(n.notifier, DATE), t: translator(language) };
  };
  const fits = (text: string, max: number, title: string, health: string) => {
    const lines = text.split('\n');
    expect(text.length).toBeLessThanOrEqual(max);
    expect(lines[0]).toBe(title);
    expect(lines.at(-1)).toBe(health);
    return lines;
  };
  const sentRows = async (db: Awaited<ReturnType<typeof setup>>['db']) =>
    db.select().from(schema.alertsSent);

  it.each(['en', 'ja'])(
    'data health: the reasons shortened with an exact count (%s)',
    async (lang) => {
      const max = 300;
      const { db, o, sent, t } = await admin(lang, max);
      const reasons = Array.from({ length: 30 }, (_, i) => `T${i}`);
      expect((await sendDataHealthAdmin(db, { ...o, health: 'yellow', reasons })).sent).toBe(1);
      const text = sent[0]!.text;
      fits(text, max, t('alerts.dataAdmin.title', { date: DATE }), t('alerts.health.yellow'));
      const shown = text.match(/T\d+: /g)!.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown + moreOf(text)).toBe(30);
      expect(text).toContain(t('alerts.more', { count: 30 - shown }));
    },
  );

  it.each(['en', 'ja'])('revisions: each kind listed and counted exactly (%s)', async (lang) => {
    const max = 900;
    const { db, o, sent, t } = await admin(lang, max);
    const rows = (kind: 'changed' | 'withdrawn') =>
      Array.from({ length: 20 }, (_, i) => ({
        ticker: `${kind === 'changed' ? 'C' : 'W'}${i}`,
        source: 'fred',
        field: 'value',
        count: 1,
        from: DATE,
        to: DATE,
        kind,
      }));
    const revisions = [...rows('changed'), ...rows('withdrawn')];
    expect((await sendRevisions(db, { ...o, runId: 'r', revisions })).sent).toBe(1);
    const lines = fits(
      sent[0]!.text,
      max,
      t('alerts.revisions.title', { count: 40 }),
      t('alerts.health.unknown'),
    );
    for (const [line, mark] of [
      [lines[1]!, 'C'],
      [lines[2]!, 'W'],
    ] as const) {
      const shown = line.match(new RegExp(`${mark}\\d+ value@fred`, 'g'))?.length ?? 0;
      expect(shown).toBeLessThanOrEqual(REVISION_ITEMS);
      expect(shown + moreOf(line)).toBe(20);
      expect(moreOf(line)).toBeGreaterThan(0);
    }
    // A large channel: REVISION_ITEMS of each, the rest counted (no inexact "...").
    const big = fakeNotifier(false, 100_000);
    await sendRevisions(db, { ...options(big.notifier, DATE), runId: 'r2', revisions });
    const [, changed, withdrawn] = big.sent[0]!.text.split('\n');
    expect(changed).toContain(`C7 value@fred 1 (${DATE}), ${t('alerts.more', { count: 12 })}`);
    expect(withdrawn).toContain(`W7 value@fred 1 (${DATE}), ${t('alerts.more', { count: 12 })}`);
  });

  it.each(['en', 'ja'])(
    'recompute: the signals and the other days counted exactly; only the days shown recorded (%s)',
    async (lang) => {
      const max = lang === 'en' ? 480 : 260;
      const { db, o, sent, t, version } = await admin(lang, max);
      const signalsDiffer = Array.from({ length: 50 }, (_, i) => `signal${i}`);
      const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
      for (const [i, date] of ['2026-01-02', ...dates].entries()) {
        await annotate(db, {
          versionId: version.id,
          date,
          kind: 'recomputed',
          detail: {
            recordedAllocation: 'Calm',
            recomputedAllocation: 'Risk on',
            signalsDiffer: i === 0 ? signalsDiffer : ['s'],
          },
          runId: null,
        });
      }
      expect((await sendRecomputeDiffers(db, o)).sent).toBe(1);
      const text = sent[0]!.text;
      const lines = fits(
        text,
        max,
        t('alerts.recompute.title', { count: 6 }),
        t('alerts.health.unknown'),
      );
      const signals = text.match(/signal\d+/g)?.length ?? 0;
      expect(signals + moreOf(lines[1]!)).toBe(50);
      expect(moreOf(lines[1]!)).toBeGreaterThan(0);
      const day = (date: string) =>
        t('alerts.recompute.otherDay', {
          version: 'Trend',
          date,
          recorded: 'Calm',
          now: 'Risk on',
        });
      const shown = dates.filter((d) => lines.includes(day(d))).length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(5);
      expect(lines).toContain(t('alerts.more', { count: 5 - shown }));
      expect(await sentRows(db)).toHaveLength(1 + shown);
      // The days not shown follow at the next runs, each told once, until all are recorded.
      for (let run = 0; run < 6 && (await sentRows(db)).length < 6; run++) {
        await sendRecomputeDiffers(db, o);
      }
      expect(await sentRows(db)).toHaveLength(6);
      const told = sent.length;
      expect((await sendRecomputeDiffers(db, o)).sent).toBe(0);
      expect(sent).toHaveLength(told);
    },
  );

  it.each(['en', 'ja'])(
    'job failure, integrity, parity: a long detail cut before the health line (%s)',
    async (lang) => {
      const max = 250;
      const { db, o, sent, t } = await admin(lang, max);
      const failures = Array.from({ length: 9 }, (_, i) => `F${i}: ${'x'.repeat(100)}`);
      await sendJobFailure(db, { ...o, job: 'daily', failures });
      await sendIntegrityFailed(db, {
        ...o,
        check: 'core_ref',
        versionId: 'v',
        detail: 'd'.repeat(600),
      });
      await sendParityFailed(db, { ...o, caseName: 'case', detail: 'p'.repeat(600) });
      expect(sent).toHaveLength(3);
      const health = t('alerts.health.unknown');
      const job = fits(
        sent[0]!.text,
        max,
        t('alerts.jobFailure.title', { job: 'daily', date: DATE }),
        health,
      );
      const shown = job.filter((l) => l.startsWith('- ')).length;
      expect(shown + moreOf(sent[0]!.text)).toBe(9);
      expect(moreOf(sent[0]!.text)).toBeGreaterThan(0);
      fits(sent[1]!.text, max, t('alerts.integrity.title', { check: 'core_ref' }), health);
      fits(sent[2]!.text, max, t('alerts.parity.title', { name: 'case' }), health);
    },
  );

  it.each(['en', 'ja'])(
    'update failed: whole at its size; one character less refused, reported, not recorded (%s)',
    async (lang) => {
      const { db, o, t } = await admin(lang, 100_000);
      const update = { from: 'abc1234', to: 'def5678', step: 'check', stuck: true };
      const text = [
        t('alerts.update.title', { to: 'def5678', step: 'check' }),
        t('alerts.update.stuck', { from: 'abc1234' }),
        t('alerts.health.unknown'),
      ].join('\n');
      const small = fakeNotifier(false, text.length - 1);
      const r = await sendUpdateFailed(db, { ...o, ...update, notifiers: [small.notifier] });
      expect(r).toEqual({ sent: 0, failed: [expect.stringMatching(tooSmall(text.length))] });
      expect(small.sent).toEqual([]);
      expect(await sentRows(db)).toEqual([]);
      const exact = fakeNotifier(false, text.length);
      expect(
        (await sendUpdateFailed(db, { ...o, ...update, notifiers: [exact.notifier] })).sent,
      ).toBe(1);
      expect(exact.sent[0]!.text).toBe(text);
    },
  );

  it.each(['en', 'ja'])(
    'an unreadable annotation: whole at its size; one character less refused and still an error (%s)',
    async (lang) => {
      const { db, o, t, version, day } = await admin(lang, 100_000);
      await day(DATE, 'Calm');
      await annotate(db, {
        versionId: version.id,
        date: DATE,
        kind: 'stand_in_corrected',
        detail: { ticker: 'AAA', deviation: null } as never,
        runId: null,
      });
      const id = (await db.select().from(schema.forwardAnnotations))[0]!.id;
      const text = [
        t('alerts.standInUnreadable.title'),
        t('alerts.standInUnreadable.body', {
          version: `Trend (${version.id})`,
          date: DATE,
          id: String(id),
        }),
        t('alerts.health.unknown'),
      ].join('\n');
      const small = fakeNotifier(false, text.length - 1);
      const r = await sendStandInCorrections(db, { ...o, notifiers: [small.notifier] });
      expect(r.sent).toBe(0);
      expect(r.failed).toEqual([expect.stringMatching(tooSmall(text.length))]);
      expect(r.errors).toHaveLength(1);
      expect(await sentRows(db)).toEqual([]);
      const exact = fakeNotifier(false, text.length);
      const ok = await sendStandInCorrections(db, { ...o, notifiers: [exact.notifier] });
      expect(ok).toEqual({ sent: 1, failed: [], errors: [] });
      expect(exact.sent[0]!.text).toBe(text);
    },
  );

  describe.each(['en', 'ja'])('owner alerts (%s)', (lang) => {
    const t = translator(lang);
    const strategyOf = (version: Parameters<typeof parseVersion>[0]) => {
      const parsed = parseVersion(version);
      if ('error' in parsed) throw new Error(parsed.error);
      return parsed.strategy;
    };
    const entry = (o: Partial<DayEntry> = {}): DayEntry => ({
      date: DATE,
      allocation: 'Calm',
      holdings: [{ ticker: 'CASH_USD', weight: 100 }],
      dataStatus: 'green',
      safeStateApplied: false,
      reasons: [],
      ...o,
    });
    /** The alert's whole text, as `strategyAlert` makes it for the channel. */
    const whole = (version: { id: string; name: string }, day: DayEntry, lastTold?: string) =>
      strategyAlert(t, lang, {
        versionId: version.id,
        name: version.name,
        execution: 'next_open',
        entry: day,
        nextSession: sessions.after(day.date),
        ...(lastTold !== undefined && { lastTold }),
      })!.text;

    it.each([
      ['state_change', entry(), undefined],
      ['data_yellow', entry({ dataStatus: 'yellow' }), 'Calm'],
    ] as const)(
      '%s: every line whole at its size; one character less refused, reported, not recorded',
      async (type, day, lastTold) => {
        const { db, owner, version } = await setup(lang);
        const [channel] = await channelsOf(db, owner);
        if (lastTold) {
          await recordAlertSent(
            db,
            channel!,
            { subject: version.id, date: '2026-01-02', type: 'state_change' },
            lastTold,
          );
        }
        const rows = (await sentRows(db)).length;
        const text = whole(version, day, lastTold);
        expect(text.split('\n')).toContain(t(`alerts.health.${day.dataStatus}`));
        const d = { version, strategy: strategyOf(version), day };
        const small = fakeNotifier(false, text.length - 1);
        const r = await sendDayAlert(db, options(small.notifier, DATE), d);
        expect(r).toEqual({ sent: 0, failed: [expect.stringMatching(tooSmall(text.length))] });
        expect(small.sent).toEqual([]);
        expect(await sentRows(db)).toHaveLength(rows);
        const exact = fakeNotifier(false, text.length);
        expect((await sendDayAlert(db, options(exact.notifier, DATE), d)).sent).toBe(1);
        expect(exact.sent[0]!.text).toBe(text);
        expect((await sentRows(db)).map((row) => row.type)).toContain(type);
      },
    );

    it('data_red: the reasons after the health line counted; too small refused', async () => {
      const { db, version } = await setup(lang);
      const day = entry({
        allocation: 'Safe state',
        holdings: [{ ticker: 'AAA', weight: 100 }],
        dataStatus: 'red',
        safeStateApplied: true,
        reasons: Array.from({ length: 40 }, (_, i) => `T${i}:A.large_move@p`),
      });
      const d = { version, strategy: strategyOf(version), day };
      const big = fakeNotifier(false, 500);
      expect((await sendDayAlert(db, options(big.notifier, DATE), d)).sent).toBe(1);
      const text = big.sent[0]!.text;
      const lines = text.split('\n');
      expect(text.length).toBeLessThanOrEqual(500);
      expect(lines[0]).toBe(t('alerts.dataRed.title', { strategy: 'Trend', date: DATE }));
      expect(lines.at(-2)).toBe(t('alerts.health.red'));
      const shown = text.match(/T\d+: /g)!.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown + moreOf(text)).toBe(40);
      expect(moreOf(text)).toBeGreaterThan(0);
      await db.delete(schema.alertsSent);
      const small = fakeNotifier(false, 100);
      const r = await sendDayAlert(db, options(small.notifier, DATE), d);
      expect(r.sent).toBe(0);
      expect(r.failed[0]).toMatch(/: channel too small for the alert \(\d+ characters needed\)$/);
      expect(await sentRows(db)).toEqual([]);
    });

    it('stand-in corrections: only the corrections shown are recorded; the rest follow', async () => {
      const { db, version, day } = await setup(lang);
      // 14 weekdays from 2026-01-05, each with a correction that changes the signal; two not.
      const dates: string[] = [];
      for (
        let d = new Date('2026-01-05T00:00:00Z');
        dates.length < 14;
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        if (d.getUTCDay() % 6 !== 0) dates.push(d.toISOString().slice(0, 10));
      }
      for (const date of dates) await day(date, 'Calm');
      const note = (date: string, detail: Record<string, unknown> = {}) =>
        annotate(db, {
          versionId: version.id,
          date,
          kind: 'stand_in_corrected',
          detail: {
            ticker: 'AAA',
            standInDate: date,
            deviation: 0.02,
            recordedAllocation: 'Calm',
            correctedAllocation: 'Risk on',
            differs: true,
            ...detail,
          } as never,
          runId: null,
        });
      for (const date of dates) await note(date);
      await note(dates[0]!, { ticker: 'BBB', correctedAllocation: 'Calm', differs: false });
      await note(dates[1]!, { ticker: 'BBB', correctedAllocation: 'Calm', differs: false });
      const last = dates.at(-1)!;
      const max = 700;
      const health = `${t('alerts.health.green')} ${t('alerts.standInCorrected.healthDate', { date: last })}`;
      const title = (date: string) =>
        t('alerts.standInCorrected.title', { strategy: 'Trend', date });
      const { notifier, sent } = fakeNotifier(false, max);
      expect((await sendStandInCorrections(db, options(notifier, last))).sent).toBe(1);
      const text = sent[0]!.text;
      const lines = text.split('\n');
      expect(text.length).toBeLessThanOrEqual(max);
      expect(lines[0]).toBe(title(last));
      expect(lines.at(-1)).toBe(health);
      expect(lines.at(-2)).toBe(t('alerts.standInCorrected.pastDay'));
      const listed = lines.filter((l) => / AAA: Calm → Risk on$/.test(l)).length;
      expect(listed).toBeGreaterThan(0);
      expect(moreOf(text)).toBeGreaterThan(0);
      expect(listed + moreOf(text)).toBe(13);
      const counted = lines.includes(t('alerts.standInCorrected.more', { count: 2 }));
      expect((await sentRows(db)).length).toBe(1 + listed + (counted ? 2 : 0));
      // The next runs tell the ones not shown, each once, until every correction is recorded.
      for (let run = 0; run < 16 && (await sentRows(db)).length < 16; run++) {
        await sendStandInCorrections(db, options(notifier, last));
      }
      expect(await sentRows(db)).toHaveLength(16);
      const told = sent.length;
      expect((await sendStandInCorrections(db, options(notifier, last))).sent).toBe(0);
      expect(sent).toHaveLength(told);
      // Every day that changes the signal was told whole, in full or on a line, exactly once.
      for (const date of dates) {
        const once = sent.filter(
          (m) =>
            m.text.split('\n')[0] === title(date) ||
            m.text.split('\n').includes(`${date} AAA: Calm → Risk on`),
        );
        expect(once).toHaveLength(1);
      }
    });
  });
});

describe('stand-in close alerts (requirements 04, the stand-in rule 5)', () => {
  const DAY = '2026-01-05';
  const CLOSED_AT = '2026-02-01T10:00:00.000Z';
  type TestDb = Awaited<ReturnType<typeof setup>>['db'];
  const note = (
    db: TestDb,
    versionId: string,
    date: string,
    detail: Record<string, unknown> = {},
  ) =>
    annotate(db, {
      versionId,
      date,
      kind: 'stand_in_closed',
      detail: {
        ticker: 'AAA',
        standInDate: DAY,
        reason: 'primary will not deliver',
        closedAt: CLOSED_AT,
        recordedAllocation: 'Calm',
        ...detail,
      } as never,
      runId: null,
    });

  /** AAA's stand-in on DAY, closed at CLOSED_AT, still the canonical bar's price. */
  const closedStandIn = async (db: TestDb, admin: string) => {
    await upsertSymbols(db, [
      { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD', leverageFactor: 1 },
    ]);
    const [{ id }] = (await db
      .select({ id: schema.symbols.id })
      .from(schema.symbols)
      .where(eq(schema.symbols.ticker, 'AAA'))) as [{ id: number }];
    await db.insert(schema.standIns).values({
      symbolId: id,
      date: DAY,
      source: 's',
      close: 100,
      band: 0.001,
      basis: 'index',
      createdAt: '2026-01-05T21:30:00.000Z',
    });
    await db
      .insert(schema.bars)
      .values({ symbolId: id, date: DAY, close: 100, source: 's', standIn: true });
    const c = { symbolId: id, date: DAY, source: 's', close: 100, band: 0.001, basis: 'index' };
    await db.insert(schema.standInCloses).values({
      ...c,
      closedBy: admin,
      reason: 'primary will not deliver',
      closedAt: CLOSED_AT,
    });
    return {
      id,
      /** A later close (the price changed, then closed again). */
      reclose: (closedAt: string, close: number) =>
        db.insert(schema.standInCloses).values({
          ...c,
          close,
          closedBy: admin,
          reason: 'revised value checked',
          closedAt,
        }),
    };
  };

  it('one message per version and closed stand-in, to the owner, once (EN and JA)', async () => {
    for (const language of [null, 'ja']) {
      const { db, owner, version, day } = await setup(language);
      await closedStandIn(db, owner);
      await day(DAY, 'Calm', { status: 'yellow', reasons: ['AAA:stand_in@s'] });
      await day('2026-01-06', 'Calm');
      await note(db, version.id, DAY);
      await note(db, version.id, '2026-01-06');
      const { notifier, sent } = fakeNotifier();
      expect(await sendStandInClosures(db, options(notifier, '2026-01-06'))).toEqual({
        sent: 1,
        failed: [],
        errors: [],
      });
      expect(sent[0]!.text.split('\n')).toEqual(
        language === 'ja'
          ? [
              `Trend: AAA の ${DAY} の価格は代替価格のままです`,
              `主ソースは AAA の ${DAY} の価格を提供しないため、管理者がその代替価格を確定しました。副ソースの価格がそのまま残り、主ソースの価格で確認されることはありません。`,
              '理由: primary will not deliver',
              `これを使った記録日: 2 日(${DAY} から 2026-01-06)。そのシグナルは記録どおりで、記録は変更せず、注記を付けました。`,
              '今後のシグナルはこの価格をそのまま読み、未確認の価格として日を黄色や赤にすることはありません。',
              '新しいシグナルではありません。現在の配分は最新のシグナルのとおりです。',
              expect.stringContaining('(最新の記録日 2026-01-06)'),
            ]
          : [
              `Trend: AAA's price for ${DAY} stays a secondary price`,
              `The primary source will not deliver AAA's price for ${DAY}, so an admin closed its stand-in: the secondary source's price stays, and no primary price will check it.`,
              'Reason given: primary will not deliver',
              `Recorded days that used it: 2 (${DAY} to 2026-01-06). Their signals stay as recorded; the record is annotated, not changed.`,
              'From now on, signals read this price as it is: it no longer makes a day yellow or red as an unconfirmed price.',
              'This is not a new signal: the latest signal gives the current allocation.',
              'Data health: green. (Latest recorded day, 2026-01-06.)',
            ],
      );
      // Told once, also when a later run annotates another of its days.
      await day('2026-01-07', 'Calm');
      await note(db, version.id, '2026-01-07');
      expect((await sendStandInClosures(db, options(notifier, '2026-01-07'))).sent).toBe(0);
      const [row] = await db.select().from(schema.alertsSent);
      expect(row).toMatchObject({
        subject: `stand_in_closed:${version.id}:AAA@${DAY}`,
        date: DAY,
        type: 'stand_in_closed',
      });
    }
  });

  it('reads a detail back only when it is one the closing step writes', () => {
    const ok = {
      ticker: 'A',
      standInDate: DAY,
      reason: 'primary will not deliver',
      closedAt: CLOSED_AT,
      recordedAllocation: 'Calm',
    };
    expect(standInClosedDetail(ok, '2026-01-06')).toEqual(ok);
    for (const bad of [
      { ...ok, reason: ' ' },
      { ...ok, reason: undefined },
      { ...ok, closedAt: '2026-02-01 10:00:00' },
      { ...ok, standInDate: '2026-01-07' },
      { ...ok, recordedAllocation: '' },
      { ...ok, ticker: '' },
      null,
    ]) {
      expect(standInClosedDetail(bad, '2026-01-06')).toBeNull();
    }
    // A correction after the close carries its time; one that is not an instant is not read.
    const corrected = {
      ticker: 'A',
      deviation: 0.01,
      recordedAllocation: 'x',
      correctedAllocation: 'y',
      differs: true,
    };
    expect(standInDetail({ ...corrected, closedAt: CLOSED_AT }, DAY)?.closedAt).toBe(CLOSED_AT);
    expect(standInDetail({ ...corrected, closedAt: 'x' }, DAY)).toBeNull();
  });

  it("only the admin's reason may be cut; too small a channel gets nothing", () => {
    const t = translator('en');
    const o = {
      name: 'Trend',
      detail: { ticker: 'AAA', standInDate: DAY, reason: 'x'.repeat(400) },
      days: [DAY],
    };
    const whole = standInClosedText(t, o, 10_000);
    expect(whole.needed).toBeUndefined();
    const lines = whole.text.split('\n');
    const room = whole.text.length - 300;
    const cut = standInClosedText(t, o, room);
    expect(cut.needed).toBeUndefined();
    expect(cut.text.length).toBeLessThanOrEqual(room);
    expect(cut.text.split('\n').filter((l) => !l.startsWith('Reason given'))).toEqual(
      lines.filter((l) => !l.startsWith('Reason given')),
    );
    expect(standInClosedText(t, o, 100).needed).toBeGreaterThan(100);
  });

  it('a closed stand-in whose day now has another price: said so, no "from now on"; its reason in words', () => {
    const t = translator('en');
    const o = {
      name: 'Trend',
      detail: { ticker: 'AAA', standInDate: DAY, reason: 'primary will not deliver' },
      days: [DAY],
    };
    const changed = standInClosedText(t, { ...o, state: 'changed' }, 10_000).text;
    expect(changed).toContain(
      'since then the day has another secondary price, which is checked again as an unconfirmed price',
    );
    expect(changed).not.toContain('From now on');
    expect(standInClosedText(t, o, 10_000).text).toContain('From now on');
    expect(describeReason(t, 'AAA:stand_in_closed_changed@s')).toBe(
      'AAA: a stand-in an admin had closed now has another price (from s); it is checked again as an unconfirmed price',
    );
  });

  it('a re-close is a close of its own: its own message', async () => {
    const { db, owner, version, day } = await setup();
    const { id, reclose } = await closedStandIn(db, owner);
    await day(DAY, 'Calm', { status: 'yellow', reasons: ['AAA:stand_in@s'] });
    await note(db, version.id, DAY);
    const { notifier, sent } = fakeNotifier();
    expect((await sendStandInClosures(db, options(notifier, DAY))).sent).toBe(1);
    // The price changed and an admin closed the new one.
    const AGAIN = '2026-02-03T10:00:00.000Z';
    await db
      .update(schema.bars)
      .set({ close: 100.4 })
      .where(and(eq(schema.bars.symbolId, id), eq(schema.bars.date, DAY)));
    await reclose(AGAIN, 100.4);
    await day('2026-01-06', 'Calm');
    await note(db, version.id, '2026-01-06', { closedAt: AGAIN, reason: 'revised value checked' });
    expect((await sendStandInClosures(db, options(notifier, '2026-01-06'))).sent).toBe(1);
    expect(sent[1]!.text).toContain('Reason given: revised value checked');
    expect(sent[1]!.text).toContain('From now on');
    expect((await db.select().from(schema.alertsSent)).map((r) => r.subject)).toEqual([
      `stand_in_closed:${version.id}:AAA@${DAY}`,
      `stand_in_closed:${version.id}:AAA@${DAY}#${AGAIN}`,
    ]);
  });

  it('a closed stand-in with another price: the admins, after the gate, once per close and price', async () => {
    const { db, owner } = await setup();
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    const reopened = (now: { source: string; close: number } | null, closedAt = CLOSED_AT) =>
      sendStandInReopened(db, {
        ...options(notifier, '2026-02-02'),
        ticker: 'AAA',
        standInDate: DAY,
        closed: { source: 's', close: 100, closedAt },
        now,
      });
    // Before the A1 gate: nothing (logged by the run only).
    expect((await reopened({ source: 's', close: 100.4 })).sent).toBe(0);
    await setSetting(db, 'forward_records_from', DAY);
    expect((await reopened({ source: 's', close: 100.4 })).sent).toBe(1);
    expect(sent[0]!.target).toBe('ops');
    expect(sent[0]!.text.split('\n').slice(0, 2)).toEqual([
      `Saku: the closed stand-in of AAA on ${DAY} has another price`,
      `An admin closed the stand-in at 100 from s; the checks now build the day from 100.4 from s. It is open again: checked as an unconfirmed price and holding corrections back. Check the new price, then close it again: pnpm sources stand-in close AAA ${DAY} --reason "<text>" --user <admin>.`,
    ]);
    // Once per close and new price; another price, a refusal or a later close is told again.
    expect((await reopened({ source: 's', close: 100.4 })).sent).toBe(0);
    expect((await reopened({ source: 's2', close: 100.4 })).sent).toBe(1);
    expect((await reopened(null)).sent).toBe(1);
    expect(sent.at(-1)!.text).toContain('the checks now refuse the day');
    expect((await reopened({ source: 's', close: 100.4 }, '2026-02-03T10:00:00.000Z')).sent).toBe(
      1,
    );
  });

  it('a close the stand-ins do not hold: told to the admins as unreadable, never as settled', async () => {
    const { db, owner, version, day } = await setup();
    await day(DAY, 'Calm');
    // An annotation whose close no stand-in holds (no stand_ins row at all).
    await note(db, version.id, DAY);
    const id = (await db.select().from(schema.forwardAnnotations)).at(-1)!.id;
    await setSetting(db, 'forward_records_from', DAY);
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    expect(await sendStandInClosures(db, options(notifier, DAY))).toEqual({
      sent: 1,
      failed: [],
      errors: [],
    });
    expect(sent.map((m) => [m.target, m.text.split('\n')[0]])).toEqual([
      ['ops', 'Saku: a stand-in close annotation cannot be read'],
    ]);
    expect(sent[0]!.text).toContain(`annotation ${id}`);
  });

  it('an unreadable detail is told to the admins once, never with a guessed value', async () => {
    const { db, owner, version, day } = await setup();
    await day(DAY, 'Calm');
    await note(db, version.id, DAY, { reason: '' });
    const bad = (await db.select().from(schema.forwardAnnotations)).at(-1)!.id;
    await setSetting(db, 'forward_records_from', DAY);
    await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
    const { notifier, sent } = fakeNotifier();
    expect(await sendStandInClosures(db, options(notifier, DAY))).toEqual({
      sent: 1,
      failed: [],
      errors: [],
    });
    expect(sent.map((m) => [m.target, m.text.split('\n').slice(0, 2)])).toEqual([
      [
        'ops',
        [
          'Saku: a stand-in close annotation cannot be read',
          `Trend (${version.id}), ${DAY}: annotation ${bad} does not read back, so its close is not told. The record is unchanged; find the cause.`,
        ],
      ],
    ]);
    expect((await sendStandInClosures(db, options(notifier, DAY))).sent).toBe(0);
  });
});
