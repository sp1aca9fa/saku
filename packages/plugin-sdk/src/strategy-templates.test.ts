// The strategy templates (`templates/strategies/*.json`) parse as `pnpm strategy check` reads a
// file (core `Strategy`), and Setup 1's signals all read SPY's total return, the volatility one
// included (spec 2026-11-01 lookback-health, C2).
import { Strategy, dependencies } from '@saku/core';
import { findRepoRoot } from '@saku/db/env';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(findRepoRoot(), 'templates', 'strategies');
const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));

describe('strategy templates', () => {
  it('every template is a valid strategy', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(Strategy.safeParse(read(file)).success, file).toBe(true);
  });

  it('Setup 1 reads total return in every signal, its volatility included', () => {
    const s = Strategy.parse(read('setup-1.json'));
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
