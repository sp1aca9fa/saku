// Core against the independent reference for the base-currency layer (docs/indicators.md "Base
// currency", "Base-currency cash", "FX spread"; spec 2026-11-02 base-currency) on seeded random
// data: equity within 1e-9 relative, the base series (values, unknownFx, invalidFx), conversions
// (count, FX spread) and refusals. CASH_BASE in allocations and the safe state, every execution
// mode, gaps (covered days), a USD and a non-USD base. Where they disagree, find the root cause
// against the contract; never copy one into the other.
import { refBacktest, refEvaluate } from '@saku/reference';
import { describe, expect, it } from 'vitest';
import type { RawBar, TradingDate } from '../domain';
import { type BacktestInput, backtest } from './backtest';
import { evaluate } from './engine';
import { Strategy } from './schema';

/** A small seeded generator (mulberry32), so failures reproduce. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 260;
const START = Date.UTC(2021, 0, 4);
const dateOf = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);

function walk(seed: number, vol: number): RawBar[] {
  const rnd = random(seed);
  const out: RawBar[] = [];
  let close = 100;
  for (let i = 0; i < N; i++) {
    const open = close * (1 + (rnd() - 0.5) * vol);
    close = open * (1 + (rnd() - 0.5) * vol);
    out.push({
      date: dateOf(i),
      open,
      close,
      closeIsSplitAdjusted: false,
      divCash: i > 0 && i % 50 === 0 ? close * 0.004 : 0,
      splitFactor: 1,
    });
  }
  return out;
}

/**
 * X, Y (held) and S (read by the signals). Y and S miss runs of dates, so the step over them
 * covers X's bars there (covered days); S alone misses a few sessions, which are then
 * safe-state sessions.
 */
function market(seed: number) {
  const rnd = random(seed * 13 + 5);
  const dropY = new Set<string>();
  const dropS = new Set<string>();
  for (let i = 40; i < N - 1; i++) {
    const u = rnd();
    if (u < 0.06) {
      const len = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < len && i < N - 1; k++, i++) dropY.add(dateOf(i));
    } else if (u < 0.1) dropS.add(dateOf(i));
  }
  const keep = (drop: Set<string>) => (b: RawBar) => !drop.has(b.date);
  return {
    X: walk(seed, 0.04),
    Y: walk(seed + 50, 0.02).filter(keep(dropY)),
    // S misses Y's dates too: a date without Y's bar is then neither a session nor evaluated.
    S: walk(seed + 90, 0.03).filter(keep(new Set([...dropY, ...dropS]))),
  };
}

/** FX around 150 (a random walk) and a deposit rate from 0 to 5% a year, on every date. */
function rates(seed: number) {
  const rnd = random(seed * 31 + 7);
  const fx = new Map<TradingDate, number>();
  const deposit = new Map<TradingDate, number>();
  let level = 150;
  for (let i = 0; i < N; i++) {
    level *= 1 + (rnd() - 0.5) * 0.02;
    fx.set(dateOf(i), level);
    deposit.set(dateOf(i), Math.round(rnd() * 500) / 100);
  }
  return { fx, deposit };
}

/** The same readers with holes: unknown on some dates, invalid (0, -1, NaN, Infinity) on others. */
function holed<T>(values: Map<TradingDate, T>, seed: number, invalid: T[]) {
  const rnd = random(seed);
  const out = new Map<TradingDate, T | undefined>();
  for (const [d, v] of values) {
    const u = rnd();
    out.set(d, u < 0.04 ? undefined : u < 0.07 ? invalid[Math.floor(rnd() * invalid.length)] : v);
  }
  return out;
}

