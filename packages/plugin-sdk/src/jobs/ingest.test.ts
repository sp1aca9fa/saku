import type { RawBar } from '@saku/core';
import { issuerRecordsOf, schema, setSetting, symbolId, upsertSymbols } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { Sessions } from '@saku/data';
import { describe, expect, it } from 'vitest';
import { BlockedError, PoliteHttp } from '../http';
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

  it("stores adjusted closes with the source's declared rounding", async () => {
    const db = await setup();
    const adj = (a: number) => ({ ...bar('2026-01-16', 10), providerAdjClose: a });
    const run = async (value: number, adjCloseRounding?: number) => {
      const a = source('a', (t) => (t === 'AAA' ? [adj(value)] : []));
      if (adjCloseRounding !== undefined) a.info.adjCloseRounding = adjCloseRounding;
      return (await ingest(db, { ...emptyPlugins(), bars: [a] }, options('daily')))[0]!;
    };
    await run(9);
    // 5e-7 relative: rounding for a source declaring 1e-6, a re-adjustment by default.
    expect((await run(9 * (1 + 5e-7), 1e-6)).readjustments).toBe(0);
    expect((await run(9 * (1 + 5e-7) * (1 + 5e-7))).readjustments).toBe(1);
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

describe('ingest: quota guard across runs', () => {
  /** A bar source that asks a fake provider once per ticker (the URL carries a key). */
  function httpSource(limits: PluginInfo['limits']) {
    const calls: string[] = [];
    const src: BarSource = {
      info: { ...info('q'), limits },
      async fetchBars(ticker, _from, to, ctx) {
        await ctx.http.json(`https://example.test/${ticker}?token=SECRETKEY`);
        return [bar(to, 1)];
      },
    };
    const context = () => ({
      http: new PoliteHttp({
        minDelayMs: 0,
        sleep: async () => {},
        limits,
        fetchImpl: (async (url: string) => {
          calls.push(url);
          return new Response('{}');
        }) as typeof fetch,
      }),
      now: new Date(),
      log,
    });
    return { src, calls, context };
  }
  const at = (iso: string) => () => new Date(iso);

  it('a second run in the same hour counts the first run’s requests (run clock)', async () => {
    const db = await setup();
    // perHour 2: 80% allows 1 request per hour; two tickers per run.
    const { src, calls, context } = httpSource({ perHour: 2 });
    const plugins = { ...emptyPlugins(), bars: [src] };
    const first = await ingest(db, plugins, {
      ...options('daily'),
      context,
      now: at('2026-01-17T01:00:00Z'),
    });
    expect(first[0]).toMatchObject({ ok: ['AAA'] });
    expect(first[0]!.stopped).toMatch(/1 of 2 requests per hour/);
    const second = await ingest(db, plugins, {
      ...options('daily'),
      context,
      now: at('2026-01-17T01:30:00Z'),
    });
    expect(second[0]).toMatchObject({ ok: [] });
    expect(second[0]!.stopped).toMatch(/per hour/);
    expect(calls).toHaveLength(1);
    // Past the hour (counted from the end of the first request's minute), room again.
    const third = await ingest(db, plugins, {
      ...options('daily'),
      context,
      now: at('2026-01-17T02:01:00Z'),
    });
    expect(third[0]).toMatchObject({ ok: ['AAA'] });
    expect(calls).toHaveLength(2);
  });

  it('a new symbol over 80% of symbolsPerMonth stops the source; a counted one is fetched', async () => {
    const db = await setup();
    // 80% of 2 is 1 symbol in 31 days.
    const { src, calls, context } = httpSource({ symbolsPerMonth: 2 });
    const plugins = { ...emptyPlugins(), bars: [src] };
    const r = await ingest(db, plugins, {
      ...options('daily'),
      context,
      now: at('2026-01-17T01:00:00Z'),
    });
    expect(r[0]).toMatchObject({ ok: ['AAA'] });
    expect(r[0]!.stopped).toMatch(/1 of 2 symbols per 31 days/);
    const next = await ingest(db, plugins, {
      ...options('daily'),
      context,
      now: at('2026-01-18T01:00:00Z'),
    });
    expect(next[0]).toMatchObject({ ok: ['AAA'] });
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/AAA', '/AAA']);
  });

  it('stores only provider buckets, counts and tickers (no URL or key)', async () => {
    const db = await setup();
    const { src, context } = httpSource({});
    await ingest(db, { ...emptyPlugins(), bars: [src] }, { ...options('daily'), context });
    const rows = await db.select().from(schema.providerUsage);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.provider === 'q')).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/SECRETKEY|example|http/);
    const day = rows.find((x) => x.windowType === 'day')!;
    expect(day).toMatchObject({ requestCount: 2, symbols: ['AAA', 'BBB'] });
  });

  it('a store that cannot be read stops the source before any request', async () => {
    const db = await setup();
    const { src, calls, context } = httpSource({});
    const r = await ingest(
      db,
      { ...emptyPlugins(), bars: [src] },
      {
        ...options('daily'),
        context,
        usage: {
          load: async () => {
            throw new Error('database locked');
          },
          record: async () => {},
        },
      },
    );
    expect(r[0]!.stopped).toMatch(/unknown: database locked/);
    expect(calls).toHaveLength(0);
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
