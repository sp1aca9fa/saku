// Plug-in contracts (requirements 15, system design section 6). A plug-in package exports one
// array per kind from `src/index.ts`, only the kinds it has.
import type { PluginKind, SourceRole, TradingDate } from '@saku/core';
import type { PoliteHttp } from './http';

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
  provides: { tickers?: string[]; series?: string[]; pairs?: string[]; markets?: string[] };
  suggestedRole: SourceRole;
  limits?: ProviderLimits;
  /** Environment variable holding the provider key, when one is needed. */
  keyEnv?: string;
  termsUrl: string;
  /** The provider's terms forbid giving its data to AI models (left out of MCP and AI exports). */
  noAi?: boolean;
  /** Not an official API. */
  unofficial?: boolean;
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
  /** The provider key from the server's `.env`, when the plug-in declares `keyEnv`. */
  apiKey?: string;
}

/** One daily bar as the source sent it. Raw fields only; adjusted values are for checks. */
export interface RawBar {
  date: TradingDate;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  /** The close is already split-adjusted by the source (it is un-split before comparing). */
  closeIsSplitAdjusted: boolean;
  volume?: number;
  /** Cash dividend going ex on this date, per share (0 when none). */
  divCash: number;
  /** Split ratio effective on this date (2 for a 2-for-1 split, 1 when none). */
  splitFactor: number;
  /** The provider's adjusted close, if it publishes one. */
  providerAdjClose?: number;
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

export interface SeriesPoint {
  date: TradingDate;
  value: number;
  /** When the source published this value, if it says (ISO 8601). */
  publishedAt?: string;
}

export interface SeriesSource {
  info: PluginInfo;
  fetchSeries(
    id: string,
    from: TradingDate,
    to: TradingDate,
    ctx: PluginContext,
  ): Promise<SeriesPoint[]>;
}

export interface FxRate {
  /** Base then quote currency, e.g. `USDXXX` = units of XXX per USD. */
  pair: string;
  date: TradingDate;
  rate: number;
  publishedAt?: string;
}

export interface FxSource {
  info: PluginInfo;
  fetchRates(
    pair: string,
    from: TradingDate,
    to: TradingDate,
    ctx: PluginContext,
  ): Promise<FxRate[]>;
}

/** A holiday table as versioned data (exchange, bond market, central bank). */
export interface Calendar {
  /** e.g. `xnys` (an exchange), `us-bond`, `ecb-target`. */
  id: string;
  /** Changes whenever the table changes; stored with check results. */
  version: string;
  /** Dates the table covers (inclusive); outside them the calendar is unknown. */
  validFrom: TradingDate;
  validTo: TradingDate;
  /** Weekdays with no session. Weekends are always closed. */
  holidays: TradingDate[];
  /** Weekdays with a shortened session. */
  earlyCloses?: TradingDate[];
}

export interface CalendarSource {
  info: PluginInfo;
  calendars: Calendar[];
}

/** What a plug-in package's `src/index.ts` exports. */
export interface PluginModule {
  bars?: BarSource[];
  series?: SeriesSource[];
  fx?: FxSource[];
  calendars?: CalendarSource[];
}
