// Install-wide admin settings (requirements 12). Validated here so the CLI, the app and jobs
// agree on what a setting may hold.
import {
  COST_FIELDS,
  type CostField,
  compareDecimalText,
  floatDecimalTextProblem,
  isTradingDate,
  tickerProblem,
} from '@saku/core';
import { eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './client';
import { activityLog, appSettings, userTaxAccounts } from './schema';

export const SETTINGS = {
  /** ISO 4217 code. Chosen before anything is stored; never changed afterwards. */
  base_currency: (v: string) => /^[A-Z]{3}$/.test(v),
  /** IANA time zone for display (trading dates stay America/New_York). */
  time_zone: (v: string) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  },
  /** Language code of the install's primary language (default for users who chose none). */
  primary_language: (v: string) => /^[a-z]{2,3}(-[A-Z]{2})?$/.test(v),
  /**
   * First trading date of forward records (registration and the daily record). Unset until the
   * A1 gate passes: before it, nothing is registered or recorded (stage A).
   */
  forward_records_from: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  /**
   * Layer D: the normal premium/discount of each fund's market close to its issuer NAV, as a JSON
   * map of ticker to a fraction (0.002 = 0.2%), each above 0 and at most MAX_NAV_TOLERANCE. Set
   * by the owner from observed data (`pnpm sources issuer-stats`; requirements 04, "Per-ETF
   * thresholds set in A3"); a fund without one is observed only (green, deviation recorded).
   */
  issuer_nav_tolerance: (v: string) => parseNavTolerances(v) !== null,
  /**
   * The red re-check deadline (requirements 04 "Red re-check before execution", decisions log
   * 2026-11-01, C16): whole minutes before the next regular US open (09:30 New York) by which a
   * day red at its first grading gets its final instruction. Default RECHECK_DEFAULT_MINUTES;
   * 0 to RECHECK_MAX_MINUTES.
   */
  red_recheck_minutes_before_open: (v: string) => parseRecheckMinutes(v) !== null,
  /**
   * The install's tax regime (requirements 07, 12): a loaded `TaxRegime` plug-in's key. Set only
   * with the loaded regimes' keys at hand (`setSetting`'s `taxRegimes`, `pnpm plugins
   * tax-regime`), so an unknown key is refused; not changed once user tax data exists.
   */
  tax_regime: (v: string) => /^[a-z][a-z0-9-]{1,39}$/.test(v),
  /**
   * The install's broker cost defaults (requirements 05 "Costs", 09 "Cost model before C1", 12):
   * `{ "slippageBps": "5", "feePct": "0.1", "fxSpreadPct": "0.2" }`, each decimal text
   * (`parseBrokerCosts`). A strategy's omitted cost takes the install's; unset: none (never 0).
   */
  broker_costs: (v: string) => 'costs' in parseBrokerCosts(v),
  /**
   * The base currency's deposit rate (requirements 05 `CASH_BASE`, 01 "Bank deposits", 12):
   * `{ "ratePct": "0.2", "asOf": "2026-10-01", "currency": "<base currency>" }`
   * (`parseDepositRate`); the currency is checked against `base_currency` when set.
   */
  deposit_rate: (v: string) => 'rate' in parseDepositRate(v),
  /**
   * The benchmark set (requirements 01 "Benchmark set", 12): a JSON list (`parseBenchmarks`). Set
   * only with the install regime's account types at hand (`setSetting`'s `accountTypes`, `pnpm
   * plugins benchmarks <file>`), so an account type the regime does not define is refused.
   */
  benchmarks: (v: string) => 'benchmarks' in parseBenchmarks(v),
} as const;

/**
 * The per-user tables holding tax data (tax accounts, lots, quota ledger, loss carryforward):
 * the tax accounts so far; the tax engine adds the others (C1). While any has a row, `tax_regime` cannot change: that
 * data was computed under the regime's account types and rules. A test makes every table with
 * an `owner_id` be listed here or declared not tax data, so a new one is never forgotten.
 */
export const USER_TAX_TABLES: readonly SQLiteTable[] = [userTaxAccounts];

