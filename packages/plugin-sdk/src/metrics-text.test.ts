// Tooltip coverage of the metric set (requirements 08 "Guidance", 13 CI gates): every metric
// has its name, definition, why it matters and an example, and every no-value reason its text.
import {
  DEFAULT_CRISES,
  METRIC_IDS,
  NO_VALUE_REASONS,
  STATISTIC_IDS,
  STATISTIC_NO_VALUE_REASONS,
} from '@saku/core';
import { hasText, missingKeys } from '@saku/content';
import { describe, expect, it } from 'vitest';

describe('metric texts', () => {
  it('every metric has a name, tooltip, why and example', () => {
    for (const id of METRIC_IDS) {
      for (const part of ['name', 'tooltip', 'why', 'example']) {
        expect(hasText(`metrics.${id}.${part}`), `metrics.${id}.${part}`).toBe(true);
      }
    }
    expect(hasText('metrics.longestDrawdown.unrecovered')).toBe(true);
  });

  it('every no-value reason has a text', () => {
    for (const reason of NO_VALUE_REASONS) {
      expect(hasText(`metrics.noValue.${reason}`), reason).toBe(true);
    }
  });

  it('the owner install languages have them all', () => {
    expect(missingKeys('ja').filter((k) => k.startsWith('metrics.'))).toEqual([]);
  });
});

describe('statistic texts', () => {
  it('every statistic has a name, tooltip, why and example', () => {
    for (const id of STATISTIC_IDS) {
      for (const part of ['name', 'tooltip', 'why', 'example']) {
        expect(hasText(`statistics.${id}.${part}`), `statistics.${id}.${part}`).toBe(true);
      }
    }
    for (const w of DEFAULT_CRISES) {
      expect(hasText(`statistics.crisisSurvival.windows.${w.id}`), w.id).toBe(true);
    }
  });

  it('every no-value reason has a text', () => {
    for (const reason of STATISTIC_NO_VALUE_REASONS) {
      expect(hasText(`statistics.noValue.${reason}`), reason).toBe(true);
    }
  });

  it('the owner install languages have them all', () => {
    expect(missingKeys('ja').filter((k) => k.startsWith('statistics.'))).toEqual([]);
  });
});
