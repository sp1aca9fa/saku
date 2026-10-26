// Values stored in the database and shared by jobs, plug-ins and the app. Lists here are stable:
// the database enforces them with CHECK constraints, and SQLite can only widen those by
// rebuilding a table, so open-ended lists (asset classes, data kinds) stay unchecked text.

/** A trading date in America/New_York, `YYYY-MM-DD`. Never a `Date` in core logic. */
export type TradingDate = string;

export const HEALTH_STATUSES = ['green', 'yellow', 'red'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const SOURCE_ROLES = ['primary', 'secondary', 'check'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export const PLUGIN_KINDS = [
  'bar',
  'series',
  'fx',
  'tax_fx',
  'issuer',
  'event_calendar',
  'tax_regime',
  'calendar',
] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const CHECK_LAYERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type CheckLayer = (typeof CHECK_LAYERS)[number];

export const JOB_TYPES = ['daily', 'weekly', 'monthly', 'bootstrap'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['running', 'success', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Valuation rates, and the three broker-style tax rates (mid, and the rates a customer pays when
 * buying or gets when selling foreign currency). Each tax regime maps its own names onto these.
 */
export const FX_KINDS = ['valuation', 'tax_mid', 'tax_buy', 'tax_sell'] as const;
export type FxKind = (typeof FX_KINDS)[number];

/** Raw bar fields covered by the revision log (provider adjusted values are not). */
export const RAW_BAR_FIELDS = [
  'open',
  'high',
  'low',
  'close',
  'close_is_split_adjusted',
  'volume',
  'div_cash',
  'split_factor',
] as const;
export type RawBarField = (typeof RAW_BAR_FIELDS)[number];

export const QUOTA_WINDOWS = ['minute', 'hour', 'day', 'month'] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

// Data as sources deliver it (plug-in contracts, requirements 15).

/** One daily bar as the source sent it. Raw fields only; adjusted values are for checks. */
export interface RawBar {
  date: TradingDate;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  /**
   * The source's prices, volume and dividend amount are split-adjusted (on today's share basis);
   * core un-splits them before comparing.
   */
  closeIsSplitAdjusted: boolean;
  volume?: number;
  /** Cash dividend going ex on this date, per share (0 when none). */
  divCash: number;
  /** Split ratio effective on this date (2 for a 2-for-1 split, 1 when none). */
  splitFactor: number;
  /** The provider's adjusted close, if it publishes one. */
  providerAdjClose?: number;
}

export interface SeriesPoint {
  date: TradingDate;
  value: number;
  /** When the source published this value, if it says (ISO 8601). */
  publishedAt?: string;
}

export interface FxRate {
  /** Base then quote currency, e.g. `USDXXX` = units of XXX per USD. */
  pair: string;
  date: TradingDate;
  rate: number;
  publishedAt?: string;
}
