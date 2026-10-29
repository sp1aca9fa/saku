// The polite HTTP client every plug-in uses (requirements 15): it keeps under 80% of each of the
// provider's declared limits, retries server errors and timeouts with backoff, and stops the
// source for the run on 403, 429 or a challenge page. It never works around a block.
import type { ProviderLimits } from './types';

/** The provider refused us (403, 429, a challenge page): the source stops for this run. */
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedError';
  }
}

/** Going on would pass 80% of a provider limit before the run could wait it out. */
export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
    /** For a 4xx: a short, redacted excerpt of the provider's answer (why it refused). */
    readonly detail?: string,
  ) {
    super(`HTTP ${status} for ${url}${detail ? `: ${detail}` : ''}`);
    this.name = 'HttpError';
  }
}

/** Longest excerpt of an error answer kept in a message. */
const EXCERPT_CHARS = 200;

/** Share of each provider limit the client may use. */
export const LIMIT_SHARE = 0.8;

const WINDOWS = [
  { name: 'minute', ms: 60_000, limit: (l: ProviderLimits) => l.perMinute },
  { name: 'hour', ms: 3_600_000, limit: (l: ProviderLimits) => l.perHour },
  { name: 'day', ms: 86_400_000, limit: (l: ProviderLimits) => l.perDay },
] as const;

const CHALLENGE_MARKERS = [/captcha/i, /cf-challenge/i, /Just a moment\.\.\./];

/** Query parameters that carry keys; their values never appear in errors or logs. */
const SECRET_PARAMS = /([?&](?:token|apikey|api_key|key|access_key)=)[^&]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SECRET_PARAMS, '$1***');
}

export interface PoliteHttpOptions {
  limits?: ProviderLimits;
  /** Times (ms since epoch) of this provider's earlier requests, from the quota guard. */
  history?: number[];
  /** Pause between any two requests. */
  minDelayMs?: number;
  /** Longest the client waits for a limit window to free up before giving up for the run. */
  maxWaitMs?: number;
  retries?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Values (keys, tokens, webhook addresses) masked wherever a URL appears in an error. */
  secrets?: string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export class PoliteHttp {
  /** Request times in this run plus the history passed in, oldest first. */
  readonly sent: number[];
  private blocked: string | null = null;
  private readonly o: Required<Omit<PoliteHttpOptions, 'history'>>;
  private readonly secrets: string[];

  constructor(options: PoliteHttpOptions = {}) {
    this.sent = [...(options.history ?? [])].sort((a, b) => a - b);
    this.secrets = (options.secrets ?? []).filter((s) => s.length >= 4);
    this.o = {
      limits: {},
      minDelayMs: 500,
      maxWaitMs: 120_000,
      retries: 3,
      timeoutMs: 30_000,
      userAgent: 'Saku (self-hosted, personal use)',
      secrets: [],
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      clock: Date.now,
      ...options,
    };
  }

  async json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const body = await (await this.request(url, { Accept: 'application/json', ...headers })).text();
    try {
      return JSON.parse(body) as T;
    } catch {
      this.checkChallenge(body, url);
      throw new Error(`invalid JSON from ${this.shown(url)}`);
    }
  }

  async text(url: string, headers: Record<string, string> = {}): Promise<string> {
    const body = await (await this.request(url, headers)).text();
    this.checkChallenge(body, url);
    return body;
  }

