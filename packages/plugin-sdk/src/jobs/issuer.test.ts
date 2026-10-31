import { describe, expect, it } from 'vitest';
import { describeCounts, notComparedLines } from './issuer';

describe('records not compared for another currency, in words', () => {
  it('counts per currency, sorted, or 0 without any', () => {
    expect(describeCounts({})).toBe('0');
    expect(describeCounts({ YYY: 1, XXX: 12 })).toBe('12 XXX, 1 YYY');
  });

  it('one line per fund, source and currency', () => {
    expect(
      notComparedLines([
        { ticker: 'AAA', source: 'iss', currency: 'XXX', count: 1 },
        { ticker: 'AAA', source: 'iss', currency: 'YYY', count: 3 },
      ]),
    ).toEqual([
      "AAA iss: 1 issuer record in XXX, not the fund's currency: NAV and distributions not " +
        'compared (no conversion; layer D has no result for them)',
      "AAA iss: 3 issuer records in YYY, not the fund's currency: NAV and distributions not " +
        'compared (no conversion; layer D has no result for them)',
    ]);
    expect(notComparedLines([])).toEqual([]);
  });
});
