import { describe, expect, it } from 'vitest';
import { BlockedError, HttpError, RequestFailedError } from '../http';
import type { Logger } from '../types';
import { heartbeatFailure, sendHeartbeat } from './heartbeat';

const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const URL_ = `https://ping.example.test/${ID}`;

function capture() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`),
    warn: (m, d) => lines.push(`${m} ${JSON.stringify(d ?? {})}`),
  };
  return { lines, log };
}

const noSleep = async () => {};

const throwing = (e: unknown) =>
  (async () => {
    throw e;
  }) as unknown as typeof fetch;

describe('heartbeat', () => {
  it('returns true and logs nothing when the ping is answered', async () => {
    const { lines, log } = capture();
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response('OK', { status: 200 });
    }) as typeof fetch;
    expect(await sendHeartbeat(URL_, 'HEALTHCHECK_URL', log, { fetchImpl, sleep: noSleep })).toBe(
      true,
    );
    expect(calls).toEqual([URL_]);
    expect(lines).toEqual([]);
  });

  it('logs the reason and cause code of a connect timeout, never the URL', async () => {
    const { lines, log } = capture();
    // What Node's fetch throws when every address's connect attempt was cut.
    const cause = Object.assign(new AggregateError([new Error('connect ETIMEDOUT')]), {
      code: 'ETIMEDOUT',
    });
    const fetchImpl = throwing(new TypeError(`fetch failed for ${URL_}`, { cause }));
    expect(await sendHeartbeat(URL_, 'HEALTHCHECK_URL', log, { fetchImpl, sleep: noSleep })).toBe(
      false,
    );
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain('Heartbeat ping failed');
    expect(line).toContain('HEALTHCHECK_URL');
    expect(line).toContain('request failed after 3 tries');
    expect(line).toContain('ETIMEDOUT');
    expect(line).not.toContain(ID);
    expect(line).not.toContain('ping.example.test');
  });

  it('logs only the status of an HTTP answer', async () => {
    const { lines, log } = capture();
    const fetchImpl = (async () =>
      new Response(`not found: ${URL_}`, { status: 404 })) as typeof fetch;
    expect(
      await sendHeartbeat(URL_, 'HEALTHCHECK_WEEKLY_URL', log, { fetchImpl, sleep: noSleep }),
    ).toBe(false);
    expect(lines[0]).toContain('"error":"HTTP 404"');
    expect(lines[0]).toContain('HEALTHCHECK_WEEKLY_URL');
    expect(lines[0]).not.toContain(ID);
  });

  it('masks the URL and each path part in any other error', () => {
    const slugUrl = `https://ping.example.test/${ID}/daily-job?create=1`;
    const shown = [
      heartbeatFailure(new BlockedError(`stopped for this run: HTTP 429 for ${slugUrl}`), slugUrl),
      heartbeatFailure(new Error(`odd: /${ID}/daily-job and ${ID} alone`), slugUrl),
      heartbeatFailure(
        new RequestFailedError(`request no answer after 1 tries: ${slugUrl}`),
        slugUrl,
      ),
    ];
    for (const s of shown) {
      expect(s.error).not.toContain(ID);
      expect(s.error).not.toContain('daily-job');
      expect(s.error).not.toContain('ping.example.test');
      expect(s.cause).toBeUndefined();
    }
    expect(shown[2]!.error).toBe('request no answer after 1 tries: ***');
  });

  it('keeps the code of a failed request and says "error" for a non-error', () => {
    expect(heartbeatFailure(new RequestFailedError('x', 'ECONNREFUSED'), URL_)).toEqual({
      error: 'x',
      cause: 'ECONNREFUSED',
    });
    expect(heartbeatFailure(`thrown text ${URL_}`, URL_)).toEqual({ error: 'error' });
    expect(heartbeatFailure(new HttpError(500, '***'), URL_)).toEqual({ error: 'HTTP 500' });
  });

  it('masks a value that is not a valid URL as given', () => {
    expect(heartbeatFailure(new Error('bad: not a url 1234'), 'not a url 1234').error).toBe(
      'bad: ***',
    );
  });
});
