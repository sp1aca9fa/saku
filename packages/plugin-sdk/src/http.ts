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
// one ledger in a run, and the store counts under the provider id across runs. A 429 or a
// challenge page answered to any of them stops them all for the run: the provider blocked us, and
// a sibling sending on would work around the block (requirements 15). A 403 stops only the client
// it was answered to (it can refuse one endpoint or plan, not the provider).
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
  /**
   * The provider's requests in the last day and symbols in the last 31 days, as seen at `now`.
   * `before`: only rows stored before then (their buckets kept whole), for a former provider id
   * that another plug-in may still use.
   */
  load(provider: string, now: number, before?: number): Promise<UsageHistory>;
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

/**
 * Another id whose stored history counts for a provider: all of it, or with `before` (ms) only
 * the rows stored before then (a former provider id, which another plug-in may still use).
 */
export interface FormerId {
  id: string;
  before?: number;
}

/** The quota guard: the store and the provider id requests are counted under across runs. */
export interface UsageGuard {
  provider: string;
  store: UsageStore;
  /**
   * Other ids whose stored history counts for this provider too (`alsoCount`): the keys its
   * plug-ins were counted under before they declared it, and provider ids they declared before.
   * Loaded with the provider's history and merged; new requests are recorded under the provider
   * id only.
   */
  formerKeys?: readonly FormerId[];
}

/**
 * Former ids merged by id: an unbounded one wins (it counts more), else the latest `before`.
 * The provider's own id is left out (all its rows count anyway).
 */
export function mergeFormerIds(provider: string, ids: readonly (string | FormerId)[]): FormerId[] {
  const out = new Map<string, FormerId>();
  for (const raw of ids) {
    const f = typeof raw === 'string' ? { id: raw } : raw;
    if (f.id === provider) continue;
    const had = out.get(f.id);
    if (!had) out.set(f.id, { ...f });
    else if (had.before !== undefined) {
      out.set(
        f.id,
        f.before === undefined
          ? { id: f.id }
          : { id: f.id, before: Math.max(had.before, f.before) },
      );
    }
  }
  return [...out.values()];
}

export interface PoliteHttpOptions {
  limits?: ProviderLimits;
  /** The quota guard's store and the provider id its requests are counted under. */
  usage?: UsageGuard;
  /**
   * Another client of the same provider whose request and symbol counts this one shares (paced
   * together). See `share`; `ownBlocks` is its opt-out of shared blocks.
   */
  shareQuotaWith?: PoliteHttp;
  /**
   * With `shareQuotaWith`: a 429 or a challenge page stops only this client, and refusals
   * answered to the clients it shares a count with do not stop it (the channels of one notifier
   * service: the service refuses one channel, e.g. one webhook, not the account).
   */
  ownBlocks?: boolean;
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
  usage?: UsageGuard;
  /** The clock the windows are read on and this run's times are kept on. */
  clock: () => number;
  /**
   * The provider refused (429, a challenge page): every client sharing this ledger stops for the
   * run, except those that opted out (`ownBlocks`). `by`: the client it was answered to.
   */
  blocked?: { reason: string; by: PoliteHttp };
}

