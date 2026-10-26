import { describe, expect, it } from 'vitest';
import { isTradingDate, tradingDateOf, zonedInstant } from './time';

describe('tradingDateOf', () => {
  it('uses New York time across daylight saving', () => {
    expect(tradingDateOf(Date.parse('2026-01-02T05:00:00Z'))).toBe('2026-01-02');
    expect(tradingDateOf(Date.parse('2026-07-02T04:00:00Z'))).toBe('2026-07-02');
    expect(tradingDateOf(Date.parse('2026-01-03T04:59:00Z'))).toBe('2026-01-02');
  });
});

describe('isTradingDate', () => {
  it('accepts real dates only', () => {
    expect(isTradingDate('2024-02-29')).toBe(true);
    expect(isTradingDate('2026-02-29')).toBe(false);
    expect(isTradingDate('2026-1-2')).toBe(false);
  });
});

describe('zonedInstant', () => {
  it('converts a local wall-clock time to UTC, winter and summer', () => {
    expect(zonedInstant('2026-01-05', '16:00', 'Europe/Berlin')).toBe('2026-01-05T15:00:00.000Z');
    expect(zonedInstant('2026-07-06', '16:00', 'Europe/Berlin')).toBe('2026-07-06T14:00:00.000Z');
    expect(zonedInstant('2026-03-09', '17:30', 'America/New_York')).toBe(
      '2026-03-09T21:30:00.000Z',
    );
  });
});
