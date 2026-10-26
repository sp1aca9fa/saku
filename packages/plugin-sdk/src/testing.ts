// For plug-in tests: a context whose HTTP client answers from saved files, never the network.
import { PoliteHttp } from './http';
import type { PluginContext } from './types';

export interface FixtureContext extends PluginContext {
  /** URLs requested, in order. */
  requested: string[];
  /** Headers of each request, in order. */
  headers: Record<string, string>[];
}

/**
 * `answer` maps a requested URL to the body (an object is sent as JSON) or a full Response.
 * Returning undefined answers 404.
 */
export function fixtureContext(
  answer: (url: URL) => unknown,
  options: { apiKey?: string; keys?: Record<string, string>; now?: Date } = {},
): FixtureContext {
  const requested: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    requested.push(input);
    headers.push({ ...(init?.headers as Record<string, string>) });
    const body = answer(new URL(input));
    if (body instanceof Response) return body;
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body));
  }) as typeof fetch;
  return {
    http: new PoliteHttp({ fetchImpl, minDelayMs: 0, sleep: async () => {} }),
    now: options.now ?? new Date('2026-01-05T12:00:00Z'),
    log: { info: () => {}, warn: () => {} },
    requested,
    headers,
    ...(options.apiKey && { apiKey: options.apiKey }),
    ...(options.keys && { keys: options.keys }),
  };
}
