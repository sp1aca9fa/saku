// The strategy templates (`templates/strategies/*.yaml`) parse as `pnpm strategy check` reads a
// file (cli/strategy-file.ts, then core `Strategy`), and Setup 1's signals all read SPY's total
// return, the volatility one included (spec 2026-11-01 lookback-health, C2). The YAML templates
// replaced JSON ones (spec 2026-11-01 yaml-strategies); their content is unchanged: the former
// JSON text is kept here and must read to the same value.
import { Strategy, dependencies } from '@saku/core';
import { findRepoRoot } from '@saku/db/env';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStrategyFile, parseStrategyYaml } from './cli/strategy-file';

const dir = join(findRepoRoot(), 'templates', 'strategies');
const text = (file: string) => readFileSync(join(dir, file), 'utf8');
const strategy = (file: string): Strategy => {
  const read = parseStrategyFile(file, text(file));
  if ('error' in read) throw new Error(read.error);
  return read.strategy;
};

/** templates/strategies/setup-1.json as it was before the YAML template replaced it. */
const SETUP_1_JSON = `{
  "name": "Setup 1: 3x on trend and calm, 1x on trend, else cash",
  "account": "taxable",
  "execution": "next_open",
  "safeState": { "holdings": [{ "ticker": "SPY", "weight": 100 }] },
  "evaluation": { "frequency": "daily" },
  "costs": { "slippageBps": 5 },
  "signals": [
    {
      "id": "trend",
      "type": "ensemble",
      "members": [
        {
          "left": { "indicator": "price", "ticker": "SPY", "totalReturn": true },
          "op": ">",
          "right": { "indicator": "sma", "ticker": "SPY", "length": 150, "totalReturn": true },
          "tolerancePct": 3
        },
        {
          "left": { "indicator": "price", "ticker": "SPY", "totalReturn": true },
          "op": ">",
          "right": { "indicator": "sma", "ticker": "SPY", "length": 200, "totalReturn": true },
          "tolerancePct": 3
        },
        {
          "left": { "indicator": "price", "ticker": "SPY", "totalReturn": true },
          "op": ">",
          "right": { "indicator": "sma", "ticker": "SPY", "length": 250, "totalReturn": true },
          "tolerancePct": 3
        }
      ],
      "threshold": 0.5
    },
    {
      "id": "calm",
      "type": "compare",
      "left": { "indicator": "volatility", "ticker": "SPY", "length": 20, "totalReturn": true },
      "op": "<",
      "right": { "threshold": 25 }
    }
  ],
  "allocations": [
    {
      "name": "Risk on",
      "when": { "all": ["trend", "calm"] },
      "holdings": [{ "ticker": "UPRO", "weight": 100 }]
    },
    {
      "name": "Trend only",
      "when": { "all": ["trend"] },
      "holdings": [{ "ticker": "SPY", "weight": 100 }]
    },
    { "name": "Cash", "holdings": [{ "ticker": "CASH_USD", "weight": 100 }] }
  ]
}`;

/** templates/strategies/spy-buy-and-hold.json as it was before the YAML template replaced it. */
const BUY_AND_HOLD_JSON = `{
  "name": "SPY buy and hold (benchmark)",
  "account": "taxable",
  "execution": "next_open",
  "safeState": { "holdings": [{ "ticker": "SPY", "weight": 100 }] },
  "evaluation": { "frequency": "daily" },
  "allocations": [{ "name": "SPY", "holdings": [{ "ticker": "SPY", "weight": 100 }] }]
}`;

describe('strategy templates', () => {
  it('every template is a valid YAML strategy (no JSON templates left)', () => {
    const files = readdirSync(dir);
    // Every file is a YAML template (.yaml or .yml), each one valid.
    expect(files.filter((f) => !/\.(ya?ml)$/.test(f))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(['setup-1.yaml', 'spy-buy-and-hold.yaml']));
    for (const file of files) {
      expect(parseStrategyFile(file, text(file)), file).not.toHaveProperty('error');
    }
  });

  it.each([
    ['setup-1.yaml', SETUP_1_JSON],
    ['spy-buy-and-hold.yaml', BUY_AND_HOLD_JSON],
  ])('%s reads to exactly the former JSON template', (file, json) => {
    // The raw values (before zod defaults), so nothing was dropped or added in the conversion.
    expect(parseStrategyYaml(text(file))).toEqual({ value: JSON.parse(json) });
    expect(strategy(file)).toEqual(Strategy.parse(JSON.parse(json)));
  });

  it('Setup 1 reads total return in every signal, its volatility included', () => {
    const s = strategy('setup-1.yaml');
    expect(dependencies(s)).toContain('SPY');
    const operands = s.signals
      .flatMap((x) => (x.type === 'compare' ? [x] : x.members))
      .flatMap((c) => [c.left, c.right])
      .filter((o) => 'indicator' in o);
    expect(
      operands.map((o) => ['indicator' in o && o.indicator, 'totalReturn' in o && o.totalReturn]),
    ).toEqual([
      ['price', true],
      ['sma', true],
      ['price', true],
      ['sma', true],
      ['price', true],
      ['sma', true],
      ['volatility', true],
    ]);
  });
});
