// Layer F (requirements 04, A3): every material corruption of a source's data, injected into a
// whole daily run with all sources available, is detected (never green) and never produces a
// normal signal on red: the forward record and the alert carry the strategy's safe state.
// Separately, a day with a single source is never green. Layer D (issuer data) faults are
// advisory: yellow with the reason, never red, never a change of the normal signal. Synthetic
// data, no network.
import { type IssuerRecord, type RawBar, totalReturnIndex, zonedInstant } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  addChannel,
  createUser,
  type Db,
  forwardRecord,
  recordProviderRequest,
  registerVersion,
  schema,
  setSetting,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { BlockedError, type PoliteHttp } from '../http';
import { emptyPlugins } from '../registry';
import type {
  BarSource,
  CalendarSource,
  FxSource,
  IssuerSource,
  PluginInfo,
  SeriesSource,
} from '../types';
import { runJob } from './run';
import { cashRates, fakeHttp, fakeNotifier, quiet, testInfo } from './testkit';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2025-11-01',
  validTo: '2026-12-31',
  holidays: [],
});
const TARGET = '2026-01-16';
const DATES = sessions.between('2025-12-01', TARGET);
const SECRET = 'f'.repeat(32);

/** Clean history: SPY rises 0.3-0.7% a day (pays a dividend on the target day); SSO is 2x SPY's
 * price return and splits 2:1 on the target day. Every day moves enough to make a fault material. */
function clean(): Record<'SPY' | 'SSO', RawBar[]> {
  const spy: RawBar[] = [];
  const sso: RawBar[] = [];
  DATES.forEach((date, i) => {
    const prev = spy[i - 1];
    const div = date === TARGET ? 1.5 : 0;
    const r = 0.005 + 0.002 * Math.sin(i);
    const close = prev ? prev.close * (1 + r) - div : 500;
    spy.push(bar(date, close, { divCash: div }));
    const pr = prev ? close / prev.close - 1 : 0;
    const split = date === TARGET ? 2 : 1;
    const s = sso[i - 1];
    sso.push(bar(date, s ? (s.close * (1 + 2 * pr)) / split : 80, { splitFactor: split }));
  });
  return { SPY: spy, SSO: sso };
}

function bar(date: string, close: number, extra: Partial<RawBar> = {}): RawBar {
  return {
    date,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    closeIsSplitAdjusted: false,
    volume: 1e6,
    divCash: 0,
    splitFactor: 1,
    ...extra,
  };
}

type Ticker = 'SPY' | 'SSO';
/** A corruption of one source's response: the bars it returns for a ticker. */
type Fault = (ticker: Ticker, bars: RawBar[], all: Record<Ticker, RawBar[]>) => RawBar[];
const onTarget =
  (ticker: Ticker, f: (b: RawBar, prev: RawBar) => RawBar): Fault =>
  (t, bars) =>
    t !== ticker
      ? bars
      : bars.map((b, i) => {
          if (b.date !== TARGET) return b;
          if (i === 0) throw new Error('fault needs the day before the target');
          return f(b, bars[i - 1]!);
        });

/**
 * A bar source answering from the clean history, corrupted by `fault`; `down` fails every call;
 * `info`: declarations added to its description (limits, adjusted-close rounding). With an HTTP
 * client in its context, each fetch first sends one request through it (as a plug-in does), so
 * the quota guard counts and refuses as for a real provider.
 */
function source(
  key: string,
  o: { fault?: Fault; down?: boolean; adjusted?: boolean; info?: Partial<PluginInfo> } = {},
) {
  const data = clean();
  const adj = Object.fromEntries(
    Object.entries(data).map(([t, bars]) => [t, totalReturnIndex(bars, 100)]),
  );
  const s: BarSource = {
    info: testInfo(key, 'bar', o.info),
    async fetchBars(ticker, from, to, ctx) {
      if (o.down) throw new Error(`${key}: HTTP 503`);
      const http = ctx.http as PoliteHttp | null;
      if (http) await http.json(`https://${key}.example.test/bars/${ticker}?from=${from}&to=${to}`);
      const t = ticker as Ticker;
      // The provider's adjusted closes come from its own (clean) books, as a check source's do.
      let bars = data[t].map((b, i) =>
        o.adjusted ? { ...b, providerAdjClose: adj[t]![i]! } : { ...b },
      );
      if (o.fault) bars = o.fault(t, bars, data);
      return bars.filter((b) => b.date >= from && b.date <= to);
    },
  };
  return s;
}

/**
 * The series source: the USD cash rate (`cashUntil`: the first date it no longer has) and SPY's
 * price index `IDX` (SPY's close x10, published 18:00 New York the next session); the index has
 * nothing after `indexUntil` and fails every call once `to` reaches `indexDownFrom`.
 */