/** Whether any user has tax data (a row in one of `tables`, default `USER_TAX_TABLES`). */
export async function userTaxDataExists(
  db: Db,
  tables: readonly SQLiteTable[] = USER_TAX_TABLES,
): Promise<boolean> {
  for (const table of tables) {
    if ((await db.select().from(table).limit(1)).length > 0) return true;
  }
  return false;
}

/**
 * The loaded regime's declaration a `tax_regime` value names: its key, version and fingerprint
 * (sha256 of its canonical rules, `taxRegimeFingerprint` in the plug-in SDK).
 */
export interface TaxRegimeDeclaration {
  key: string;
  version: string;
  fingerprint: string;
}

/** Where the declaration the regime was set with is kept (not an admin setting of its own). */
const TAX_REGIME_DECLARATION = 'tax_regime_declaration';

/**
 * The declaration `tax_regime` was last set with; undefined when none is stored; `invalid` when
 * the stored row cannot be read (only a hand edit can do that): then it matches no declaration.
 */
export async function taxRegimeDeclaration(
  db: Db,
): Promise<TaxRegimeDeclaration | { invalid: true } | undefined> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, TAX_REGIME_DECLARATION));
  if (!row) return undefined;
  const v = row.value as Record<string, unknown> | null;
  return v !== null &&
    typeof v === 'object' &&
    typeof v.key === 'string' &&
    typeof v.version === 'string' &&
    typeof v.fingerprint === 'string'
    ? { key: v.key, version: v.version, fingerprint: v.fingerprint }
    : { invalid: true };
}

/**
 * Refuses a `tax_regime` value that names no loaded regime (`known`; undefined: not checked
 * against the loaded plug-ins, refused too), and, while users have tax data, a change of the
 * regime or of its declaration under the same key (a different fingerprint than the one it was
 * set with: that data was computed under the old rules, and is never silently rebased).
 * Returns the declaration to store.
 */
export async function checkTaxRegimeChange(
  db: Db,
  value: string,
  known: readonly TaxRegimeDeclaration[] | undefined,
  tables: readonly SQLiteTable[] = USER_TAX_TABLES,
): Promise<TaxRegimeDeclaration> {
  if (known === undefined) {
    throw new Error(
      'tax_regime is set with `pnpm plugins tax-regime <key>`, which checks the key against the loaded tax regimes.',
    );
  }
  const declaration = known.find((d) => d.key === value);
  if (!declaration) {
    throw new Error(
      `No loaded tax regime has the key ${value} (loaded: ${known.length > 0 ? known.map((d) => d.key).join(', ') : 'none'}).`,
    );
  }
  const current = await getSetting(db, 'tax_regime');
  if (current === undefined || !(await userTaxDataExists(db, tables))) return declaration;
  if (current !== value) {
    throw new Error(
      `tax_regime is ${current} and cannot be changed: users have tax data computed under it.`,
    );
  }
  const stored = await taxRegimeDeclaration(db);
  if (
    stored === undefined ||
    'invalid' in stored ||
    stored.fingerprint !== declaration.fingerprint
  ) {
    const was =
      stored === undefined || 'invalid' in stored
        ? 'an unknown declaration'
        : `version ${stored.version}`;
    throw new Error(
      `The ${value} regime's rules changed since it was set (${was}, now version ${declaration.version}): users have tax data computed under the old rules, so the new ones are refused. Restore the plug-in version it was set with.`,
    );
  }
  return declaration;
}

/** The default re-check deadline: one hour before the next regular US open (C16). */
export const RECHECK_DEFAULT_MINUTES = 60;
/**
 * The earliest deadline the setting accepts (10 hours before the open, 23:30 New York the evening
 * before): earlier would end the re-check before most corrections can arrive (a typo, not a choice).
 */
export const RECHECK_MAX_MINUTES = 600;

/** `red_recheck_minutes_before_open` as a number, or null when the text is not a valid one. */
export function parseRecheckMinutes(text: string): number | null {
  if (!/^\d{1,4}$/.test(text)) return null;
  const n = Number(text);
  return n <= RECHECK_MAX_MINUTES ? n : null;
}

