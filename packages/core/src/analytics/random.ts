// Seeded random numbers and the stationary block bootstrap (docs/analytics.md "Statistics",
// "Random numbers" and "Stationary block bootstrap"). Every draw is specified there exactly, so
// the reference implementation draws the same numbers from the same seed.

const TWO_32 = 4_294_967_296;

/**
 * The default mean block length of the stationary bootstrap, in trading days: a choice (about one
 * month; docs/analytics.md "Stationary block bootstrap"). Callers pass their own `meanBlock`.
 */
export const DEFAULT_MEAN_BLOCK = 20;
const MASK_64 = (1n << 64n) - 1n;

/** One SplitMix64 step (Vigna, splitmix64.c): the next counter and its output, modulo 2^64. */
export function splitMix64(x: bigint): { next: bigint; output: bigint } {
  const next = (x + 0x9e3779b97f4a7c15n) & MASK_64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  return { next, output: z ^ (z >> 31n) };
}

const isUint32 = (v: number) => Number.isInteger(v) && v >= 0 && v < TWO_32;

/** xoshiro128** (Blackman and Vigna 2018). */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** From an explicit state (four unsigned 32-bit words, not all zero). */
  constructor(state: readonly [number, number, number, number]) {
    if (!state.every(isUint32) || state.every((w) => w === 0)) {
      throw new Error('Rng: the state is four unsigned 32-bit words, not all zero.');
    }
    [this.s0, this.s1, this.s2, this.s3] = state;
  }

  /** The next unsigned 32-bit output. */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** A float in [0, 1) from two outputs (53 bits, as MT19937's genrand_res53). */
  float(): number {
    const a = this.next() >>> 5;
    const b = this.next() >>> 6;
    return (a * 67_108_864 + b) / 9_007_199_254_740_992;
  }

  /** An integer in [0, n), n an integer in 1 .. 2^32, by rejection (no modulo bias). */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
      throw new Error(`Rng.int: ${n} is not an integer in 1 .. 2^32.`);
    }
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** The generator seeded from `(seed, stream)` through SplitMix64 (`x = seed x 2^32 + stream`). */
export function createRng(seed: number, stream = 0): Rng {
  if (!isUint32(seed) || !isUint32(stream)) {
    throw new Error('createRng: seed and stream are integers in 0 .. 2^32 - 1.');
  }
  const first = splitMix64((BigInt(seed) << 32n) | BigInt(stream));
  const second = splitMix64(first.next);
  const low = (z: bigint) => Number(z & 0xffffffffn);
  const high = (z: bigint) => Number(z >> 32n);
  return new Rng([low(first.output), high(first.output), low(second.output), high(second.output)]);
}

/**
 * Stationary bootstrap (Politis and Romano 1994): `length` indexes into a sample of `n` days.
 * Day 0 starts a block at a random day; each next day starts a new block with probability
 * 1 / meanBlock (one float, then one integer when it does), else continues to the next day,
 * wrapping from the last day to the first.
 */
export function stationaryBootstrap(
  rng: Rng,
  n: number,
  length: number,
  meanBlock: number,
): number[] {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
    throw new Error('stationaryBootstrap: the sample has 1 .. 2^32 days.');
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new Error('stationaryBootstrap: the length is a non-negative integer.');
  }
  if (typeof meanBlock !== 'number' || !Number.isFinite(meanBlock) || meanBlock < 1) {
    throw new Error('stationaryBootstrap: the mean block length is a number >= 1.');
  }
  const out: number[] = [];
  if (length === 0) return out;
  const p = 1 / meanBlock;
  let i = rng.int(n);
  out.push(i);
  for (let t = 1; t < length; t++) {
    i = rng.float() < p ? rng.int(n) : (i + 1) % n;
    out.push(i);
  }
  return out;
}
