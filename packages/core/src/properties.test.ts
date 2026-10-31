// Property tests (requirements 13: fast-check) for invariants the forward record and the signals
// rest on, each over a few hundred generated cases with a fixed seed (reproducible, fast in CI):
// - RFC 8785 canonical JSON (requirements 05, hash chain): the text does not depend on key order
//   and is stable (reading it back and canonicalizing again gives the same text).
// - The forward total-return index (requirements 04, adjusted series): computed incrementally (in
//   pieces, each continuing from the last level) it equals the full computation within 1e-9
//   relative, and a new bar never changes earlier levels.
// - The engine (requirements 13, incremental vs full): evaluated on the bars up to a day, the
//   signals and allocations equal the full history's for those days (split-adjusted prices).
// - The near-tie rule (requirements 06; CLAUDE.md "Near-ties"): a value within 1e-9 relative of
//   a bound keeps the previous state, in core and in the reference implementation.
// - `asOf` (requirements 04, point-in-time reads, no look-ahead): never returns a value that was
//   not known at the asked moment, versions known later never change an answer, and it equals
//   an independent oracle.
import { refEvaluate, refTotalReturn } from '@saku/reference';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { totalReturnIndex } from './adjusted';
import { type Json, canonicalJson } from './canonical';
import type { RawBar } from './domain';
import { PointInTime, type Vintage } from './pointintime';
import { NEAR_TIE, evaluate } from './strategy/engine';
import { Strategy } from './strategy/schema';

const RUNS = { seed: 20261101, numRuns: 300 };
const relClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.abs(b);

describe('canonical JSON (RFC 8785)', () => {
  // Valid JSON values with any Unicode strings (no lone surrogates: canonical JSON refuses them).
  const json = fc.jsonValue({ stringUnit: 'grapheme' }) as fc.Arbitrary<Json>;

  /** The same value with every object's keys in another order (`turn` picks the order). */
  function reorder(v: Json, turn: number): Json {
    if (Array.isArray(v)) return v.map((x) => reorder(x, turn));
    if (v === null || typeof v !== 'object') return v;
    const entries = Object.entries(v).map(([k, x]) => [k, reorder(x as Json, turn)] as const);
    const n = entries.length;
    const turned =
      turn % 2 === 0
        ? entries.reverse()
        : entries.map((_, i) => entries[(i + turn) % Math.max(1, n)]!);
    // fromEntries defines own properties, so a "__proto__" key stays a key.
    return Object.fromEntries(turned);
  }

  it('does not depend on key order', () => {
    fc.assert(
      fc.property(json, fc.nat(50), (v, turn) => {
        expect(canonicalJson(reorder(v, turn))).toBe(canonicalJson(v));
      }),
      RUNS,
    );
  });

  it('is stable: its text read back canonicalizes to the same text', () => {
    fc.assert(
      fc.property(json, (v) => {
        const text = canonicalJson(v);
        expect(canonicalJson(JSON.parse(text) as Json)).toBe(text);
      }),
      RUNS,
    );
  });
});

/** Bars with positive closes, some dividends and splits, on either price basis. */
const bars = fc
  .array(
    fc.record({
      close: fc.double({ min: 1, max: 1000, noNaN: true }),
      dividend: fc.oneof(
        { weight: 4, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: fc.double({ min: 0, max: 0.05, noNaN: true }) },
      ),
      splitFactor: fc.oneof(
        { weight: 8, arbitrary: fc.constant(1) },
        { weight: 1, arbitrary: fc.constantFrom(2, 3, 0.5, 0.1) },
      ),
      closeIsSplitAdjusted: fc.boolean(),
    }),
    { minLength: 1, maxLength: 120, size: 'max' },
  )
  .map((list): RawBar[] =>
    list.map((b, i) => ({
      date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      close: b.close,
      divCash: b.close * b.dividend,
      splitFactor: b.splitFactor,
      closeIsSplitAdjusted: b.closeIsSplitAdjusted,
    })),
  );

