// The strategy definition (requirements 05, YAML), validated by zod. A2 covers what the owner's
// Setup 1 needs: price, SMA and volatility operands, compare and ensemble signals with tolerance
// bands, an allocation chain with fixed-weight holdings, and the safe state. B1 adds the other v1
// indicators of requirements 06 (EMA, N-day return, range-based volatility methods, drawdown,
// N-day high and low) and the derived signals not, and, or. Other parts of 05 join as later
// stages need them.
//
// Every object is strict: an unknown key (a typo such as `tolerencePct`) is refused, never
// dropped, since a registered version must be exactly what its file says (requirements 05,
// registered versions are immutable; spec 2026-11-01 yaml-strategies). Registration stores the
// parsed output, so stored versions carry only known keys and re-parse unchanged.
import { z } from 'zod';
import { tickerProblem } from './ticker';

/**
 * A ticker in the one grammar (`./ticker`, docs/indicators.md "Synthetic leverage"): `BASE` or
 * `BASE?L=3&E=0.9`. A malformed one (`X?L=`, `X?L=0x3`, `X?L=1e1`, `X?L=%33`, `X?L=2&L=3`,
 * `CASH_USD?L=2`, ...) is refused at parse with its path and the reason, never read loosely.
 */
const ticker = z.string().superRefine((t, ctx) => {
  const problem = tickerProblem(t);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

/**
 * An indicator operand's ticker: well-formed and without parameters. An indicator reads the
 * ticker's own bars by its plain name, so `SPY?L=3` would read bars no ticker has (never a value);
 * L and E apply to holdings only (docs/indicators.md "Synthetic leverage"). Refused at parse.
 */
const operandTicker = ticker.superRefine((t, ctx) => {
  if (tickerProblem(t) === undefined && t.includes('?')) {
    ctx.addIssue({
      code: 'custom',
      message:
        `"${t}": an indicator reads the plain ticker's bars; parameters (L, E) apply to ` +
        `holdings only. Use "${t.slice(0, t.indexOf('?'))}"`,
    });
  }
});

/** Range-based and close-based volatility methods (docs/indicators.md, B1); `close` when omitted. */
export const VOLATILITY_METHODS = ['close', 'parkinson', 'garman_klass', 'yang_zhang'] as const;
/** Methods that need two days in a window (a sample variance): length >= 2. */
const TWO_DAY_METHODS: readonly string[] = ['close', 'yang_zhang'];

const length = z.number().int().min(1);
const totalReturn = z.boolean().default(false);

export const IndicatorOperand = z.discriminatedUnion('indicator', [
  z.strictObject({ indicator: z.literal('price'), ticker: operandTicker, totalReturn }),
  z.strictObject({ indicator: z.literal('sma'), ticker: operandTicker, length, totalReturn }),
  z.strictObject({ indicator: z.literal('ema'), ticker: operandTicker, length, totalReturn }),
  z.strictObject({ indicator: z.literal('return'), ticker: operandTicker, length, totalReturn }),
  z
    .strictObject({
      indicator: z.literal('volatility'),
      ticker: operandTicker,
      length,
      // Optional without a default: a version stored before methods existed re-parses to itself
      // (registration stores the parsed output).
      method: z.enum(VOLATILITY_METHODS).optional(),
      totalReturn,
    })
    .refine((o) => o.length >= 2 || !TWO_DAY_METHODS.includes(o.method ?? 'close'), {
      message: 'this volatility method needs a length of at least 2 (a sample variance)',
      path: ['length'],
    }),
  /** Without `length`: from the all-time high (since the series' first value). */
  z.strictObject({
    indicator: z.literal('drawdown'),
    ticker: operandTicker,
    length: length.optional(),
    totalReturn,
  }),
  z.strictObject({ indicator: z.literal('high'), ticker: operandTicker, length, totalReturn }),
  z.strictObject({ indicator: z.literal('low'), ticker: operandTicker, length, totalReturn }),
]);
export const Operand = z.union([IndicatorOperand, z.strictObject({ threshold: z.number() })]);

const comparison = {
  left: Operand,
  op: z.enum(['>', '<']),
  right: Operand,
  tolerancePct: z.number().min(0).default(0),
};
export const Comparison = z.strictObject(comparison);

/** Indicators whose value is a price level (rescaled by a split), not a percentage. */
export const PRICE_LEVELS: readonly string[] = ['price', 'sma', 'ema', 'high', 'low'];
/** Indicators whose value is a percentage (not rescaled by a split). */
export const PERCENTAGES: readonly string[] = ['return', 'volatility', 'drawdown'];

const plainLevel = (o: Operand) =>
  'indicator' in o && PRICE_LEVELS.includes(o.indicator) && !o.totalReturn;

/**
 * A plain price level (`totalReturn: false`: price, SMA, EMA, N-day high or low) compared with a
 * fixed level (decisions log 2026-11-01, C18 (a); docs/indicators.md B1 "Fixed levels"): a split
 * rescales every earlier plain price, so the same level means something else before and after one
 * (a 2:1 split halves the price and the comparison flips with nothing having happened). Refused.
 * A fund compared with its own average is scale-free; return, volatility and drawdown are
 * percentages, so they may be compared with a level. A total-return series against a level is
 * not rescaled by a split but depends on where the stored history starts (open decision C26), so
 * the message does not suggest it.
 */
export function plainPriceAgainstLevel(c: { left: Operand; right: Operand }): boolean {
  const level = (o: Operand) => 'threshold' in o;
  return (plainLevel(c.left) && level(c.right)) || (level(c.left) && plainLevel(c.right));
}

/**
 * A plain price level compared with a percentage operand (return, volatility, drawdown): the
 * same flaw as a fixed level (C18 (a), B1 review): a split rescales the plain price and not the
 * percentage, so the comparison flips with nothing having happened (and the two are not in the
 * same unit). Refused like a fixed level.
 */
export function plainPriceAgainstPercentage(c: { left: Operand; right: Operand }): boolean {
  const pct = (o: Operand) => 'indicator' in o && PERCENTAGES.includes(o.indicator);
  return (plainLevel(c.left) && pct(c.right)) || (pct(c.left) && plainLevel(c.right));
}

export const PLAIN_PRICE_AGAINST_LEVEL =
  'a plain price, average, high or low (totalReturn: false) is compared with a fixed level: a ' +
  'split rescales earlier plain prices, so the level would mean something else after one. ' +
  'Compare the fund with its own average, or use a percentage (return, volatility or drawdown) ' +
  'against the level, instead';

export const PLAIN_PRICE_AGAINST_PERCENTAGE =
  'a plain price, average, high or low (totalReturn: false) is compared with a percentage ' +
  '(return, volatility or drawdown): a split rescales earlier plain prices but not the ' +
  'percentage, so the comparison would change after one. Compare price levels with price ' +
  'levels, and percentages with percentages or a fixed level, instead';

const signalId = z.string().min(1);

/**
 * Derived (`not`) and aggregate (`and`, `or`) signals (requirements 05 "Signals"; contract in
 * docs/indicators.md "Signals"): they read other signals' states on the same date and keep no
 * state of their own. `and` and `or` name at least 2 different signals (a repeated id would make
 * fewer than 2, most likely a typo; refused like a ticker listed twice in holdings).
 */
const distinctIds = z
  .array(signalId)
  .min(2)
  .superRefine((ids, ctx) => {
    for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) {
      ctx.addIssue({
        code: 'custom',
        message: `"${id}" is named twice; name each signal once (at least 2 different ones)`,
      });
    }
  });

export const Signal = z.discriminatedUnion('type', [
  z.strictObject({ id: signalId, type: z.literal('compare'), ...comparison }),
  z.strictObject({
    id: signalId,
    type: z.literal('ensemble'),
    members: z.array(Comparison).min(1),
    /** True when at least this share of members is true. */
    threshold: z.number().gt(0).max(1),
  }),
  /** True when the named signal is false. */
  z.strictObject({ id: signalId, type: z.literal('not'), of: signalId }),
  /** True when every named signal is true. */
  z.strictObject({ id: signalId, type: z.literal('and'), of: distinctIds }),
  /** True when at least one named signal is true. */
  z.strictObject({ id: signalId, type: z.literal('or'), of: distinctIds }),
]);

type AnySignal = z.infer<typeof Signal>;
export type DerivedSignal = Extract<AnySignal, { type: 'not' | 'and' | 'or' }>;

export const isDerived = (s: AnySignal): s is DerivedSignal =>
  s.type === 'not' || s.type === 'and' || s.type === 'or';

/**
 * The comparisons a signal evaluates itself: a compare signal its own, an ensemble its members,
 * a derived signal none (it reads other signals' states, whose comparisons are listed there).
 * Every walk over operands (tickers, lookbacks, refusals) goes through this.
 */
export function comparisonsOf(s: AnySignal): z.infer<typeof Comparison>[] {
  if (s.type === 'compare') return [s];
  if (s.type === 'ensemble') return s.members;
  return [];
}

/** The signal ids a derived signal reads (none for compare and ensemble signals). */
export const inputsOf = (s: AnySignal): string[] =>
  s.type === 'not' ? [s.of] : isDerived(s) ? s.of : [];

/**
 * The derived signals in an order where each comes after every derived signal it reads, file
 * order otherwise (the order in the file does not matter, docs/indicators.md "Signals"); compare
 * and ensemble signals read none, so they can all go first. Throws on an unknown id, a cycle or a
 * reference to itself, which the schema refuses (a parsed strategy has none of them).
 */
export function derivedOrder(signals: AnySignal[]): DerivedSignal[] {
  const derived = signals.filter(isDerived);
  const derivedIds = new Set(derived.map((s) => s.id));
  const allIds = new Set(signals.map((s) => s.id));
  for (const s of derived) {
    for (const id of inputsOf(s)) {
      if (!allIds.has(id)) throw new Error(`Signal "${s.id}" reads an unknown signal "${id}".`);
    }
  }
  const placed = new Set<string>();
  const out: DerivedSignal[] = [];
  while (out.length < derived.length) {
    const next = derived.find(
      (s) => !placed.has(s.id) && inputsOf(s).every((id) => !derivedIds.has(id) || placed.has(id)),
    );
    if (!next) throw new Error('Derived signals read each other in a cycle.');
    placed.add(next.id);
    out.push(next);
  }
  return out;
}

/**
 * Each cycle among derived signals once (a reference to itself excluded: it has its own
 * message), as the ids along it starting from the one first in the file; ids that are not
 * derived signals (unknown, compare, ensemble) end a path.
 */
function cyclesOf(signals: AnySignal[]): string[][] {
  const reads = new Map(
    signals.filter(isDerived).map((s) => [s.id, inputsOf(s).filter((x) => x !== s.id)]),
  );
  const order = [...reads.keys()];
  const done = new Set<string>();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (id: string, path: string[]) => {
    const at = path.indexOf(id);
    if (at >= 0) {
      const ring = path.slice(at);
      // Rotate to start from the id first in the file, so a cycle is reported once.
      const first = ring.reduce((a, b) => (order.indexOf(b) < order.indexOf(a) ? b : a));
      const k = ring.indexOf(first);
      const rotated = [...ring.slice(k), ...ring.slice(0, k)];
      const key = rotated.join('\u0000');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(rotated);
      }
      return;
    }
    if (done.has(id) || !reads.has(id)) return;
    for (const next of reads.get(id)!) visit(next, [...path, id]);
    done.add(id);
  };
  for (const id of order) visit(id, []);
  return cycles;
}

