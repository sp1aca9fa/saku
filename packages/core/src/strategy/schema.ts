// The strategy definition (requirements 05, YAML), validated by zod. A2 covers what the owner's
// Setup 1 needs: price, SMA and volatility operands, compare and ensemble signals with tolerance
// bands, an allocation chain with fixed-weight holdings, and the safe state. B1 adds the other v1
// indicators of requirements 06 (EMA, N-day return, range-based volatility methods, drawdown,
// N-day high and low). Other parts of 05 join as later stages need them.
//
// Every object is strict: an unknown key (a typo such as `tolerencePct`) is refused, never
// dropped, since a registered version must be exactly what its file says (requirements 05,
// registered versions are immutable; spec 2026-11-01 yaml-strategies). Registration stores the
// parsed output, so stored versions carry only known keys and re-parse unchanged.
import { z } from 'zod';

const ticker = z.string().min(1);

/** Range-based and close-based volatility methods (docs/indicators.md, B1); `close` when omitted. */
export const VOLATILITY_METHODS = ['close', 'parkinson', 'garman_klass', 'yang_zhang'] as const;
/** Methods that need two days in a window (a sample variance): length >= 2. */
const TWO_DAY_METHODS: readonly string[] = ['close', 'yang_zhang'];

const length = z.number().int().min(1);
const totalReturn = z.boolean().default(false);

export const IndicatorOperand = z.discriminatedUnion('indicator', [
  z.strictObject({ indicator: z.literal('price'), ticker, totalReturn }),
  z.strictObject({ indicator: z.literal('sma'), ticker, length, totalReturn }),
  z.strictObject({ indicator: z.literal('ema'), ticker, length, totalReturn }),
  z.strictObject({ indicator: z.literal('return'), ticker, length, totalReturn }),
  z
    .strictObject({
      indicator: z.literal('volatility'),
      ticker,
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
    ticker,
    length: length.optional(),
    totalReturn,
  }),
  z.strictObject({ indicator: z.literal('high'), ticker, length, totalReturn }),
  z.strictObject({ indicator: z.literal('low'), ticker, length, totalReturn }),
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
const PRICE_LEVELS: readonly string[] = ['price', 'sma', 'ema', 'high', 'low'];

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
  const plain = (o: Operand) =>
    'indicator' in o && PRICE_LEVELS.includes(o.indicator) && !o.totalReturn;
  const level = (o: Operand) => 'threshold' in o;
  return (plain(c.left) && level(c.right)) || (level(c.left) && plain(c.right));
}

export const PLAIN_PRICE_AGAINST_LEVEL =
  'a plain price, average, high or low (totalReturn: false) is compared with a fixed level: a ' +
  'split rescales earlier plain prices, so the level would mean something else after one. ' +
  'Compare the fund with its own average, or use a percentage (return, volatility or drawdown) ' +
  'against the level, instead';

export const Signal = z.discriminatedUnion('type', [
  z.strictObject({ id: z.string().min(1), type: z.literal('compare'), ...comparison }),
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('ensemble'),
    members: z.array(Comparison).min(1),
    /** True when at least this share of members is true. */
    threshold: z.number().gt(0).max(1),
  }),
]);

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
          : x.members.map((c, j) => ({ c, path: ['signals', i, 'members', j] }));
      for (const { c, path } of comparisons) {
        if (plainPriceAgainstLevel(c)) {
          ctx.addIssue({ code: 'custom', message: PLAIN_PRICE_AGAINST_LEVEL, path });
        }
      }
    });
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
