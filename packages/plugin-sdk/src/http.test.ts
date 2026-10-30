import { USAGE_REQUEST_WINDOW_MS, USAGE_SYMBOL_WINDOW_MS } from '@saku/db';
import { describe, expect, it } from 'vitest';
import {
  BlockedError,
  HttpError,
  PoliteHttp,
  type PoliteHttpOptions,
  QuotaError,
  SYMBOL_WINDOW_MS,
  SymbolQuotaError,
  type UsageStore,
  WINDOWS,
  mergeFormerIds,
  redactUrl,
} from './http';

/** A client on a fake clock: sleeping moves time forward instantly. */
function fakeClient(responses: (() => Response)[], options: PoliteHttpOptions = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  let i = 0;
  const http = new PoliteHttp({
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetchImpl: (async (url: string) => {
      calls.push(url);
      const next = responses[Math.min(i++, responses.length - 1)]!;
      return next();
    }) as typeof fetch,
    ...options,
  });
  return { http, calls, now: () => now };
}

const ok = () => new Response('{"a":1}', { status: 200 });

describe('PoliteHttp', () => {
  it('parses JSON', async () => {
    const { http } = fakeClient([ok]);
    expect(await http.json('https://example.test/a')).toEqual({ a: 1 });
  });

  it('returns files as bytes with their content type', async () => {
    const file = () =>
      new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
        headers: { 'content-type': 'application/vnd.ms-excel' },
      });
    const { http } = fakeClient([file]);
    const got = await http.bytes('https://example.test/f.xlsx');
    expect([...got.data]).toEqual([0x50, 0x4b, 3, 4]);
    expect(got.contentType).toBe('application/vnd.ms-excel');
  });

  it('stops on a challenge page served instead of a file', async () => {
    const page = () =>
      new Response('<title>Just a moment...</title>', {
        headers: { 'content-type': 'text/html' },
      });
    const { http } = fakeClient([page]);
    await expect(http.bytes('https://example.test/f.xlsx')).rejects.toBeInstanceOf(BlockedError);
  });

  it('retries server errors with backoff, then gives up', async () => {
    const { http, calls } = fakeClient([() => new Response('', { status: 503 }), ok]);
    expect(await http.json('https://example.test/a')).toEqual({ a: 1 });
    expect(calls).toHaveLength(2);
    const failing = fakeClient([() => new Response('', { status: 500 })], { retries: 2 });
    await expect(failing.http.json('https://example.test/a')).rejects.toBeInstanceOf(HttpError);
    expect(failing.calls).toHaveLength(3);
  });

  it('stops the source for the run on 403 and 429, without retrying', async () => {
    for (const status of [403, 429]) {
      const { http, calls } = fakeClient([() => new Response('', { status }), ok]);
      await expect(http.json('https://example.test/a')).rejects.toBeInstanceOf(BlockedError);
      await expect(http.json('https://example.test/b')).rejects.toBeInstanceOf(BlockedError);
      expect(calls).toHaveLength(1);
    }
  });

  it('treats a challenge page as a block', async () => {
    const { http } = fakeClient([() => new Response('<title>Just a moment...</title>')]);
    await expect(http.json('https://example.test/a')).rejects.toBeInstanceOf(BlockedError);
  });

  it('does not retry a 404', async () => {
    const { http, calls } = fakeClient([() => new Response('', { status: 404 })]);
    await expect(http.json('https://example.test/a')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('never passes 80% of a per-minute limit in any minute', async () => {
    const { http, now } = fakeClient([ok], { limits: { perMinute: 10 }, minDelayMs: 0 });
    const times: number[] = [];
    for (let k = 0; k < 20; k++) {
      await http.json('https://example.test/a');
      times.push(now());
    }
    for (const t of times) {
      expect(times.filter((u) => u > t - 60_000 && u <= t).length).toBeLessThanOrEqual(8);
    }
  });

  it('counts earlier requests and gives up when the wait is too long', async () => {
    const requests = Array.from({ length: 40 }, (_, k) => 1_000_000 - 1000 * (k + 40));
    const store: UsageStore = {
      load: async () => ({ requests, symbols: new Map() }),
      record: async () => {},
    };
    const { http, calls } = fakeClient([ok], {
      limits: { perHour: 50 },
      usage: { provider: 'p', store },
      wallClock: () => 0,
    });
    await expect(http.json('https://example.test/a')).rejects.toBeInstanceOf(QuotaError);
    expect(calls).toHaveLength(0);
  });

  it('keeps keys out of error messages', async () => {
    const { http } = fakeClient([() => new Response('', { status: 404 })]);
    await expect(http.json('https://example.test/a?token=SECRET&x=1')).rejects.toThrow(
      'https://example.test/a?token=***&x=1',
    );
    expect(redactUrl('https://x.test/?apiKey=abc')).toBe('https://x.test/?apiKey=***');
  });
});

describe('why a request was refused', () => {
  const refused = async (http: PoliteHttp, url: string) =>
    http.json(url).then(
      () => '',
      (e: Error) => e.message,
    );

  it("adds the provider's own message from a JSON error answer", async () => {
    const { http } = fakeClient([
      () =>
        new Response('{"error_code":400,"error_message":"Bad Request.  Too many vintages."}', {
          status: 400,
        }),
    ]);
    expect(await refused(http, 'https://example.test/a?x=1')).toBe(
      'HTTP 400 for https://example.test/a?x=1: Bad Request. Too many vintages.',
    );
  });

  it('keeps a short, tag-free excerpt of other answers', async () => {
    const page = `<html><body><h1>Not found</h1><p>${'x'.repeat(500)}</p></body></html>`;
    const { http } = fakeClient([() => new Response(page, { status: 404 })]);
    const message = await refused(http, 'https://example.test/a');
    expect(message.startsWith('HTTP 404 for https://example.test/a: Not found x')).toBe(true);
    expect(message).not.toContain('<');
    expect(message.length).toBeLessThan(300);
    // An empty answer adds nothing.
    const empty = fakeClient([() => new Response('', { status: 404 })]);
    expect(await refused(empty.http, 'https://example.test/a')).toBe(
      'HTTP 404 for https://example.test/a',
    );
  });

  it('masks keys the answer repeats, from the URL and registered secrets', async () => {
    const body = JSON.stringify({
      error_message: 'key k3y/v4lue is not valid; token SECRET2; see ?api_key=k3y',
    });
    const { http } = fakeClient([() => new Response(body, { status: 400 })], {
      secrets: ['SECRET2'],
    });
    const message = await refused(http, 'https://example.test/a?api_key=k3y%2Fv4lue');
    expect(message).toBe(
      'HTTP 400 for https://example.test/a?api_key=***: key *** is not valid; token ***; see ?api_key=***',
    );
  });

  it('masks the whole answer before cutting, so no part of a key survives the cut', async () => {
    const key = 'LONGSECRET987';
    const { http } = fakeClient([() => new Response(`${'x'.repeat(195)}${key}`, { status: 400 })]);
    const message = await refused(http, `https://example.test/a?api_key=${key}`);
    expect(message.endsWith(`${'x'.repeat(195)}***`)).toBe(true);
    expect(message).not.toContain('LONG');
    // A key JSON escapes (`\/`) is masked in the decoded message too.
    const escaped = fakeClient([
      () => new Response('{"error_message":"bad key k3y\\/v4lue"}', { status: 400 }),
    ]);
    expect(await refused(escaped.http, 'https://example.test/a?api_key=k3y%2Fv4lue')).toBe(
      'HTTP 400 for https://example.test/a?api_key=***: bad key ***',
    );
  });

  it('says why a 403 stopped the source, masked, also on later requests', async () => {
    const body = JSON.stringify({ message: 'plan refuses this; key SECRET9 ?apikey=SECRET9' });
    const { http, calls } = fakeClient([() => new Response(body, { status: 403 }), ok], {
      secrets: ['SECRET9'],
    });
    const why = 'plan refuses this; key *** ?apikey=***';
    expect(await refused(http, 'https://example.test/a?apikey=SECRET9')).toBe(
      `HTTP 403 for https://example.test/a?apikey=***: ${why}`,
    );
    expect(await refused(http, 'https://example.test/b')).toBe(
      `stopped for this run: HTTP 403 for https://example.test/a?apikey=***: ${why}`,
    );
    expect(calls).toHaveLength(1);
    // A 429 still names only the request.
    const limited = fakeClient([() => new Response('slow down', { status: 429 })]);
    expect(await refused(limited.http, 'https://example.test/a')).toBe(
      'HTTP 429 for https://example.test/a',
    );
  });

  it('adds no excerpt to a server error', async () => {
    const { http } = fakeClient([() => new Response('stack trace', { status: 500 })], {
      retries: 0,
    });
    expect(await refused(http, 'https://example.test/a')).toBe(
      'HTTP 500 for https://example.test/a',
    );
  });
});

describe('secrets in errors', () => {
  it('masks registered values in URLs, including path parts', async () => {
    const http = new PoliteHttp({
      fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
      minDelayMs: 0,
      retries: 0,
      secrets: ['TOKEN123'],
    });
    http.addSecret('hook-secret');
    await expect(http.text('https://api.example.test/botTOKEN123/x')).rejects.toThrow(
      'HTTP 404 for https://api.example.test/bot***/x',
    );
    await expect(http.text('https://hooks.example.test/1/hook-secret')).rejects.toThrow(
      'HTTP 404 for https://hooks.example.test/1/***',
    );
  });
});

/** An exact in-memory store (the database one is tested in @saku/db and through ingest). */
function memoryStore() {
  const rows: { provider: string; at: number; symbol: string | null }[] = [];
  const store: UsageStore = {
    async load(provider, now) {
      const mine = rows.filter((r) => r.provider === provider);
      const symbols = new Map<string, number>();
      for (const r of mine) if (r.symbol !== null) symbols.set(r.symbol, r.at);
      return {
        requests: mine.filter((r) => r.at > now - 86_400_000).map((r) => r.at),
        symbols,
      };
    },
    async record(provider, at, symbol) {
      rows.push({ provider, at, symbol });
    },
  };
  return { store, rows };
}

describe('PoliteHttp quota guard', () => {
  const guarded = (store: UsageStore, at: { now: number }, options: PoliteHttpOptions = {}) => {
    const calls: string[] = [];
    const http = new PoliteHttp({
      clock: () => at.now,
      sleep: async (ms) => {
        at.now += ms;
      },
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return ok();
      }) as typeof fetch,
      maxWaitMs: 1000,
      usage: { provider: 'p', store },
      wallClock: () => 0,
      ...options,
    });
    return { http, calls };
  };

  it('a second run in the same hour sees the first run’s requests', async () => {
    const { store } = memoryStore();
    const at = { now: 1_000_000 };
    const first = guarded(store, at, { limits: { perHour: 50 } });
    for (let k = 0; k < 40; k++) await first.http.json('https://example.test/a');
    const second = guarded(store, at, { limits: { perHour: 50 } });
    await expect(second.http.json('https://example.test/a')).rejects.toBeInstanceOf(QuotaError);
    expect(second.calls).toHaveLength(0);
    // An hour after the first run's requests, there is room again.
    at.now += 3_600_000;
    const third = guarded(store, at, { limits: { perHour: 50 } });
    await third.http.json('https://example.test/a');
    expect(third.calls).toHaveLength(1);
  });

  it('records each request before it is sent, so a crash keeps it (retries count too)', async () => {
    const { store, rows } = memoryStore();
    const at = { now: 1_000_000 };
    let seen = 0;
    const http = new PoliteHttp({
      clock: () => at.now,
      sleep: async (ms) => {
        at.now += ms;
      },
      usage: { provider: 'p', store },
      wallClock: () => 0,
      fetchImpl: (async () => {
        // Recorded before the request left: what was stored already includes this one.
        seen = rows.length;
        throw new Error('the process dies here');
      }) as typeof fetch,
      retries: 2,
    });
    await expect(http.json('https://example.test/a')).rejects.toThrow(/after 3 tries/);
    expect(seen).toBe(3);
    expect(rows).toHaveLength(3);
  });

  it('sends nothing when earlier requests are unknown or a request cannot be recorded', async () => {
    const at = { now: 1_000_000 };
    const failing = (what: 'load' | 'record'): UsageStore => ({
      load: async () => {
        if (what === 'load') throw new Error('database locked');
        return { requests: [], symbols: new Map() };
      },
      record: async () => {
        throw new Error('database locked');
      },
    });
    for (const what of ['load', 'record'] as const) {
      const { http, calls } = guarded(failing(what), at);
      await expect(http.json('https://example.test/a')).rejects.toBeInstanceOf(QuotaError);
      expect(calls).toHaveLength(0);
    }
    const { http } = guarded(failing('load'), at, { limits: { symbolsPerMonth: 10 } });
    await expect(http.forSymbol('AAA')).rejects.toBeInstanceOf(QuotaError);
  });

  it('symbolsPerMonth: 400 of 500 used refuses a new symbol, allows a used one, frees after 31 days', async () => {
    const { store } = memoryStore();
    const at = { now: 1_000_000_000 };
    const limits = { symbolsPerMonth: 500 };
    const first = guarded(store, at, { limits, minDelayMs: 0 });
    for (let k = 0; k < 400; k++) {
      await first.http.forSymbol(`S${k}`);
      await first.http.json(`https://example.test/${k}`);
    }
    // The run itself stops at 80%.
    await expect(first.http.forSymbol('NEW')).rejects.toThrow(/400 of 500 symbols/);
    at.now += 60_000;
    const second = guarded(store, at, { limits });
    await expect(second.http.forSymbol('NEW')).rejects.toBeInstanceOf(SymbolQuotaError);
    await second.http.forSymbol('S7');
    await second.http.json('https://example.test/again');
    expect(second.calls).toHaveLength(1);
    // 31 days after the last request for S0..S399 (S7 was asked again a minute later).
    at.now += SYMBOL_WINDOW_MS;
    const later = guarded(store, at, { limits });
    await later.http.forSymbol('NEW');
    await later.http.json('https://example.test/new');
    expect(later.calls).toHaveLength(1);
  });

  it('a request after a refused symbol is recorded without it', async () => {
    const { store, rows } = memoryStore();
    const at = { now: 1_000_000 };
    const { http } = guarded(store, at, { limits: { symbolsPerMonth: 1 } });
    await http.forSymbol('AAA');
    await http.json('https://example.test/a');
    await expect(http.forSymbol('BBB')).rejects.toBeInstanceOf(SymbolQuotaError);
    await http.json('https://example.test/series');
    expect(rows.map((r) => r.symbol)).toEqual(['AAA', null]);
  });

  it('the store gets only the provider, the time and the symbol', async () => {
    const { store, rows } = memoryStore();
    const { http } = guarded(store, { now: 1_000_000 });
    await http.forSymbol('AAA');
    await http.json('https://example.test/a?token=SECRET', { Authorization: 'Token SECRET' });
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|example|http/);
  });

  it('attaches once, and never after requests were sent', async () => {
    const { store } = memoryStore();
    const { http } = fakeClient([ok]);
    await http.json('https://example.test/a');
    expect(() => http.guard({ provider: 'p', store })).toThrow(/after requests/);
    const fresh = new PoliteHttp();
    fresh.guard({ provider: 'p', store });
    expect(fresh.guarded).toBe(true);
    expect(() => fresh.guard({ provider: 'p', store })).toThrow(/already attached/);
  });

  it('clients sharing a count: one ledger, guard, clock, symbols and block', async () => {
    const { store, rows } = memoryStore();
    const at = { now: 1_000_000 };
    let blockSecond = false;
    const fetchImpl = (async (url: string) =>
      blockSecond && url.includes('/b') ? new Response('', { status: 429 }) : ok()) as typeof fetch;
    const limits = { perMinute: 5, symbolsPerMonth: 3 };
    const first = new PoliteHttp({ limits, fetchImpl, minDelayMs: 0, wallClock: () => 0 });
    // Guarded after it was joined, on the run's clock: the guard and the clock count for both.
    const second = new PoliteHttp({ limits, fetchImpl, minDelayMs: 0, wallClock: () => 0 });
    second.share(first);
    first.guard({ provider: 'p', store }, () => at.now);
    expect(second.guarded).toBe(true);
    expect(second.provider).toBe('p');
    await first.forSymbol('AAA');
    await first.json('https://example.test/a');
    await second.forSymbol('BBB');
    await second.json('https://example.test/b');
    expect(rows.map((r) => [r.provider, r.at, r.symbol])).toEqual([
      ['p', 1_000_000, 'AAA'],
      ['p', 1_000_000, 'BBB'],
    ]);
    // 80% of 3 symbols is 2, both counted (one by each client): a third is refused to either.
    await expect(first.forSymbol('CCC')).rejects.toBeInstanceOf(SymbolQuotaError);
    await expect(second.forSymbol('CCC')).rejects.toBeInstanceOf(SymbolQuotaError);
    await second.forSymbol('AAA');
    await first.forSymbol(null);
    // 80% of 5 per minute is 4: two more from either, then neither can send this minute.
    await first.json('https://example.test/a');
    await second.json('https://example.test/b');
    expect(first.sent).toHaveLength(4);
    const opts = { limits, fetchImpl, minDelayMs: 0, maxWaitMs: 1000 };
    const third = new PoliteHttp(opts);
    third.share(first);
    await expect(third.json('https://example.test/c')).rejects.toThrow(
      /4 of 5 requests per minute/,
    );
    // A 429 is the provider's: it stops every client sharing the count, sending nothing more.
    at.now += 60_001;
    blockSecond = true;
    await expect(second.json('https://example.test/b')).rejects.toBeInstanceOf(BlockedError);
    const recorded = rows.length;
    const refused = first.json('https://example.test/a');
    await expect(refused).rejects.toBeInstanceOf(BlockedError);
    await expect(refused).rejects.toThrow(/refused another source .*HTTP 429 for .*\/b/);
    await expect(second.json('https://example.test/b')).rejects.toThrow(/stopped for this run/);
    expect(rows).toHaveLength(recorded);
  });

  it('a challenge page stops every client sharing the count; a 403 only its own', async () => {
    const page = () => new Response('<title>Just a moment...</title>');
    const forbidden = () => new Response('plan does not include this', { status: 403 });
    const pair = (answer: () => Response) => {
      const calls: string[] = [];
      const fetchImpl = (async (url: string) => {
        calls.push(url);
        return url.includes('/b') ? answer() : ok();
      }) as typeof fetch;
      const first = new PoliteHttp({ fetchImpl, minDelayMs: 0 });
      const second = new PoliteHttp({ fetchImpl, minDelayMs: 0, shareQuotaWith: first });
      return { first, second, calls };
    };
    const challenged = pair(page);
    await expect(challenged.second.text('https://example.test/b')).rejects.toBeInstanceOf(
      BlockedError,
    );
    await expect(challenged.first.json('https://example.test/a')).rejects.toThrow(/challenge page/);
    expect(challenged.calls).toHaveLength(1);
    // A 403 can refuse one endpoint or plan: the sibling goes on.
    const refused = pair(forbidden);
    await expect(refused.second.json('https://example.test/b')).rejects.toThrow(/HTTP 403/);
    await expect(refused.first.json('https://example.test/a')).resolves.toEqual({ a: 1 });
    await expect(refused.second.json('https://example.test/b')).rejects.toThrow(/stopped/);
  });

  it('ownBlocks: a client that opted out keeps its refusals and ignores the others’', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('/b') ? new Response('', { status: 429 }) : ok()) as typeof fetch;
    const first = new PoliteHttp({ fetchImpl, minDelayMs: 0 });
    const second = new PoliteHttp({ fetchImpl, minDelayMs: 0 });
    second.share(first, { ownBlocks: true });
    const third = new PoliteHttp({
      fetchImpl,
      minDelayMs: 0,
      shareQuotaWith: first,
      ownBlocks: true,
    });
    await expect(second.json('https://example.test/b')).rejects.toBeInstanceOf(BlockedError);
    await expect(first.json('https://example.test/a')).resolves.toEqual({ a: 1 });
    await expect(third.json('https://example.test/a')).resolves.toEqual({ a: 1 });
    // The first client's 429 stops itself; the opted-out ones go on.
    await expect(first.json('https://example.test/b')).rejects.toBeInstanceOf(BlockedError);
    await expect(third.json('https://example.test/a')).resolves.toEqual({ a: 1 });
    await expect(second.json('https://example.test/a')).rejects.toThrow(/HTTP 429/);
  });

  it('counts the history stored under former keys; records under the provider id only', async () => {
    const { store, rows } = memoryStore();
    const at = { now: 10_000_000 };
    // Stored under the plug-in's key before it declared the provider.
    rows.push({ provider: 'acme-bars', at: at.now - 1000, symbol: 'OLD' });
    rows.push({ provider: 'acme-bars', at: at.now - 900, symbol: null });
    const limits = { perMinute: 3, symbolsPerMonth: 2 };
    const sleeps: number[] = [];
    const http = new PoliteHttp({
      limits,
      minDelayMs: 0,
      wallClock: () => 0,
      fetchImpl: ok as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        at.now += ms;
      },
    });
    http.guard({ provider: 'acme', store }, () => at.now);
    http.alsoCount(['acme-bars', 'acme']);
    // 80% of 2 symbols is 1: OLD counted under the old key, so a new one is refused.
    await expect(http.forSymbol('NEW')).rejects.toBeInstanceOf(SymbolQuotaError);
    await http.forSymbol('OLD');
    // 80% of 3 per minute is 2, both used under the old key: the first request waits until the
    // older one (1 s ago) leaves the minute.
    await http.json('https://example.test/a');
    expect(sleeps).toEqual([59_001]);
    expect(rows.slice(2).map((r) => [r.provider, r.symbol])).toEqual([['acme', 'OLD']]);
    expect(() => http.alsoCount(['late'])).toThrow(/after requests/);
    expect(() => new PoliteHttp().alsoCount(['x'])).toThrow(/quota guard/);
  });

  it('mergeFormerIds: one entry per id, all rows over a bound, the later bound of two', () => {
    expect(
      mergeFormerIds('acme', [
        'acme',
        { id: 'a', before: 5 },
        { id: 'a', before: 9 },
        { id: 'b', before: 3 },
        'b',
        { id: 'c' },
        { id: 'c', before: 1 },
      ]),
    ).toEqual([{ id: 'a', before: 9 }, { id: 'b' }, { id: 'c' }]);
  });

  it('a bounded former id is loaded only up to its bound', async () => {
    const calls: [string, number | undefined][] = [];
    const store: UsageStore = {
      load: async (id, _now, before) => {
        calls.push([id, before]);
        return { requests: [], symbols: new Map() };
      },
      record: async () => {},
    };
    const http = new PoliteHttp({
      minDelayMs: 0,
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
    });
    http.guard({ provider: 'acme-corp', store });
    http.alsoCount([{ id: 'acme', before: 42 }, 'acme-bars']);
    await http.json('https://example.test/a');
    expect(calls).toEqual([
      ['acme-corp', undefined],
      ['acme', 42],
      ['acme-bars', undefined],
    ]);
  });

  it('history unknown under a former key sends nothing', async () => {
    const { store } = memoryStore();
    const failing: UsageStore = {
      load: async (id, now) => {
        if (id === 'acme-bars') throw new Error('database locked');
        return store.load(id, now);
      },
      record: store.record,
    };
    const calls: string[] = [];
    const http = new PoliteHttp({
      usage: { provider: 'acme', store: failing, formerKeys: [{ id: 'acme-bars' }] },
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return ok();
      }) as typeof fetch,
    });
    await expect(http.json('https://example.test/a')).rejects.toThrow(
      /acme \(stored under acme-bars\) unknown: database locked/,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses to share after a request, across providers or limits', async () => {
    const { store } = memoryStore();
    const { http: used } = fakeClient([ok], { minDelayMs: 0 });
    await used.json('https://example.test/a');
    expect(() => used.share(new PoliteHttp())).toThrow(/before any request/);
    const p = new PoliteHttp({ usage: { provider: 'p', store }, limits: { perMinute: 5 } });
    const q = new PoliteHttp({ usage: { provider: 'q', store }, limits: { perMinute: 5 } });
    expect(() => q.share(p)).toThrow(/same provider/);
    // A guarded client never joins an unguarded count (its requests would not be stored).
    expect(() => p.share(new PoliteHttp({ limits: { perMinute: 5 } }))).toThrow(/same provider/);
    const other = new PoliteHttp({ limits: { perMinute: 6 } });
    expect(() => other.share(p)).toThrow(/same limits/);
    expect(() => new PoliteHttp({ shareQuotaWith: p })).toThrow(/same limits/);
    const joined = new PoliteHttp({ limits: { perMinute: 5 } });
    joined.share(p);
    expect(joined.provider).toBe('p');
  });

  it('records at the system time when the injected clock is frozen or behind', async () => {
    const { store, rows } = memoryStore();
    const wall = { now: 5_000_000 };
    const frozen = { now: 1_000_000 };
    const { http } = guarded(store, frozen, { wallClock: () => wall.now });
    await http.json('https://example.test/a');
    wall.now += 10_000;
    await http.json('https://example.test/b');
    // Stored never earlier than sent; the windows still read the injected clock (in memory).
    expect(rows.map((r) => r.at)).toEqual([5_000_000, 5_010_000]);
    expect(Math.max(...http.sent)).toBeLessThan(5_000_000);
    // A clock ahead of the system one is kept: the later of the two.
    const ahead = { now: 9_000_000 };
    const late = guarded(store, ahead, { wallClock: () => wall.now });
    await late.http.json('https://example.test/c');
    expect(rows.at(-1)!.at).toBe(9_000_000);
  });

  it('the database store keeps the windows the guard needs', () => {
    expect(USAGE_SYMBOL_WINDOW_MS).toBe(SYMBOL_WINDOW_MS);
    expect(USAGE_REQUEST_WINDOW_MS).toBeGreaterThanOrEqual(Math.max(...WINDOWS.map((w) => w.ms)));
  });
});