function seriesSource(
  o: { cashUntil?: string; indexUntil?: string; indexDownFrom?: string } = {},
): SeriesSource {
  const cash = cashRates(sessions, DATES, o.cashUntil ?? TARGET);
  const spy = clean().SPY;
  return {
    info: {
      ...cash.info,
      provides: { series: ['CASH', 'IDX'], cashRates: { USD: 'CASH' } },
    },
    async fetchSeries(id, from, to, ctx) {
      if (id !== 'IDX') return cash.fetchSeries(id, from, to, ctx);
      if (o.indexDownFrom && to >= o.indexDownFrom) throw new Error('idx: HTTP 503');
      return spy
        .filter((b) => b.date >= from && b.date <= to && (!o.indexUntil || b.date <= o.indexUntil))
        .map((b) => ({
          date: b.date,
          value: b.close * 10,
          publishedAt: zonedInstant(sessions.after(b.date), '18:00', 'America/New_York'),
        }));
    },
  };
}
const rates = seriesSource();

/**
 * An FX source for `USDJPY` (rate 150, published 16:00 UTC the same day); `primary` suggests
 * itself as the primary; nothing after `until`; every call failing once `to` reaches `downFrom`;
 * no rate on the `closed` days, declared as its calendar `fx-cal` when `declared`.
 */
function fxSource(
  key: string,
  o: {
    primary?: boolean;
    until?: string;
    downFrom?: string;
    closed?: string[];
    declared?: boolean;
  } = {},
) {
  const s: FxSource = {
    info: testInfo(key, 'fx', {
      suggestedRole: o.primary ? 'primary' : 'secondary',
      ...(o.declared && { calendar: 'fx-cal' }),
    }),
    supports: (pair) => pair === 'USDJPY',
    async fetchRates(pair, from, to) {
      if (o.downFrom && to >= o.downFrom) throw new Error(`${key}: HTTP 503`);
      return DATES.filter(
        (d) => d >= from && d <= to && (!o.until || d <= o.until) && !o.closed?.includes(d),
      ).map((date) => ({ pair, date, rate: 150, publishedAt: `${date}T16:00:00Z` }));
    },
  };
  return s;
}

/** The calendars plug-in with `fx-cal`: the test sessions, `closed` days added as holidays. */
const fxCalendar = (closed: string[]): CalendarSource => ({
  info: testInfo('cal', 'calendar', { suggestedRole: 'primary' }),
  calendars: [{ ...sessions.calendar, id: 'fx-cal', holidays: closed }],
});

/** A corruption of the issuer's records for a ticker. */
type IssuerFault = (ticker: Ticker, records: IssuerRecord[]) => IssuerRecord[];

/**
 * An issuer publishing the clean history (NAV = the close, SPY's distribution, SSO's split),
 * corrupted by `fault`; nothing after `until`; every call failing once `to` reaches `downFrom`;
 * `blocked`: refusing every call (403), from the bootstrap on.
 */
function issuerSource(
  o: { fault?: IssuerFault; until?: string; downFrom?: string; blocked?: boolean } = {},
) {
  const data = clean();
  const s: IssuerSource = {
    info: testInfo('iss', 'issuer', { suggestedRole: 'check' }),
    supports: (ticker) => ticker === 'SPY' || ticker === 'SSO',
    async fetchRecords(ticker, from, to) {
      if (o.blocked) throw new BlockedError('iss: HTTP 403');
      if (o.downFrom && to >= o.downFrom) throw new Error('iss: HTTP 503');
      const t = ticker as Ticker;
      let records: IssuerRecord[] = data[t].map((b) => ({
        date: b.date,
        nav: b.close,
        currency: 'USD',
        ...(b.divCash > 0 && { distribution: b.divCash }),
        ...(b.splitFactor !== 1 && { split: b.splitFactor }),
      }));
      if (o.fault) records = o.fault(t, records);
      return records.filter(
        (r) => r.date >= from && r.date <= to && (!o.until || r.date <= o.until),
      );
    },
  };
  return s;
}
const onIssuerTarget =
  (ticker: Ticker, f: (r: IssuerRecord) => IssuerRecord): IssuerFault =>
  (t, records) =>
    t !== ticker ? records : records.map((r) => (r.date === TARGET ? f(r) : r));
/** Both funds' normal premium set (1%), so a NAV fault is graded, not only observed. */
const TOLERANCES = '{"SPY":0.01,"SSO":0.01}';

/**
 * A clean bootstrap up to the day before (the history the server holds), then the daily job for
 * the target day with these sources; returns the run, the day's forward entry and the alerts.
 */
