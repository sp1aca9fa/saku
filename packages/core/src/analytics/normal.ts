// The standard normal distribution function and its inverse (docs/analytics.md "Statistics",
// "Normal distribution"): accurate to 1e-13 relative for |z| <= 8 and 1e-11 for |z| <= 37.

const SQRT_PI = Math.sqrt(Math.PI);

/** exp(-x^2) without the rounding of x^2 (split x into a 1/16 part whose square is exact). */
function expMinusSquare(x: number): number {
  const high = Math.trunc(x * 16) / 16;
  return Math.exp(-high * high) * Math.exp(-(x - high) * (x + high));
}

/** The complementary error function for x >= 0. */
function erfcNonNegative(x: number): number {
  if (x < 1) {
    // erf(x) = 2 / sqrt(pi) x sum((-1)^k x^(2k+1) / (k! (2k+1))), then erfc = 1 - erf (>= 0.157).
    const x2 = x * x;
    let power = x; // (-1)^k x^(2k+1) / k!
    let sum = x;
    for (let k = 1; k < 100; k++) {
      power *= -x2 / k;
      const term = power / (2 * k + 1);
      sum += term;
      if (Math.abs(term) <= 1e-17 * Math.abs(sum)) break;
    }
    return 1 - (2 / SQRT_PI) * sum;
  }
  // erfc(x) = exp(-x^2) / sqrt(pi) / (x + (1/2) / (x + 1 / (x + (3/2) / (x + ...)))), modified Lentz.
  const tiny = 1e-300;
  let f = x;
  let c = x;
  let d = 0;
  for (let k = 1; k < 10_000; k++) {
    const a = k / 2;
    d = x + a * d;
    if (d === 0) d = tiny;
    d = 1 / d;
    c = x + a / c;
    if (c === 0) c = tiny;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) <= 1e-16) break;
  }
  return expMinusSquare(x) / (SQRT_PI * f);
}

/** Phi(z), the standard normal distribution function. */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return NaN;
  if (z === -Infinity) return 0;
  if (z === Infinity) return 1;
  const x = Math.abs(z) / Math.SQRT2;
  const tail = erfcNonNegative(x) / 2; // Phi(-|z|)
  return z < 0 ? tail : 1 - tail;
}

const normalDensity = (z: number) =>
  expMinusSquare(Math.abs(z) / Math.SQRT2) / Math.sqrt(2 * Math.PI);

/** Phi^-1(p) for p <= 0.5 (lower tail): Newton steps on ln Phi from Abramowitz and Stegun 26.2.23. */
function lowerQuantile(p: number): number {
  if (p === 0.5) return 0;
  const t = Math.sqrt(-2 * Math.log(p));
  let x = -(
    t -
    (2.515517 + 0.802853 * t + 0.010328 * t * t) /
      (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t)
  );
  const target = Math.log(p);
  for (let k = 0; k < 100; k++) {
    const cdf = normalCdf(x);
    const step = ((Math.log(cdf) - target) * cdf) / normalDensity(x);
    x -= step;
    if (Math.abs(step) <= 4e-16 * Math.max(1, Math.abs(x))) break;
  }
  if (!Number.isFinite(x)) throw new Error(`normalQuantile: ${p} is below the supported range.`);
  return x;
}

/** Phi^-1(p), the standard normal quantile, for p in (0, 1); -Infinity at 0, Infinity at 1. */
export function normalQuantile(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) throw new Error(`normalQuantile: ${p} is not in [0, 1].`);
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  // 1 - p is exact for p >= 0.5 (Sterbenz), so the upper half mirrors the lower tail.
  return p <= 0.5 ? lowerQuantile(p) : -lowerQuantile(1 - p);
}

/** Phi^-1(1 - q), computed from q (never from the rounded 1 - q). */
export function normalUpperQuantile(q: number): number {
  return -normalQuantile(q);
}
