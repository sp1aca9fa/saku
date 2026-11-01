// Plug-in contracts (requirements 15, system design section 6). A plug-in package exports one
// array per kind from `src/index.ts`, only the kinds it has.
import type {
  Calendar,
  EarlyCloses,
  FxKind,
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
  EarlyCloses,
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
  /**
   * The provider whose limits the plug-in's requests count against (requirements 04 "Quota
   * guard"); default: the key. Plug-ins of one provider (e.g. its bars and its FX) declare the
   * same id and the same `limits`, so their requests together stay under 80% of each limit, in a
   * run and across runs (the stored usage is counted under it). Same form as a key. Changing or
   * removing it keeps the usage stored under the old id before the change counting (remembered
   * in the saved description for 32 days, `savePluginInfos`).
   */
  provider?: string;
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
   * Bar sources that list a cash dividend only some time after its ex-date (e.g. once processed,
   * about its payable date): the most calendar days after the ex-date it may still report none,
   * a whole number from 1 to 366 (`MAX_DIVIDEND_LISTING_LAG_DAYS`). Layer B then reads a
   * dividend of the primary that this source reports as 0, dated within that many days before
   * the checking run's target date, as `dividend_pending` (not listed yet, never a
   * disagreement): green when another secondary confirmed the dividend, else yellow. Older, a
   * missing dividend is a red `dividend_match` as for any source (decisions log 2026-11-01,
   * C20). Not declared: the source lists dividends on their ex-date. State the provider's
   * behavior it rests on next to the value.
   */
  dividendListingLagDays?: number;
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

/**
 * A series response that says whether it is complete for its span (spec 2026-10-31
 * vanished-values). A plain `SeriesPoint[]` is the same as `completeSpan: false`.
 */
export interface SeriesFetch {
  points: SeriesPoint[];
  /**
   * True only when `points` hold every value the source still publishes for every date from the
   * first point's date through the requested end (`to`), inclusive (e.g. a series served as
   * current values only, without vintages, read to the last page). A stored date in that span
   * that is left out, also one after the last point, no longer has a value at the source: on a
   * full fetch (bootstrap, weekly) core records a withdrawal for it, known from the fetch.
   * Stored dates before the first point or after `to` are kept and noted. Never declare it for a
   * source whose answer can end before `to` while it still has later values (an embargo or lag). Never true for a response that may be partial (capped,
   * truncated) or that leaves out a date it still has a value for.
   */
  completeSpan: boolean;
}

