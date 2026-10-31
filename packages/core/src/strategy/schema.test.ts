// The strategy schema is strict at every level (spec 2026-11-01 yaml-strategies, review fix): an
// unknown key is refused with its path, never dropped, so a registered version is exactly what
// its file says.
import { describe, expect, it } from 'vitest';
import { Strategy } from './schema';

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
  ],
  allocations: [
    { name: 'In', when: { all: ['up', 'calm'] }, holdings: [{ ticker: 'AAA', weight: 100 }] },
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
