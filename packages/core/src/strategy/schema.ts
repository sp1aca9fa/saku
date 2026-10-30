// The strategy definition (requirements 05, YAML), validated by zod. A2 covers what the owner's
// Setup 1 needs: price, SMA and volatility operands, compare and ensemble signals with tolerance
// bands, an allocation chain with fixed-weight holdings, and the safe state. Other parts of 05
// join as later stages need them.
import { z } from 'zod';

const ticker = z.string().min(1);

export const IndicatorOperand = z.discriminatedUnion('indicator', [
  z.object({ indicator: z.literal('price'), ticker, totalReturn: z.boolean().default(false) }),
  z.object({
    indicator: z.literal('sma'),
    ticker,
    length: z.number().int().min(1),
    totalReturn: z.boolean().default(false),
  }),
  z.object({
    indicator: z.literal('volatility'),
    ticker,
    length: z.number().int().min(2),
    totalReturn: z.boolean().default(false),
  }),
]);
export const Operand = z.union([IndicatorOperand, z.object({ threshold: z.number() })]);

const comparison = {
  left: Operand,
  op: z.enum(['>', '<']),
  right: Operand,
  tolerancePct: z.number().min(0).default(0),
};
export const Comparison = z.object(comparison);

export const Signal = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('compare'), ...comparison }),
  z.object({
    id: z.string().min(1),
    type: z.literal('ensemble'),
    members: z.array(Comparison).min(1),
    /** True when at least this share of members is true. */
    threshold: z.number().gt(0).max(1),
  }),
]);

export const Holding = z.object({ ticker, weight: z.number().gt(0).max(100) });
const holdings = z
  .array(Holding)
  .min(1)
  .refine((hs) => Math.abs(hs.reduce((s, h) => s + h.weight, 0) - 100) < 1e-9, {
    message: 'weights must add up to 100',
  })
  // A ticker listed twice would trade only one of its weights (the trade keeps one per ticker).
  .refine((hs) => new Set(hs.map((h) => h.ticker)).size === hs.length, {
    message: 'each ticker at most once per allocation',
  });

export const Condition = z
  .object({
    all: z.array(z.string()).optional(),
    any: z.array(z.string()).optional(),
    none: z.array(z.string()).optional(),
  })
  .refine((c) => (c.all?.length ?? 0) + (c.any?.length ?? 0) + (c.none?.length ?? 0) > 0, {
    message: 'a condition names at least one signal',
  });

export const Allocation = z.object({
  name: z.string().min(1),
  when: Condition.optional(),
  holdings,
});

export const Strategy = z
  .object({
    name: z.string().min(1),
    account: z.string().min(1),
    execution: z.enum(['next_open', 'next_close', 'same_close']).default('next_open'),
    safeState: z.object({ holdings }),
    evaluation: z.object({ frequency: z.enum(['daily', 'weekly', 'monthly']) }),
    costs: z
      .object({
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
