// Whole shares (docs/indicators.md "Equity curves", "Whole shares"): core against the independent
// reference (requirements 04 layer E, 13) on seeded random cases. Bars as traded in cents with
// forward and reverse splits and dividends, missing bars (dates that are no session), days
// without a decision (safe state), cash rates, all three execution modes, costs, allocations with
// CASH_USD weights, and decimal initial amounts (cents, tiny, large, and amounts at a whole-share
// boundary of the first trade). Per trade: share counts and zero-share lists exactly; V within
// 1e-9 relative; residual and costs within 1e-9 relative or 1e-9 x V absolute. Per point: value
// and equity within 1e-9 relative, weights within 1e-9. Refused inputs: both throw, each for the
// contract's reason. Where they disagree, find the root cause against the contract; never copy
// one into the other.
import { type RefBacktestResult, refBacktest } from '@saku/reference';
import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import { type BacktestInput, type BacktestResult, backtest } from './backtest';
import type { StrategyDay } from './engine';
import type { Holding } from './schema';

const TOL = 1e-9;

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
type Rnd = () => number;
const pick = <T>(rnd: Rnd, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
const int = (rnd: Rnd, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
/** A price as quoted: whole cents, at least one cent. */
const cents = (x: number) => Math.max(1, Math.round(x * 100)) / 100;
/** Integer cents as plain decimal text ("1234.05"). */
const centsText = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

const TICKERS = ['A', 'B', 'C'] as const;
const NON_CASH = new Set<string>(TICKERS);
/** Forward (2, 3, 3:2, 4) and reverse (1:2, 1:4, 1:10, 1:3, 1:5) splits. */
const SPLITS = [2, 3, 1.5, 4, 0.5, 0.25, 0.1, 1 / 3, 0.2];
const EXECUTIONS = ['next_open', 'next_close', 'same_close'] as const;
type Execution = (typeof EXECUTIONS)[number];

interface Case {
  execution: Execution;
  strategy: BacktestInput['strategy'];
  days: StrategyDay[];
  bars: Record<string, RawBar[]>;
  rates: Map<string, number | undefined>;
  amount: string;
  /** The amount's kind, for the coverage counts. */
  kind: 'cents' | 'tiny' | 'large' | 'boundary';
  /** For a boundary amount: the ticker and the share count the first trade sits at. */
  boundary?: { ticker: string; k: number; delta: number };
}

/** Bars as traded (not split-adjusted), in cents; C misses a few dates (no session there). */
function makeBars(rnd: Rnd, dates: string[]): Record<string, RawBar[]> {
  const out: Record<string, RawBar[]> = {};
  for (const t of TICKERS) {
    let close = cents(pick(rnd, [0.87, 3.17, 12.5, 48, 150, 420, 2500]) * (0.5 + rnd()));
    const list: RawBar[] = [];
    dates.forEach((date, i) => {
      // The first two dates always have every bar: the first trade's price is known.
      if (t === 'C' && i >= 2 && rnd() < 0.04) return;
      const split = i > 0 && rnd() < 0.05 ? pick(rnd, SPLITS) : 1;
      const open = cents((close / split) * (1 + (rnd() - 0.5) * 0.04));
      close = cents(open * (1 + (rnd() - 0.5) * 0.06));
      const divCash = i > 0 && rnd() < 0.06 ? Math.round(close * 100 * rnd()) / 10_000 : 0;
      list.push({ date, open, close, closeIsSplitAdjusted: false, divCash, splitFactor: split });
    });
    out[t] = list;
  }
  return out;
}

/** 1 to 3 holdings over A, B, C and CASH_USD, distinct, weights summing to 100. */
function makeHoldings(rnd: Rnd): Holding[] {
  const pool = ['A', 'B', 'C', 'CASH_USD'];
  const n = int(rnd, 1, 3);
  const tickers: string[] = [];
  while (tickers.length < n) {
    const t = pick(rnd, pool);
    if (!tickers.includes(t)) tickers.push(t);
  }
  if (n === 1) return [{ ticker: tickers[0]!, weight: 100 }];
  const decimal = rnd() < 0.3;
  const weights: number[] = [];
  let left = decimal ? 1000 : 100;
  for (let i = 0; i < n - 1; i++) {
    const w = int(rnd, 1, left - (n - 1 - i));
    weights.push(w);
    left -= w;
  }
  weights.push(left);
  return tickers.map((ticker, i) => ({
    ticker,
    weight: decimal ? weights[i]! / 10 : weights[i]!,
  }));
}

function makeCase(seed: number, execution: Execution): Case {
  const rnd = random(seed);
  const n = int(rnd, 30, 70);
  const start = Date.UTC(2025, 0, 2);
  const dates = Array.from({ length: n }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  const bars = makeBars(rnd, dates);
  const allocations = Array.from({ length: int(rnd, 2, 5) }, (_, i) => ({
    name: `a${i}`,
    holdings: makeHoldings(rnd),
  }));
  // At least one ticker that is not cash, so the sessions need bars.
  if (allocations.every((a) => a.holdings.every((h) => h.ticker === 'CASH_USD'))) {
    allocations.push({ name: 'x', holdings: [{ ticker: 'A', weight: 100 }] });
  }
  const safeState = {
    holdings: rnd() < 0.5 ? [{ ticker: 'CASH_USD', weight: 100 }] : pick(rnd, allocations).holdings,
  };
  const everyBar = new Set(
    dates.filter((d) => TICKERS.every((t) => bars[t]!.some((b) => b.date === d))),
  );
  let current = int(rnd, 0, allocations.length - 1);
  const days: StrategyDay[] = [];
  dates.forEach((date, i) => {
    if (!everyBar.has(date)) return;
    if (rnd() < 0.2) current = int(rnd, 0, allocations.length - 1);
    // A date without a decision (after the first): the safe state is traded.
    if (i > 0 && rnd() < 0.08) return;
    const a = allocations[current]!;
    days.push({ date, signals: {}, allocation: a.name, holdings: a.holdings, ties: [] });
  });
  const costs = {
    slippageBps: pick(rnd, [0, 0, 2, 5, 10, 50]),
    feePct: pick(rnd, [0, 0, 0.05, 0.1, 1]),
  };
  const rates = new Map<string, number | undefined>(
    dates.map((d) => [d, pick(rnd, [0, 0.5, 2.5, 5.25, rnd() * 6])]),
  );

  // The initial amount: cents, tiny (0 shares), large, or at a whole-share boundary of the first
  // trade (on dates[0] with same_close, dates[1] otherwise; every ticker has bars on both).
  const r = rnd();
  let kind: Case['kind'] = 'cents';
  let amount: string;
  let boundary: Case['boundary'];
  const first = days[0]!.holdings.find((h) => h.ticker !== 'CASH_USD');
  if (r < 0.35 && first) {
    kind = 'boundary';
    const tradeDate = execution === 'same_close' ? dates[0]! : dates[1]!;
    const bar = bars[first.ticker]!.find((b) => b.date === tradeDate)!;
    const p = execution === 'next_open' ? bar.open! : bar.close;
    const c = costs.slippageBps / 10_000 + costs.feePct / 100;
    const k = int(rnd, 1, 60);
    const delta = pick(rnd, [-1, 0, 0, 1]);
    // V at which x = (weight x V) / (100 x p x (1 + c)) is exactly k, to the cent, +- a cent.
    const at = Math.round(((k * 100 * p * (1 + c)) / first.weight) * 100) + delta;
    amount = centsText(Math.max(1, at));
    boundary = { ticker: first.ticker, k, delta };
  } else if (r < 0.45) {
    kind = 'tiny';
    amount = pick(rnd, ['0.01', '0.5', '1', '3.07', '0.001']);
  } else if (r < 0.55) {
    kind = 'large';
    amount = pick(rnd, ['10000000', '123456789.12', '2500000.5']);
  } else {
    // Log-uniform from 1 USD to 1,000,000 USD, as cents, one decimal, whole, or zero-padded.
    const c = Math.round(10 ** (2 + rnd() * 6));
    const form = rnd();
    amount =
      form < 0.6
        ? centsText(c)
        : form < 0.75
          ? `${Math.floor(c / 100)}.${Math.floor((c % 100) / 10)}`
          : form < 0.9
            ? String(Math.max(1, Math.floor(c / 100)))
            : `00${centsText(c)}`;
  }
  return {
    execution,
    strategy: { execution, costs, allocations, safeState },
    days,
    bars,
    rates,
    amount,
    kind,
    ...(boundary && { boundary }),
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };
function attempt<T>(f: () => T): Outcome<T> {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

const runCore = (c: Case, currency = 'USD') =>
  attempt(() =>
    backtest({
      strategy: c.strategy,
      days: c.days,
      bars: c.bars,
      cashRate: (d) => c.rates.get(d),
      wholeShares: { initialAmount: c.amount, currency },
    }),
  );
const runRef = (c: Case, currency = 'USD') =>
  attempt(() =>
    refBacktest(
      c.strategy as Parameters<typeof refBacktest>[0],
      c.days,
      c.bars,
      // The reference reads an unknown rate as not finite (and refuses it where it is needed).
      (d) => c.rates.get(d) ?? Number.NaN,
      { wholeShares: { initialAmount: c.amount, currency } },
    ),
  );

/** Within 1e-9 relative, or 1e-9 x scale absolute. */
const near = (a: number, b: number, scale: number) =>
  Math.abs(a - b) <= TOL * Math.max(Math.abs(b), scale);

function expectSame(label: string, a: BacktestResult, b: RefBacktestResult) {
  expect(
    a.points.map((p) => p.date),
    label,
  ).toEqual(b.dates);
  expect(a.switches, `${label} switches`).toBe(b.switches);
  expect(near(a.costs, b.costs!, 1), `${label} costs ${a.costs} vs ${b.costs}`).toBe(true);

  const ta = a.wholeShares!.trades;
  const tb = b.trades!;
  expect(ta.length, `${label} trades`).toBe(tb.length);
  ta.forEach((x, i) => {
    const y = tb[i]!;
    const at = `${label} trade ${i} on ${x.date}`;
    expect([x.date, x.at], at).toEqual([y.date, y.time]);
    expect(x.shares, `${at} shares`).toEqual(y.shares);
    expect(x.zeroShares, `${at} zero shares`).toEqual(y.zeroShares);
    const V = y.V.amount;
    expect(near(x.value.amount, V, 0), `${at} V ${x.value.amount} vs ${V}`).toBe(true);
    expect(
      near(x.residualCash.amount, y.residual.amount, V),
      `${at} residual ${x.residualCash.amount} vs ${y.residual.amount}`,
    ).toBe(true);
    expect(
      near(x.costs.amount, y.costs.amount, V),
      `${at} costs ${x.costs.amount} vs ${y.costs.amount}`,
    ).toBe(true);
    expect(x.residualCash.amount, `${at} residual >= 0`).toBeGreaterThanOrEqual(0);
    for (const m of [x.value, x.residualCash, x.costs]) expect(m.currency).toBe('USD');
  });

  a.points.forEach((p, i) => {
    const at = `${label} point ${p.date}`;
    const v = b.value![i]!.amount;
    expect(p.value?.currency, at).toBe('USD');
    expect(
      Math.abs(p.value!.amount / v - 1),
      `${at} value ${p.value!.amount} vs ${v}`,
    ).toBeLessThanOrEqual(TOL);
    expect(Math.abs(p.equity / b.equity[i]! - 1), `${at} equity`).toBeLessThanOrEqual(TOL);
    const w = b.weights![i]!;
    for (const t of new Set([...Object.keys(p.weights), ...Object.keys(w)])) {
      expect(Math.abs((p.weights[t] ?? 0) - (w[t] ?? 0)), `${at} weight ${t}`).toBeLessThanOrEqual(
        TOL,
      );
    }
  });
}

/** Both refuse, each with the contract's reason (so neither fails on something unrelated). */
function expectBothRefuse(label: string, c: Case, core: RegExp, ref: RegExp, currency?: string) {
  const a = runCore(c, currency);
  const b = runRef(c, currency);
  expect(a.ok, `${label}: core ran`).toBe(false);
  expect(b.ok, `${label}: reference ran`).toBe(false);
  if (!a.ok) expect(a.error.message, label).toMatch(core);
  if (!b.ok) expect(b.error.message, label).toMatch(ref);
}

const SEEDS = Array.from({ length: 110 }, (_, i) => 20_261_102 + i * 7919);

describe('whole shares: core vs reference on seeded random cases', () => {
  for (const execution of EXECUTIONS) {
    it(`agree per trade and per point, ${execution} (${SEEDS.length} seeds)`, () => {
      const seen = {
        trades: 0,
        zeroShareTrades: 0,
        cashTargets: 0,
        safeStateDays: 0,
        heldThroughSplit: 0,
        heldThroughReverseSplit: 0,
        heldThroughDividend: 0,
        heldToZero: 0,
        tradesOnExDates: 0,
        boundary: { below: 0, at: 0, above: 0 },
        kinds: new Map<string, number>(),
      };
      for (const seed of SEEDS) {
        const c = makeCase(seed, execution);
        const label = `seed ${seed} ${execution} amount ${c.amount}`;
        const a = runCore(c);
        const b = runRef(c);
        if (!a.ok) throw new Error(`${label}: core refused a valid case: ${a.error.message}`);
        if (!b.ok) throw new Error(`${label}: reference refused a valid case: ${b.error.message}`);
        expectSame(label, a.value, b.value);

        // Coverage (checked below, so the cases are not vacuous).
        seen.kinds.set(c.kind, (seen.kinds.get(c.kind) ?? 0) + 1);
        const trades = a.value.wholeShares!.trades;
        seen.trades += trades.length;
        seen.zeroShareTrades += trades.filter((t) => t.zeroShares.length > 0).length;
        seen.safeStateDays += a.value.points.filter((p) => !p.decided).length;
        if (c.boundary && trades[0]) {
          const n = trades[0].shares[c.boundary.ticker]!;
          if (n === c.boundary.k) seen.boundary.at++;
          else if (n < c.boundary.k) seen.boundary.below++;
          else seen.boundary.above++;
          // A cent above the boundary, the count is at least k (the floor never loses a share).
          if (c.boundary.delta === 1) expect(n, label).toBeGreaterThanOrEqual(c.boundary.k);
        }
        const barOn = (t: string, d: string) => c.bars[t]!.find((x) => x.date === d)!;
        trades.forEach((t, i) => {
          if (c.days.find((d) => d.date === t.date)?.holdings.some((h) => h.ticker === 'CASH_USD'))
            seen.cashTargets++;
          const before = i > 0 ? trades[i - 1]!.shares : {};
          if (
            Object.entries(before).some(([k, n]) => {
              const x = barOn(k, t.date);
              return n > 0 && (x.splitFactor !== 1 || x.divCash > 0);
            })
          )
            seen.tradesOnExDates++;
        });
        // Holdings carried through events between trades.
        const pointByDate = new Map(a.value.points.map((p) => [p.date, p]));
        for (let i = 0; i < trades.length; i++) {
          const from = trades[i]!.date;
          const to = trades[i + 1]?.date ?? '9999-12-31';
          for (const [k, n] of Object.entries(trades[i]!.shares)) {
            if (n === 0) continue;
            for (const x of c.bars[k]!) {
              if (x.date <= from || x.date >= to || !pointByDate.has(x.date)) continue;
              if (x.splitFactor > 1) seen.heldThroughSplit++;
              if (x.splitFactor < 1) seen.heldThroughReverseSplit++;
              if (x.divCash > 0) seen.heldThroughDividend++;
              if (x.splitFactor < 1 && pointByDate.get(x.date)!.weights[k] === undefined)
                seen.heldToZero++;
            }
          }
        }
      }
      expect(seen.trades).toBeGreaterThan(SEEDS.length * 3);
      expect(seen.zeroShareTrades).toBeGreaterThan(0);
      expect(seen.cashTargets).toBeGreaterThan(0);
      expect(seen.safeStateDays).toBeGreaterThan(0);
      expect(seen.heldThroughSplit).toBeGreaterThan(0);
      expect(seen.heldThroughReverseSplit).toBeGreaterThan(0);
      expect(seen.heldThroughDividend).toBeGreaterThan(0);
      expect(seen.heldToZero).toBeGreaterThan(0);
      expect(seen.tradesOnExDates).toBeGreaterThan(0);
      expect(seen.boundary.at).toBeGreaterThan(0);
      expect(seen.boundary.below).toBeGreaterThan(0);
      for (const k of ['cents', 'tiny', 'large', 'boundary']) {
        expect(seen.kinds.get(k) ?? 0, k).toBeGreaterThan(0);
      }
    });
  }
});

// Amounts exactly at a whole-share boundary (no costs): k x 100 x p / weight in whole cents, so
// in exact decimals x = (weight x V) / (100 x p) is k. The float quotient can land a few ulps
// below k; the contract's snap (1e-12 relative) makes it k. One cent below, x is below k by far
// more than the snap: k - 1.
describe('whole shares: core vs reference at exact whole-share boundaries', () => {
  const PRICES = [1, 3, 7, 13, 29, 57, 99, 101, 123, 200, 333, 1001, 4999, 12345, 33333, 250001];
  const WEIGHTS = [1, 3, 7, 25, 33, 50, 58, 66, 99, 100, 12.5, 37.5];
  for (const execution of ['next_open', 'same_close'] as const) {
    it(`share counts are k at the boundary and k - 1 a cent below, ${execution}`, () => {
      let cases = 0;
      let noisy = 0;
      for (const pc of PRICES) {
        for (const weight of WEIGHTS) {
          for (let k = 1; k <= 40; k++) {
            // V in cents = k x 100 x p (cents) / weight, when that is a whole number of cents.
            const vc = (k * 100 * pc) / weight;
            if (!Number.isInteger(vc)) continue;
            const p = pc / 100;
            const x = (weight * (vc / 100)) / (100 * p); // the contract's order, c = 0
            if (x !== k) noisy++;
            for (const delta of [0, -1]) {
              if (vc + delta < 1) continue;
              cases++;
              const holdings: Holding[] =
                weight === 100
                  ? [{ ticker: 'X', weight }]
                  : [
                      { ticker: 'X', weight },
                      { ticker: 'CASH_USD', weight: 100 - weight },
                    ];
              const dates = ['2026-01-05', '2026-01-06'];
              const c: Case = {
                execution,
                strategy: { execution, costs: {} },
                days: dates.map((date) => ({
                  date,
                  signals: {},
                  allocation: 'x',
                  holdings,
                  ties: [],
                })),
                // The trade's price is p: the second open (next_open) or the first close.
                bars: {
                  X: dates.map((date) => ({
                    date,
                    open: p,
                    close: p,
                    closeIsSplitAdjusted: false,
                    divCash: 0,
                    splitFactor: 1,
                  })),
                },
                rates: new Map(dates.map((d) => [d, 1])),
                amount: centsText(vc + delta),
                kind: 'boundary',
              };
              const label = `p ${p} weight ${weight} k ${k} delta ${delta} ${execution}`;
              const a = runCore(c);
              const b = runRef(c);
              if (!a.ok) throw new Error(`${label}: core: ${a.error.message}`);
              if (!b.ok) throw new Error(`${label}: reference: ${b.error.message}`);
              expectSame(label, a.value, b.value);
              expect(a.value.wholeShares!.trades[0]!.shares.X, label).toBe(k + delta);
            }
          }
        }
      }
      expect(cases).toBeGreaterThan(1000);
      // The float quotient misses k on some of them: the snap is exercised, not assumed.
      expect(noisy).toBeGreaterThan(0);
    });
  }
});

/** A fault injected into a valid case: a copy of the bars with one bar changed. */
function withBar(c: Case, ticker: string, date: string, change: Partial<RawBar>): Case {
  return {
    ...c,
    bars: {
      ...c.bars,
      [ticker]: c.bars[ticker]!.map((b) => (b.date === date ? { ...b, ...change } : b)),
    },
  };
}

/** The clean run's trades, to place a fault where the contract refuses it. */
function cleanTrades(c: Case) {
  const a = runCore(c);
  if (!a.ok) throw new Error(a.error.message);
  return { trades: a.value.wholeShares!.trades, dates: a.value.points.map((p) => p.date) };
}

const REFUSAL_SEEDS = SEEDS.slice(0, 40);

describe('whole shares: core and reference refuse the same inputs', () => {
  it('an initial amount that is not plain decimal text above 0, or a currency other than USD', () => {
    const c = makeCase(SEEDS[0]!, 'next_open');
    for (const bad of [
      '0',
      '0.00',
      '000',
      '-5',
      '1e3',
      ' 100',
      '100 ',
      '1,000',
      '1000.',
      '.5',
      '',
      '+1',
      '0x10',
      'Infinity',
      'NaN',
    ]) {
      expectBothRefuse(
        `amount ${JSON.stringify(bad)}`,
        { ...c, amount: bad },
        /initial amount/,
        /initial amount/,
      );
    }
    for (const currency of ['EUR', 'JPY', 'usd', '']) {
      expectBothRefuse(`currency ${currency}`, c, /only USD/, /USD only/, currency);
    }
  });

  for (const execution of EXECUTIONS) {
    it(`faults placed at a trade or a held position, ${execution}`, () => {
      let missingOpens = 0;
      let unknownRates = 0;
      for (const seed of REFUSAL_SEEDS) {
        const c = makeCase(seed, execution);
        const { trades, dates } = cleanTrades(c);
        const label = `seed ${seed} ${execution}`;
        const rnd = random(seed ^ 0x5a5a);
        const trade = pick(rnd, trades);
        // The tickers priced at this trade: held before it or in its target (cash aside).
        const i = trades.indexOf(trade);
        const priced = [
          ...new Set([
            ...Object.entries(i > 0 ? trades[i - 1]!.shares : {})
              .filter(([, n]) => n > 0)
              .map(([t]) => t),
            ...Object.keys(trade.shares),
          ]),
        ].sort();
        if (priced.length > 0) {
          const t = pick(rnd, priced);
          // A price at or below 0 at the trade's execution time.
          const field = trade.at === 'open' ? 'open' : 'close';
          for (const p of [0, -1]) {
            expectBothRefuse(
              `${label} ${t} ${field} ${p} on ${trade.date}`,
              withBar(c, t, trade.date, { [field]: p }),
              /cannot be bought or sold/,
              /price .* at a trade/,
            );
          }
          // A missing open at a next_open trade.
          if (trade.at === 'open') {
            missingOpens++;
            expectBothRefuse(
              `${label} ${t} no open on ${trade.date}`,
              withBar(c, t, trade.date, { open: undefined }),
              /has no open/,
              /no open/,
            );
          }
        }
        // An unknown cash rate on the session after a trade that left cash above 0: read there.
        const after = dates[dates.indexOf(trade.date) + 1];
        if (after && trade.residualCash.amount > 0) {
          unknownRates++;
          const rates = new Map(c.rates);
          rates.set(after, undefined);
          expectBothRefuse(
            `${label} rate on ${after}`,
            { ...c, rates },
            /No cash rate/,
            /unknown cash rate/,
          );
        }
        // Up to the first trade nothing is invested: an unknown rate there is not read (the first
        // trade is at the close of the first session with same_close, in the second otherwise).
        const early = new Map(c.rates);
        for (const d of dates.slice(0, execution === 'same_close' ? 1 : 2)) early.set(d, undefined);
        const a = runCore({ ...c, rates: early });
        const b = runRef({ ...c, rates: early });
        expect(a.ok && b.ok, `${label} early unknown rate`).toBe(true);
        if (a.ok && b.ok) expectSame(`${label} early unknown rate`, a.value, b.value);

        // One split-adjusted bar of a ticker it may hold.
        const held = [...new Set(c.days.flatMap((d) => d.holdings.map((h) => h.ticker)))].filter(
          (t) => NON_CASH.has(t),
        );
        const t = pick(rnd, held);
        const d = pick(rnd, c.bars[t]!).date;
        expectBothRefuse(
          `${label} ${t} split-adjusted on ${d}`,
          withBar(c, t, d, { closeIsSplitAdjusted: true }),
          /split-adjusted/,
          /split-adjusted/,
        );

        // A synthetic ticker in a day's holdings, an allocation, or the safe state.
        const synth = (h: Holding[]) =>
          h.map((x, j) =>
            j === 0 && NON_CASH.has(x.ticker) ? { ...x, ticker: `${x.ticker}?L=1` } : x,
          );
        const lastDay = c.days.at(-1)!;
        const withDay = {
          ...c,
          days: [
            ...c.days.slice(0, -1),
            { ...lastDay, holdings: [{ ticker: 'A?E=0.5', weight: 100 }] },
          ],
        };
        expectBothRefuse(`${label} synthetic day`, withDay, /synthetic ticker/, /synthetic ticker/);
        const allocations = c.strategy.allocations!.map((x) => ({
          ...x,
          holdings: synth(x.holdings),
        }));
        if (allocations.some((x) => x.holdings.some((h) => h.ticker.includes('?')))) {
          expectBothRefuse(
            `${label} synthetic allocation`,
            { ...c, strategy: { ...c.strategy, allocations } },
            /synthetic ticker/,
            /synthetic ticker/,
          );
        }
        expectBothRefuse(
          `${label} synthetic safe state`,
          {
            ...c,
            strategy: {
              ...c.strategy,
              safeState: { holdings: [{ ticker: 'B?L=2', weight: 100 }] },
            },
          },
          /synthetic ticker/,
          /synthetic ticker/,
        );

        // The first decision (always traded) listing a ticker twice.
        const twice = [
          { ticker: 'A', weight: 50 },
          { ticker: 'A', weight: 50 },
        ];
        const dup = { ...c, days: c.days.map((x, j) => (j === 0 ? { ...x, holdings: twice } : x)) };
        expectBothRefuse(`${label} listed twice`, dup, /listed twice/, /twice/);
      }
      if (execution === 'next_open') expect(missingOpens).toBeGreaterThan(10);
      expect(unknownRates).toBeGreaterThan(10);
    });
  }
});
