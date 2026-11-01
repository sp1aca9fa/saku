// Costs and stored versions (spec 2026-11-02 c2-settings, review item 9): a version registered
// before C2 (costs omitted, `"costs":{}`) still parses and is evaluated as it was recorded.
import { type RawBar, type StrategyDay, Strategy } from '@saku/core';
import { registerVersion } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { describe, expect, it } from 'vitest';
import { FX_SPREAD_NOT_APPLIED, costsLine } from './costs';
import { forwardEquity, parseVersion } from './forward';

const D = ['2026-01-05', '2026-01-06', '2026-01-07'] as const;
const bar = (date: string, open: number, close: number): RawBar => ({
  date,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
});
const bars = { AAA: [bar(D[0], 100, 100), bar(D[1], 100, 110), bar(D[2], 110, 121)] };
const day = (date: string): StrategyDay => ({
  date,
  signals: {},
  allocation: 'All',
  holdings: [{ ticker: 'AAA', weight: 100 }],
  ties: [],
});
const definition = {
  name: 'Old',
  account: 'taxable',
  execution: 'next_open',
  safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  costs: {},
  signals: [],
  allocations: [{ name: 'All', holdings: [{ ticker: 'AAA', weight: 100 }] }],
};

describe('a version registered before C2 (costs omitted)', () => {
  it('parses unchanged and runs through forwardEquity with an omitted cost read as 0, as recorded', async () => {
    const db = await testDb();
    // Inserted directly, as registration stored it before C2 (no effective costs written).
    const v = await registerVersion(db, { ownerId: null, name: 'Old', strategy: definition });
    expect(v.canonicalJson).toContain('"costs":{}');
    const parsed = parseVersion(v);
    expect(parsed).toEqual({ strategy: definition });
    const strategy = (parsed as { strategy: Strategy }).strategy;
    const equity = forwardEquity(strategy, [day(D[0])], bars, () => 2, day(D[1]));
    expect(equity).not.toBeNull();
    // Today's meaning: exactly what stating every cost as 0 gives.
    const zero = { ...strategy, costs: { slippageBps: 0, feePct: 0, fxSpreadPct: 0 } };
    expect(forwardEquity(zero, [day(D[0])], bars, () => 2, day(D[1]))).toBe(equity);
    const fee = { ...strategy, costs: { slippageBps: 0, feePct: 1, fxSpreadPct: 0 } };
    expect(forwardEquity(fee, [day(D[0])], bars, () => 2, day(D[1]))!).toBeLessThan(equity!);
  });

  it('parses a stored version over the cost limits added later; a new definition is refused', () => {
    const over = { ...definition, costs: { slippageBps: 2500, feePct: 100, fxSpreadPct: 150 } };
    expect(parseVersion({ canonicalJson: JSON.stringify({ strategy: over }) })).toEqual({
      strategy: over,
    });
    const issues = Strategy.safeParse(over).error?.issues.map((i) => i.path.join('.'));
    expect(issues).toEqual(['costs.slippageBps', 'costs.feePct', 'costs.fxSpreadPct']);
    // At the limits: accepted.
    const edge = { ...definition, costs: { slippageBps: 1000, feePct: 99.99, fxSpreadPct: 0 } };
    expect(Strategy.safeParse(edge).success).toBe(true);
  });
});

describe('costsLine', () => {
  it('says the FX spread is not applied yet', () => {
    const strategy = Strategy.parse({
      ...definition,
      costs: { slippageBps: 5, feePct: 0.1, fxSpreadPct: 0.2 },
    });
    expect(costsLine({ strategy, fromInstall: ['fxSpreadPct'] })).toBe(
      `Costs: slippageBps 5, feePct 0.1, fxSpreadPct 0.2 (${FX_SPREAD_NOT_APPLIED}) (from the install's broker_costs: fxSpreadPct)`,
    );
  });
});
