// Layer F (requirements 04, A3): every material corruption of a source's data, injected into a
// whole daily run with all sources available, is detected (never green) and never produces a
// normal signal on red: the forward record and the alert carry the strategy's safe state.
// Separately, a day with a single source is never green. Layer D (issuer data) faults are
// advisory: yellow with the reason, never red, never a change of the normal signal. Synthetic
// data, no network.
import { type IssuerRecord, type RawBar, totalReturnIndex } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  addChannel,
  createUser,
  forwardRecord,
  registerVersion,
  schema,
  setSetting,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { BlockedError } from '../http';
import { emptyPlugins } from '../registry';
import type { BarSource, IssuerSource, SeriesSource } from '../types';
import { runJob } from './run';
import { cashRates, fakeNotifier, quiet, testInfo } from './testkit';

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

/** A bar source answering from the clean history, corrupted by `fault`; `down` fails every call. */
function source(key: string, o: { fault?: Fault; down?: boolean; adjusted?: boolean } = {}) {
  const data = clean();
  const adj = Object.fromEntries(
    Object.entries(data).map(([t, bars]) => [t, totalReturnIndex(bars, 100)]),
  );
  const s: BarSource = {
    info: testInfo(key, 'bar'),
    async fetchBars(ticker, from, to) {
      if (o.down) throw new Error(`${key}: HTTP 503`);
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

const rates = cashRates(sessions, DATES, TARGET);

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
) {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'SPY', tier: 0, assetClass: 'equity', currency: 'USD' },
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
    const ctx = () => ({ http: null as never, now: new Date(now), log: quiet });
    return runJob(
      db,
      {
        ...emptyPlugins(),
        bars: list,
        series: [series],
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
          context: ctx,
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
    // The primary lacks the target day: SPY's stand-in passes, SSO's fails layer C against the
    // shifted underlying. The shifted days before are red on their own dates.
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
    const stale = cashRates(sessions, DATES, sessions.before(TARGET, 7));
    const { today, adminAlerts } = await run(sources(), stale);
    expect(today.dataStatus).toBe('green');
    expect(adminAlerts.some((t) => t.startsWith(`Saku: data for ${TARGET} is not green`))).toBe(
      true,
    );
    expect(adminAlerts.join('\n')).toMatch(/CASH/);
  });
});
