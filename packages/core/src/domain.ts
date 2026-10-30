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

export const JOB_TYPES = ['daily', 'weekly', 'monthly', 'bootstrap', 'checks'] as const;
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

/** A series value for one date as the source published it. */
export interface SeriesValue {
  date: TradingDate;
  value: number;
  /** When the source published this value, if it says (ISO 8601). */
  publishedAt?: string;
  withdrawn?: undefined;
}

/**
 * The source withdrew its value for `date`: from `publishedAt` (or, with none given, the fetch)
 * on it has no value for that date any more (FRED/ALFRED: a later vintage of the date reading
 * '.'). Point-in-time reads from then on treat the date as having no value (never the old one,
 * never 0); reads before it still see the old value. A later value for the date restores it.
 * Sent only for a date the source had a value for; a date that never had one is simply left out.
 */
export interface SeriesWithdrawal {
  date: TradingDate;
  withdrawn: true;
  /** When the source withdrew the value, if it says (ISO 8601). */
  publishedAt?: string;
  value?: undefined;
}

/** What a series source returns per date and vintage: a value, or a withdrawal of one. */
export type SeriesPoint = SeriesValue | SeriesWithdrawal;

/**
 * What a fund issuer publishes for one date (layer D, best effort; for checks only, never a value
 * used in calculations). One record per date. Values are as published for that date: the NAV
 * per share on that day's share basis, never adjusted for later splits or distributions (an
 * adjusted history reads as a premium on every day before the event). On an ex-date, the
 * distribution per share (every distribution going ex that day summed) and the split ratio (new
 * shares per old share, 2 for a 2-for-1 split). A source that publishes NAV is compared on the
 * dates it has a record; a source without NAV (events only) reports every distribution and split
 * from its first to its last record, since one it leaves out reads as a mismatch.
 */
export interface IssuerRecord {
  date: TradingDate;
  nav?: number;
  /** The NAV's currency (ISO 4217), required with a NAV; compared with the fund's currency. */
  currency?: string;
  distribution?: number;
  split?: number;
}

/** An exchange rate for one date as the source published it. */
export interface FxValue {
  /** Base then quote currency, e.g. `USDXXX` = units of XXX per USD. */
  pair: string;
  date: TradingDate;
  rate: number;
  publishedAt?: string;
  withdrawn?: undefined;
}

/** The source withdrew its rate for `date` from `publishedAt` on (as `SeriesWithdrawal`). */
export interface FxWithdrawal {
  pair: string;
  date: TradingDate;
  withdrawn: true;
  publishedAt?: string;
  rate?: undefined;
}

/** What an FX source returns per date and vintage: a rate, or a withdrawal of one. */
export type FxRate = FxValue | FxWithdrawal;

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
