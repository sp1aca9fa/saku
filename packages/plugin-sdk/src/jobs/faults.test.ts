// Layer F (requirements 04, A3): every material corruption of a source's data, injected into a
// whole daily run with all sources available, is detected (never green) and never produces a
// normal signal on red: the forward record and the alert carry the strategy's safe state.
// Separately, a day with a single source is never green. Synthetic data, no network.
import { type RawBar, totalReturnIndex, zonedInstant } from '@saku/core';
import { Sessions } from '@saku/data';
import {
  addChannel,
  createUser,
  forwardRecord,
  registerVersion,
  setSetting,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { emptyPlugins } from '../registry';
import type { BarSource, Notifier, PluginInfo, SeriesSource } from '../types';
import { runJob } from './run';

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
const quiet = { info() {}, warn() {} };

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
    t !== ticker ? bars : bars.map((b, i) => (b.date === TARGET ? f(b, bars[i - 1]!) : b));

const info = (key: string, kind: PluginInfo['kind'], extra: Partial<PluginInfo> = {}) =>
  ({
    key,
    kind,
    name: key,
    provides: {},
    suggestedRole: key === 'p' ? 'primary' : 'secondary',
    termsUrl: 'https://example.test',
    ...extra,
  }) as PluginInfo;

/** A bar source answering from the clean history, corrupted by `fault`; `down` fails every call. */
function source(key: string, o: { fault?: Fault; down?: boolean; adjusted?: boolean } = {}) {
  const data = clean();
  const adj = Object.fromEntries(
    Object.entries(data).map(([t, bars]) => [t, totalReturnIndex(bars, 100)]),
  );
  const s: BarSource = {
    info: info(key, 'bar'),
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

const rates: SeriesSource = {
  info: info('rates', 'series', {
    suggestedRole: 'primary',
    provides: { series: ['CASH'], cashRates: { USD: 'CASH' } },
  }),
  async fetchSeries(_id, from, to) {
    return DATES.filter((d) => d >= from && d <= to && d < TARGET).map((date) => ({
      date,
      value: 4,
      publishedAt: zonedInstant(sessions.after(date), '18:00', 'America/New_York'),
    }));
  },
};

/**
 * A clean bootstrap up to the day before (the history the server holds), then the daily job for
 * the target day with these sources; returns the day's forward entry and the alerts.
 */
async function run(bars: BarSource[]) {
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
  const sent: string[] = [];
  const notifier: Notifier = {
    info: { key: 'fake', kind: 'notifier', name: 'Fake', termsUrl: 'x', maxLength: 4000 },
    validTarget: () => true,
    send: async (_target, text) => void sent.push(text),
  };
  const ctx = () => ({ http: null as never, now: new Date(), log: quiet });
  const job = (job: 'bootstrap' | 'daily', target: string, now: string, list: BarSource[]) =>
    runJob(
      db,
      { ...emptyPlugins(), bars: list, series: [rates] },
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
          date: TARGET,
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
  const before = await job(
    'bootstrap',
    sessions.before(TARGET, 1),
    '2026-01-16T01:30:00Z',
    sources(),
  );
  expect(before.ok).toBe(true);
  const result = await job('daily', TARGET, '2026-01-17T01:30:00Z', bars);
  const record = await forwardRecord(db, version.id);
  return { result, today: record.find((e) => e.date === TARGET)!, sent };
}

const sources = (fault?: Fault, on: 'p' | 's1' = 'p') => [
  source('p', on === 'p' && fault ? { fault } : {}),
  source('s1', { adjusted: true, ...(on === 's1' && fault && { fault }) }),
  source('s2'),
];

/** Each material fault and the status the severity rules give it. */
const FAULTS: { name: string; fault: Fault; on?: 'p' | 's1'; expect: 'red' | 'yellow' }[] = [
  {
    name: 'decimal shift',
    fault: onTarget('SPY', (b) => ({ ...b, close: b.close * 10, high: b.high * 10 })),
    expect: 'red',
  },
  {
    name: 'decimal shift in a secondary',
    fault: onTarget('SPY', (b) => ({ ...b, close: b.close / 10, low: b.low / 10 })),
    on: 's1',
    expect: 'red',
  },
  {
    name: 'missed split',
    fault: onTarget('SSO', (b) => ({ ...b, splitFactor: 1 })),
    expect: 'red',
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
  },
  { name: 'missed dividend', fault: onTarget('SPY', (b) => ({ ...b, divCash: 0 })), expect: 'red' },
  {
    name: 'dividend ten times too large',
    fault: onTarget('SPY', (b) => ({ ...b, divCash: b.divCash * 10 })),
    expect: 'red',
  },
  {
    name: 'stale close',
    fault: onTarget('SPY', (b, prev) => ({
      ...b,
      open: prev.close,
      high: prev.close,
      low: prev.close,
      close: prev.close,
    })),
    expect: 'red',
  },
  {
    name: 'swapped tickers',
    fault: (t, _bars, all) => all[t === 'SPY' ? 'SSO' : 'SPY'].map((b) => ({ ...b })),
    expect: 'red',
  },
  {
    name: 'timezone shift (each bar a session late)',
    fault: (_t, bars) => bars.slice(0, -1).map((b, i) => ({ ...b, date: bars[i + 1]!.date })),
    expect: 'red',
  },
  {
    name: 'timezone shift (each bar a session early)',
    fault: (_t, bars) => bars.slice(1).map((b, i) => ({ ...b, date: bars[i]!.date })),
    expect: 'red',
  },
  // The primary has no usable bar: the stand-in rule grades it (two agreeing secondaries, and the
  // signal is far from flipping within the band, so yellow "secondary source only").
  {
    name: 'missing day',
    fault: (t, bars) => (t === 'SPY' ? bars.filter((b) => b.date !== TARGET) : bars),
    expect: 'yellow',
  },
  {
    name: 'duplicate day',
    fault: (t, bars) =>
      t === 'SPY' ? [...bars, { ...bars.at(-1)!, close: bars.at(-1)!.close * 1.01 }] : bars,
    expect: 'yellow',
  },
];

describe('fault injection (layer F)', () => {
  it('clean data is green (the control: otherwise the cases below prove nothing)', async () => {
    const { result, today } = await run(sources());
    expect(result.ok).toBe(true);
    expect(today).toMatchObject({
      dataStatus: 'green',
      safeStateApplied: false,
      allocation: 'Risk on',
    });
  });

  for (const c of FAULTS) {
    it(`${c.name}: ${c.expect}${c.expect === 'red' ? ', safe state' : ', with the warning'}`, async () => {
      const { today, sent } = await run(sources(c.fault, c.on));
      expect(today.dataStatus).toBe(c.expect);
      const alert = sent.find((t) => t.includes(TARGET))!;
      if (c.expect === 'red') {
        // Never a normal signal: the record and the alert carry the safe state.
        expect(today).toMatchObject({ safeStateApplied: true, allocation: 'Safe state' });
        expect(alert).toContain('safe state');
      } else {
        expect(today.safeStateApplied).toBe(false);
        expect(JSON.parse(today.payload).reasons).toContain('SPY:stand_in@s1');
        expect(alert).toMatch(/not green|warning|secondary/i);
      }
    });
  }

  it('a day with a single source is never green', async () => {
    const { result, today } = await run([
      source('p'),
      source('s1', { down: true }),
      source('s2', { down: true }),
    ]);
    expect(result.ok).toBe(false);
    expect(today.dataStatus).not.toBe('green');
  });
});
