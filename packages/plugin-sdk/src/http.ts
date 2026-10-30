// The polite HTTP client every plug-in uses (requirements 15): it keeps under 80% of each of the
// provider's declared limits, retries server errors and timeouts with backoff, and stops the
// source for the run on 403, 429 or a challenge page. It never works around a block.
//
// Quota guard (requirements 04 "Quota guard"): with a usage store attached, the limits hold across
// runs, not only inside one. The provider's earlier requests (last day) and symbols (last 31 days)
// are loaded before the first request, each request is recorded as it is sent (a run that crashes
// keeps what it sent), and a new symbol that would pass 80% of `symbolsPerMonth` is refused
// (`SymbolQuotaError`: that symbol fails, symbols already counted are still fetched). History
// that is unknown (the store fails) sends nothing: the source stops for the run.
//
// One provider, one count: the clients of all plug-ins with the same provider id (`share`) keep
// one ledger in a run, and the store counts under the provider id across runs.
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

/**
 * A new symbol would pass 80% of the provider's symbols per 31 days. Only that symbol is refused:
 * symbols already counted can still be fetched, so the caller fails the item, not the source.
 */
export class SymbolQuotaError extends QuotaError {
  constructor(message: string) {
    super(message);
    this.name = 'SymbolQuotaError';
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Longest excerpt of an error answer kept in a message. */
const EXCERPT_CHARS = 200;

/** Share of each provider limit the client may use. */
export const LIMIT_SHARE = 0.8;

/** The request windows, rolling. The longest (a day) is what a usage store must return. */
export const WINDOWS = [
  { name: 'minute', ms: 60_000, limit: (l: ProviderLimits) => l.perMinute },
  { name: 'hour', ms: 3_600_000, limit: (l: ProviderLimits) => l.perHour },
  { name: 'day', ms: 86_400_000, limit: (l: ProviderLimits) => l.perDay },
] as const;

/**
 * The symbols-per-month window: a rolling 31 days. Providers do not say whether "a month" is a
 * calendar month; 31 rolling days is never shorter than one, so it is the conservative reading.
 */
export const SYMBOL_WINDOW_MS = 31 * 86_400_000;

/** A provider's earlier requests, each at a time (ms) no earlier than it was actually sent. */
export interface UsageHistory {
  /** Requests within the last day, oldest first. */
  requests: number[];
  /** Symbols requested within the last 31 days, each with the latest time it counts from. */
  symbols: Map<string, number>;
}

/** Where the quota guard keeps each provider's requests across runs (the database in jobs). */
export interface UsageStore {
  /** The provider's requests in the last day and symbols in the last 31 days, as seen at `now`. */
  load(provider: string, now: number): Promise<UsageHistory>;
  /** Records one request as it is sent; given no URL, key or body. */
  record(provider: string, at: number, symbol: string | null): Promise<void>;
}

/** Whether two declarations state the same limits (an absent limit equals only an absent one). */
export function sameLimits(a: ProviderLimits | undefined, b: ProviderLimits | undefined): boolean {
  const fields = ['perMinute', 'perHour', 'perDay', 'symbolsPerMonth'] as const;
  return fields.every((f) => a?.[f] === b?.[f]);
}

const CHALLENGE_MARKERS = [/captcha/i, /cf-challenge/i, /Just a moment\.\.\./];

/** Query parameters that carry keys; their values never appear in errors or logs. */
const SECRET_PARAMS = /([?&](?:token|apikey|api_key|key|access_key)=)[^&]*/gi;

/** The same parameters inside free text (an answer body): the value ends at a quote, space or tag. */
const SECRET_PARAMS_IN_TEXT = /([?&](?:token|apikey|api_key|key|access_key)=)[^&\s"'<>]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SECRET_PARAMS, '$1***');
}

export interface PoliteHttpOptions {
  limits?: ProviderLimits;
  /** The quota guard's store and the provider id its requests are counted under. */
  usage?: { provider: string; store: UsageStore };
  /**
   * Another client of the same provider whose request and symbol counts this one shares (paced
   * together), e.g. the channels of one notifier service; refusals (403, 429) stay per client.
   * See `share`.
   */
  shareQuotaWith?: PoliteHttp;
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
  /**
   * The clock the windows are read on (a run's injected clock, see `guard`); a client that joins
   * another's count reads on the other's.
   */
  clock?: () => number;
  /**
   * The system clock. A request is recorded at the later of the two clocks, so an injected clock
   * that is frozen or behind never records a request earlier than it was sent; stored usage is
   * read and pruned at the earlier, so one ahead never drops rows still inside a real window.
   * Tests replace it.
   */
  wallClock?: () => number;
}

/** What the windows count, shared by clients of one provider (`share`, `shareQuotaWith`). */
interface Ledger {
  /** Request times in this run plus the stored history, oldest first. */
  sent: number[];
  /** Symbols this provider received (stored and this run), with the latest time each counts from. */
  symbols: Map<string, number>;
  /** The stored history, loaded once before the first request or symbol check. */
  loaded?: Promise<void>;
  /** The quota guard's store and the provider id the requests are counted under. */
  usage?: { provider: string; store: UsageStore };
  /** The clock the windows are read on and this run's times are kept on. */
  clock: () => number;
}

export class PoliteHttp {
  private blocked: string | null = null;
  private readonly o: Required<Omit<PoliteHttpOptions, 'usage' | 'shareQuotaWith' | 'clock'>>;
  private readonly secrets: string[];
  private ledger: Ledger;
  /** The symbol the next requests are for (`forSymbol`), recorded with each. */
  private symbol: string | null = null;

  constructor(options: PoliteHttpOptions = {}) {
    this.ledger = {
      sent: [],
      symbols: new Map(),
      clock: options.clock ?? Date.now,
      ...(options.usage && { usage: options.usage }),
    };
    this.secrets = (options.secrets ?? []).filter((s) => s.length >= 4);
    this.o = {
      minDelayMs: 500,
      maxWaitMs: 120_000,
      retries: 3,
      timeoutMs: 30_000,
      userAgent: 'Saku (self-hosted, personal use)',
      secrets: [],
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      wallClock: Date.now,
      ...options,
      // A plug-in without limits hands over `limits: undefined`: no declared limit, not a crash.
      limits: options.limits ?? {},
    };
    if (options.shareQuotaWith) this.share(options.shareQuotaWith);
  }

  /**
   * Joins the request and symbol counts of another client of the same provider before this one
   * sends anything, so their requests together stay under 80% of each limit (requirements 04
   * "Quota guard"): one ledger, one pace (the minimum gap counts from either's last request),
   * one quota guard (attached to either, it counts for all) and one clock (the peer's, the one
   * the shared times are kept on). Refusals (403, 429, a challenge) stay per client. Refused: a
   * client that already sent or loaded its history, a different provider (or a guarded client
   * joining an unguarded one), different limits (one count cannot honor two).
   */
  share(peer: PoliteHttp): void {
    if (peer === this) return;
    if (this.ledger.loaded || this.sent.length > 0) {
      throw new Error('a shared quota is joined before any request');
    }
    if (this.usage && peer.usage?.provider !== this.usage.provider) {
      throw new Error(
        `a shared quota needs the same provider (${this.usage.provider}, not ${peer.usage?.provider ?? 'unguarded'})`,
      );
    }
    if (!sameLimits(this.o.limits, peer.o.limits)) {
      throw new Error(
        `a shared quota needs the same limits (${peer.usage?.provider ?? 'unguarded'})`,
      );
    }
    this.ledger = peer.ledger;
  }

  /** The quota guard of this client's ledger (shared by the clients of one provider). */
  private get usage(): { provider: string; store: UsageStore } | undefined {
    return this.ledger.usage;
  }

  /** Request times in this run plus the stored history, oldest first. */
  get sent(): readonly number[] {
    return this.ledger.sent;
  }

  private get symbols(): Map<string, number> {
    return this.ledger.symbols;
  }

  /** The provider id requests are counted under across runs; undefined when not guarded. */
  get provider(): string | undefined {
    return this.usage?.provider;
  }

  /** Whether requests are counted across runs (a usage store is attached). */
  get guarded(): boolean {
    return this.usage !== undefined;
  }

  /**
   * Attaches the quota guard's store before the first request (a run's jobs do this for every
   * source's client). `clock`: the run's clock, so an injected one sets the windows. Attached to
   * one of the clients sharing a count (`share`), it guards them all.
   */
  guard(usage: { provider: string; store: UsageStore }, clock?: () => number): void {
    if (this.usage) throw new Error(`quota guard already attached (${this.usage.provider})`);
    if (this.ledger.loaded || this.sent.length > 0) {
      throw new Error('quota guard attached after requests were sent');
    }
    this.ledger.usage = usage;
    if (clock) this.ledger.clock = clock;
  }

  /**
   * The symbol the following requests are for (a bar, meta or corporate-action fetch), recorded
   * with each; null for requests about no symbol. With a `symbolsPerMonth` limit, a symbol not
   * yet counted in the last 31 days is refused (SymbolQuotaError) when it would pass 80% of the
   * limit; a symbol already counted is always allowed.
   */
  async forSymbol(symbol: string | null): Promise<void> {
    this.symbol = null;
    if (symbol === null) return;
    await this.ready();
    const limit = this.o.limits.symbolsPerMonth;
    if (limit !== undefined) {
      const allowed = Math.max(1, Math.floor(limit * LIMIT_SHARE));
      const since = this.ledger.clock() - SYMBOL_WINDOW_MS;
      const counted = [...this.symbols].filter(([, at]) => at > since).map(([s]) => s);
      if (!counted.includes(symbol) && counted.length >= allowed) {
        throw new SymbolQuotaError(
          `${counted.length} of ${limit} symbols per 31 days used (80% cap); ${symbol} is new`,
        );
      }
    }
    this.symbol = symbol;
  }

  /** Loads the stored history once; unknown history sends nothing (QuotaError). */
  private ready(): Promise<void> {
    const usage = this.usage;
    if (!usage) return Promise.resolve();
    this.ledger.loaded ??= (async () => {
      let h: UsageHistory;
      try {
        // Read (and pruned) at the earlier of the two clocks, the mirror of recording at the
        // later: an injected clock ahead of the system one never prunes or skips rows that are
        // still inside a real window. The windows then filter on the run's clock.
        h = await usage.store.load(
          usage.provider,
          Math.min(this.ledger.clock(), this.o.wallClock()),
        );
      } catch (e) {
        throw new QuotaError(`earlier requests of ${usage.provider} unknown: ${message(e)}`);
      }
      this.ledger.sent.push(...h.requests);
      this.ledger.sent.sort((a, b) => a - b);
      for (const [s, at] of h.symbols) this.noteSymbol(s, at);
    })();
    return this.ledger.loaded;
  }

  private noteSymbol(symbol: string, at: number): void {
    if ((this.symbols.get(symbol) ?? -Infinity) < at) this.symbols.set(symbol, at);
  }

  /**
   * Records a request about to be sent; one that cannot be recorded is not sent. Stored at the
   * later of the run's clock and the system clock (never earlier than sent); kept in memory at
   * the run's clock, which the windows are read on.
   */
  private async note(at: number): Promise<void> {
    if (this.usage) {
      try {
        const stored = Math.max(at, this.o.wallClock());
        await this.usage.store.record(this.usage.provider, stored, this.symbol);
      } catch (e) {
        throw new QuotaError(`request of ${this.usage.provider} not recorded: ${message(e)}`);
      }
    }
    // Kept in order: stored times may lie after this one (the end of their bucket).
    const sent = this.ledger.sent;
    let i = sent.length;
    while (i > 0 && sent[i - 1]! > at) i--;
    sent.splice(i, 0, at);
    if (this.symbol !== null) this.noteSymbol(this.symbol, at);
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
    await this.ready();
    for (let attempt = 0; ; attempt++) {
      if (this.blocked) throw new BlockedError(`stopped for this run: ${this.blocked}`);
      await this.pace();
      await this.note(this.ledger.clock());
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
        // A 403 says why it refused (e.g. a plan limit), masked and cut like any 4xx excerpt.
        const detail = res.status === 403 ? await this.excerpt(res, url) : undefined;
        this.blocked = `HTTP ${res.status} for ${shown}${detail ? `: ${detail}` : ''}`;
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
   * `error_message`). The whole answer is masked first (the registered secrets, every key-like
   * query value of the request URL wherever it appears, key-like query parameters in the text);
   * only then is a message picked, tags stripped and the text cut.
   */
  private async excerpt(res: Response, url: string): Promise<string | undefined> {
    let body: string;
    try {
      body = await res.text();
    } catch {
      return undefined;
    }
    body = this.masked(body, url);
    let text = body;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const said = ['error_message', 'message', 'error', 'detail'].find(
        (k) => typeof parsed?.[k] === 'string',
      );
      // Masked again: JSON escapes (e.g. `\/`) can hide a key from the first pass.
      if (said) text = this.masked(parsed[said] as string, url);
    } catch {
      // Not JSON: plain text or a page; tags are dropped below.
    }
    text = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, EXCERPT_CHARS);
    return text || undefined;
  }

  /** Text with every secret masked: registered ones, and key-like query values of `url`. */
  private masked(text: string, url: string): string {
    let out = text;
    for (const m of url.matchAll(SECRET_PARAMS)) {
      const raw = m[0].slice(m[1]!.length);
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // A malformed escape: mask the raw text only.
      }
      for (const value of [raw, decoded]) {
        if (value.length >= 4) out = out.replaceAll(value, '***');
      }
    }
    for (const secret of this.secrets) out = out.replaceAll(secret, '***');
    return out.replace(SECRET_PARAMS_IN_TEXT, '$1***');
  }

  /** Waits for the minimum gap and for every limit window to have room under 80%. */
  private async pace(): Promise<void> {
    // The gap counts from the latest request not after now (a stored time may be its bucket's end).
    const start = this.ledger.clock();
    const last = this.sent.findLast((t) => t <= start);
    if (last !== undefined) {
      const gap = this.o.minDelayMs - (start - last);
      if (gap > 0) await this.o.sleep(gap);
    }
    for (const w of WINDOWS) {
      const limit = w.limit(this.o.limits);
      if (!limit) continue;
      const allowed = Math.max(1, Math.floor(limit * LIMIT_SHARE));
      const now = this.ledger.clock();
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