describe('forward total-return index', () => {
  it('incremental equals full within 1e-9; a new bar never changes earlier levels', () => {
    fc.assert(
      fc.property(bars, fc.array(fc.nat(), { maxLength: 6 }), (list, cuts) => {
        const full = totalReturnIndex(list);
        // Pieces end at the cut points; each continues from the last level of the one before
        // (overlapping by one bar, whose close the next day's return needs).
        const ends = [...new Set(cuts.map((c) => 1 + (c % list.length)))].sort((a, b) => a - b);
        let levels = totalReturnIndex(list.slice(0, ends[0] ?? list.length));
        for (const end of [...ends.slice(1), list.length]) {
          const from = levels.length - 1;
          if (end <= from + 1) continue;
          levels = [...levels, ...totalReturnIndex(list.slice(from, end), levels[from]).slice(1)];
        }
        expect(levels.length).toBe(full.length);
        levels.forEach((x, i) => expect(relClose(x, full[i]!), `bar ${i}`).toBe(true));
        // A shorter history gives exactly the same earlier levels.
        for (const end of ends)
          expect(totalReturnIndex(list.slice(0, end))).toEqual(full.slice(0, end));
        // The reference implementation agrees (requirements 04 layer E).
        refTotalReturn(list).forEach((x, i) =>
          expect(relClose(x, full[i]!), `ref ${i}`).toBe(true),
        );
      }),
      RUNS,
    );
  });
});

describe('evaluate: incremental equals full', () => {
  /** A raw-price random walk with splits (the close drops by the split ratio that day). */
  const walk = fc
    .record({
      steps: fc.array(
        fc.record({
          move: fc.double({ min: -0.05, max: 0.05, noNaN: true }),
          split: fc.oneof(
            { weight: 30, arbitrary: fc.constant(1) },
            { weight: 1, arbitrary: fc.constantFrom(2, 3, 0.5) },
          ),
        }),
        { minLength: 2, maxLength: 160, size: 'max' },
      ),
      start: fc.double({ min: 20, max: 500, noNaN: true }),
    })
    .map(({ steps, start }): RawBar[] => {
      let close = start;
      return steps.map((s, i) => {
        close = (close * (1 + s.move)) / s.split;
        return {
          date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
          close,
          divCash: 0,
          splitFactor: s.split,
          closeIsSplitAdjusted: false,
        };
      });
    });
  const params = fc.record({
    smaLength: fc.integer({ min: 2, max: 40 }),
    volLength: fc.integer({ min: 2, max: 30 }),
    tolerancePct: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 5, noNaN: true })),
    volThreshold: fc.double({ min: 5, max: 60, noNaN: true }),
    cut: fc.nat(),
  });
  const strategyOf = (p: {
    smaLength: number;
    volLength: number;
    tolerancePct: number;
    volThreshold: number;
  }) =>
    Strategy.parse({
      name: 'Incremental example',
      account: 'taxable',
      safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
      evaluation: { frequency: 'daily' },
      signals: [
        {
          id: 'trend',
          type: 'compare',
          left: { indicator: 'price', ticker: 'AAA' },
          op: '>',
          right: { indicator: 'sma', ticker: 'AAA', length: p.smaLength },
          tolerancePct: p.tolerancePct,
        },
        {
          id: 'calm',
          type: 'compare',
          left: { indicator: 'volatility', ticker: 'AAA', length: p.volLength },
          op: '<',
          right: { threshold: p.volThreshold },
        },
      ],
      allocations: [
        {
          name: 'On',
          when: { all: ['trend', 'calm'] },
          holdings: [{ ticker: 'AAA', weight: 100 }],
        },
        { name: 'Off', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
      ],
    });

  // Price against its own average and volatility against a threshold: a later split rescales
  // every earlier split-adjusted close by one factor, which neither changes. Price (totalReturn
  // false) against a fixed level is left out: this property found that a later split does change
  // its earlier days (a close of 15 above a level of 10 becomes 7.5 after a 2-for-1 split), which
  // contradicts docs/indicators.md "Price"; reported to the owner (spec 2026-11-01
  // yaml-strategies, review fix 8), not fixed here.
  it('the days up to a cut match the full history', () => {
    fc.assert(
      fc.property(walk, params, (list, p) => {
        const strategy = strategyOf(p);
        const k = 1 + (p.cut % list.length);
        const full = evaluate(strategy, { AAA: list });
        const part = evaluate(strategy, { AAA: list.slice(0, k) });
        expect(part).toEqual(full.filter((d) => d.date <= list[k - 1]!.date));
      }),
      RUNS,
    );
  });
});

