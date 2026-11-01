import { describe, expect, it } from 'vitest';
import { refusalNote } from './version-refusal';

const strategy = (ticker: string) => ({
  name: 'S',
  account: 'taxable',
  safeState: { holdings: [{ ticker: 'CASH_USD', weight: 100 }] },
  evaluation: { frequency: 'daily' },
  signals: [],
  allocations: [{ name: 'In', holdings: [{ ticker, weight: 100 }] }],
});

describe('refusalNote', () => {
  it('is undefined for a version the current schema parses', () => {
    expect(refusalNote({ canonicalJson: JSON.stringify({ strategy: strategy('SPY') }) })).toBe(
      undefined,
    );
  });

  it('names the first issue path and message for a refused version', () => {
    const note = refusalNote({ canonicalJson: JSON.stringify({ strategy: strategy('X?L=') }) });
    expect(note).toMatch(
      /^ {2}REFUSED by the current schema: allocations\.0\.holdings\.0\.ticker: /,
    );
  });

  it('refuses unreadable JSON and a missing strategy', () => {
    expect(refusalNote({ canonicalJson: '{' })).toMatch(/REFUSED by the current schema: /);
    expect(refusalNote({ canonicalJson: '{}' })).toMatch(/REFUSED by the current schema: /);
  });
});
