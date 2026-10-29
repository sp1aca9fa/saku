import { describe, expect, it } from 'vitest';
import {
  BlockedError,
  HttpError,
  PoliteHttp,
  type PoliteHttpOptions,
  QuotaError,
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
    const history = Array.from({ length: 40 }, (_, k) => 1_000_000 - 1000 * (k + 1));
    const { http, calls } = fakeClient([ok], { limits: { perHour: 50 }, history });
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