const strategyFor = (execution: string, o: { cashBase?: boolean; spread?: boolean } = {}) => {
  const base = o.cashBase !== false;
  const cash = base ? 'CASH_BASE' : 'CASH_USD';
  return Strategy.parse({
    name: 'Base',
    account: 'taxable',
    execution,
    safeState: {
      holdings: [
        { ticker: cash, weight: 50 },
        { ticker: 'Y', weight: 50 },
      ],
    },
    evaluation: { frequency: 'daily' },
    costs: { slippageBps: 5, feePct: 0.1, ...(o.spread !== false && { fxSpreadPct: 0.4 }) },
    signals: [
      {
        id: 'A',
        type: 'compare',
        left: { indicator: 'price', ticker: 'S', totalReturn: true },
        op: '>',
        right: { indicator: 'sma', ticker: 'S', length: 8, totalReturn: true },
      },
      {
        id: 'B',
        type: 'compare',
        left: { indicator: 'price', ticker: 'S', totalReturn: true },
        op: '>',
        right: { indicator: 'sma', ticker: 'S', length: 25, totalReturn: true },
      },
    ],
    allocations: [
      { name: 'X', when: { all: ['A', 'B'] }, holdings: [{ ticker: 'X', weight: 100 }] },
      {
        name: 'Mix',
        when: { all: ['A'] },
        holdings: base
          ? [
              { ticker: 'X', weight: 40 },
              { ticker: 'CASH_BASE', weight: 30 },
              { ticker: 'CASH_USD', weight: 30 },
            ]
          : [
              { ticker: 'X', weight: 40 },
              { ticker: 'CASH_USD', weight: 60 },
            ],
      },
      { name: 'Cash', when: { all: ['B'] }, holdings: [{ ticker: cash, weight: 100 }] },
      { name: 'Y', holdings: [{ ticker: 'Y', weight: 100 }] },
    ],
  });
};

type Outcome =
  | { ok: true; core: ReturnType<typeof backtest>; ref: ReturnType<typeof refBacktest> }
  | { ok: false; core?: string; ref?: string };

/** Both implementations on the same inputs: both succeed (compared) or both refuse. */
function both(
  strategy: Strategy,
  bars: Record<string, RawBar[]>,
  o: Omit<BacktestInput, 'strategy' | 'days' | 'bars' | 'cashRate'>,
): Outcome {
  const cashRate = (date: string) => 1 + (Date.parse(date) % 7) / 10;
  const days = evaluate(strategy, bars);
  const refDays = refEvaluate(strategy, bars);
  expect(days.map((d) => d.allocation)).toEqual(refDays.map((d) => d.allocation));
  let core: ReturnType<typeof backtest> | undefined;
  let ref: ReturnType<typeof refBacktest> | undefined;
  let coreError: string | undefined;
  let refError: string | undefined;
  try {
    core = backtest({ strategy, days, bars, cashRate, ...o });
  } catch (e) {
    coreError = String(e);
  }
  try {
    ref = refBacktest(strategy, refDays, bars, cashRate, o);
  } catch (e) {
    refError = String(e);
  }
  // A refusal on one side only is a disagreement: the messages say which and why.
  expect({ core: coreError ?? 'ran', ref: refError ?? 'ran' }).toEqual(
    coreError === undefined ? { core: 'ran', ref: 'ran' } : { core: coreError, ref: refError },
  );
  if (core && ref) {
    compare(core, ref);
    return { ok: true, core, ref };
  }
  return { ok: false, core: coreError, ref: refError };
}

const close = (a: number, b: number, what: string) =>
  expect(
    Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE),
    what,
  ).toBeLessThanOrEqual(1e-9);

function compare(core: ReturnType<typeof backtest>, ref: ReturnType<typeof refBacktest>) {
  expect(core.points.map((p) => p.date)).toEqual(ref.dates);
  core.points.forEach((p, i) => {
    // A point is null on both or on neither (unusable FX, docs/indicators.md "Base-currency
    // cash"); a null point gives the same reason on both.
    const r = ref.equity[i];
    expect(p.equity === null, `equity null ${p.date}`).toBe(r === null);
    if (p.equity === null) {
      const why = ref.unknown?.find((u) => u.date === p.date)?.reason;
      expect(p.unknown?.reason, `reason ${p.date}`).toBe(why);
    } else close(p.equity, r!, `equity ${p.date}`);
  });
  expect(core.switches).toBe(ref.switches);
  expect(core.conversions?.count).toBe(ref.conversions?.count);
  if (core.conversions) {
    close(core.conversions.fxSpreadCosts, ref.conversions!.fxSpread, 'FX spread');
    expect(core.conversions.tax).toBe('not_applied');
    expect(ref.conversions!.tax).toBe('not_applied');
  }
  expect(core.base === undefined).toBe(ref.base === undefined);
  if (core.base && ref.base) {
    expect(core.base.currency).toBe(ref.base.currency);
    expect(core.base.unknownFx).toEqual(ref.base.unknownFx);
    expect(core.base.invalidFx).toEqual(ref.base.invalidFx);
    core.base.points.forEach((p, i) => {
      const r = ref.base!.equity[i];
      expect(p.equity === null, `base null ${p.date}`).toBe(r === null);
      if (p.equity !== null) close(p.equity, r!, `base equity ${p.date}`);
      // Whole shares: the value in the base currency, null where the equity is.
      expect(p.value === undefined, `base value ${p.date}`).toBe(ref.base!.value === undefined);
      if (p.value !== undefined) {
        const v = ref.base!.value![i];
        expect(p.value === null).toBe(v === null);
        if (p.value && v) {
          expect(p.value.currency).toBe(v.currency);
          close(p.value.amount, v.amount, `base value ${p.date}`);
        }
      }
    });
  }
}