/**
 * The re-check deadline's minutes before the open: the default when unset. A stored value that no
 * longer parses (only a hand edit can do that) is reported as `invalid`, never read as the default
 * without saying so: the forward step then opens no re-check (the safe state at once, as before
 * C16) and the run names it.
 */
export async function recheckMinutes(db: Db): Promise<{ minutes: number } | { invalid: string }> {
  const text = await getSetting(db, 'red_recheck_minutes_before_open');
  if (text === undefined) return { minutes: RECHECK_DEFAULT_MINUTES };
  const n = parseRecheckMinutes(text);
  return n === null ? { invalid: text } : { minutes: n };
}

/** The widest NAV tolerance the setting accepts (20%): wider would not catch a decimal error. */
export const MAX_NAV_TOLERANCE = 0.2;

/** The `issuer_nav_tolerance` map, or null when the text is not a valid one. */
export function parseNavTolerances(text: string): Record<string, number> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  for (const [ticker, tol] of entries) {
    if (!/^\S{1,20}$/.test(ticker)) return null;
    if (typeof tol !== 'number' || !(tol > 0 && tol <= MAX_NAV_TOLERANCE)) return null;
  }
  // Own properties only, whatever the ticker is called.
  return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * The NAV tolerance per ticker (none set: an empty map, every fund observed only). A stored value
 * that no longer parses (only a hand edit can do that) is reported as `invalid`, never read as
 * "none set" without saying so: layer D then observes only and grades the day yellow.
 */
export async function navTolerances(
  db: Db,
): Promise<{ tolerances: Record<string, number>; invalid: boolean }> {
  const text = await getSetting(db, 'issuer_nav_tolerance');
  if (text === undefined) return { tolerances: {}, invalid: false };
  const parsed = parseNavTolerances(text);
  return parsed === null
    ? { tolerances: {}, invalid: true }
    : { tolerances: parsed, invalid: false };
}

/** Tolerance keys that name no active symbol (a typo, or a fund no longer in the universe). */
export function unmatchedTolerances(
  tolerances: Record<string, number>,
  tickers: string[],
): string[] {
  return Object.keys(tolerances)
    .filter((t) => !tickers.includes(t))
    .sort();
}

// --- Broker costs, deposit rate, benchmarks (C2; spec 2026-11-02 c2-settings) ---
//
// JSON settings are read strictly, like a strategy file: a key given twice in one object (which
// `JSON.parse` would silently read as the last), an unknown key (a typo) or a missing one is
// refused, with every reason. Rates are decimal text (core `decimal-text`, the TaxRegime
// contract's rule), at most 15 significant digits, since float64 analytics read them.

/** Object keys given twice in one object of `text`, which must be valid JSON. */
export function duplicateJsonKeys(text: string): string[] {
  const objects: Set<string>[] = [];
  const repeated: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{') {
      objects.push(new Set());
      i++;
    } else if (c === '}') {
      objects.pop();
      i++;
    } else if (c === '"') {
      // A string runs to the next unescaped quote (valid JSON has no raw quote inside one).
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const token = text.slice(i, j + 1);
      i = j + 1;
      let k = i;
      while (k < text.length && ' \t\n\r'.includes(text[k]!)) k++;
      // A string followed by ":" is a key of the innermost open object.
      if (text[k] === ':') {
        const key = JSON.parse(token) as string;
        const keys = objects.at(-1)!;
        if (keys.has(key)) repeated.push(key);
        keys.add(key);
      }
    } else i++;
  }
  return repeated;
}

/** `text` as JSON, or the reason it is not read: not JSON, or a key given twice. */
function strictJson(text: string): { value: unknown } | { problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { problems: [`not valid JSON (${(e as Error).message})`] };
  }
  const repeated = duplicateJsonKeys(text);
  if (repeated.length > 0) {
    return {
      problems: [...new Set(repeated)].map((k) => `"${k}" is given twice in one object`),
    };
  }
  return { value };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Problems with an object's keys: each of `keys` required, nothing else. */
