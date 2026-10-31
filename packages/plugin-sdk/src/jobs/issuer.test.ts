import { describe, expect, it } from 'vitest';
import { describeCounts, notComparedLines, notComparedList } from './issuer';

describe('NAVs and distributions not compared for another currency, in words', () => {
  it('counts per currency, sorted, or 0 without any', () => {
    expect(describeCounts({})).toBe('0');
    expect(describeCounts({ XXX: { navs: 0, distributions: 0 } })).toBe('0');
    expect(
      describeCounts({
        YYY: { navs: 1, distributions: 0 },
        XXX: { navs: 12, distributions: 1 },
        ZZZ: { navs: 0, distributions: 2 },
      }),
    ).toBe('XXX 12 NAVs and 1 distribution; YYY 1 NAV; ZZZ 2 distributions');
  });

  it('one line per fund, source and currency', () => {
    const list = notComparedList('AAA', 'iss', {
      XXX: { navs: 1, distributions: 0 },
      YYY: { navs: 3, distributions: 2 },
    });
    expect(list).toEqual([
      { ticker: 'AAA', source: 'iss', currency: 'XXX', navs: 1, distributions: 0 },
      { ticker: 'AAA', source: 'iss', currency: 'YYY', navs: 3, distributions: 2 },
    ]);
    expect(notComparedLines(list)).toEqual([
      "AAA iss: 1 NAV in XXX, not the fund's currency, not compared (no conversion; layer D " +
        'has no result for them)',
      "AAA iss: 3 NAVs and 2 distributions in YYY, not the fund's currency, not compared (no " +
        'conversion; layer D has no result for them)',
    ]);
    expect(notComparedLines([])).toEqual([]);
  });
});