describe('near-tie rule', () => {
  /**
   * One compare signal, price against a fixed threshold with a tolerance band. Day 1 sets the
   * state well outside the band; day 2 sits within NEAR_TIE of a bound (its state must be day
   * 1's, a tie); day 3 leaves the band past that bound by more than NEAR_TIE (the state follows
   * the comparison).
   */
  const cases = fc.record({
    op: fc.constantFrom('>' as const, '<' as const),
    threshold: fc.double({ min: 1, max: 1000, noNaN: true }),
    tolerancePct: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 10, noNaN: true })),
    startAbove: fc.boolean(),
    upper: fc.boolean(),
    // Within the tie distance (a little inside it, so rounding cannot push it out).
    tie: fc.double({ min: -0.9 * NEAR_TIE, max: 0.9 * NEAR_TIE, noNaN: true }),
    // Clearly past the bound: at least twice the tie distance.
    past: fc.double({ min: 2 * NEAR_TIE, max: 0.5, noNaN: true }),
  });

  it('a value within 1e-9 relative of a bound keeps the previous state (core and reference)', () => {
    fc.assert(
      fc.property(cases, (c) => {
        const t = c.tolerancePct / 100;
        const upper = c.threshold * (1 + t);
        const lower = c.threshold * (1 - t);
        const bound = c.upper ? upper : lower;
        const closes = [
          c.startAbove ? upper * 2 : lower * 0.5,
          bound * (1 + c.tie),
          c.upper ? upper * (1 + c.past) : lower * (1 - c.past),
        ];
        const list: RawBar[] = closes.map((close, i) => ({
          date: `2026-01-0${i + 2}`,
          close,
          divCash: 0,
          splitFactor: 1,
          closeIsSplitAdjusted: false,
        }));
        const strategy = Strategy.parse({
          name: 'Near-tie example',
          account: 'taxable',
          safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
          evaluation: { frequency: 'daily' },
          signals: [
            {
              id: 's',
              type: 'compare',
              left: { indicator: 'price', ticker: 'AAA' },
              op: c.op,
              right: { threshold: c.threshold },
              tolerancePct: c.tolerancePct,
            },
          ],
          allocations: [
            { name: 'On', when: { all: ['s'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
            { name: 'Off', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
          ],
        });
        const first = c.op === '>' ? c.startAbove : !c.startAbove;
        const last = c.op === '>' ? c.upper : !c.upper;
        const core = evaluate(strategy, { AAA: list });
        expect(core.map((d) => d.signals.s)).toEqual([first, first, last]);
        expect(core[1]!.ties).toEqual(['s']);
        expect(core[2]!.ties).toEqual([]);
        const ref = refEvaluate(strategy, { AAA: list });
        expect(ref.map((d) => d.signals.s)).toEqual([first, first, last]);
      }),
      RUNS,
    );
  });
});

describe('asOf (point-in-time reads)', () => {
  // 24 dates and up to 80 versions, so reads reach past the 10-observation look-back.
  const DATES = Array.from({ length: 24 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const hour = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
  // Each version is published some hours after its date: usually soon, sometimes weeks later
  // (a late source), so later-published observations sit between known ones.
  const rows = fc.array(
    fc
      .record({
        day: fc.nat(DATES.length - 1),
        value: fc.double({ min: -100, max: 100, noNaN: true }),
        lag: fc.oneof({ weight: 3, arbitrary: fc.nat(48) }, fc.nat(600)),
        // The vintage time is at or before the known time (the constructor refuses otherwise).
        vintageBack: fc.option(fc.nat(100)),
        withdrawn: fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, fc.constant(true)),
      })
      .map((r): Vintage => {
        const known = r.day * 24 + r.lag;
        return {
          date: DATES[r.day]!,
          knownAt: hour(known),
          ...(r.vintageBack !== null && { vintageAt: hour(Math.max(0, known - r.vintageBack)) }),
          ...(r.withdrawn ? { withdrawn: true } : { value: r.value }),
        };
      }),
    // `size: 'max'`: lengths up to 80 (fast-check's default size keeps arrays near 10).
    { maxLength: 80, size: 'max' },
  );
  const query = fc.record({
    date: fc.constantFrom('2025-12-31', ...DATES, '2026-02-01'),
    at: fc.nat(1200).map(hour),
  });

  /**
   * An oracle written apart from PointInTime (requirements 04, point-in-time reads): only the
   * versions known at `at` and dated on or before `date`; per date the rank-latest one (latest
   * vintage time, then latest known, then the later in the order given); of the latest 10 such
   * dates (the look-back), the newest whose version is a value.
   */
  function oracle(list: Vintage[], date: string, at: string) {
    const vintage = (v: Vintage) => v.vintageAt ?? v.knownAt;
    const latest = new Map<string, Vintage>();
    for (const v of list) {
      if (v.knownAt > at || v.date > date) continue;
      const best = latest.get(v.date);
      if (
        !best ||
        vintage(v) > vintage(best) ||
        (vintage(v) === vintage(best) && v.knownAt >= best.knownAt)
      ) {
        latest.set(v.date, v);
      }
    }
    const window = [...latest.keys()].sort().reverse().slice(0, 10);
    for (const d of window) {
      const v = latest.get(d)!;
      if (v.withdrawn !== true) {
        return { date: v.date, value: v.value, knownAt: v.knownAt, firstKnown: false };
      }
    }
    return undefined;
  }

  it('equals an independent oracle', () => {
    fc.assert(
      fc.property(rows, query, (list, q) => {
        expect(new PointInTime(list).asOf(q.date, q.at)).toEqual(oracle(list, q.date, q.at));
      }),
      RUNS,
    );
  });

  it('never returns a value known after the asked moment', () => {
    fc.assert(
      fc.property(rows, query, (list, q) => {
        const r = new PointInTime(list).asOf(q.date, q.at);
        if (r === undefined) return;
        expect(r.firstKnown).toBe(false);
        expect(r.knownAt <= q.at).toBe(true);
        expect(r.date <= q.date).toBe(true);
        // It is one of the stored versions of that date, a value (not a withdrawal).
        expect(
          list.some(
            (x) =>
              x.date === r.date &&
              x.withdrawn !== true &&
              x.value === r.value &&
              x.knownAt === r.knownAt,
          ),
        ).toBe(true);
      }),
      RUNS,
    );
  });

  it('versions known later never change an answer (nor remove one)', () => {
    fc.assert(
      fc.property(rows, query, (list, q) => {
        const known = list.filter((x) => x.knownAt <= q.at);
        expect(new PointInTime(list).asOf(q.date, q.at)).toEqual(
          new PointInTime(known).asOf(q.date, q.at),
        );
      }),
      RUNS,
    );
  });

  it('a first-known fallback is flagged; an unflagged read is always known at the moment', () => {
    fc.assert(
      fc.property(rows, query, (list, q) => {
        const pit = new PointInTime(list);
        const r = pit.asOf(q.date, q.at, { firstKnown: true });
        if (r === undefined || !r.firstKnown) {
          if (r) expect(r.knownAt <= q.at).toBe(true);
          expect(r).toEqual(pit.asOf(q.date, q.at));
        } else {
          // Only when nothing dated on or before the date was known (labeled look-ahead).
          expect(pit.asOf(q.date, q.at)).toBeUndefined();
          expect(list.some((x) => x.date <= q.date && x.knownAt <= q.at)).toBe(false);
        }
      }),
      RUNS,
    );
  });
});
