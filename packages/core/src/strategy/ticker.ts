// The one grammar of a holding's or operand's ticker (docs/indicators.md "Equity curves",
// "Synthetic leverage"; docs/analytics.md `averageExposure`; spec 2026-11-01 ticker-grammar).
// The schema, the backtest and the metrics read a ticker only through `parseTicker`, so a ticker
// means one thing everywhere, and a malformed one is refused rather than read loosely (Pillar 1:
// `Number('')` is 0, so `X?L=` would otherwise hold X at no leverage).
//
//   ticker  = base | base "?" param [ "&" param ]
//   param   = ("L" | "E") "=" decimal        each key at most once, in either order
//   decimal = ["-"] digits [ "." digits ]    no exponent, no "+", no spaces, no escapes
//   base    = one or more characters, none of them whitespace or ? & = %
//
// L (leverage) is finite and > 0; E (expense, percent a year) is finite and >= 0. CASH_USD takes
// no parameters (it accrues the cash rate; a leverage or an expense on it means nothing defined).
// Assumed (spec): L > 0, since a short or 0x synthetic is not in the requirements.

export const CASH_USD = 'CASH_USD';

const BASE = /^[^\s?&=%]+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const KEYS = ['L', 'E'] as const;

export interface ParsedTicker {
  base: string;
  /** L: 1 without it. */
  leverage: number;
  /** E, percent a year: 0 without it. */
  expensePct: number;
}

type Read = { ok: true; value: ParsedTicker } | { ok: false; reason: string };

function read(ticker: string): Read {
  const fail = (reason: string): Read => ({ ok: false, reason });
  if (typeof ticker !== 'string' || ticker === '') return fail('a ticker is required');
  const q = ticker.indexOf('?');
  const base = q < 0 ? ticker : ticker.slice(0, q);
  if (!BASE.test(base)) {
    return fail(
      `"${ticker}": the ticker before "?" must be non-empty, without spaces or the characters ? & = %`,
    );
  }
  const parsed: ParsedTicker = { base, leverage: 1, expensePct: 0 };
  if (q < 0) return { ok: true, value: parsed };
  if (base === CASH_USD) return fail(`"${ticker}": ${CASH_USD} takes no parameters`);
  const query = ticker.slice(q + 1);
  const seen = new Set<string>();
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (!(KEYS as readonly string[]).includes(key)) {
      return fail(
        `"${ticker}": unknown parameter "${key}"; write the ticker as BASE?L=3&E=0.9 (L and E only)`,
      );
    }
    if (seen.has(key)) return fail(`"${ticker}": ${key} is given twice; give it once`);
    seen.add(key);
    const text = eq < 0 ? '' : part.slice(eq + 1);
    if (!DECIMAL.test(text)) {
      return fail(
        `"${ticker}": ${key} must be a plain decimal number such as 3 or 0.9 (no exponent, ` +
          'spaces or escapes)',
      );
    }
    // + 0 turns -0 into 0 (E=-0 is a valid 0, never a negative zero carried on).
    const v = Number(text) + 0;
    if (!Number.isFinite(v)) return fail(`"${ticker}": ${key} is not a finite number`);
    if (key === 'L') {
      if (!(v > 0)) return fail(`"${ticker}": L (leverage) must be greater than 0`);
      parsed.leverage = v;
    } else {
      if (!(v >= 0)) return fail(`"${ticker}": E (expense, percent a year) must be 0 or more`);
      parsed.expensePct = v;
    }
  }
  return { ok: true, value: parsed };
}

/** Why the ticker is malformed (the grammar above), or undefined when it is well-formed. */
export function tickerProblem(ticker: string): string | undefined {
  const r = read(ticker);
  return r.ok ? undefined : r.reason;
}

/**
 * A holding's ticker read by the grammar above, e.g. `SPY?L=3&E=0.9` (leverage 3, expense 0.9% a
 * year). Throws on a malformed ticker: never a 0 or NaN read silently. A parsed strategy has no
 * malformed ticker (the schema refuses it).
 */
export function parseTicker(ticker: string): ParsedTicker {
  const r = read(ticker);
  if (!r.ok) throw new Error(`Malformed ticker: ${r.reason}.`);
  return r.value;
}
