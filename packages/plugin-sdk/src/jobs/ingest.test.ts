import type { RawBar } from '@saku/core';
import { issuerRecordsOf, schema, setSetting, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { Sessions } from '@saku/data';
import { describe, expect, it } from 'vitest';
import { BlockedError } from '../http';
import { emptyPlugins } from '../registry';
import type { BarSource, FxSource, IssuerSource, PluginInfo } from '../types';
import { ingest, issuerAvailability, windowStart } from './ingest';

const sessions = new Sessions({
  id: 'test',
  version: 't',
  validFrom: '1990-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const log = { info: () => {}, warn: () => {} };
const info = (key: string, kind: PluginInfo['kind'] = 'bar'): PluginInfo => ({
  key,
  kind,
  name: key,
  provides: {},
  suggestedRole: 'secondary',
  termsUrl: 'https://example.test',
});
const bar = (date: string, close: number): RawBar => ({
  date,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
});

function source(
  key: string,
  fetch: (ticker: string, from: string, to: string) => RawBar[],
): BarSource & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    info: info(key),
    calls,
    async fetchBars(ticker, from, to) {
      calls.push(`${ticker} ${from} ${to}`);
      return fetch(ticker, from, to);
    },
  };
}

async function setup() {
  const db = await testDb();
  await upsertSymbols(db, [
    { ticker: 'AAA', tier: 0, assetClass: 'equity', currency: 'USD' },
    { ticker: 'BBB', tier: 0, assetClass: 'equity', currency: 'USD' },
  ]);
  return db;
}

const options = (mode: 'bootstrap' | 'daily') => ({
  mode,
  to: '2026-01-16',
  sessions,
  runId: null,
  log,
  context: () => ({ http: undefined as never, now: new Date(), log }),
  now: () => new Date('2026-01-17T01:00:00Z'),
});

describe('ingest', () => {
  it('daily runs refetch the last 10 sessions from every bar source', async () => {
    const db = await setup();
    const a = source('a', (_t, _f, to) => [bar(to, 10)]);
    const plugins = { ...emptyPlugins(), bars: [a] };
    const [report] = await ingest(db, plugins, options('daily'));
    expect(a.calls).toEqual(['AAA 2026-01-02 2026-01-16', 'BBB 2026-01-02 2026-01-16']);
    expect(report).toMatchObject({ source: 'a', ok: ['AAA', 'BBB'], inserted: 2 });
  });

  it('a block stops the source; another error only skips that ticker', async () => {
    const db = await setup();
    const blocked = source('blocked', () => {
      throw new BlockedError('HTTP 429');
    });
    const flaky = source('flaky', (t) => {
      if (t === 'AAA') throw new Error('bad answer');
      return [bar('2026-01-16', 1)];
    });
    const reports = await ingest(
      db,
      { ...emptyPlugins(), bars: [blocked, flaky] },
      options('daily'),
    );
    expect(blocked.calls).toHaveLength(1);
    expect(reports[0]).toMatchObject({ stopped: 'HTTP 429', ok: [] });
    expect(reports[1]).toMatchObject({
      ok: ['BBB'],
      failed: [{ item: 'AAA', error: 'bad answer' }],
    });
  });

  it('skips a source whose key is missing', async () => {
    const db = await setup();
    const a = source('a', () => []);
    const reports = await ingest(
      db,
      { ...emptyPlugins(), bars: [a] },
      {
        ...options('daily'),
        context: () => {
          throw new Error('A_KEY is not set in .env (a).');
        },
      },
    );
    expect(a.calls).toEqual([]);
    expect(reports[0]!.stopped).toMatch(/A_KEY/);
  });

  it('bootstraps from the inception date and stores metadata', async () => {
    const db = await setup();
    const a = source('a', () => []);
    a.fetchMeta = async (ticker) => ({ ticker, inceptionDate: '2001-05-01', exchange: 'X' });
    await ingest(db, { ...emptyPlugins(), bars: [a] }, options('bootstrap'));
    expect(a.calls[0]).toBe('AAA 2001-05-01 2026-01-16');
    const rows = await db.select().from(schema.symbols);
    expect(rows[0]).toMatchObject({ inceptionDate: '2001-05-01', exchange: 'X' });
  });

  it('fetches the base currency pair from FX sources that support it', async () => {
    const db = await setup();
    await setSetting(db, 'base_currency', 'XXX');
    const asked: string[] = [];
    const fx: FxSource = {
      info: info('fx', 'fx'),
      supports: (pair) => pair === 'USDXXX',
      async fetchRates(pair, _from, to) {
        asked.push(pair);
        return [{ pair, date: to, rate: 150 }];
      },
    };
    const reports = await ingest(db, { ...emptyPlugins(), fx: [fx] }, options('daily'));
    expect(asked).toEqual(['USDXXX']);
    expect(reports[0]).toMatchObject({ ok: ['USDXXX'], inserted: 1 });
  });

  it('fetches issuer records for the symbols a source supports, in the daily window', async () => {
    const db = await setup();
    const asked: string[] = [];
    const iss: IssuerSource = {
      info: info('iss', 'issuer'),
      supports: (ticker) => ticker === 'BBB',
      async fetchRecords(ticker, from, to) {
        asked.push(`${ticker} ${from} ${to}`);
        return [{ date: to, nav: 20, currency: 'USD', distribution: 0.1 }];
      },
    };
    const reports = await ingest(db, { ...emptyPlugins(), issuers: [iss] }, options('daily'));
    expect(asked).toEqual(['BBB 2026-01-02 2026-01-16']);
    expect(reports[0]).toMatchObject({ kind: 'issuer', ok: ['BBB'], inserted: 1 });
    const stored = await issuerRecordsOf(db, (await symbolId(db, 'BBB'))!);
    expect(stored.get('iss')).toEqual([
      { date: '2026-01-16', nav: 20, currency: 'USD', distribution: 0.1 },
    ]);
    expect(issuerAvailability(reports)).toEqual([
      { source: 'iss', supported: ['BBB'], unavailable: [] },
    ]);
    // A full fetch asks from the symbol's inception (or the earliest date) to the target.
    await ingest(db, { ...emptyPlugins(), issuers: [iss] }, options('bootstrap'));
    expect(asked[1]).toBe('BBB 1990-01-01 2026-01-16');
  });

  it('records an issuer failure per symbol and a refused response, and goes on', async () => {
    const db = await setup();
    const iss: IssuerSource = {
      info: info('iss', 'issuer'),
      supports: () => true,
      async fetchRecords(ticker, _from, to) {
        if (ticker === 'AAA') throw new Error('iss: HTTP 503');
        return [
          { date: to, nav: 1 },
          { date: to, nav: 2 },
        ];
      },
    };
    const [r] = await ingest(db, { ...emptyPlugins(), issuers: [iss] }, options('daily'));
    expect(r!.ok).toEqual([]);
    expect(r!.failed.map((f) => f.item)).toEqual(['AAA', 'BBB']);
    expect(r!.failed[1]!.error).toMatch(/same date twice/);
    expect(await db.select().from(schema.issuerRecords)).toEqual([]);
    const broken: IssuerSource = {
      ...iss,
      supports: () => {
        throw new Error('bad list');
      },
    };
    const [b] = await ingest(db, { ...emptyPlugins(), issuers: [broken] }, options('daily'));
    expect(b!.stopped).toBe('bad list');
    // Unknown support counts every fund, none delivered: each is graded, never left out.
    expect(issuerAvailability([r!, b!])).toEqual([
      { source: 'iss', supported: ['AAA', 'BBB'], unavailable: ['AAA', 'BBB'] },
      { source: 'iss', supported: ['AAA', 'BBB'], unavailable: ['AAA', 'BBB'] },
    ]);
  });
});

describe('windowStart', () => {
  it('respects the plan’s history', () => {
    const base = info('x');
    expect(
      windowStart({ ...base, history: { from: '2016-01-01' } }, '1993-01-29', '2026-01-16'),
    ).toBe('2016-01-01');
    expect(windowStart({ ...base, history: { years: 2 } }, '1993-01-29', '2026-01-16')).toBe(
      '2024-01-17',
    );
    expect(windowStart(base, '2026-01-02', '2026-01-16')).toBe('2026-01-02');
  });
});
