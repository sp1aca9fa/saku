import type { Calendar } from '@saku/core';
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

  it('has no early-close knowledge without a list', () => {
    expect(s.closeOf('2026-01-02')).toBe('unknown');
  });
});

describe('Sessions.closeOf', () => {
  const early: Calendar = {
    ...cal,
    earlyCloses: {
      from: '2026-06-01',
      to: '2026-12-31',
      time: '13:00',
      dates: ['2026-11-27', '2026-12-24'],
    },
  };
  const s = new Sessions(early);

  it('reads early, regular, or unknown outside the early-close range', () => {
    expect(s.closeOf('2026-11-27')).toBe('early');
    expect(s.closeOf('2026-11-30')).toBe('regular');
    expect(s.closeOf('2026-06-01')).toBe('regular');
    // Before the range: unknown, never a full day.
    expect(s.closeOf('2026-05-29')).toBe('unknown');
  });

  it('throws for a date with no session or outside the calendar', () => {
    expect(() => s.closeOf('2026-11-28')).toThrow(/not a session/);
    expect(() => s.closeOf('2026-01-19')).toThrow(/not a session/);
    expect(() => s.closeOf('2027-01-04')).toThrow(/outside/);
  });

  it('refuses a table whose early closes are not sessions inside their range', () => {
    const bad = (e: Partial<NonNullable<Calendar['earlyCloses']>>) => () =>
      new Sessions({ ...early, earlyCloses: { ...early.earlyCloses!, ...e } });
    expect(bad({ dates: ['2026-11-28'] })).toThrow(/not a session/); // a Saturday
    expect(bad({ dates: ['2026-01-19'], from: '2026-01-01' })).toThrow(/not a session/); // a holiday
    expect(bad({ dates: ['2026-05-29'] })).toThrow(/outside 2026-06-01/);
    expect(bad({ to: '2027-01-31' })).toThrow(/range/);
    expect(bad({ from: '2026-12-31', to: '2026-06-01' })).toThrow(/range/);
    expect(bad({ time: '1pm' })).toThrow(/HH:MM/);
    expect(bad({ time: '24:00' })).toThrow(/HH:MM/);
  });
});
