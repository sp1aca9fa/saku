// Plug-in contracts (requirements 15, system design section 6). A plug-in package exports one
// array per kind from `src/index.ts`, only the kinds it has.
import type {
  Calendar,
  FxRate,
  FxValue,
  FxWithdrawal,
  IssuerRecord,
  PluginKind,
  RawBar,
  SeriesPoint,
  SeriesValue,
  SeriesWithdrawal,
  SourceRole,
  TradingDate,
} from '@saku/core';
import type { IssuerPublishes } from '@saku/data';
import type { PoliteHttp } from './http';

export type {
  Calendar,
  FxRate,
  FxValue,
  FxWithdrawal,
  IssuerRecord,
  RawBar,
  SeriesPoint,
  SeriesValue,
  SeriesWithdrawal,
};

/** A provider's limits as its terms state them. The HTTP client stays under 80% of each. */
export interface ProviderLimits {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
  /** Distinct symbols per month (enforced by the quota guard across runs). */
  symbolsPerMonth?: number;
}

export interface PluginInfo {
  /** Stable identifier, stored with every row the plug-in provides. Never changed once data exists. */
  key: string;
  kind: PluginKind;
  /** The provider's name as shown in Settings. */
  name: string;
  /** What it provides: tickers or series ids, currencies, markets. */
  provides: {
    tickers?: string[];
    series?: string[];
    pairs?: string[];
    markets?: string[];
    /** A currency's cash rate series (percent a year), e.g. `{ USD: '<series id>' }`. */
    cashRates?: Record<string, string>;
  };
  suggestedRole: SourceRole;
  limits?: ProviderLimits;
  /** Environment variable(s) holding the provider's key, when one is needed. */
  keyEnv?: string | string[];
  termsUrl: string;
  /** The provider's terms forbid giving its data to AI models (left out of MCP and AI exports). */
  noAi?: boolean;
  /** How far back the provider's plan reaches (a fixed date, or a number of years from today). */
  history?: { from?: TradingDate; years?: number };
  /** Tickers, series or pairs treated as `noAi` when the rest of the plug-in's data is not. */
  noAiItems?: string[];
  /** Not an official API. */
  unofficial?: boolean;
  /**
   * The calendar (a loaded calendar plug-in's id) of the days the source publishes on: a missing
   * value on a day it is closed is an expected gap (green), not an unavailable cross-check.
   * Not declared, or not loaded: no day counts as closed.
   */
  calendar?: string;
  /**
   * Bar sources sending adjusted closes: their relative rounding, i.e. how far apart two fetches'
   * ratios (new / stored) of one real factor can be. A change within it is stored without a
   * re-adjustment event, and dates within it of an event's factor share that event. Default
   * 1e-9 (double precision); at most 1e-5 (below the smallest real re-adjustment). State the
   * provider's precision it rests on next to the value.
   */
  adjCloseRounding?: number;
  /**
   * Issuer sources: what their records hold (`IssuerPublishes` in `@saku/data`). Layer D compares
   * only the declared kinds; an undeclared one is not checked (no result, never green). Not
   * declared: inferred from the records (NAV when any has one; distributions and splits always).
   */
  publishes?: IssuerPublishes;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/** What core hands a plug-in for one run. Plug-ins never call `fetch` directly. */
export interface PluginContext {
  http: PoliteHttp;
  now: Date;
  log: Logger;
  /** The provider key from the server's `.env` (the first `keyEnv`). */
  apiKey?: string;
  /** Every declared `keyEnv` with its value. */
  keys?: Record<string, string>;
  /**
   * The run's final time (`HH:MM`, New York): a session's data counts as final from this time on
   * the session's date (`SAKU_DAILY_AFTER`, default 20:00), as for the daily target. Absent in
   * contexts that are not a run's (a plug-in then uses its own default).
   */
  finalAfter?: string;
}

export interface TickerMeta {
  ticker: string;
  name?: string;
  exchange?: string;
  inceptionDate?: TradingDate;
  active?: boolean;
}

export interface BarSource {
  info: PluginInfo;
  fetchBars(
    ticker: string,
    from: TradingDate,
    to: TradingDate,
    ctx: PluginContext,
  ): Promise<RawBar[]>;
  fetchMeta?(ticker: string, ctx: PluginContext): Promise<TickerMeta>;
}

export interface SeriesSource {
  info: PluginInfo;
  /**
   * Values per date and vintage. A source that revises a value to "no value" sends a withdrawal
   * (`{ date, withdrawn: true, publishedAt }`, `SeriesWithdrawal`), never a 0 and never nothing:
   * a date simply left out keeps its stored value as current.
   */
  fetchSeries(
    id: string,
    from: TradingDate,
    to: TradingDate,
    ctx: PluginContext,
  ): Promise<SeriesPoint[]>;
}

export interface FxSource {
  info: PluginInfo;
  /** Whether the source can provide this pair. */
  supports(pair: string): boolean;
  /** Rates per date and vintage; a withdrawn rate as `FxWithdrawal` (see `fetchSeries`). */
  fetchRates(
    pair: string,
    from: TradingDate,
    to: TradingDate,
    ctx: PluginContext,
  ): Promise<FxRate[]>;
}

/** A fund issuer's published data (layer D, best effort): checks only, never a value used. */
export interface IssuerSource {
  info: PluginInfo;
  /** Whether the source publishes records for this fund. */
  supports(ticker: string): boolean;
  fetchRecords(
    ticker: string,
    from: TradingDate,
    to: TradingDate,
    ctx: PluginContext,
  ): Promise<IssuerRecord[]>;
}

export interface CalendarSource {
  info: PluginInfo;
  calendars: Calendar[];
}

/** A notification channel (requirements 11). Sends plain text to one stored target. */
export interface NotifierInfo {
  /** Stored as the channel's type. Never changed once channels exist. */
  key: string;
  kind: 'notifier';
  name: string;
  limits?: ProviderLimits;
  /** Install-wide credential (e.g. a bot token), when the service needs one. */
  keyEnv?: string;
  termsUrl: string;
  /** Longest message the service accepts, in characters. */
  maxLength: number;
}

export interface Notifier {
  info: NotifierInfo;
  /** Whether a target (a webhook address, a chat id) has the right shape before it is stored. */
  validTarget(target: string): boolean;
  /** Errors must not contain the target or the key (they are logged). */
  send(target: string, text: string, ctx: PluginContext): Promise<void>;
}

/** What a plug-in package's `src/index.ts` exports. */
export interface PluginModule {
  bars?: BarSource[];
  series?: SeriesSource[];
  fx?: FxSource[];
  issuers?: IssuerSource[];
  calendars?: CalendarSource[];
  notifiers?: Notifier[];
}