function keyProblems(v: Record<string, unknown>, keys: readonly string[], at: string): string[] {
  const problems: string[] = [];
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) problems.push(`${at}unknown key "${k}" (keys: ${keys.join(', ')})`);
  }
  for (const k of keys) {
    if (!Object.hasOwn(v, k)) problems.push(`${at}"${k}" is required`);
  }
  return problems;
}

/** A decimal-text rate below `below` (or at most `atMost`); the problem, or undefined. */
function rateProblem(
  v: unknown,
  path: string,
  limit: { below: string } | { atMost: string },
): string | undefined {
  const problem = floatDecimalTextProblem(v);
  if (problem !== undefined) return `${path} ${problem}`;
  const text = v as string;
  if ('below' in limit && compareDecimalText(text, limit.below) >= 0) {
    return `${path} must be below ${limit.below} (got ${text})`;
  }
  if ('atMost' in limit && compareDecimalText(text, limit.atMost) > 0) {
    return `${path} must be at most ${limit.atMost} (got ${text})`;
  }
  return undefined;
}

/** The highest slippage the setting accepts, in basis points (10%): more is a typo, not a cost. */
export const MAX_SLIPPAGE_BPS = '1000';
/** Fees and FX spreads are below this percent: 100% or more would take the whole amount traded. */
export const COST_PCT_BELOW = '100';

/** The install's broker costs, each decimal text (slippage in bps, fee and spread in percent). */
export type BrokerCosts = Record<CostField, string>;

/**
 * `broker_costs`: every field required (no default is invented; 0 is written as "0"), each
 * decimal text >= 0, slippage at most MAX_SLIPPAGE_BPS, fee and FX spread below COST_PCT_BELOW.
 */
export function parseBrokerCosts(text: string): { costs: BrokerCosts } | { problems: string[] } {
  const read = strictJson(text);
  if ('problems' in read) return read;
  const v = read.value;
  if (!isObject(v)) return { problems: ['must be a JSON object such as ' + BROKER_COSTS_EXAMPLE] };
  const problems = keyProblems(v, COST_FIELDS, '');
  for (const f of COST_FIELDS) {
    if (!Object.hasOwn(v, f)) continue;
    const p = rateProblem(
      v[f],
      f,
      f === 'slippageBps' ? { atMost: MAX_SLIPPAGE_BPS } : { below: COST_PCT_BELOW },
    );
    if (p) problems.push(p);
  }
  if (problems.length > 0) return { problems };
  return {
    costs: {
      slippageBps: v.slippageBps,
      feePct: v.feePct,
      fxSpreadPct: v.fxSpreadPct,
    } as BrokerCosts,
  };
}

export const BROKER_COSTS_EXAMPLE = '{"slippageBps":"5","feePct":"0.1","fxSpreadPct":"0.2"}';

/**
 * The install's broker costs: `unset` when never set (a strategy's omitted cost is then refused,
 * never read as 0); `invalid` when the stored value no longer parses (only a hand edit can do
 * that), never read as unset without saying so.
 */
export async function brokerCosts(
  db: Db,
): Promise<{ costs: BrokerCosts } | { unset: true } | { invalid: string[] }> {
  const text = await getSetting(db, 'broker_costs');
  if (text === undefined) return { unset: true };
  const parsed = parseBrokerCosts(text);
  return 'costs' in parsed ? parsed : { invalid: parsed.problems };
}

/**
 * The deposit rate's ceiling (below 1000% a year): only a guard against an absurd value; it
 * catches no unit mistake (a rate in basis points or as a fraction), which the owner checks.
 */
export const DEPOSIT_RATE_BELOW = '1000';

/** The base currency's deposit rate: percent a year (decimal text), dated, in that currency. */
export interface DepositRate {
  ratePct: string;
  /** The date the rate was read (`YYYY-MM-DD`): it is known from that date on (`asOf`). */
  asOf: string;
  currency: string;
}

const DEPOSIT_KEYS = ['ratePct', 'asOf', 'currency'] as const;

