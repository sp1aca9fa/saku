// Tests only (not exported from the package).
import { PRICE_LEVELS, Strategy } from './schema';

const plainable = (o: Record<string, unknown>) =>
  PRICE_LEVELS.includes(o.indicator as string) && o.totalReturn !== true;

/**
 * Parses `s` with its plain price-level operands (`PRICE_LEVELS`, not total return) made plain
 * again after the schema's checks, so a plain price against a fixed level or a percentage passes,
 * which the schema refuses (decisions log 2026-11-01, C18 (a): a split rescales earlier plain
 * prices). For tests of the
 * engine's own math (tolerance bands, near-ties, lookbacks) on exact closes without splits, where
 * the operand kind does not matter: the engine evaluates whatever comparison it is given.
 */
export function parsePlainAgainstLevel(s: unknown): Strategy {
  const paths: (string | number)[][] = [];
  const marked = structuredClone(s);
  const mark = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) return v.forEach((x, i) => mark(x, [...path, i]));
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (plainable(o)) {
      o.totalReturn = true;
      paths.push(path);
    }
    for (const [k, x] of Object.entries(o)) mark(x, [...path, k]);
  };
  mark(marked, []);
  const parsed = Strategy.parse(marked);
  for (const path of paths) {
    let o: unknown = parsed;
    for (const k of path) o = (o as Record<string | number, unknown>)[k];
    (o as { totalReturn: boolean }).totalReturn = false;
  }
  return parsed;
}