export interface SeriesSource {
  info: PluginInfo;
  /**
   * Values per date and vintage. A source that revises a value to "no value" sends a withdrawal
   * (`{ date, withdrawn: true, publishedAt }`, `SeriesWithdrawal`), never a 0 and never nothing:
   * a date simply left out keeps its stored value as current, unless the response declares
   * itself complete for its span (`SeriesFetch.completeSpan`).
   */
  fetchSeries(
    id: string,
    from: TradingDate,
    to: TradingDate,
    ctx: PluginContext,
  ): Promise<SeriesPoint[] | SeriesFetch>;
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
  /**
   * One record per date as published that day; `currency` is the currency of the record's NAV
   * and distribution (required with a NAV and with a nonzero distribution: a response with a
   * record lacking it is refused whole; see `IssuerRecord`).
   */
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

// Tax regimes (requirements 07 "What a regime plug-in declares", 15). A regime only declares;
// the tax engine in core computes (C1, with decimal.js). Every amount and rate is a decimal
// written as text, never a float (system design: decimal money, tax and quotas). Checked when
// the plug-ins load (`validateTaxRegime`): a declaration that does not pass is refused whole.

/**
 * A non-negative decimal in plain notation: digits, optionally a point and more digits
 * (`"0.20315"`, `"2400000"`). No sign, exponent, grouping or spaces.
 */
export type DecimalText = string;

/** An amount in a currency (ISO 4217 code, e.g. `"XTS"`). Always the regime's `currency`. */
export interface MoneyText {
  amount: DecimalText;
  currency: string;
}

/**
 * A text the regime ships in its own language files (`TaxRegime.texts`): a dotted key into them
 * (e.g. `"accounts.general.name"`), resolved in the user's language with English as fallback.
 */
export type RegimeTextKey = string;

/** How a purchase may be made: one purchase of any size, or a recurring plan (DCA). */
export type PurchaseMode = 'lump_sum' | 'periodic';

/** What a realized loss may be set against. */
export type LossOffset = 'gains' | 'dividends';

/** How the cost of a sold position is found from its purchases. */
export type LotMethod = 'moving_average' | 'fifo';

/**
 * The order in which one day's trades of one product meet the lot method: as executed, or all
 * purchases before the sales (so a same-day repurchase enters the sold position's cost), or all
 * sales first.
 */
export type SameDayOrder = 'execution' | 'purchases_first' | 'sales_first';

/** The stored tax rate kinds (`FX_KINDS` in core, without `valuation`). */
export type TaxFxKind = Exclude<FxKind, 'valuation'>;

/** Which products an account type may hold and how they may be bought. */
export interface TaxEligibility {
  /**
   * Leveraged and inverse products (`symbols.leverage_factor` other than 1) may be held. The
   * symbol import requires every symbol to state its factor (1 for an unleveraged fund).
   */
  leveraged: boolean;
  /** The asset classes it may hold (`symbols.asset_class`), or `'all'`. */
  assetClasses: 'all' | string[];
  /**
   * Only products the regime designates (a list kept by an authority, e.g. funds approved for a
   * savings scheme). Where that list comes from is not part of the contract yet (it is decided
   * with the first regime that needs it); until then no product is eligible for such an account
   * type. Default false.
   */
  designatedOnly?: boolean;
  /** The purchase modes allowed (at least one). */
  purchaseModes: PurchaseMode[];
}

/**
 * When a sale gives quota back: which limits, at what value (the sold position's cost, its
 * `book value`, or the sale's proceeds), and from when (the start of the next regime year, or
 * the trade date).
 */
export interface QuotaRelease {
  limits: ('annual' | 'lifetime')[];
  basis: 'book_value' | 'proceeds';
  from: 'next_year' | 'trade_date';
}

/**
 * An account type's purchase limits. Purchases count against them at their cost in the regime's
 * currency (converted at the purchase rate, `TaxFx.purchases`). A year is the regime year
 * (`TaxRegime.yearStart`).
 */
export interface TaxQuota {
  /** Most that may be bought in one regime year. */
  annual?: MoneyText;
  /** Most that may be held at cost over a lifetime. */
  lifetime?: MoneyText;
  /** Whether and how a sale frees quota; absent: a sale frees nothing. */
  release?: QuotaRelease;
}

/** Tax rates on what an account type realizes, as fractions (`"0.20315"` for 20.315%). */
export interface TaxRates {
  realizedGains: DecimalText;
  dividends: DecimalText;
}

/** A condition a tax rule depends on. */
export interface TaxCondition {
  /** `filing`: the person files a tax return for the year. */
  kind: 'filing';
  /** What the user is told about it (placeholders: `REGIME_TEXT_PLACEHOLDERS`). */
  textKey: RegimeTextKey;
}

/** A condition on a loss rule, naming the rules it applies to. */
export interface LossCondition extends TaxCondition {
  /**
   * `offsets`: setting a loss against gains or dividends within the year; `carryforward`:
   * carrying an unused loss into later years. An in-year offset can need nothing while the
   * carryforward needs a filed return.
   */
  appliesTo: ('offsets' | 'carryforward')[];
}

/** What happens to a realized loss in an account type. */
export interface TaxLosses {
  /** What a loss may be set against within the year; empty: no offset. */
  offsets: LossOffset[];
  /** Regime years a loss not used may be carried forward (whole number, 0: none), or no limit. */
  carryforwardYears: number | 'unlimited';
  /** Conditions for the offsets or the carryforward (none: they always apply). */
  conditions: LossCondition[];
}

/** One kind of account a person may hold under the regime. */
export interface TaxAccountType {
  /** Stable identifier (`taxable` is required); never changed once user data exists. */
  key: string;
  treatment: 'taxable' | 'tax_advantaged';
  nameKey: RegimeTextKey;
  descriptionKey: RegimeTextKey;
  eligibility: TaxEligibility;
  /** Absent: no purchase limit. */
  quota?: TaxQuota;
  tax: TaxRates;
  losses: TaxLosses;
  /**
   * Whether foreign tax withheld on dividends is credited against this regime's tax: `false`,
   * or credited under its conditions (none: always).
   */
  foreignTaxCredit: false | { conditions: TaxCondition[] };
  /**
   * What the dividend tax (`tax.dividends`) on a foreign dividend is charged on: the gross
   * dividend, or what is left after the withholding at source.
   */
  foreignDividendBase: 'gross' | 'net_of_withholding';
  /**
   * Withholding at source for this account type where it differs from the regime's
   * (`TaxRegime.foreignWithholding`), per paying country; countries not listed take the regime's.
   */
  foreignWithholding?: ForeignWithholding[];
}

/** A lifetime or annual limit several account types share (e.g. one lifetime cap for two). */
export interface QuotaGroup {
  key: string;
  nameKey: RegimeTextKey;
  accountTypes: string[];
  annual?: MoneyText;
  lifetime?: MoneyText;
}

/** Tax withheld at source on dividends paid from another country. */
export interface ForeignWithholding {
  /** ISO 3166-1 alpha-2 code of the country the dividend comes from. */
  country: string;
  rate: DecimalText;
}

/**
 * Which exchange rate converts each kind of amount into the regime's currency. `rates` names
 * the regime's own rates (e.g. `TTM`, `TTS`, `TTB`) and maps each onto a stored kind.
 */
export interface TaxFx {
  rates: Record<string, { kind: TaxFxKind; nameKey: RegimeTextKey }>;
  purchases: string;
  sales: string;
  dividends: string;
}

/** A move of holdings from one account type to another without a sale. */
export interface TaxTransfer {
  from: string;
  to: string;
}

/** A regime's language files: per language code a tree of texts; `en` is required and complete. */
export interface RegimeTexts {
  [key: string]: string | RegimeTexts;
}

export interface TaxRegimeInfo {
  /** Stable identifier (the `tax_regime` setting); never changed once user tax data exists. */
  key: string;
  kind: 'tax_regime';
  /**
   * The declaration's version (e.g. `2026.1`), raised with every change of a rule. The install
   * stores the declaration's fingerprint when the regime is set; a changed declaration is not
   * used until the admin sets it again, which is refused once users have tax data.
   */
  version: string;
  nameKey: RegimeTextKey;
  /** The country whose rules these are (ISO 3166-1 alpha-2; a made-up one: a user-assigned code). */
  country: string;
  /** The currency taxes and limits are computed in (ISO 4217). */
  currency: string;
  /** Official sources of the rules (laws, the tax authority's pages); at least one. */
  sources: string[];
}

/** A country's tax rules for the engine (requirements 07). Declarations only, no code. */
export interface TaxRegime {
  info: TaxRegimeInfo;
  /** First day of the regime year (`MM-DD`), for annual limits and carryforward. */
  yearStart: string;
  /**
   * Which date of a trade places it in a regime year (quotas, gains, carryforward).
   * `settlement_date` is refused for now: no settlement lag is declared anywhere yet.
   */
  yearDate: 'trade_date' | 'settlement_date';
  /**
   * Which date's tax rate (`fx`) converts a trade. `settlement_date` is refused for now: without
   * a declared settlement lag the date is unknown, and a rate dated after what is known (`asOf`)
   * would have to show as pending, never be replaced by the trade date's rate.
   */
  fxDate: 'trade_date' | 'settlement_date';
  accountTypes: TaxAccountType[];
  quotaGroups?: QuotaGroup[];
  costBasis: { method: LotMethod; sameDayOrder: SameDayOrder };
  fx: TaxFx;
  /**
   * Withholding at source per paying country (not the regime's own `info.country`). A dividend
   * from a country not listed has an unknown withholding: the engine says so, never assumes 0.
   */
  foreignWithholding: ForeignWithholding[];
  /** Moves allowed without a sale; any other move is a sale and a new purchase. */
  transfers: TaxTransfer[];
  /** Per language code (`en` required). */
  texts: Record<string, RegimeTexts>;
}

/** What a plug-in package's `src/index.ts` exports. */
export interface PluginModule {
  bars?: BarSource[];
  series?: SeriesSource[];
  fx?: FxSource[];
  issuers?: IssuerSource[];
  calendars?: CalendarSource[];
  notifiers?: Notifier[];
  taxRegimes?: TaxRegime[];
}
