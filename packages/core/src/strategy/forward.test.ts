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
      standIns: [{ date: D, band }],
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

  it('decision margin: shifts every stand-in together, not one at a time', () => {
    const pair = Strategy.parse({
      ...strategy,
      signals: [
        {
          id: 'A',
          type: 'compare',
          left: { indicator: 'price', ticker: 'X' },
          op: '>',
          right: { indicator: 'price', ticker: 'Y' },
        },
      ],
    });
    const standIn = {
      status: 'yellow' as const,
      reasons: ['stand_in@s'],
      standIns: [{ date: D, band: 0.003 }],
    };
    // 100.5 vs 100: neither 0.3% shift alone flips it (100.2 > 100, 100.5 > 100.3); both do.
    const input = { X: bars([100, 100, 100, 100.5]), Y: bars([100, 100, 100, 100]) };
    const one = forwardDecision(pair, D, input, { X: standIn, Y: green, X3: green });
    expect(one).toMatchObject({ dataStatus: 'yellow', allocation: 'Risk on' });
    const both = forwardDecision(pair, D, input, { X: standIn, Y: standIn, X3: green });
    expect(both).toMatchObject({ dataStatus: 'red', safeStateApplied: true });
    expect(both.reasons).toContain('X+Y:decision_margin');
  });

  it('red in the lookback: a red or ungraded day of a signal ticker applies the safe state', () => {
    const input = { X: bars([100, 100, 100, 110]) };
    const red = forwardDecision(strategy, D, input, {
      X: { ...green, lookback: [{ date: day(1), why: 'red' }] },
      X3: green,
    });
    expect(red).toMatchObject({
      allocation: SAFE_STATE,
      safeStateApplied: true,
      dataStatus: 'red',
      reasons: [`X:lookback_red@${day(1)}`],
    });
    // The normal signals are still recorded (not acted on).
    expect(red.signals).toEqual({ A: true });
    const ungraded = forwardDecision(strategy, D, input, {
      X: { ...green, lookback: [{ date: day(2), why: 'ungraded' }] },
      X3: green,
    });
    expect(ungraded).toMatchObject({
      safeStateApplied: true,
      reasons: [`X:lookback_ungraded@${day(2)}`],
    });
  });

  it('red in the lookback of a ticker only held (no signal reads it): the normal decision', () => {
    const d = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 110]) },
      { X: green, X3: { ...green, lookback: [{ date: day(1), why: 'red' }] } },
    );
    expect(d).toMatchObject({ allocation: 'Risk on', dataStatus: 'green', reasons: [] });
  });

  it('a red day keeps its own reasons; the lookback adds only the past days', () => {
    const d = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 110]) },
      {
        X: {
          status: 'red',
          reasons: ['B.close_match@s'],
          lookback: [{ date: day(2), why: 'red' }],
        },
        X3: green,
      },
    );
    expect(d.reasons).toEqual(['X:B.close_match@s', `X:lookback_red@${day(2)}`]);
    // The day itself in the list is not a lookback day (the day's own grade says it).
    const same = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 110]) },
      { X: { ...green, lookback: [{ date: D, why: 'red' }] }, X3: green },
    );
    expect(same).toMatchObject({ allocation: 'Risk on', reasons: [] });
  });

  it('an older unresolved stand-in the signals read: yellow when no signal can flip, else red', () => {
    // SMA(3) on the day reads day 1-3; the stand-in is day 2's close.
    const older = (band: number) => ({
      ...green,
      standIns: [{ date: day(2), band }],
    });
    const far = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 110]) },
      { X: older(0.01), X3: green },
    );
    expect(far).toMatchObject({
      allocation: 'Risk on',
      dataStatus: 'yellow',
      reasons: [`X:stand_in_lookback@${day(2)}`],
    });
    // SMA of 100, 100, 101 is 100.33; day 2 at +3% gives 101.33, above the price 101: flips.
    const close = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 101]) },
      { X: older(0.03), X3: green },
    );
    expect(close).toMatchObject({ dataStatus: 'red', safeStateApplied: true });
    expect(close.reasons).toEqual([`X:stand_in_lookback@${day(2)}`, 'X:decision_margin']);
    // An older stand-in of a ticker only held is not read by any signal.
    const held = forwardDecision(
      strategy,
      D,
      { X: bars([100, 100, 100, 101]) },
      { X: green, X3: older(0.03) },
    );
    expect(held).toMatchObject({ allocation: 'Risk on', dataStatus: 'green' });
  });

  it("the margin test moves the day's and the older stand-ins together", () => {
    // SMA of 100, 100, 101 is 100.33. With 0.8% bands, day 2 alone at +0.8% gives an SMA of
    // 100.6 (below 101) and the day alone at -0.8% 100.192 against 100.064: neither flips; both
    // together, 100.192 against (100 + 100.8 + 100.192) / 3 = 100.331, do. With 0.5% bands even
    // both together keep it (100.495 against 100.332).
    const both = (band: number) => ({
      status: 'yellow' as const,
      reasons: ['stand_in@s'],
      standIns: [
        { date: day(2), band },
        { date: D, band },
      ],
    });
    const input = { X: bars([100, 100, 100, 101]) };
    expect(forwardDecision(strategy, D, input, { X: both(0.005), X3: green })).toMatchObject({
      dataStatus: 'yellow',
      allocation: 'Risk on',
    });
    for (const date of [day(2), D]) {
      const one = { ...both(0.008), standIns: [{ date, band: 0.008 }] };
      expect(forwardDecision(strategy, D, input, { X: one, X3: green }).dataStatus).toBe('yellow');
    }
    const flips = forwardDecision(strategy, D, input, { X: both(0.008), X3: green });
    expect(flips).toMatchObject({ dataStatus: 'red', safeStateApplied: true });
    expect(flips.reasons).toContain('X:decision_margin');
  });

  it('more than 4 unresolved stand-in prices the signals read is red, counted per date', () => {
    const many = (n: number) => ({
      ...green,
      standIns: Array.from({ length: n }, (_, i) => ({ date: day(i), band: 1e-6 })),
    });
    const input = { X: bars([100, 100, 100, 110]) };
    expect(forwardDecision(strategy, D, input, { X: many(4), X3: green })).toMatchObject({
      dataStatus: 'yellow',
    });
    const five = forwardDecision(strategy, D, input, {
      X: { ...many(4), standIns: [...many(4).standIns, { date: D, band: 1e-6 }] },
      X3: green,
    });
    expect(five).toMatchObject({ dataStatus: 'red', safeStateApplied: true });
    expect(five.reasons).toContain('X:decision_margin');
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