export const Holding = z.strictObject({ ticker, weight: z.number().gt(0).max(100) });
const holdings = z
  .array(Holding)
  .min(1)
  .refine((hs) => Math.abs(hs.reduce((s, h) => s + h.weight, 0) - 100) < 1e-9, {
    message: 'weights must add up to 100',
  })
  // A ticker listed twice would trade only one of its weights (the trade keeps one per ticker).
  .superRefine((hs, ctx) => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const h of hs) {
      if (seen.has(h.ticker)) repeated.add(h.ticker);
      seen.add(h.ticker);
    }
    for (const t of repeated) {
      ctx.addIssue({
        code: 'custom',
        message: `"${t}" is listed twice; list each ticker once with its total weight`,
      });
    }
  });

export const Condition = z
  .strictObject({
    all: z.array(z.string()).optional(),
    any: z.array(z.string()).optional(),
    none: z.array(z.string()).optional(),
  })
  .refine((c) => (c.all?.length ?? 0) + (c.any?.length ?? 0) + (c.none?.length ?? 0) > 0, {
    message: 'a condition names at least one signal',
  });

export const Allocation = z.strictObject({
  name: z.string().min(1),
  when: Condition.optional(),
  holdings,
});

export const Strategy = z
  .strictObject({
    name: z.string().min(1),
    account: z.string().min(1),
    execution: z.enum(['next_open', 'next_close', 'same_close']).default('next_open'),
    safeState: z.strictObject({ holdings }),
    evaluation: z.strictObject({ frequency: z.enum(['daily', 'weekly', 'monthly']) }),
    costs: z
      .strictObject({
        slippageBps: z.number().min(0),
        feePct: z.number().min(0),
        fxSpreadPct: z.number().min(0),
      })
      .partial()
      .default({}),
    signals: z.array(Signal).default([]),
    allocations: z.array(Allocation).min(1),
  })
  .superRefine((s, ctx) => {
    const ids = s.signals.map((x) => x.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'signal ids must be unique', path: ['signals'] });
    }
    s.signals.forEach((x, i) => {
      const comparisons =
        x.type === 'compare'
          ? [{ c: x, path: ['signals', i] }]
          : comparisonsOf(x).map((c, j) => ({ c, path: ['signals', i, 'members', j] }));
      for (const { c, path } of comparisons) {
        if (plainPriceAgainstLevel(c)) {
          ctx.addIssue({ code: 'custom', message: PLAIN_PRICE_AGAINST_LEVEL, path });
        }
        if (plainPriceAgainstPercentage(c)) {
          ctx.addIssue({ code: 'custom', message: PLAIN_PRICE_AGAINST_PERCENTAGE, path });
        }
      }
    });
    // Derived signals: every id they read exists, is not their own, and they form no cycle.
    s.signals.forEach((x, i) => {
      for (const id of new Set(inputsOf(x))) {
        const path = ['signals', i, 'of'];
        if (id === x.id) {
          ctx.addIssue({ code: 'custom', message: `signal "${id}" reads itself`, path });
        } else if (!ids.includes(id)) {
          ctx.addIssue({ code: 'custom', message: `unknown signal "${id}"`, path });
        }
      }
    });
    for (const ring of cyclesOf(s.signals)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'signals read each other in a cycle (' +
          [...ring, ring[0]!].map((id) => `"${id}"`).join(' -> ') +
          '), so none of them has a value; break the cycle',
        path: ['signals', s.signals.findIndex((x) => isDerived(x) && x.id === ring[0]), 'of'],
      });
    }
    s.allocations.forEach((a, i) => {
      const last = i === s.allocations.length - 1;
      if (last && a.when) {
        ctx.addIssue({
          code: 'custom',
          message: 'the last allocation is the unconditional fallback (no `when`)',
          path: ['allocations', i, 'when'],
        });
      }
      if (!last && !a.when) {
        ctx.addIssue({
          code: 'custom',
          message: 'only the last allocation may have no `when`',
          path: ['allocations', i],
        });
      }
      for (const id of [...(a.when?.all ?? []), ...(a.when?.any ?? []), ...(a.when?.none ?? [])]) {
        if (!ids.includes(id)) {
          ctx.addIssue({
            code: 'custom',
            message: `unknown signal "${id}"`,
            path: ['allocations', i, 'when'],
          });
        }
      }
    });
  });

export type IndicatorOperand = z.infer<typeof IndicatorOperand>;
export type Operand = z.infer<typeof Operand>;
export type Comparison = z.infer<typeof Comparison>;
export type Signal = z.infer<typeof Signal>;
export type Holding = z.infer<typeof Holding>;
export type Condition = z.infer<typeof Condition>;
export type Allocation = z.infer<typeof Allocation>;
export type Strategy = z.infer<typeof Strategy>;
