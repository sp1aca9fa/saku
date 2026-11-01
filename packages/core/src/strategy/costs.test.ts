import { describe, expect, it } from 'vitest';
import { resolveCosts } from './costs';

const install = { slippageBps: 5, feePct: 0.1, fxSpreadPct: 0.2 };

describe('resolveCosts (requirements 05 "Costs": the install\'s for each omitted)', () => {
  it("keeps the strategy's own costs, 0 included, and names those taken from the install", () => {
    expect(resolveCosts({ slippageBps: 0, feePct: 1, fxSpreadPct: 0 }, undefined)).toEqual({
      costs: { slippageBps: 0, feePct: 1, fxSpreadPct: 0 },
      fromInstall: [],
    });
    expect(resolveCosts({ feePct: 0 }, install)).toEqual({
      costs: { slippageBps: 5, feePct: 0, fxSpreadPct: 0.2 },
      fromInstall: ['slippageBps', 'fxSpreadPct'],
    });
    expect(resolveCosts({}, install)).toEqual({
      costs: install,
      fromInstall: ['slippageBps', 'feePct', 'fxSpreadPct'],
    });
  });

  it('says which are missing when one is omitted and the install has none (never 0)', () => {
    expect(resolveCosts({ slippageBps: 5 }, undefined)).toEqual({
      missing: ['feePct', 'fxSpreadPct'],
    });
    expect(resolveCosts({}, undefined)).toEqual({
      missing: ['slippageBps', 'feePct', 'fxSpreadPct'],
    });
  });
});