/**
 * `deposit_rate`: `ratePct` decimal text >= 0 and below DEPOSIT_RATE_BELOW, `asOf` a real date,
 * `currency` an ISO 4217 code (the base currency's, checked when set and when read).
 */
export function parseDepositRate(text: string): { rate: DepositRate } | { problems: string[] } {
  const read = strictJson(text);
  if ('problems' in read) return read;
  const v = read.value;
  if (!isObject(v)) {
    return {
      problems: [
        'must be a JSON object such as {"ratePct":"0.2","asOf":"2026-10-01","currency":"EUR"}',
      ],
    };
  }
  const problems = keyProblems(v, DEPOSIT_KEYS, '');
  if (Object.hasOwn(v, 'ratePct')) {
    const p = rateProblem(v.ratePct, 'ratePct', { below: DEPOSIT_RATE_BELOW });
    if (p) problems.push(p);
  }
  if (Object.hasOwn(v, 'asOf') && !(typeof v.asOf === 'string' && isTradingDate(v.asOf))) {
    problems.push(`asOf must be a date like 2026-10-01 (got ${JSON.stringify(v.asOf)})`);
  }
  if (
    Object.hasOwn(v, 'currency') &&
    !(typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency))
  ) {
    problems.push(`currency must be an ISO 4217 code (got ${JSON.stringify(v.currency)})`);
  }
  if (problems.length > 0) return { problems };
  return { rate: { ratePct: v.ratePct, asOf: v.asOf, currency: v.currency } as DepositRate };
}

/**
 * The deposit rate: `unset` when never set; `invalid` when the stored value no longer parses or
 * is not in the base currency (only a hand edit can do either), never read as unset.
 */
export async function depositRate(
  db: Db,
): Promise<{ rate: DepositRate } | { unset: true } | { invalid: string[] }> {
  const text = await getSetting(db, 'deposit_rate');
  if (text === undefined) return { unset: true };
  const parsed = parseDepositRate(text);
  if ('problems' in parsed) return { invalid: parsed.problems };
  const base = await getSetting(db, 'base_currency');
  if (parsed.rate.currency !== base) {
    return {
      invalid: [`currency ${parsed.rate.currency} is not the base currency ${base ?? '(not set)'}`],
    };
  }
  return parsed;
}

/** The holding a benchmark uses for the base currency's deposit rate (`deposit_rate`). */
export const DEPOSIT = 'DEPOSIT';

/** A benchmark (requirements 01 "Benchmark set"): what it holds, its fund fee, its account type. */
export interface Benchmark {
  /** `[a-z][a-z0-9_]*`: its name is the text `benchmarks.<id>` when the content has one. */
  id: string;
  /** Tickers (the strict grammar) or DEPOSIT; weights in percent, adding up to 100. */
  holdings: { ticker: string; weight: number }[];
  /** The modeled fund's fee, percent a year (decimal text). */
  feePctPerYear: string;
  /** An account type key of the install's tax regime. */
  account: string;
}

const BENCHMARK_KEYS = ['id', 'holdings', 'feePctPerYear', 'account'] as const;
const HOLDING_KEYS = ['ticker', 'weight'] as const;
const BENCHMARK_ID = /^[a-z][a-z0-9_]{0,39}$/;
/** The form of a tax regime's account type key (plug-in SDK, `TaxRegime` `accountTypes`). */
const ACCOUNT_KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** Near-ties within 1e-9 relative (CLAUDE.md "Execution and numerics"): of the 100 a sum makes. */
const WEIGHT_SUM_TOLERANCE = 100 * 1e-9;

/**
 * `benchmarks`: a non-empty JSON list; each benchmark has exactly `id` (unique,
 * `[a-z][a-z0-9_]*`, at most 40 characters), `holdings` (non-empty; each ticker in the strict
 * grammar or DEPOSIT, listed once, weight above 0 and at most 100, the weights adding up to 100
 * within 1e-9 relative), `feePctPerYear` (decimal text below 100) and `account` (an account type
 * key's form; whether the install's regime defines it is `benchmarkAccountProblems`).
 */
