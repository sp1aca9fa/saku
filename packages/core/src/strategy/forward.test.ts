import { describe, expect, it } from 'vitest';
import type { RawBar } from '../domain';
import { SAFE_STATE, dependencies, forwardDecision } from './forward';
import { Strategy } from './schema';

const day = (i: number) =>
  new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);
const bars = (closes: number[]): RawBar[] =>
  closes.map((close, i) => ({
    date: day(i),
    close,
    closeIsSplitAdjusted: false,
    divCash: 0,
    splitFactor: 1,
  }));

// Above its 3-day SMA: hold the 3x fund; else the 1x; safe state the 1x.
const strategy = Strategy.parse({
  name: 't',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'X', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [
    {
      id: 'A',
      type: 'compare',
      left: { indicator: 'price', ticker: 'X' },
      op: '>',
      right: { indicator: 'sma', ticker: 'X', length: 3 },
    },
  ],
  allocations: [
    { name: 'Risk on', when: { all: ['A'] }, holdings: [{ ticker: 'X3', weight: 100 }] },
    { name: 'Calm', holdings: [{ ticker: 'X', weight: 100 }] },
  ],
});
const green = { status: 'green' as const, reasons: [] };
const D = day(3);

describe('forwardDecision', () => {
  it('depends on its signal tickers and what it may hold', () => {
    expect(dependencies(strategy)).toEqual(['X', 'X3']);
  });

  it('green: the strategy decides', () => {
    const d = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 110]) },
      { X: green, X3: green },
    );
    expect(d).toMatchObject({
      allocation: 'Risk on',
      safeStateApplied: false,
      dataStatus: 'green',
    });
  });

  it('yellow: the decision with its reasons', () => {
    const d = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 110]) },
      { X: { status: 'yellow', reasons: ['single_source'] }, X3: green },
    );
    expect(d).toMatchObject({
      allocation: 'Risk on',
      dataStatus: 'yellow',
      reasons: ['X:single_source'],
    });
  });

  it('red on any dependency (a held fund too, or one with no data): the safe state', () => {
    const d = forwardDecision(strategy, D, { X: bars([100, 100, 100, 110]) }, { X: green });
    expect(d).toMatchObject({
      allocation: SAFE_STATE,
      holdings: [{ ticker: 'X', weight: 100 }],
      safeStateApplied: true,
      dataStatus: 'red',
      reasons: ['X3:no_data'],
    });
    expect(d.signals).toEqual({ A: true });
  });

  it('a stand-in that could flip a signal within its band is red; one that could not, yellow', () => {
    const standIn = (band: number) => ({
      status: 'yellow' as const,
      reasons: ['stand_in@s'],
      standInBand: band,
    });
    // SMA of 100, 100, 101 is 100.33; a 1% band around 101 reaches 99.99: could flip.
    const close = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 101]) },
      { X: standIn(0.01), X3: green },
    );
    expect(close).toMatchObject({ dataStatus: 'red', safeStateApplied: true });
    expect(close.reasons).toContain('X:decision_margin');
    const far = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 110]) },
      { X: standIn(0.01), X3: green },
    );
    expect(far).toMatchObject({ dataStatus: 'yellow', allocation: 'Risk on' });
  });

  it('red when the day cannot be evaluated (no bar that day)', () => {
    const d = forwardDecision(
      strategy,
      day(4),
      { X: bars([100, 100, 100, 110]) },
      { X: green, X3: green },
    );
    expect(d).toMatchObject({ safeStateApplied: true, reasons: ['no_decision'] });
  });
});
