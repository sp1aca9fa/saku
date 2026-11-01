// Decimal text: a non-negative number written as plain text (`"0.2"`, `"1000"`), so no float
// holds a rate or an amount whose exact digits matter (the TaxRegime contract, plugin-sdk
// tax-regime.ts; until `decimal.js` is approved, action C34, values are only checked for form and
// range and compared exactly as text). One rule for the tax regime declarations and the admin
// settings that hold rates (broker costs, deposit rate, benchmark fees).

/** Non-negative, plain notation: no sign, exponent, padding zero or spaces (`"012.5"` fails). */
export const DECIMAL_TEXT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
/** Far beyond any real rate or amount. */
export const DECIMAL_TEXT_MAX_LENGTH = 40;
/** Texts are shown with every digit; formatting keeps at most 20 decimals. */
export const DECIMAL_TEXT_MAX_DECIMALS = 20;
/**
 * Significant digits a decimal text may have where float64 analytics read it: up to 15, a
 * float64 holds the text's value so that it reads back to the same digits (IEEE 754 binary64,
 * DBL_DIG = 15). More would be silently rounded when read.
 */
export const FLOAT_SAFE_DIGITS = 15;

/** Why `v` is not decimal text, or undefined when it is. */
export function decimalTextProblem(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > DECIMAL_TEXT_MAX_LENGTH || !DECIMAL_TEXT.test(v)) {
    return `must be a decimal written as text, e.g. "0.2" (got ${JSON.stringify(v)})`;
  }
  if ((v.split('.')[1] ?? '').length > DECIMAL_TEXT_MAX_DECIMALS) {
    return `at most ${DECIMAL_TEXT_MAX_DECIMALS} decimals`;
  }
  return undefined;
}

/** A decimal text as integer and fraction digits without padding zeros (`"012.50"` never passes DECIMAL_TEXT). */
function parts(d: string): [string, string] {
  const [int, frac = ''] = d.split('.');
  return [int!, frac.replace(/0+$/, '')];
}

/** Compares two DECIMAL_TEXT texts exactly (no float): -1, 0 or 1. */
export function compareDecimalText(a: string, b: string): -1 | 0 | 1 {
  const [ai, af] = parts(a);
  const [bi, bf] = parts(b);
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const n = Math.max(af.length, bf.length);
  const ap = af.padEnd(n, '0');
  const bp = bf.padEnd(n, '0');
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}

/**
 * The significant digits of a DECIMAL_TEXT text: from the first non-zero digit to the last
 * non-zero one (`"0.0250"`: 2, `"100.5"`: 4, `"1000"`: 1, `"0"`: 0).
 */
export function significantDigits(d: string): number {
  const [int, frac] = parts(d);
  return `${int}${frac}`.replace(/^0+/, '').replace(/0+$/, '').length;
}

/**
 * Why decimal text `v` is not one float64 analytics can read exactly, or undefined: its form
 * (`decimalTextProblem`), then at most FLOAT_SAFE_DIGITS significant digits.
 */
export function floatDecimalTextProblem(v: unknown): string | undefined {
  const problem = decimalTextProblem(v);
  if (problem !== undefined) return problem;
  return significantDigits(v as string) > FLOAT_SAFE_DIGITS
    ? `at most ${FLOAT_SAFE_DIGITS} significant digits (more would be rounded when computed with)`
    : undefined;
}