export function parseBenchmarks(
  text: string,
): { benchmarks: Benchmark[] } | { problems: string[] } {
  const read = strictJson(text);
  if ('problems' in read) return read;
  const v = read.value;
  if (!Array.isArray(v) || v.length === 0) {
    return { problems: ['must be a non-empty JSON list of benchmarks (templates/benchmarks/)'] };
  }
  const problems: string[] = [];
  const ids = new Set<string>();
  v.forEach((b: unknown, n) => {
    const at = `[${n}]`;
    if (!isObject(b)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const where = typeof b.id === 'string' ? `${at} "${b.id}": ` : `${at} `;
    problems.push(...keyProblems(b, BENCHMARK_KEYS, where));
    if (Object.hasOwn(b, 'id')) {
      if (typeof b.id !== 'string' || !BENCHMARK_ID.test(b.id)) {
        problems.push(
          `${where}id must be lowercase letters, digits and _ starting with a letter, at most 40 (got ${JSON.stringify(b.id)})`,
        );
      } else if (ids.has(b.id)) {
        problems.push(`${where}id is used twice`);
      } else ids.add(b.id);
    }
    if (Object.hasOwn(b, 'holdings')) problems.push(...holdingsProblems(b.holdings, where));
    if (Object.hasOwn(b, 'feePctPerYear')) {
      const p = rateProblem(b.feePctPerYear, 'feePctPerYear', { below: COST_PCT_BELOW });
      if (p) problems.push(`${where}${p}`);
    }
    if (
      Object.hasOwn(b, 'account') &&
      !(typeof b.account === 'string' && ACCOUNT_KEY.test(b.account))
    ) {
      problems.push(
        `${where}account must be an account type key such as "taxable" (got ${JSON.stringify(b.account)})`,
      );
    }
  });
  return problems.length > 0 ? { problems } : { benchmarks: v as Benchmark[] };
}

function holdingsProblems(hs: unknown, where: string): string[] {
  if (!Array.isArray(hs) || hs.length === 0) return [`${where}holdings must be a non-empty list`];
  const problems: string[] = [];
  const seen = new Set<string>();
  let sum = 0;
  let weighed = true;
  hs.forEach((h: unknown, m) => {
    const at = `${where}holdings[${m}] `;
    if (!isObject(h)) {
      problems.push(`${at}must be an object`);
      weighed = false;
      return;
    }
    problems.push(...keyProblems(h, HOLDING_KEYS, at));
    if (typeof h.ticker === 'string') {
      if (seen.has(h.ticker)) problems.push(`${at}"${h.ticker}" is listed twice`);
      seen.add(h.ticker);
      const problem = h.ticker === DEPOSIT ? undefined : tickerProblem(h.ticker);
      if (problem !== undefined) problems.push(`${at}${problem}`);
      // DEPOSIT is the deposit rate, not a fund: no leverage or expense applies to it.
      else if (h.ticker.startsWith(`${DEPOSIT}?`)) {
        problems.push(`${at}"${h.ticker}": ${DEPOSIT} takes no parameters`);
      }
    } else if (Object.hasOwn(h, 'ticker')) {
      problems.push(`${at}ticker must be text (got ${JSON.stringify(h.ticker)})`);
    }
    if (
      typeof h.weight === 'number' &&
      Number.isFinite(h.weight) &&
      h.weight > 0 &&
      h.weight <= 100
    ) {
      sum += h.weight;
    } else {
      weighed = false;
      if (Object.hasOwn(h, 'weight')) {
        problems.push(
          `${at}weight must be a number above 0 and at most 100 (got ${JSON.stringify(h.weight)})`,
        );
      }
    }
  });
  if (weighed && !(Math.abs(sum - 100) <= WEIGHT_SUM_TOLERANCE)) {
    problems.push(`${where}weights must add up to 100 (they add up to ${sum})`);
  }
  return problems;
}

/** Benchmarks whose account type the install's regime does not define (`accountTypes`: its keys). */
export function benchmarkAccountProblems(
  benchmarks: readonly Benchmark[],
  accountTypes: readonly string[],
): string[] {
  return benchmarks
    .filter((b) => !accountTypes.includes(b.account))
    .map(
      (b) =>
        `"${b.id}": the install's tax regime has no account type "${b.account}" (it has: ${accountTypes.join(', ') || 'none'})`,
    );
}

/**
 * The benchmark set: `unset` when never set; `invalid` when the stored value no longer parses
 * (only a hand edit can do that). Account types are checked against the regime by the reader
 * that loads it (`benchmarkAccountProblems`).
 */
export async function benchmarkSet(
  db: Db,
): Promise<{ benchmarks: Benchmark[] } | { unset: true } | { invalid: string[] }> {
  const text = await getSetting(db, 'benchmarks');
  if (text === undefined) return { unset: true };
  const parsed = parseBenchmarks(text);
  return 'benchmarks' in parsed ? parsed : { invalid: parsed.problems };
}

/** Why a value is refused, for the settings that say more than "not valid". */
function valueProblems(key: SettingKey, value: string): string[] | undefined {
  const parsed =
    key === 'broker_costs'
      ? parseBrokerCosts(value)
      : key === 'deposit_rate'
        ? parseDepositRate(value)
        : key === 'benchmarks'
          ? parseBenchmarks(value)
          : undefined;
  return parsed && 'problems' in parsed ? parsed.problems : undefined;
}

export type SettingKey = keyof typeof SETTINGS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export async function getSetting(db: Db, key: SettingKey): Promise<string | undefined> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row ? String(row.value) : undefined;
}