export class PoliteHttp {
  /** Why this client alone stopped: a 403, or any refusal when it keeps its own blocks. */
  private blocked: string | null = null;
  /** Whether refusals stay with this client instead of stopping its whole ledger (`ownBlocks`). */
  private ownBlocks: boolean;
  private readonly o: Required<
    Omit<PoliteHttpOptions, 'usage' | 'shareQuotaWith' | 'clock' | 'ownBlocks'>
  >;
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
    this.ownBlocks = options.ownBlocks ?? false;
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
   * the shared times are kept on). One block too: a 429 or a challenge page answered to any of
   * them stops all of them for the run (requirements 15: never work around a block). A 403 stays
   * with the client it was answered to (one endpoint or plan refused, not the provider).
   * `ownBlocks`: the opt-out for clients a service refuses one by one (a notifier's channels):
   * every refusal stays with this client, and the others' do not stop it. Refused: a client that
   * already sent or loaded its history, a different provider (or a guarded client joining an
   * unguarded one), different limits (one count cannot honor two).
   */
  share(peer: PoliteHttp, o: { ownBlocks?: boolean } = {}): void {
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
    if (o.ownBlocks) this.ownBlocks = true;
  }

  /** The quota guard of this client's ledger (shared by the clients of one provider). */
  private get usage(): UsageGuard | undefined {
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
  guard(usage: UsageGuard, clock?: () => number): void {
    if (this.usage) throw new Error(`quota guard already attached (${this.usage.provider})`);
    if (this.ledger.loaded || this.sent.length > 0) {
      throw new Error('quota guard attached after requests were sent');
    }
    this.ledger.usage = usage;
    if (clock) this.ledger.clock = clock;
  }

  /**
   * Counts the stored history under other ids for the guarded provider too: the keys its
   * plug-ins were counted under before they declared it, so declaring a provider never forgets
   * their earlier requests and symbols. Before the history is loaded; new requests are still
   * recorded under the provider id only. For the clients sharing the count, like the guard.
   */
  alsoCount(formerKeys: readonly (string | FormerId)[]): void {
    const usage = this.usage;
    if (!usage) throw new Error('former keys need a quota guard');
    if (this.ledger.loaded || this.sent.length > 0) {
      throw new Error('former keys added after requests were sent');
    }
    const keys = mergeFormerIds(usage.provider, [...(usage.formerKeys ?? []), ...formerKeys]);
    this.ledger.usage = { ...usage, formerKeys: keys };
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

  /**
   * Loads the stored history once, under the provider id and each former key (`alsoCount`),
   * merged: every stored request counts, and each symbol from its latest time under any id.
   * Unknown history (any of them fails) sends nothing (QuotaError).
   */
  private ready(): Promise<void> {
    const usage = this.usage;
    if (!usage) return Promise.resolve();
    this.ledger.loaded ??= (async () => {
      const histories: UsageHistory[] = [];
      for (const { id, before } of [{ id: usage.provider }, ...(usage.formerKeys ?? [])]) {
        try {
          // Read (and pruned) at the earlier of the two clocks, the mirror of recording at the
          // later: an injected clock ahead of the system one never prunes or skips rows that are
          // still inside a real window. The windows then filter on the run's clock.
          const at = Math.min(this.ledger.clock(), this.o.wallClock());
          histories.push(
            await (before === undefined
              ? usage.store.load(id, at)
              : usage.store.load(id, at, before)),
          );
        } catch (e) {
          const under = id === usage.provider ? '' : ` (stored under ${id})`;
          throw new QuotaError(
            `earlier requests of ${usage.provider}${under} unknown: ${message(e)}`,
          );
        }
      }
      for (const h of histories) {
        this.ledger.sent.push(...h.requests);
        for (const [s, at] of h.symbols) this.noteSymbol(s, at);
      }
      this.ledger.sent.sort((a, b) => a - b);
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
      throw this.stop(`challenge page at ${this.shown(url)}`, true);
    }
  }

  /**
   * Stops this client for the run; `providerWide` (a 429, a challenge page) stops every client
   * sharing its count too, unless this one keeps its own blocks (`ownBlocks`).
   */
  private stop(reason: string, providerWide: boolean): BlockedError {
    if (providerWide && !this.ownBlocks) this.ledger.blocked = { reason, by: this };
    else this.blocked = reason;
    return new BlockedError(reason);
  }

  /** Why this client may send nothing more in this run, or null. */
  private stoppedBecause(): string | null {
    if (this.blocked) return this.blocked;
    const shared = this.ledger.blocked;
    if (!shared || this.ownBlocks) return null;
    return shared.by === this
      ? shared.reason
      : `the provider refused another source sharing its count (${shared.reason})`;
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
      const stopped = this.stoppedBecause();
      if (stopped) throw new BlockedError(`stopped for this run: ${stopped}`);
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
        // A 429 is the provider's (stops all its clients); a 403 can refuse one endpoint or plan.
        const detail = res.status === 403 ? await this.excerpt(res, url) : undefined;
        throw this.stop(
          `HTTP ${res.status} for ${shown}${detail ? `: ${detail}` : ''}`,
          res.status === 429,
        );
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
