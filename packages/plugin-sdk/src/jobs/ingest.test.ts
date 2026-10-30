import type { RawBar } from '@saku/core';
import {
  issuerRecordsOf,
  recordProviderRequest,
  schema,
  setSetting,
  symbolId,
  upsertSymbols,
} from '@saku/db';
import { testDb } from '@saku/db/testing';
import { Sessions } from '@saku/data';
import { describe, expect, it } from 'vitest';
import { BlockedError, PoliteHttp, type UsageStore } from '../http';
import { emptyPlugins } from '../registry';
import type {
  BarSource,
  FxSource,
  IssuerSource,
  PluginInfo,
  SeriesPoint,
  SeriesSource,
} from '../types';
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

  it('reports a withdrawn series value as its own kind, once, and warns', async () => {
    const db = await setup();
    const at = (d: string) => `${d}T23:00:00.000Z`;
    let points: SeriesPoint[] = [{ date: '2026-01-14', value: 4, publishedAt: at('2026-01-14') }];
    const series: SeriesSource = {
      info: { ...info('rates', 'series'), provides: { series: ['CASH'] } },
      fetchSeries: async () => points,
    };
    const warned: { message: string; data?: Record<string, unknown> }[] = [];
    const o = {
      ...options('daily'),
      log: {
        info: () => {},
        warn: (message: string, data?: Record<string, unknown>) =>
          warned.push({ message, ...(data && { data }) }),
      },
    };
    const plugins = { ...emptyPlugins(), series: [series] };
    expect((await ingest(db, plugins, o))[0]).toMatchObject({ inserted: 1, revised: 0 });
    // A later vintage withdraws the value: counted with the revisions, listed as withdrawn (never
    // as a changed value), and warned.
    points = [...points, { date: '2026-01-14', withdrawn: true, publishedAt: at('2026-01-15') }];
    const [r] = await ingest(db, plugins, o);
    expect(r).toMatchObject({
      inserted: 0,
      revised: 1,
      revisedValues: {},
      withdrawnValues: { CASH: ['2026-01-14'] },
    });
    expect(warned.filter((w) => w.message.includes('withdrew'))).toEqual([
      {
        message: 'series rates CASH: the source withdrew stored values',
        data: { dates: ['2026-01-14'] },
      },
    ]);
    // The same answer again: stored once, nothing reported.
    expect((await ingest(db, plugins, o))[0]).toMatchObject({
      revised: 0,
      revisedValues: {},
      withdrawnValues: {},
    });
    expect(await db.select().from(schema.seriesWithdrawals)).toHaveLength(1);
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
        // Recorded on the run's clock (these runs are dated before the test's system time).
        wallClock: () => 0,
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

  it('a new symbol over 80% of symbolsPerMonth fails that item; a counted one after it is fetched', async () => {
    const db = await setup();
    // BBB was asked for in an earlier run; 80% of 2 is 1 symbol in 31 days, so AAA is refused.
    await recordProviderRequest(db, {
      provider: 'q',
      at: Date.parse('2026-01-10T12:00:00Z'),
      symbol: 'BBB',
    });
    const { src, calls, context } = httpSource({ symbolsPerMonth: 2 });
    const r = await ingest(
      db,
      { ...emptyPlugins(), bars: [src] },
      { ...options('daily'), context, now: at('2026-01-17T01:00:00Z') },
    );
    expect(r[0]).toMatchObject({ ok: ['BBB'], failed: [{ item: 'AAA' }] });
    expect(r[0]!.failed[0]!.error).toMatch(/1 of 2 symbols per 31 days used .*AAA is new/);
    expect(r[0]!.stopped).toBeUndefined();
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/BBB']);
  });

  describe('two plug-ins of one provider', () => {
    /**
     * A bar source (5 requests per ticker) and a series source (4 per series) on one fake clock;
     * `provider` set on both or neither. 80% of 10 per minute is 8.
     */
    function pair(
      provider: string | undefined,
      limits: PluginInfo['limits'] = { perMinute: 10 },
      answer: (url: string) => Response = () => new Response('{}'),
    ) {
      let clock = Date.parse('2026-01-17T01:00:00Z');
      const times: number[] = [];
      const ask = async (ctx: { http: PoliteHttp }, n: number, path: string) => {
        for (let k = 0; k < n; k++) await ctx.http.json(`https://example.test/${path}`);
      };
      const bars: BarSource = {
        info: { ...info('acme-bars'), limits, ...(provider && { provider }) },
        async fetchBars(_t, _f, to, ctx) {
          await ask(ctx, 5, 'bars');
          return [bar(to, 1)];
        },
      };
      const series: SeriesSource = {
        info: {
          ...info('acme-series', 'series'),
          provides: { series: ['S1', 'S2', 'S3'] },
          limits,
          ...(provider && { provider }),
        },
        async fetchSeries(_id, _f, to, ctx) {
          await ask(ctx, 4, 'series');
          return [{ date: to, value: 1 }];
        },
      };
      const context = () => ({
        http: new PoliteHttp({
          minDelayMs: 0,
          limits,
          sleep: async (ms) => {
            clock += ms;
          },
          wallClock: () => 0,
          fetchImpl: (async (url: string) => {
            times.push(clock);
            return answer(url);
          }) as typeof fetch,
        }),
        now: new Date(),
        log,
      });
      return {
        start: Date.parse('2026-01-17T01:00:00Z'),
        plugins: { ...emptyPlugins(), bars: [bars], series: [series] },
        context,
        times,
        now: () => new Date(clock),
      };
    }
    /** The most requests in any rolling minute. */
    const busiest = (times: number[]) =>
      Math.max(...times.map((t) => times.filter((u) => u > t - 60_000 && u <= t).length));
    /** A store whose history is empty, so only the run's own ledger can hold them back. */
    const blank = () => {
      const recorded: string[] = [];
      const usage: UsageStore = {
        load: async () => ({ requests: [], symbols: new Map() }),
        record: async (p) => {
          recorded.push(p);
        },
      };
      return { usage, recorded };
    };

    it('share one count in the run: together never above 80% of the per-minute limit', async () => {
      const db = await setup();
      const p = pair('acme');
      const { usage, recorded } = blank();
      const r = await ingest(db, p.plugins, {
        ...options('daily'),
        context: p.context,
        now: p.now,
        usage,
      });
      expect(r.map((x) => [x.source, x.ok.length, x.stopped])).toEqual([
        ['acme-bars', 2, undefined],
        ['acme-series', 3, undefined],
      ]);
      expect(p.times).toHaveLength(22);
      expect(busiest(p.times)).toBe(8);
      expect(new Set(recorded)).toEqual(new Set(['acme']));
    });

    it('without a provider, each key is its own provider (stored under the key)', async () => {
      const db = await setup();
      const p = pair(undefined);
      const { usage, recorded } = blank();
      await ingest(db, p.plugins, { ...options('daily'), context: p.context, now: p.now, usage });
      expect(new Set(recorded)).toEqual(new Set(['acme-bars', 'acme-series']));
      // Each paced alone: the series starts at once after the bars' last request.
      expect(busiest(p.times)).toBeGreaterThan(8);
    });

    it('across runs, the database counts them under the provider id', async () => {
      const db = await setup();
      const p = pair('acme');
      await ingest(db, p.plugins, { ...options('daily'), context: p.context, now: p.now });
      const rows = await db.select().from(schema.providerUsage);
      expect(new Set(rows.map((x) => x.provider))).toEqual(new Set(['acme']));
      const second = await ingest(db, p.plugins, {
        ...options('daily'),
        context: p.context,
        now: p.now,
      });
      expect(second.every((x) => x.stopped === undefined)).toBe(true);
      expect(busiest(p.times)).toBeLessThanOrEqual(8);
    });

    it('a 429 to one source stops every source of the provider; a 403 only its own', async () => {
      const db = await setup();
      const p = pair('acme', undefined, () => new Response('', { status: 429 }));
      const { usage, recorded } = blank();
      const r = await ingest(db, p.plugins, {
        ...options('daily'),
        context: p.context,
        now: p.now,
        usage,
      });
      expect(r[0]!.stopped).toMatch(/HTTP 429 for https:\/\/example.test\/bars/);
      expect(r[1]!.stopped).toMatch(/refused another source .*HTTP 429/);
      expect(p.times).toHaveLength(1);
      expect(recorded).toHaveLength(1);
      // A 403 can refuse one endpoint or plan: the other source goes on.
      const q = pair('acme', undefined, (url) =>
        url.endsWith('/bars') ? new Response('not in plan', { status: 403 }) : new Response('{}'),
      );
      const s = await ingest(db, q.plugins, {
        ...options('daily'),
        context: q.context,
        now: q.now,
        usage,
      });
      expect(s[0]!.stopped).toMatch(/HTTP 403/);
      expect(s[1]).toMatchObject({ ok: ['S1', 'S2', 'S3'] });
    });

    it('a provider newly declared: history stored under the old keys still paces and refuses', async () => {
      const db = await setup();
      const p = pair('acme', { perMinute: 10, symbolsPerMonth: 2 });
      // Stored before the plug-ins declared 'acme': 8 requests (80% of 10) in the last minute,
      // and BBB this month (80% of 2 symbols is 1), under the bar plug-in's own key.
      const before = p.start - 1000;
      await recordProviderRequest(db, { provider: 'acme-bars', at: before, symbol: 'BBB' });
      for (let k = 0; k < 7; k++) {
        await recordProviderRequest(db, { provider: 'acme-bars', at: before, symbol: null });
      }
      const r = await ingest(db, p.plugins, {
        ...options('daily'),
        context: p.context,
        now: p.now,
      });
      expect(r[0]).toMatchObject({ ok: ['BBB'], failed: [{ item: 'AAA' }] });
      expect(r[0]!.failed[0]!.error).toMatch(/1 of 2 symbols per 31 days used .*AAA is new/);
      // The stored minute (its bucket ends 1 ms before the run) is full: the first request waits.
      expect(p.times[0]).toBe(p.start + 60_000);
      expect(busiest([...Array(8).fill(p.start - 1), ...p.times])).toBe(8);
      // New rows only under the provider id; the old key's rows are left as stored.
      const rows = await db.select().from(schema.providerUsage);
      const minutes = (id: string) =>
        rows
          .filter((x) => x.provider === id && x.windowType === 'minute')
          .reduce((n, x) => n + x.requestCount, 0);
      expect(minutes('acme-bars')).toBe(8);
      expect(minutes('acme')).toBe(p.times.length);
      expect(new Set(rows.map((x) => x.provider))).toEqual(new Set(['acme', 'acme-bars']));
    });

    it('fault: unknown history stops every source of the provider, sending nothing', async () => {
      const db = await setup();
      const p = pair('acme');
      const asked: string[] = [];
      const usage: UsageStore = {
        load: async (id) => {
          asked.push(id);
          throw new Error('database locked');
        },
        record: async () => {},
      };
      const r = await ingest(db, p.plugins, {
        ...options('daily'),
        context: p.context,
        now: p.now,
        usage,
      });
      expect(r.map((x) => x.ok.length)).toEqual([0, 0]);
      for (const x of r)
        expect(x.stopped).toMatch(/earlier requests of acme unknown: database locked/);
      expect(p.times).toHaveLength(0);
      expect(asked).toEqual(['acme']);
    });

    it('fault: a record failure on the second source leaves the first’s counts intact', async () => {
      const db = await setup();
      const p = pair('acme');
      const rows: { provider: string; at: number }[] = [];
      let failing = true;
      const usage: UsageStore = {
        load: async (id) => ({
          requests: rows.filter((x) => x.provider === id).map((x) => x.at),
          symbols: new Map(),
        }),
        record: async (provider, at) => {
          // The bars' 10 requests are recorded; the series' first one cannot be.
          if (failing && rows.length === 10) throw new Error('disk full');
          rows.push({ provider, at });
        },
      };
      const first = await ingest(db, p.plugins, {
        ...options('daily'),
        context: p.context,
        now: p.now,
        usage,
      });
      expect(first[0]).toMatchObject({ ok: ['AAA', 'BBB'] });
      expect(first[0]!.stopped).toBeUndefined();
      expect(first[1]!.stopped).toMatch(/request of acme not recorded: disk full/);
      expect(p.times).toHaveLength(10);
      expect(rows).toHaveLength(10);
      // The next run counts the first source's requests: together still never above 8 a minute.
      failing = false;
      const second = await ingest(db, p.plugins, {
        ...options('daily'),
        context: p.context,
        now: p.now,
        usage,
      });
      expect(second.every((x) => x.stopped === undefined)).toBe(true);
      expect(p.times).toHaveLength(32);
      expect(busiest(p.times)).toBeLessThanOrEqual(8);
    });

    it('a client that cannot share the count is skipped, sending nothing', async () => {
      const db = await setup();
      const p = pair('acme');
      const { usage } = blank();
      const context = (i: PluginInfo) => {
        const ctx = p.context();
        // Counted under another id by its context: storing it as 'acme' would be wrong.
        if (i.kind === 'series') ctx.http.guard({ provider: 'elsewhere', store: usage });
        return ctx;
      };
      const r = await ingest(db, p.plugins, { ...options('daily'), context, now: p.now, usage });
      expect(r[1]!.stopped).toMatch(/counted under elsewhere/);
      expect(p.times).toHaveLength(10);
    });
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
