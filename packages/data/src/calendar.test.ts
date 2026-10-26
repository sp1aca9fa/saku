import type { Calendar } from '@saku/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { Sessions } from './calendar';

const cal: Calendar = {
  id: 'test',
  version: 'test-1',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-01-01', '2026-01-19'],
};

describe('Sessions', () => {
  const s = new Sessions(cal);

  it('skips weekends and holidays', () => {
    expect(s.between('2026-01-01', '2026-01-06')).toEqual([
      '2026-01-02',
      '2026-01-05',
      '2026-01-06',
    ]);
    expect(s.isSession('2026-01-19')).toBe(false);
  });

  it('counts sessions backwards', () => {
    expect(s.before('2026-01-20')).toBe('2026-01-16');
    expect(s.before('2026-01-06', 2)).toBe('2026-01-02');
    expect(s.onOrBefore('2026-01-04')).toBe('2026-01-02');
  });

  it('refuses dates the calendar does not cover', () => {
    expect(() => s.isSession('2027-01-04')).toThrow(/outside/);
  });
});
