// The strategy schema is strict at every level (spec 2026-11-01 yaml-strategies, review fix): an
// unknown key is refused with its path, never dropped, so a registered version is exactly what
// its file says.
import { describe, expect, it } from 'vitest';
import { Strategy, derivedOrder } from './schema';

const full = () => ({
  name: 'Every level',
  account: 'taxable',
  execution: 'next_open',
  safeState: { holdings: [{ ticker: 'AAA', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  costs: { slippageBps: 5 },
  signals: [
    {
      id: 'up',
      type: 'compare',
      left: { indicator: 'price', ticker: 'AAA', totalReturn: true },
      op: '>',
      right: { indicator: 'sma', ticker: 'AAA', length: 200 },
      tolerancePct: 3,
    },
    {
      id: 'calm',
      type: 'ensemble',
      members: [
        {
          left: { indicator: 'volatility', ticker: 'AAA', length: 20 },
          op: '<',
          right: { threshold: 25 },
        },
      ],
      threshold: 0.5,
    },
    { id: 'both', type: 'and', of: ['up', 'calm'] },
  ],
  allocations: [
    { name: 'In', when: { all: ['both'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
    { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  ],
});

/** Each object in `full()`, reached by its path. */
const LEVELS: (string | number)[][] = [
  [],
  ['safeState'],
  ['safeState', 'holdings', 0],
  ['evaluation'],
  ['costs'],
  ['signals', 0],
  ['signals', 0, 'left'],
  ['signals', 0, 'right'],
  ['signals', 1],
  ['signals', 1, 'members', 0],
  ['signals', 1, 'members', 0, 'left'],
  ['signals', 1, 'members', 0, 'right'],
  ['signals', 2],
  ['allocations', 0],
  ['allocations', 0, 'when'],
  ['allocations', 0, 'holdings', 0],
];

function withKey(path: (string | number)[], key: string) {
  const s = full();
  let o: Record<string | number, unknown> = s;
  for (const p of path) o = o[p] as Record<string | number, unknown>;
  Object.defineProperty(o, key, { value: 1, enumerable: true, configurable: true, writable: true });
  return s;
}

describe('Strategy schema: unknown keys', () => {
  it('the full example is valid', () => {
    expect(Strategy.safeParse(full()).success).toBe(true);
  });

  it.each(LEVELS.map((p) => [p.join('.') || '(top)', p] as const))(
    'an unknown key at %s is refused, not dropped',
    (_, path) => {
      const r = Strategy.safeParse(withKey(path, 'tolerencePct'));
      expect(r.success).toBe(false);
      const text = JSON.stringify(r.error!.issues);
      // The issue names the key (an operand's issue sits inside its union's alternatives).
      expect(text).toContain('tolerencePct');
    },
  );

  it('a "__proto__" key from JSON is refused too', () => {
    const json = JSON.stringify(full()).replace('{"name"', '{"__proto__":{"x":1},"name"');
    const parsed: unknown = JSON.parse(json);
    expect(Object.keys(parsed as object)).toContain('__proto__');
    const r = Strategy.safeParse(parsed);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain('__proto__');
    const holding = JSON.stringify(full()).replace(
      '{"ticker":"CASH_USD"',
      '{"__proto__":null,"ticker":"CASH_USD"',
    );
    expect(Strategy.safeParse(JSON.parse(holding)).success).toBe(false);
  });

  it('the parsed output has only known keys and re-parses to itself (stored versions)', () => {
    const once = Strategy.parse(full());
    expect(Strategy.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

// Decisions log 2026-11-01, C18 (a): a split rescales earlier plain prices, so a plain price or
// its average against a fixed level is refused; total return, the fund's own average and
// volatility are not rescaled.
describe('Strategy schema: a plain price against a fixed level', () => {
  const withComparison = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    member = false,
  ) => {
    const s = full() as unknown as { signals: Record<string, unknown>[] };
    const c = { left, op: '>', right };
    if (member) (s.signals[1]!.members as unknown[]).push(c);
    else Object.assign(s.signals[0]!, c);
    return s;
  };
  const level = { threshold: 400 };
  const plainPrice = { indicator: 'price', ticker: 'AAA' };
  const plainSma = { indicator: 'sma', ticker: 'AAA', length: 200, totalReturn: false };

  it.each([
    ['a plain price (default) > a level', plainPrice, level, false, ['signals', 0]],
    ['a level > a plain SMA', level, plainSma, false, ['signals', 0]],
    ['an ensemble member', plainPrice, level, true, ['signals', 1, 'members', 1]],
  ])('%s is refused, with the reason and where', (_, left, right, member, path) => {
    const r = Strategy.safeParse(withComparison(left, right, member));
    expect(r.success).toBe(false);
    const issue = r.error!.issues.find((i) => i.message.includes('fixed level'));
    expect(issue?.path).toEqual(path);
    expect(issue?.message).toMatch(/split rescales earlier plain prices/);
    expect(issue?.message).toMatch(/its own average/);
  });

  it.each([
    ['a total-return price against a level', { ...plainPrice, totalReturn: true }, level],
    ['a total-return SMA against a level', level, { ...plainSma, totalReturn: true }],
    ['a plain price against its own plain average', plainPrice, plainSma],
    [
      'a plain volatility against a level',
      { indicator: 'volatility', ticker: 'AAA', length: 20 },
      level,
    ],
  ])('%s is allowed', (_, left, right) => {
    expect(Strategy.safeParse(withComparison(left, right)).success).toBe(true);
    expect(Strategy.safeParse(withComparison(left, right, true)).success).toBe(true);
  });
});

// Derived and aggregate signals (requirements 05 "Signals"; docs/indicators.md "Signals"): an
// unknown id, a reference to itself or a cycle is refused at parse; the order in the file does
// not matter.
describe('Strategy schema: not, and, or', () => {
  const compare = (id: string) => ({
    id,
    type: 'compare',
    left: { indicator: 'price', ticker: 'AAA', totalReturn: true },
    op: '>',
    right: { indicator: 'sma', ticker: 'AAA', length: 10, totalReturn: true },
  });
  const withSignals = (signals: unknown[], when = 'x') => ({
    ...full(),
    signals,
    allocations: [
      { name: 'In', when: { all: [when] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
      { name: 'Out', holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
    ],
  });
  const issues = (signals: unknown[], when?: string) => {
    const r = Strategy.safeParse(withSignals(signals, when));
    return r.success ? [] : r.error.issues.map((i) => [i.path.join('.'), i.message]);
  };

  it('parses not, and, or, nested and named before what they read', () => {
    const signals = [
      { id: 'x', type: 'or', of: ['n', 'both'] },
      { id: 'n', type: 'not', of: 'a' },
      { id: 'both', type: 'and', of: ['a', 'b'] },
      compare('a'),
      compare('b'),
    ];
    expect(issues(signals)).toEqual([]);
    const s = Strategy.parse(withSignals(signals));
    expect(s.signals[0]).toEqual({ id: 'x', type: 'or', of: ['n', 'both'] });
    // Each derived signal after the derived signals it reads; file order otherwise.
    expect(derivedOrder(s.signals).map((x) => x.id)).toEqual(['n', 'both', 'x']);
  });

  it('refuses an unknown id, with where', () => {
    expect(issues([compare('a'), { id: 'x', type: 'and', of: ['a', 'zz'] }])).toEqual([
      ['signals.1.of', 'unknown signal "zz"'],
    ]);
    expect(issues([compare('a'), { id: 'x', type: 'not', of: 'zz' }])).toEqual([
      ['signals.1.of', 'unknown signal "zz"'],
    ]);
  });

  it('refuses a signal that reads itself', () => {
    expect(issues([compare('a'), { id: 'x', type: 'or', of: ['a', 'x'] }])).toEqual([
      ['signals.1.of', 'signal "x" reads itself'],
    ]);
    expect(issues([compare('a'), { id: 'x', type: 'not', of: 'x' }])).toEqual([
      ['signals.1.of', 'signal "x" reads itself'],
    ]);
  });

  it('refuses a cycle once, named from its signal first in the file', () => {
    expect(
      issues([
        compare('a'),
        { id: 'p', type: 'and', of: ['a', 'q'] },
        { id: 'x', type: 'not', of: 'p' },
        { id: 'q', type: 'or', of: ['a', 'r'] },
        { id: 'r', type: 'not', of: 'p' },
      ]),
    ).toEqual([
      [
        'signals.1.of',
        'signals read each other in a cycle ("p" -> "q" -> "r" -> "p"), so none of them has a ' +
          'value; break the cycle',
      ],
    ]);
    // Two cycles through one signal: both named.
    const two = issues([
      compare('a'),
      { id: 'p', type: 'and', of: ['q', 'r'] },
      { id: 'q', type: 'not', of: 'p' },
      { id: 'r', type: 'not', of: 'p' },
      { id: 'x', type: 'not', of: 'a' },
    ]);
    expect(two.map((i) => i[1])).toEqual([
      expect.stringContaining('("p" -> "q" -> "p")'),
      expect.stringContaining('("p" -> "r" -> "p")'),
    ]);
  });

  it('derivedOrder throws on a cycle (the schema refuses one first)', () => {
    expect(() =>
      derivedOrder([
        { id: 'p', type: 'not', of: 'q' },
        { id: 'q', type: 'not', of: 'p' },
      ]),
    ).toThrow(/cycle/);
  });

  it.each([
    ['and with one id', { id: 'x', type: 'and', of: ['a'] }, /at least 2|>=2/i],
    ['or with none', { id: 'x', type: 'or', of: [] }, /at least 2|>=2/i],
    ['and naming one id twice', { id: 'x', type: 'and', of: ['a', 'a'] }, /named twice/],
    ['not with a list', { id: 'x', type: 'not', of: ['a'] }, /string/],
    ['and with a single id', { id: 'x', type: 'and', of: 'a' }, /array/],
    ['an extra key', { id: 'x', type: 'not', of: 'a', tolerancePct: 1 }, /tolerancePct/],
  ])('refuses %s', (_, signal, message) => {
    const r = Strategy.safeParse(withSignals([compare('a'), compare('b'), signal]));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toMatch(message);
  });

  it('an allocation may name a derived signal; an unknown one is still refused', () => {
    expect(issues([compare('a'), { id: 'x', type: 'not', of: 'a' }])).toEqual([]);
    expect(issues([compare('a'), { id: 'x', type: 'not', of: 'a' }], 'y')).toEqual([
      ['allocations.0.when', 'unknown signal "y"'],
    ]);
  });
});
