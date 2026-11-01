// The one ticker grammar (docs/indicators.md "Synthetic leverage"), read independently of
// packages/core: `BASE` or `BASE?k=v[&k=v]`, k is `L` or `E`, each at most once, either order;
// v a plain decimal `-?digits[.digits]` (no exponent, `+`, spaces, hex or URL escapes); L finite
// and > 0 (1 without it), E finite and >= 0 (0 without it); BASE non-empty, without whitespace or
// `? & = %`; `CASH_USD` and `CASH_BASE` take no parameters. Anything else is unreadable (undefined).

export interface RefTicker {
  base: string;
  L: number;
  E: number;
}

const BASE = /^[^\s?&=%]+$/;
const PAIR = /^([LE])=(-?\d+(\.\d+)?)$/;

/** The ticker's base, L and E, or undefined when it is outside the grammar. */
export function refParseTicker(ticker: string): RefTicker | undefined {
  const q = ticker.indexOf('?');
  const base = q < 0 ? ticker : ticker.slice(0, q);
  if (!BASE.test(base)) return undefined;
  if (q < 0) return { base, L: 1, E: 0 };
  if (base === 'CASH_USD' || base === 'CASH_BASE') return undefined;
  const parts = ticker.slice(q + 1).split('&');
  if (parts.length > 2) return undefined;
  const seen: Record<string, number> = {};
  for (const part of parts) {
    const m = PAIR.exec(part);
    if (!m) return undefined;
    const key = m[1]!;
    if (key in seen) return undefined;
    seen[key] = Number(m[2]);
  }
  const L = seen.L ?? 1;
  const E = seen.E ?? 0;
  if (!Number.isFinite(L) || !(L > 0)) return undefined;
  if (!Number.isFinite(E) || !(E >= 0)) return undefined;
  return { base, L, E };
}