export async function setSetting(
  db: Db,
  key: SettingKey,
  value: string,
  actor = 'cli',
  options: {
    /** `tax_regime` only: the loaded tax regimes' declarations (the setting names one of them). */
    taxRegimes?: readonly TaxRegimeDeclaration[];
    /** `benchmarks` only: the account type keys of the install's tax regime, as loaded. */
    accountTypes?: readonly string[];
  } = {},
) {
  const problems = valueProblems(key, value);
  if (problems) throw new Error(`Not a valid ${key}:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  if (!SETTINGS[key](value)) throw new Error(`Not a valid ${key}: ${value}`);
  if (key === 'deposit_rate') {
    const base = await getSetting(db, 'base_currency');
    const { currency } = (parseDepositRate(value) as { rate: DepositRate }).rate;
    if (base === undefined) {
      throw new Error("Set base_currency first: deposit_rate is the base currency's rate.");
    }
    if (currency !== base) {
      throw new Error(
        `deposit_rate is the base currency's rate: its currency must be ${base} (got ${currency}).`,
      );
    }
  }
  if (key === 'benchmarks') {
    if (options.accountTypes === undefined) {
      throw new Error(
        "benchmarks is set with `pnpm plugins benchmarks <file>`, which checks each benchmark's account against the install's tax regime.",
      );
    }
    const wrong = benchmarkAccountProblems(
      (parseBenchmarks(value) as { benchmarks: Benchmark[] }).benchmarks,
      options.accountTypes,
    );
    if (wrong.length > 0) {
      throw new Error(`Not a valid benchmarks:\n${wrong.map((p) => `- ${p}`).join('\n')}`);
    }
  }
  const current = await getSetting(db, key);
  if (key === 'base_currency' && current !== undefined && current !== value) {
    throw new Error(`base_currency is ${current} and cannot be changed once set.`);
  }
  if (key === 'tax_regime') {
    const declaration = await checkTaxRegimeChange(db, value, options.taxRegimes);
    // The value and the declaration it was set with are written together.
    await db.transaction(async (tx) => {
      await tx
        .insert(appSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: appSettings.key, set: { value } });
      await tx
        .insert(appSettings)
        .values({ key: TAX_REGIME_DECLARATION, value: declaration })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: declaration } });
      await tx
        .insert(activityLog)
        .values({ actor, action: 'setting.set', detail: { key, value, declaration } });
    });
    return;
  }
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  await db.insert(activityLog).values({ actor, action: 'setting.set', detail: { key, value } });
}
