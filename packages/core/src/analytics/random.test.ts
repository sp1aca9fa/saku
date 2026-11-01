// Golden values from an independent Python implementation of the published C code
// (splitmix64.c, xoshiro128starstar.c) and the draw order of docs/analytics.md "Random numbers".
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Rng, createRng, splitMix64, stationaryBootstrap } from './random';

/** An unsigned 32-bit integer. */
const uint32 = fc.tuple(fc.nat(0xffff), fc.nat(0xffff)).map(([a, b]) => a * 65_536 + b);

describe('random numbers', () => {
  it('SplitMix64 from 0 gives the reference outputs', () => {
    let x = 0n;
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const step = splitMix64(x);
      x = step.next;
      out.push(step.output.toString(16).padStart(16, '0'));
    }
    expect(out).toEqual(['e220a8397b1dcdaf', '6e789e6aa1b965f4', '06c45d188009454f']);
  });

  it('xoshiro128** from (1, 2, 3, 4) gives the reference outputs', () => {
    const r = new Rng([1, 2, 3, 4]);
    expect(Array.from({ length: 10 }, () => r.next())).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597,
      4258142804,
    ]);
  });

  it('seeds from (seed, stream)', () => {
    const first4 = (r: Rng) => Array.from({ length: 4 }, () => r.next());
    expect(first4(createRng(42))).toEqual([561131802, 1455960195, 1624807067, 676739556]);
    expect(first4(createRng(42, 7))).toEqual([3218433758, 3595279162, 1425948380, 2234227796]);
    expect(first4(createRng(0))).toEqual([3737715805, 2584255861, 2876756834, 3286328325]);
    expect(first4(createRng(4294967295, 4294967295))).toEqual([
      477689756, 2493998634, 555695776, 607808419,
    ]);
  });

  it('draws floats with 53 bits and integers without bias', () => {
    expect(createRng(42).float()).toBe(0.13064867510640732);
    const r = createRng(42);
    expect(Array.from({ length: 10 }, () => r.int(10))).toEqual([2, 5, 7, 6, 8, 3, 5, 4, 2, 6]);
    // n = 3e9: limit = 3e9, so the outputs below it are returned as they are.
    const big = createRng(42);
    expect(Array.from({ length: 4 }, () => big.int(3_000_000_000))).toEqual([
      561131802, 1455960195, 1624807067, 676739556,
    ]);
    expect(createRng(1).int(1)).toBe(0);
    expect(createRng(1).int(4294967296)).toBe(createRng(1).next());
  });

  it('refuses bad seeds, states and ranges', () => {
    expect(() => createRng(-1)).toThrow('seed');
    expect(() => createRng(1.5)).toThrow('seed');
    expect(() => createRng(2 ** 32)).toThrow('seed');
    expect(() => createRng(1, -1)).toThrow('stream');
    expect(() => new Rng([0, 0, 0, 0])).toThrow('not all zero');
    expect(() => createRng(1).int(0)).toThrow('1 .. 2^32');
    expect(() => createRng(1).int(2.5)).toThrow('1 .. 2^32');
  });

  it('floats stay in [0, 1) and integers in [0, n)', () => {
    fc.assert(
      fc.property(uint32, uint32, (seed, m) => {
        const n = m + 1;
        const r = createRng(seed);
        for (let i = 0; i < 20; i++) {
          const f = r.float();
          const k = r.int(n);
          if (!(f >= 0 && f < 1) || !(Number.isInteger(k) && k >= 0 && k < n)) return false;
        }
        return true;
      }),
    );
  });
});

describe('stationary bootstrap', () => {
  it('draws in the specified order (golden from the independent implementation)', () => {
    // 2, then 3 (a continuation), a new block at 3, then runs on and wraps from 9 to 0.
    expect(stationaryBootstrap(createRng(42), 10, 12, 3)).toEqual([
      2, 3, 3, 4, 5, 6, 7, 8, 9, 0, 1, 8,
    ]);
    expect(stationaryBootstrap(createRng(7, 3), 1000, 8, 20)).toEqual([
      384, 385, 386, 387, 388, 389, 390, 391,
    ]);
  });

  it('mean block 1 draws a new day every day (one float, then one integer)', () => {
    const a = createRng(5);
    const b = createRng(5);
    const want = [b.int(7)];
    for (let t = 1; t < 30; t++) {
      b.float();
      want.push(b.int(7));
    }
    expect(stationaryBootstrap(a, 7, 30, 1)).toEqual(want);
  });

  it('a very long mean block runs on and wraps', () => {
    const d = stationaryBootstrap(createRng(9), 5, 12, 1e15);
    d.forEach((v, t) => expect(v).toBe((d[0]! + t) % 5));
  });

  it('blocks average the mean length', () => {
    const d = stationaryBootstrap(createRng(11), 1_000_000, 200_000, 20);
    let blocks = 1;
    for (let t = 1; t < d.length; t++) if (d[t] !== (d[t - 1]! + 1) % 1_000_000) blocks++;
    // About 200,000 / 20 = 10,000 blocks (a new start equal to the continuation is not seen:
    // one in a million); the count's sd is about 100.
    expect(blocks).toBeGreaterThan(9_500);
    expect(blocks).toBeLessThan(10_500);
  });

  it('handles empty and single-day samples, refuses bad input', () => {
    expect(stationaryBootstrap(createRng(1), 3, 0, 20)).toEqual([]);
    expect(stationaryBootstrap(createRng(1), 1, 4, 2)).toEqual([0, 0, 0, 0]);
    expect(() => stationaryBootstrap(createRng(1), 0, 4, 2)).toThrow('sample');
    expect(() => stationaryBootstrap(createRng(1), 3, -1, 2)).toThrow('length');
    expect(() => stationaryBootstrap(createRng(1), 3, 4, 0.5)).toThrow('mean block');
    expect(() => stationaryBootstrap(createRng(1), 3, 4, NaN)).toThrow('mean block');
  });
});
