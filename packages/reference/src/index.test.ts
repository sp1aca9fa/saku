// The reference's own checks for holdings identity (requirements 05, 13): a reorder of the same
// tickers and weights is no trade. Written against the reference only (no @saku/core).
import { describe, expect, it } from 'vitest';
import { refBacktest, type RefBar, type RefDay } from './index';

const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
type H = RefDay['holdings'];
const A: H = [
  { ticker: 'SPY', weight: 50 },
  { ticker: 'SSO', weight: 50 },
];
const B: H = [
  { ticker: 'SSO', weight: 50 },
  { ticker: 'SPY', weight: 50 },
];
const C: H = [
  { ticker: 'SPY', weight: 60 },
  { ticker: 'SSO', weight: 40 },
];
const series = (closes: number[]): RefBar[] =>
  closes.map((close, i) => ({
    date: dates[i]!,
    open: close * (i % 2 === 0 ? 0.98 : 1.02),
    close,
    divCash: 0,
    splitFactor: 1,
    closeIsSplitAdjusted: false,
  }));
const bars = { SPY: series([100, 102, 98, 103]), SSO: series([50, 53, 48, 54]) };
const days = (lists: H[]): RefDay[] =>
  lists.map((holdings, i) => ({ date: dates[i]!, signals: {}, allocation: `a${i}`, holdings }));
const costs = { slippageBps: 10, feePct: 0.1 };

describe('reference: holdings identity ignores order', () => {
  for (const execution of ['next_open', 'next_close', 'same_close'] as const) {
    it(`${execution}: alternating A and B gives no switch and the same equity as holding A`, () => {
      const alternating = refBacktest({ execution, costs }, days([A, B, A, B]), bars, () => 0);
      const constant = refBacktest({ execution, costs }, days([A, A, A, A]), bars, () => 0);
      expect(alternating.switches).toBe(0);
      expect(alternating.equity).toEqual(constant.equity);
    });

    it(`${execution}: a weight change still counts`, () => {
      const r = refBacktest({ execution, costs }, days([A, B, C, C]), bars, () => 0);
      expect(r.switches).toBe(1);
    });

    it(`${execution}: swapped weights between the same tickers count as a switch`, () => {
      const x: H = [
        { ticker: 'SPY', weight: 40 },
        { ticker: 'SSO', weight: 60 },
      ];
      const y: H = [
        { ticker: 'SPY', weight: 60 },
        { ticker: 'SSO', weight: 40 },
      ];
      const r = refBacktest({ execution, costs }, days([x, y, y, y]), bars, () => 0);
      expect(r.switches).toBe(1);
    });

    // Only the switch count is checked: the money for a repeated ticker is not defined yet.
    it(`${execution}: a repeated ticker is not the same as one weight for it`, () => {
      const one: H = [{ ticker: 'SPY', weight: 100 }];
      const split: H = [
        { ticker: 'SPY', weight: 50 },
        { ticker: 'SPY', weight: 50 },
      ];
      const r = refBacktest({ execution, costs }, days([one, split, split, split]), bars, () => 0);
      expect(r.switches).toBe(1);
    });
  }
});
