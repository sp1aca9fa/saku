import { describe, expect, it } from 'vitest';
import { priceReturn, totalReturn, totalReturnIndex } from './adjusted';
import type { RawBar } from './domain';

const bar = (date: string, close: number, divCash = 0, splitFactor = 1): RawBar => ({
  date,
  close,
  closeIsSplitAdjusted: false,
  divCash,
  splitFactor,
});

describe('total return', () => {
  it('adds the dividend and multiplies by the split', () => {
    expect(totalReturn(bar('a', 100), bar('b', 99, 1))).toBeCloseTo(0, 15);
    // 2-for-1 split: 50 per new share, two shares: unchanged.
    expect(totalReturn(bar('a', 100), bar('b', 50, 0, 2))).toBeCloseTo(0, 15);
    expect(priceReturn(bar('a', 100), bar('b', 99, 1))).toBeCloseTo(-0.01, 15);
  });

  it('builds a forward index that past values never depend on later bars', () => {
    const bars = [bar('a', 100), bar('b', 110), bar('c', 54, 0.5, 2)];
    const index = totalReturnIndex(bars);
    expect(index[0]).toBe(1);
    expect(index[1]).toBeCloseTo(1.1, 15);
    expect(index[2]).toBeCloseTo((1.1 * (54.5 * 2)) / 110, 15);
    // Adding a later bar leaves earlier values exactly as they were.
    expect(totalReturnIndex([...bars, bar('d', 60, 1)]).slice(0, 3)).toEqual(index);
  });

  it('treats split-adjusted prices without applying the split again', () => {
    const adjusted = { ...bar('b', 50, 0, 2), closeIsSplitAdjusted: true };
    expect(totalReturn({ ...bar('a', 50), closeIsSplitAdjusted: true }, adjusted)).toBe(0);
  });
});