const reader =
  <T>(m: Map<TradingDate, T | undefined>) =>
  (d: TradingDate) =>
    m.get(d);

/** What the cases exercised (asserted at the end). */
const seen = {
  conversions: 0,
  heldOverGap: 0,
  safeStateWithBase: 0,
  nullPoints: 0,
  invalidPoints: 0,
  refusedBoth: 0,
  lostAfterConversion: 0,
};

function countCoverage(
  r: ReturnType<typeof backtest>,
  bars: Record<string, RawBar[]>,
  strategy: Strategy,
) {
  seen.conversions += r.conversions?.count ?? 0;
  const holdable = [...new Set([...bars.X!, ...bars.Y!].map((b) => b.date))].sort();
  const safe = strategy.safeState.holdings.some((h) => h.ticker === 'CASH_BASE');
  for (let i = 1; i < r.points.length; i++) {
    const [prev, cur] = [r.points[i - 1]!, r.points[i]!];
    if ('CASH_BASE' in prev.weights && holdable.some((d) => d > prev.date && d < cur.date)) {
      seen.heldOverGap++;
    }
    if (!cur.decided && safe && 'CASH_BASE' in cur.weights) seen.safeStateWithBase++;
  }
}

describe('core vs reference: base currency (seeded)', () => {
  for (const seed of [21, 22, 23]) {
    for (const execution of ['next_open', 'next_close', 'same_close']) {
      const bars = market(seed);
      const { fx, deposit } = rates(seed);

      it(`seed ${seed}, ${execution}: CASH_BASE with a non-USD base`, () => {
        const strategy = strategyFor(execution);
        const r = both(strategy, bars, {
          baseCurrency: 'JPY',
          fxRate: reader(fx),
          depositRate: reader(deposit),
        });
        expect(r.ok).toBe(true);
        if (r.ok) countCoverage(r.core, bars, strategy);
      });

      it(`seed ${seed}, ${execution}: CASH_BASE with a USD base (no FX, no spread)`, () => {
        const strategy = strategyFor(execution);
        const r = both(strategy, bars, {
          baseCurrency: 'USD',
          fxRate: () => {
            throw new Error('FX read with a USD base');
          },
          depositRate: reader(deposit),
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.core.conversions).toBeUndefined();
      });

      it(`seed ${seed}, ${execution}: a USD-only strategy, FX with holes (null base points)`, () => {
        const strategy = strategyFor(execution, { cashBase: false });
        const r = both(strategy, bars, {
          baseCurrency: 'JPY',
          fxRate: reader(holed(fx, seed + 1, [0, -1, Number.NaN, Number.POSITIVE_INFINITY])),
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
          seen.nullPoints += r.core.base!.unknownFx.length;
          seen.invalidPoints += r.core.base!.invalidFx.length;
          // The USD curve never reads FX: equal to a run without a base currency.
          const plain = backtest({
            strategy,
            days: evaluate(strategy, bars),
            bars,
            cashRate: (date: string) => 1 + (Date.parse(date) % 7) / 10,
          });
          expect(r.core.points).toEqual(plain.points);
        }
      });

      it(`seed ${seed}, ${execution}: CASH_BASE with deposit holes: both refuse or both agree`, () => {
        const strategy = strategyFor(execution);
        const o = {
          baseCurrency: 'JPY',
          fxRate: reader(fx),
          depositRate: reader(holed(deposit, seed + 3, [Number.NaN, Number.POSITIVE_INFINITY])),
        };
        // Refused by both when a hole falls on a covered day CASH_BASE is held; otherwise both
        // run and are compared like any case.
        if (!both(strategy, bars, o).ok) seen.refusedBoth++;
      });

      it(`seed ${seed}, ${execution}: CASH_BASE with FX holes: core values the other sessions`, () => {
        // Contract round 2 (docs/indicators.md "Base-currency cash"): a session without a usable
        // FX has no value; later sessions with one are valued; a trade with CASH_BASE on such a
        // session leaves every later point unknown. Core and reference are compared on it.
        const strategy = strategyFor(execution);
        const o = {
          baseCurrency: 'JPY',
          fxRate: reader(holed(fx, seed + 2, [0, -1, Number.NaN])),
          depositRate: reader(deposit),
        };
        const cashRate = (date: string) => 1 + (Date.parse(date) % 7) / 10;
        const days = evaluate(strategy, bars);
        const core = backtest({ strategy, days, bars, cashRate, ...o });
        const ref = refBacktest(strategy, refEvaluate(strategy, bars), bars, cashRate, o);
        compare(core, ref);
        for (const p of core.points) {
          if (p.equity === null) {
            expect(p.unknown!.reason).toMatch(/FX rate \(USDJPY\)/);
            seen.nullPoints++;
            if (p.unknown!.date !== p.date) seen.lostAfterConversion++;
          }
        }
      });
    }
  }

  it('an omitted FX spread: both refuse, or both read 0 when told omitted costs are 0', () => {
    const bars = market(24);
    const { fx, deposit } = rates(24);
    const strategy = strategyFor('next_open', { spread: false });
    const o = { baseCurrency: 'JPY', fxRate: reader(fx), depositRate: reader(deposit) };
    expect(both(strategy, bars, o).ok).toBe(false);
    const zero = both(strategy, bars, { ...o, omittedCostsAsZero: true });
    expect(zero.ok).toBe(true);
    if (zero.ok) {
      expect(zero.core.conversions!.count).toBeGreaterThan(0);
      expect(zero.core.conversions!.fxSpreadCosts).toBe(0);
    }
    // With a USD base nothing converts, so the omitted spread is never read.
    expect(both(strategy, bars, { baseCurrency: 'USD', depositRate: reader(deposit) }).ok).toBe(
      true,
    );
  });

  it('whole shares: the base value agrees (FX with holes); CASH_BASE is refused by both', () => {
    for (const execution of ['next_open', 'next_close', 'same_close']) {
      const bars = market(26);
      const { fx, deposit } = rates(26);
      const wholeShares = { initialAmount: '25000', currency: 'USD' };
      const r = both(strategyFor(execution, { cashBase: false }), bars, {
        wholeShares,
        baseCurrency: 'JPY',
        fxRate: reader(holed(fx, 27, [0, Number.NaN])),
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.core.base!.points.some((p) => p.value === null)).toBe(true);
      const refused = both(strategyFor(execution), bars, {
        wholeShares,
        baseCurrency: 'JPY',
        fxRate: reader(fx),
        depositRate: reader(deposit),
      });
      expect(refused.ok).toBe(false);
    }
  });

  it('CASH_BASE without a base currency, or with a code that is not ISO: both refuse', () => {
    const bars = market(25);
    const { fx, deposit } = rates(25);
    const strategy = strategyFor('next_open');
    expect(both(strategy, bars, { fxRate: reader(fx), depositRate: reader(deposit) }).ok).toBe(
      false,
    );
    expect(
      both(strategy, bars, {
        baseCurrency: 'jpy',
        fxRate: reader(fx),
        depositRate: reader(deposit),
      }).ok,
    ).toBe(false);
  });

  it('the cases cover conversions, CASH_BASE over gaps and in the safe state, null points, refusals', () => {
    expect(seen.conversions).toBeGreaterThan(10);
    expect(seen.heldOverGap).toBeGreaterThan(0);
    expect(seen.safeStateWithBase).toBeGreaterThan(0);
    expect(seen.nullPoints).toBeGreaterThan(0);
    expect(seen.invalidPoints).toBeGreaterThan(0);
    expect(seen.refusedBoth).toBeGreaterThan(4);
    expect(seen.lostAfterConversion).toBeGreaterThan(0);
  });
});
