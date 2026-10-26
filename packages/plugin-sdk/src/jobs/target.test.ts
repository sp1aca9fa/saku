import { Sessions } from '@saku/data';
import { describe, expect, it } from 'vitest';
import { dailyTarget } from './target';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-01-19'],
});

describe('dailyTarget', () => {
  it('is today only after 20:00 New York time', () => {
    // Tuesday 2026-01-20 19:59 and 20:00 in New York (EST, UTC-5).
    expect(dailyTarget(sessions, new Date('2026-01-21T00:59:00Z'))).toBe('2026-01-16');
    expect(dailyTarget(sessions, new Date('2026-01-21T01:00:00Z'))).toBe('2026-01-20');
  });

  it('on a weekend or holiday, the last session', () => {
    expect(dailyTarget(sessions, new Date('2026-01-18T03:00:00Z'))).toBe('2026-01-16');
    expect(dailyTarget(sessions, new Date('2026-01-20T03:00:00Z'))).toBe('2026-01-16');
  });
});