  /** A file as bytes (spreadsheets, archives) with its content type; an HTML page is checked for a challenge. */
  async bytes(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ data: Uint8Array; contentType: string | null }> {
    const res = await this.request(url, headers);
    const data = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      this.checkChallenge(new TextDecoder().decode(data.subarray(0, 50_000)), url);
    }
    return { data, contentType };
  }

  private checkChallenge(body: string, url: string): void {
    if (body.length < 50_000 && CHALLENGE_MARKERS.some((m) => m.test(body))) {
      this.blocked = `challenge page at ${this.shown(url)}`;
      throw new BlockedError(this.blocked);
    }
  }

  /** Masks a value in every later error (for a secret that is part of a URL's path). */
  addSecret(value: string): void {
    if (value.length >= 4 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  private shown(url: string): string {
    let out = redactUrl(url);
    for (const s of this.secrets) out = out.replaceAll(s, '***');
    return out;
  }

  /** POSTs a body (e.g. a timestamp query) and returns the answer as bytes. */
  async post(
    url: string,
    body: Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<{ data: Uint8Array; contentType: string | null }> {
    const res = await this.request(url, headers, body);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type'),
    };
  }

  private async request(
    url: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const shown = this.shown(url);
    for (let attempt = 0; ; attempt++) {
      if (this.blocked) throw new BlockedError(`stopped for this run: ${this.blocked}`);
      await this.pace();
      this.sent.push(this.o.clock());
      let res: Response;
      try {
        res = await this.o.fetchImpl(url, {
          ...(body && { method: 'POST', body }),
          headers: { 'User-Agent': this.o.userAgent, ...headers },
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (e) {
        if (attempt < this.o.retries) {
          await this.o.sleep(2 ** attempt * 2000);
          continue;
        }
        const reason = e instanceof Error && e.name === 'TimeoutError' ? 'no answer' : 'failed';
        throw new Error(`request ${reason} after ${attempt + 1} tries: ${shown}`);
      }
      if (res.status === 403 || res.status === 429) {
        this.blocked = `HTTP ${res.status} for ${shown}`;
        throw new BlockedError(this.blocked);
      }
      if (res.status >= 500 && attempt < this.o.retries) {
        await this.o.sleep(2 ** attempt * 2000);
        continue;
      }
      if (!res.ok) {
        const detail = res.status < 500 ? await this.excerpt(res, url) : undefined;
        throw new HttpError(res.status, shown, detail);
      }
      return res;
    }
  }

  /**
   * A short excerpt of a refused request's answer, so the error says why (e.g. FRED's JSON
   * `error_message`). Keys are masked: the registered secrets, every key-like query value of the
   * request URL wherever it appears, and key-like query parameters in the text.
   */
  private async excerpt(res: Response, url: string): Promise<string | undefined> {
    let body: string;
    try {
      body = (await res.text()).slice(0, 20_000);
    } catch {
      return undefined;
    }
    let text = body;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const said = ['error_message', 'message', 'error', 'detail'].find(
        (k) => typeof parsed?.[k] === 'string',
      );
      if (said) text = parsed[said] as string;
    } catch {
      // Not JSON: plain text or a page; tags are dropped below.
    }
    text = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    for (const m of url.matchAll(SECRET_PARAMS)) {
      const raw = m[0].slice(m[1]!.length);
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // A malformed escape: mask the raw text only.
      }
      for (const value of [raw, decoded]) {
        if (value.length >= 4) text = text.replaceAll(value, '***');
      }
    }
    text = this.shown(text).slice(0, EXCERPT_CHARS);
    return text || undefined;
  }

  /** Waits for the minimum gap and for every limit window to have room under 80%. */
  private async pace(): Promise<void> {
    const last = this.sent.at(-1);
    if (last !== undefined) {
      const gap = this.o.minDelayMs - (this.o.clock() - last);
      if (gap > 0) await this.o.sleep(gap);
    }
    for (const w of WINDOWS) {
      const limit = w.limit(this.o.limits);
      if (!limit) continue;
      const allowed = Math.max(1, Math.floor(limit * LIMIT_SHARE));
      const now = this.o.clock();
      const inWindow = this.sent.filter((t) => t > now - w.ms);
      if (inWindow.length < allowed) continue;
      // Room opens when the oldest request that keeps the window full falls out of it.
      const wait = inWindow[inWindow.length - allowed]! + w.ms - now + 1;
      if (wait > this.o.maxWaitMs) {
        throw new QuotaError(`${allowed} of ${limit} requests per ${w.name} used (80% cap)`);
      }
      await this.o.sleep(wait);
    }
  }
}