async function run(
  bars: BarSource[],
  series: SeriesSource = rates,
  // `dailyMissing`: the plug-in is loaded for the bootstrap (its role is seeded), not the daily run.
  issuer?: { source: IssuerSource; tolerances?: string; dailyMissing?: boolean },
  // A base currency other than USD, with its FX sources.
  fx?: { base: string; sources: FxSource[]; calendars?: CalendarSource[] },
  // `http`: the daily run gives each bar source an HTTP client with its declared limits (the run
  // attaches the quota guard's store, the database's `provider_usage`); `before`: runs on the
  // database before the daily run (e.g. earlier runs' usage).
  daily: { http?: boolean; before?: (db: Db) => Promise<void> } = {},
) {
  const db = await testDb();
  await upsertSymbols(db, [
    // SPY's index check (layer C) runs on every case.
    { ticker: 'SPY', tier: 0, assetClass: 'equity', currency: 'USD', indexSeries: 'IDX' },
    {
      ticker: 'SSO',
      tier: 0,
      assetClass: 'equity',
      currency: 'USD',
      underlying: 'SPY',
      leverageFactor: 2,
    },
  ]);
  const owner = await createUser(db, {
    username: 'alex',
    passwordHash: 'x',
    totpSecretEnc: 'x',
    totpLastStep: 1,
    backupCodeHashes: ['a'],
    isAdmin: true,
  });
  await setSetting(db, 'forward_records_from', '2026-01-02');
  if (issuer?.tolerances) await setSetting(db, 'issuer_nav_tolerance', issuer.tolerances);
  if (fx) await setSetting(db, 'base_currency', fx.base);
  const version = await registerVersion(db, {
    ownerId: owner,
    name: 'Trend 2x',
    at: new Date('2026-01-14T22:00:00Z'),
    strategy: {
      name: 'Trend 2x',
      account: 'taxable',
      safeState: { holdings: [{ ticker: 'SPY', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [
        {
          id: 'A',
          type: 'compare',
          left: { indicator: 'price', ticker: 'SPY' },
          op: '>',
          right: { indicator: 'sma', ticker: 'SPY', length: 3 },
        },
      ],
      allocations: [
        { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'SSO', weight: 100 }] },
        { name: 'Calm', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      ],
    },
  });
  await addChannel(db, owner, { type: 'fake', target: 'me', authSecret: SECRET });
  await addChannel(db, owner, { type: 'fake', target: 'ops', admin: true, authSecret: SECRET });
  const { notifier, sent } = fakeNotifier();
  const job = (job: 'bootstrap' | 'daily', target: string, now: string, list: BarSource[]) => {
    const ctx = (info?: PluginInfo) => ({
      http:
        job === 'daily' && daily.http && info?.kind === 'bar'
          ? fakeHttp(Date.parse(now), info.limits)
          : (null as never),
      now: new Date(now),
      log: quiet,
    });
    return runJob(
      db,
      {
        ...emptyPlugins(),
        bars: list,
        series: [series],
        fx: fx?.sources ?? [],
        calendars: fx?.calendars ?? [],
        issuers: issuer && !(job === 'daily' && issuer.dailyMissing) ? [issuer.source] : [],
      },
      {
        job,
        target,
        sessions,
        seriesSessions: sessions,
        now: new Date(now),
        clock: () => new Date(now),
        log: quiet,
        context: ctx,
        alerting: {
          date: target,
          notifiers: [notifier],
          authSecret: SECRET,
          context: () => ctx(),
          log: quiet,
        },
        tsa: { authorities: [] },
        code: 'test',
        onComplete: async () => true,
      },
    );
  };
  const before = await job(
    'bootstrap',
    sessions.before(TARGET, 1),
    '2026-01-16T01:30:00Z',
    sources(),
  );
  expect(before.ok).toBe(true);
  await daily.before?.(db);
  const result = await job('daily', TARGET, '2026-01-17T01:30:00Z', bars);
  const today = (await forwardRecord(db, version.id)).find((e) => e.date === TARGET)!;
  return {
    db,
    result,
    today,
    reasons: (JSON.parse(today.payload) as { reasons: string[] }).reasons,
    // The owner's alert for the strategy (the admin alerts on the same channel are separate).
    alert: sent.map((m) => m.text).find((t) => t.startsWith('Trend 2x:')),
    adminAlerts: sent.map((m) => m.text).filter((t) => t.startsWith('Saku:')),
    /** A later daily run for the same target (a catch-up run) with these sources. */
    again: (list: BarSource[], now: string) => job('daily', TARGET, now, list),
  };
}

type Source = 'p' | 's1' | 's2';
/** The primary, an adjusted secondary (as Yahoo or Tiingo send adjusted closes) and a plain one. */
const sources = (fault?: Fault, on: Source = 'p') => [
  source('p', on === 'p' && fault ? { fault } : {}),
  source('s1', { adjusted: true, ...(on === 's1' && fault && { fault }) }),
  source('s2', on === 's2' && fault ? { fault } : {}),
];

const decimalShift = onTarget('SPY', (b) => ({ ...b, close: b.close * 10, high: b.high! * 10 }));
const missedSplit = onTarget('SSO', (b) => ({ ...b, splitFactor: 1 }));
const missedDividend = onTarget('SPY', (b) => ({ ...b, divCash: 0 }));
const staleClose = onTarget('SPY', (b, prev) => ({
  ...b,
  open: prev.close,
  high: prev.close,
  low: prev.close,
  close: prev.close,
}));

/**
 * Each material fault, the source it is injected into, the status the severity rules give it
 * and the check expected to catch it (a reason on the strategy's record).
 */
const FAULTS: { name: string; fault: Fault; on?: Source; expect: 'red'; caught: string }[] = [
  { name: 'decimal shift', fault: decimalShift, expect: 'red', caught: 'SPY:B.close_match@s1' },
  {
    name: 'decimal shift in a secondary',
    fault: decimalShift,
    on: 's2',
    expect: 'red',
    caught: 'SPY:B.close_match@s2',
  },
  { name: 'missed split', fault: missedSplit, expect: 'red', caught: 'SSO:B.split_match@s1' },
  {
    name: 'missed split in a secondary',
    fault: missedSplit,
    on: 's1',
    expect: 'red',
    caught: 'SSO:B.split_match@s1',
  },
  {
    name: 'split applied to prices but not declared',
    fault: onTarget('SSO', (b) => ({
      ...b,
      close: b.close * 2,
      open: b.open! * 2,
      high: b.high! * 2,
      low: b.low! * 2,
      splitFactor: 1,
    })),
    expect: 'red',
    caught: 'SSO:B.split_match@s1',
  },
  {
    name: 'missed dividend',
    fault: missedDividend,
    expect: 'red',
    caught: 'SPY:B.dividend_match@s1',
  },
  {
    name: 'missed dividend in a secondary',
    fault: missedDividend,
    on: 's2',
    expect: 'red',
    caught: 'SPY:B.dividend_match@s2',
  },
  {
    name: 'dividend ten times too large',
    fault: onTarget('SPY', (b) => ({ ...b, divCash: b.divCash * 10 })),
    expect: 'red',
    caught: 'SPY:B.dividend_match@s1',
  },
  {
    name: "a provider's adjusted close off by 1%",
    fault: onTarget('SPY', (b) => ({ ...b, providerAdjClose: b.providerAdjClose! * 1.01 })),
    on: 's1',
    expect: 'red',
    caught: 'SPY:B.adj_return_match@s1',
  },
  { name: 'stale close', fault: staleClose, expect: 'red', caught: 'SPY:B.close_match@s1' },
  {
    name: 'stale close in a secondary',
    fault: staleClose,
    on: 's2',
    expect: 'red',
    caught: 'SPY:B.close_match@s2',
  },
  {
    name: 'swapped tickers',
    fault: (t, _bars, all) => all[t === 'SPY' ? 'SSO' : 'SPY'].map((b) => ({ ...b })),
    expect: 'red',
    caught: 'SPY:B.close_match@s1',
  },
  {
    name: 'timezone shift (each bar a session late)',
    fault: (_t, bars) => bars.slice(0, -1).map((b, i) => ({ ...b, date: bars[i + 1]!.date })),
    expect: 'red',
    caught: 'SPY:B.close_match@s1',
  },
  {
    // The primary lacks the target day: SPY's stand-in passes (the index for the target is not
    // published by the run, so it cannot check it), SSO's fails layer C against the shifted
    // underlying. The shifted days before are red on their own dates.
    name: 'timezone shift (each bar a session early)',
    fault: (_t, bars) => bars.slice(1).map((b, i) => ({ ...b, date: bars[i]!.date })),
    expect: 'red',
    caught: 'SSO:stand_in_refused:layer_c',
  },
];

describe('fault injection (layer F)', () => {
  it('clean data is green (the control: otherwise the cases below prove nothing)', async () => {
    const { result, today, alert } = await run(sources());
    expect(result.ok).toBe(true);
    expect(today).toMatchObject({
      dataStatus: 'green',
      safeStateApplied: false,
      allocation: 'Risk on',
    });
    expect(alert).toMatch(/^Trend 2x: new allocation/);
  });

  for (const c of FAULTS) {
    it(`${c.name} (${c.on ?? 'p'}): red, safe state`, async () => {
      const { today, reasons, alert } = await run(sources(c.fault, c.on));
      expect(today.dataStatus).toBe(c.expect);
      expect(reasons).toContain(c.caught);
      // Never a normal signal: the record and the alert carry the safe state.
      expect(today).toMatchObject({ safeStateApplied: true, allocation: 'Safe state' });
      expect(alert).toMatch(new RegExp(`^Trend 2x: safe state for ${TARGET}`));
    });
  }

  // The primary has no usable bar: the stand-in rule grades it (two agreeing secondaries, and the
  // signal is far from flipping within the band, so yellow "secondary source only").
  for (const c of [
    {
      name: 'missing day',
      fault: ((t, bars) => (t === 'SPY' ? bars.filter((b) => b.date !== TARGET) : bars)) as Fault,
    },
    {
      name: 'the same day sent twice (the response is refused)',
      fault: ((t, bars) =>
        t === 'SPY'
          ? [...bars, { ...bars.at(-1)!, close: bars.at(-1)!.close * 1.01 }]
          : bars) as Fault,
    },
  ]) {
    it(`${c.name}: yellow by the stand-in rule, with the warning`, async () => {
      const { result, today, reasons, alert } = await run(sources(c.fault));
      expect(today).toMatchObject({
        dataStatus: 'yellow',
        safeStateApplied: false,
        allocation: 'Risk on',
      });
      expect(reasons).toContain('SPY:stand_in@s1');
      // The record's first entry: the allocation alert, with the warning.
      expect(alert).toContain('Data health: yellow (computed with a warning).');
      // A refused response leaves the source incomplete for the run (nothing of it is stored).
      if (c.name.startsWith('the same day')) expect(result.error).toBe('incomplete: p');
    });
  }

  it('a day with a single source is never green: yellow, with the warning', async () => {
    const { result, today, reasons, alert } = await run([
      source('p'),
      source('s1', { down: true }),
      source('s2', { down: true }),
    ]);
    expect(result.ok).toBe(false);
    expect(today).toMatchObject({ dataStatus: 'yellow', safeStateApplied: false });
    expect(reasons).toContain('SPY:single_source');
    expect(alert).toContain('Data health: yellow (computed with a warning).');
  });

  describe('layer D (issuer data, advisory)', () => {
    /** The daily run's layer D results (the bootstrap's are stored by its own run). */
    const layerD = async (db: Awaited<ReturnType<typeof run>>['db'], runId: string) =>
      db.select().from(schema.checkResults).where(eq(schema.checkResults.runId, runId));

    it('clean issuer data stays green (the control)', async () => {
      const { db, result, today } = await run(sources(), rates, {
        source: issuerSource(),
        tolerances: TOLERANCES,
      });
      expect(result.ok).toBe(true);
      expect(today).toMatchObject({
        dataStatus: 'green',
        safeStateApplied: false,
        allocation: 'Risk on',
      });
      const d = (await layerD(db, result.runId)).filter((r) => r.layer === 'D');
      // Every check ran on the target day, all green.
      const onTarget = d.filter((r) => r.date === TARGET).map((r) => r.checkName);
      expect(onTarget).toEqual(
        expect.arrayContaining([
          'nav_premium',
          'distribution_match',
          'split_match',
          'issuer_stale',
        ]),
      );
      expect(d.every((r) => r.status === 'green')).toBe(true);
    });

    for (const c of [
      {
        name: 'NAV off by 10% with a tolerance set',
        source: () =>
          issuerSource({ fault: onIssuerTarget('SPY', (r) => ({ ...r, nav: r.nav! * 1.1 })) }),
        caught: 'SPY:D.nav_premium@iss',
        told: false,
      },
      {
        name: "a missed distribution in the issuer's data",
        source: () =>
          issuerSource({
            fault: onIssuerTarget('SPY', ({ distribution: _d, ...r }) => r),
          }),
        caught: 'SPY:D.distribution_match@iss',
        told: false,
      },
      {
        name: 'the issuer source down for days',
        source: () => issuerSource({ until: sessions.before(TARGET, 3), downFrom: TARGET }),
        caught: 'SPY:D.issuer_stale@iss',
        told: true,
      },
      {
        // Nothing ever stored: graded on what the source supports, never green by having nothing.
        name: 'the issuer refusing every request from the bootstrap on',
        source: () => issuerSource({ blocked: true }),
        caught: 'SPY:D.issuer_stale@iss',
        told: true,
      },
      {
        // The role stays in source_roles; without the plug-in nothing is fetched or said.
        name: 'the issuer plug-in no longer loaded (role still set)',
        source: () => issuerSource(),
        dailyMissing: true,
        caught: 'SPY:D.issuer_stale@iss',
        told: true,
      },
    ]) {
      it(`${c.name}: yellow with the reason, never red, the normal signal kept`, async () => {
        const { db, result, today, reasons, alert, adminAlerts } = await run(sources(), rates, {
          source: c.source(),
          tolerances: TOLERANCES,
          ...('dailyMissing' in c && { dailyMissing: true }),
        });
        // Best effort: an issuer failure never makes the run incomplete.
        expect(result.ok).toBe(true);
        expect(today).toMatchObject({
          dataStatus: 'yellow',
          safeStateApplied: false,
          allocation: 'Risk on',
        });
        expect(reasons).toContain(c.caught);
        expect(alert).toContain('Data health: yellow (computed with a warning).');
        const d = (await layerD(db, result.runId)).filter((r) => r.layer === 'D');
        expect(d.some((r) => r.status === 'yellow')).toBe(true);
        expect(d.every((r) => r.status !== 'red')).toBe(true);
        // A source that could not be fetched is told to the admins in words.
        expect(adminAlerts.join('\n').includes('issuer data could not be fetched (iss)')).toBe(
          c.told,
        );
      });
    }
  });

  it('a stale cash rate is red for the day overall and tells the admins', async () => {
    // The rate stops a week before (more than 5 business days behind). By design it grades the day,
    // not the strategy: it moves cash and financing equity, never the signal (docs/data-pipeline.md).
    const stale = seriesSource({ cashUntil: sessions.before(TARGET, 7) });
    const { today, adminAlerts } = await run(sources(), stale);
    expect(today.dataStatus).toBe('green');
    expect(adminAlerts.some((t) => t.startsWith(`Saku: data for ${TARGET} is not green`))).toBe(
      true,
    );
    expect(adminAlerts.join('\n')).toMatch(/CASH/);
  });

  it('the index source down for days: the fund yellow, the allocation kept, admins told', async () => {
    // The index stops three sessions before and its source fails from the target on: SPY's index
    // check cannot run (yellow, a cross-check unavailable), the series 3 business days behind.
    const down = seriesSource({ indexUntil: sessions.before(TARGET, 3), indexDownFrom: TARGET });
    const { result, today, reasons, alert, adminAlerts } = await run(sources(), down);
    expect(result.error).toBe('incomplete: rates');
    expect(today).toMatchObject({
      dataStatus: 'yellow',
      safeStateApplied: false,
      allocation: 'Risk on',
    });
    expect(reasons).toContain('SPY:C.index_unavailable@rates');
    expect(alert).toContain('Data health: yellow (computed with a warning).');
    const told = adminAlerts.join('\n');
    expect(told).toMatch(new RegExp(`Saku: data for ${TARGET} is not green`));
    expect(told).toContain('IDX: 3 business days behind (rates)');
  });

  for (const c of [
    { name: 'three sessions', until: 3, grade: 'yellow', words: 'USDJPY: 3 business days behind' },
    { name: 'a week', until: 7, grade: 'red', words: 'USDJPY: 7 business days behind' },
  ]) {
    it(`the FX primary down for ${c.name} (base JPY): the day ${c.grade}, the strategy unaffected`, async () => {
      // FX health never affects a signal computed in USD (04): the day overall only.
      const fx = [
        fxSource('fxp', {
          primary: true,
          until: sessions.before(TARGET, c.until),
          downFrom: TARGET,
        }),
        fxSource('fxs'),
      ];
      const { db, result, today, adminAlerts } = await run(sources(), rates, undefined, {
        base: 'JPY',
        sources: fx,
      });
      expect(result.error).toBe('incomplete: fxp');
      expect(today).toMatchObject({
        dataStatus: 'green',
        safeStateApplied: false,
        allocation: 'Risk on',
      });
      const [overall] = await db
        .select()
        .from(schema.dataHealth)
        .where(eq(schema.dataHealth.runId, result.runId))
        .then((rows) => rows.filter((r) => r.symbolId === null && r.date === TARGET));
      expect(overall).toMatchObject({ status: c.grade });
      expect(overall!.reasons).toEqual(
        expect.arrayContaining([`USDJPY:stale(${c.until})@fxp`, 'USDJPY:B.fx_unavailable@fxs']),
      );
      const told = adminAlerts.join('\n');
      expect(told).toContain(c.words);
      expect(told).toContain('the exchange rate cross-check could not run');
    });
  }

  it('a clean FX primary and secondary (base JPY) stay green (the control)', async () => {
    const { result, today, db } = await run(sources(), rates, undefined, {
      base: 'JPY',
      sources: [fxSource('fxp', { primary: true }), fxSource('fxs')],
    });
    expect(result.ok).toBe(true);
    expect(today).toMatchObject({ dataStatus: 'green', allocation: 'Risk on' });
    const rows = await db
      .select()
      .from(schema.dataHealth)
      .where(eq(schema.dataHealth.runId, result.runId));
    expect(rows.find((r) => r.symbolId === null && r.date === TARGET)).toMatchObject({
      status: 'green',
    });
  });

  for (const declared of [true, false]) {
    it(`an FX primary closed on a day it ${declared ? 'declares (expected gap): green' : 'does not declare: yellow for that day'}`, async () => {
      const closed = [sessions.before(TARGET, 2)];
      const { result, today, db } = await run(sources(), rates, undefined, {
        base: 'JPY',
        sources: [fxSource('fxp', { primary: true, closed, declared }), fxSource('fxs')],
        calendars: [fxCalendar(closed)],
      });
      expect(result.ok).toBe(true);
      expect(today).toMatchObject({ dataStatus: 'green', allocation: 'Risk on' });
      const [day] = await db
        .select()
        .from(schema.dataHealth)
        .where(eq(schema.dataHealth.runId, result.runId))
        .then((rows) => rows.filter((r) => r.symbolId === null && r.date === closed[0]));
      expect(day).toMatchObject(
        declared
          ? { status: 'green' }
          : { status: 'yellow', reasons: ['USDJPY:B.fx_unavailable@fxs'] },
      );
    });
  }

  // The data paths added on 2026-10-30 (docs/data-pipeline.md "Quota guard" and "A source's
  // unfinished day is not stored"; storeRawBars' declared adjusted-close rounding).
  describe('quota guard, unfinished day, adjusted-close rounding', () => {
    /** The daily run's clock (as in `run`). */
    const DAILY = Date.parse('2026-01-17T01:30:00Z');
    /** `n` earlier requests of `provider`, `ago` ms before the daily run, cycling over `symbols`. */
    const earlier =
      (provider: string, n: number, symbols: (string | null)[], ago: number) => async (db: Db) => {
        for (let i = 0; i < n; i++) {
          const symbol = symbols[i % symbols.length] ?? null;
          await recordProviderRequest(db, { provider, at: DAILY - ago, symbol });
        }
      };
    /** A day of an earlier run: the symbols stay counted (31 days), the request windows are clear. */
    const DAY_AGO = 86_400_000 + 3_600_000;
    /** Ten minutes ago: inside the hour window, which frees up only in 50 minutes (over 2). */
    const MINUTES_AGO = 600_000;
    /** perHour 10: 8 requests allowed (80%); `full` fills them. */
    const hourly = { limits: { perHour: 10 } };
    const full = (provider: string) => earlier(provider, 8, [null], MINUTES_AGO);

    const health = async (r: Awaited<ReturnType<typeof run>>, runId = r.result.runId) => {
      const tickers = new Map(
        (await r.db.select().from(schema.symbols)).map((x) => [x.id, x.ticker]),
      );
      return (await r.db.select().from(schema.dataHealth).where(eq(schema.dataHealth.runId, runId)))
        .filter((x) => x.date === TARGET)
        .map((x) => ({
          ticker: x.symbolId === null ? null : tickers.get(x.symbolId),
          status: x.status,
          reasons: x.reasons,
        }));
    };
    /** The sources that stored a bar for the ticker on the target day. */
    const storedOnTarget = async (r: Awaited<ReturnType<typeof run>>, ticker: Ticker) => {
      const [sym] = await r.db
        .select()
        .from(schema.symbols)
        .where(eq(schema.symbols.ticker, ticker));
      return (await r.db.select().from(schema.barsRaw))
        .filter((x) => x.symbolId === sym!.id && x.date === TARGET)
        .map((x) => x.source)
        .sort();
    };

    // The control for the cases below: the sources' requests go through a guarded client.
    it('limits declared and room left: green, every request counted (the control)', async () => {
      const r = await run(
        [
          source('p', { info: { limits: { symbolsPerMonth: 5, perHour: 10 } } }),
          source('s1', { adjusted: true, info: hourly }),
          source('s2', { info: hourly }),
        ],
        rates,
        undefined,
        undefined,
        { http: true, before: earlier('p', 3, ['AAA', 'BBB', 'SPY'], DAY_AGO) },
      );
      expect(r.result.ok).toBe(true);
      expect(r.today).toMatchObject({ dataStatus: 'green', allocation: 'Risk on' });
      const days = (await r.db.select().from(schema.providerUsage)).filter(
        (u) => u.windowType === 'day' && u.windowStart === '2026-01-17',
      );
      for (const key of ['p', 's1', 's2']) {
        expect(days.find((u) => u.provider === key)).toMatchObject({
          requestCount: 2,
          symbols: ['SPY', 'SSO'],
        });
      }
    });

    // A refused ticker is the primary missing for it: the stand-in rule grades it (04: "Primary
    // data missing with no usable stand-in" is red; here two agreeing secondaries stand in and the
    // signal cannot flip within the band, so yellow), exactly as the primary failing outright.
    it("the primary's symbol cap refuses a ticker the strategy reads: as a primary failure for it", async () => {
      // symbolsPerMonth 5: 4 allowed; AAA, BBB, CCC and SPY counted by earlier runs, SSO is new.
      const r = await run(
        [
          source('p', { info: { limits: { symbolsPerMonth: 5 } } }),
          source('s1', { adjusted: true }),
          source('s2'),
        ],
        rates,
        undefined,
        undefined,
        { http: true, before: earlier('p', 4, ['AAA', 'BBB', 'CCC', 'SPY'], DAY_AGO) },
      );
      // SPY, already counted, is still fetched; SSO is refused (nothing sent, nothing stored).
      expect(await storedOnTarget(r, 'SPY')).toEqual(['p', 's1', 's2']);
      expect(await storedOnTarget(r, 'SSO')).toEqual(['s1', 's2']);
      const usage = await r.db.select().from(schema.providerUsage);
      expect(usage.some((u) => u.provider === 'p' && u.symbols.includes('SSO'))).toBe(false);
      expect(r.result.error).toBe('incomplete: p');
      expect(r.today).toMatchObject({
        dataStatus: 'yellow',
        safeStateApplied: false,
        allocation: 'Risk on',
      });
      expect(r.reasons).toEqual(['SSO:stand_in@s1']);
      expect(await health(r)).toEqual(
        expect.arrayContaining([
          { ticker: 'SPY', status: 'green', reasons: [] },
          { ticker: 'SSO', status: 'yellow', reasons: ['stand_in@s1'] },
        ]),
      );
      expect(r.alert).toContain('Data health: yellow (computed with a warning).');
      expect(r.adminAlerts.join('\n')).toContain(
        `Saku: the daily run for ${TARGET} did not finish\nReason: incomplete: p.`,
      );
    });

    it("the primary's hour window full from an earlier run: stopped, graded as the primary down", async () => {
      const r = await run(
        [source('p', { info: hourly }), source('s1', { adjusted: true }), source('s2')],
        rates,
        undefined,
        undefined,
        { http: true, before: full('p') },
      );
      // Nothing sent: the source stopped before its first request.
      expect(await storedOnTarget(r, 'SPY')).toEqual(['s1', 's2']);
      expect(await storedOnTarget(r, 'SSO')).toEqual(['s1', 's2']);
      const down = await run([
        source('p', { down: true }),
        source('s1', { adjusted: true }),
        source('s2'),
      ]);
      for (const x of [r, down]) {
        expect(x.result.error).toBe('incomplete: p');
        expect(x.today).toMatchObject({
          dataStatus: 'yellow',
          safeStateApplied: false,
          allocation: 'Risk on',
        });
        expect(x.reasons).toEqual(['SPY:stand_in@s1', 'SSO:stand_in@s1']);
        expect(x.adminAlerts.join('\n')).toContain('Reason: incomplete: p.');
      }
      expect(await health(r)).toEqual(await health(down));
    });

    it('a secondary stopped by its quota: yellow (secondary unavailable), never green', async () => {
      const r = await run(
        [source('p'), source('s1', { adjusted: true }), source('s2', { info: hourly })],
        rates,
        undefined,
        undefined,
        { http: true, before: full('s2') },
      );
      expect(r.result.error).toBe('incomplete: s2');
      expect(r.today).toMatchObject({
        dataStatus: 'yellow',
        safeStateApplied: false,
        allocation: 'Risk on',
      });
      expect(r.reasons).toEqual(['SPY:B.secondary_missing@s2', 'SSO:B.secondary_missing@s2']);
      // Caught as the secondary's bar missing (layer B, yellow), not as a mismatch.
      const b = (
        await r.db
          .select()
          .from(schema.checkResults)
          .where(eq(schema.checkResults.runId, r.result.runId))
      ).filter((x) => x.date === TARGET && x.source === 's2' && x.layer === 'B');
      expect(b.map((x) => [x.checkName, x.status, x.message])).toEqual([
        ['secondary_missing', 'yellow', 'no secondary bar'],
        ['secondary_missing', 'yellow', 'no secondary bar'],
      ]);
    });

    it('both secondaries stopped by their quotas: single source, yellow, never green', async () => {
      const r = await run(
        [
          source('p'),
          source('s1', { adjusted: true, info: hourly }),
          source('s2', { info: hourly }),
        ],
        rates,
        undefined,
        undefined,
        {
          http: true,
          before: async (db) => {
            await full('s1')(db);
            await full('s2')(db);
          },
        },
      );
      expect(r.result.error).toBe('incomplete: s1, s2');
      expect(r.today).toMatchObject({
        dataStatus: 'yellow',
        safeStateApplied: false,
        allocation: 'Risk on',
      });
      expect(r.reasons).toEqual(expect.arrayContaining(['SPY:single_source', 'SSO:single_source']));
      expect(r.alert).toContain('Data health: yellow (computed with a warning).');
    });

    it("a secondary's unfinished day (no bar for the target yet): yellow, then green with the bar", async () => {
      // As Yahoo before the final time: the bar left out, the others have it. Not a failure of the
      // run (the source answered); the day is graded with that secondary unavailable.
      const unfinished: Fault = (_t, bars) => bars.filter((b) => b.date !== TARGET);
      const r = await run([
        source('p'),
        source('s1', { adjusted: true, fault: unfinished }),
        source('s2'),
      ]);
      expect(r.result.ok).toBe(true);
      expect(await storedOnTarget(r, 'SPY')).toEqual(['p', 's2']);
      expect(r.today).toMatchObject({
        dataStatus: 'yellow',
        safeStateApplied: false,
        allocation: 'Risk on',
      });
      // Its own reason, in words naming the source, never "closes differ between sources".
      expect(r.reasons).toEqual(['SPY:B.secondary_missing@s1', 'SSO:B.secondary_missing@s1']);
      expect(r.alert).toContain('SPY: no bar from s1 for this day');
      expect(r.alert).not.toContain('closes differ');
      const b = (
        await r.db
          .select()
          .from(schema.checkResults)
          .where(eq(schema.checkResults.runId, r.result.runId))
      ).filter((x) => x.date === TARGET && x.source === 's1' && x.layer === 'B');
      expect(b.map((x) => [x.checkName, x.status, x.message])).toEqual([
        ['secondary_missing', 'yellow', 'no secondary bar'],
        ['secondary_missing', 'yellow', 'no secondary bar'],
      ]);
      // The next run, with the bar: the target regraded green; the forward record keeps what was
      // signaled (yellow), append-only.
      const next = await r.again(sources(), '2026-01-17T03:00:00Z');
      expect(next.ok).toBe(true);
      expect(await health(r, next.runId)).toEqual(
        expect.arrayContaining([
          { ticker: 'SPY', status: 'green', reasons: [] },
          { ticker: 'SSO', status: 'green', reasons: [] },
          { ticker: null, status: 'green', reasons: [] },
        ]),
      );
      const record = await forwardRecord(r.db, r.today.versionId);
      expect(record.filter((e) => e.date === TARGET).map((e) => e.dataStatus)).toEqual(['yellow']);
    });

    // The declared rounding only spares re-adjustment events within it; it never hides a fault.
    for (const c of [
      { name: 'on the target day', date: TARGET, events: 0 },
      // A stored date: the change is recorded as a one-date re-adjustment (factor 1.01), not
      // rounding, and the target's adjusted return (from that date) is caught.
      { name: 'on the stored day before', date: sessions.before(TARGET, 1), events: 1 },
    ]) {
      it(`a provider's adjusted close off by 1% ${c.name}, rounding 1e-6 declared: red, safe state`, async () => {
        const off: Fault = (t, bars) =>
          t !== 'SPY'
            ? bars
            : bars.map((x) =>
                x.date === c.date ? { ...x, providerAdjClose: x.providerAdjClose! * 1.01 } : x,
              );
        const r = await run([
          source('p'),
          source('s1', { adjusted: true, fault: off, info: { adjCloseRounding: 1e-6 } }),
          source('s2'),
        ]);
        expect(r.today.dataStatus).toBe('red');
        expect(r.reasons).toContain('SPY:B.adj_return_match@s1');
        expect(r.today).toMatchObject({ safeStateApplied: true, allocation: 'Safe state' });
        expect(r.alert).toMatch(new RegExp(`^Trend 2x: safe state for ${TARGET}`));
        const events = await r.db.select().from(schema.readjustments);
        expect(events).toHaveLength(c.events);
        if (c.events) {
          expect(events[0]).toMatchObject({ source: 's1', fromDate: c.date, toDate: c.date });
          expect(events[0]!.factor).toBeCloseTo(1.01, 12);
        }
      });
    }
  });
});
