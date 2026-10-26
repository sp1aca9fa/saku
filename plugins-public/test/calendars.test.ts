import { describe, expect, it } from 'vitest';
import { calendars } from '../src/calendars';

const holidays = (id: string, year: number) =>
  calendars.calendars.find((c) => c.id === id)!.holidays.filter((d) => d.startsWith(`${year}-`));

// Published holiday lists (NYSE, Federal Reserve, ECB) for checked years.
describe('calendars', () => {
  it('NYSE', () => {
    expect(holidays('xnys', 2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-04-03',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03',
      '2026-09-07',
      '2026-11-26',
      '2026-12-25',
    ]);
    // New Year's Day on a Saturday is not observed; Christmas on a Sunday moves to Monday.
    expect(holidays('xnys', 2022)).toEqual([
      '2022-01-17',
      '2022-02-21',
      '2022-04-15',
      '2022-05-30',
      '2022-06-20',
      '2022-07-04',
      '2022-09-05',
      '2022-11-24',
      '2022-12-26',
    ]);
    expect(holidays('xnys', 2001)).toEqual([
      '2001-01-01',
      '2001-01-15',
      '2001-02-19',
      '2001-04-13',
      '2001-05-28',
      '2001-07-04',
      '2001-09-03',
      '2001-09-11',
      '2001-09-12',
      '2001-09-13',
      '2001-09-14',
      '2001-11-22',
      '2001-12-25',
    ]);
    expect(holidays('xnys', 1995)).not.toContain('1995-01-16'); // no MLK Day before 1998
  });

  it('Federal Reserve: Saturday holidays are not moved', () => {
    expect(holidays('us-fed', 2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-05-25',
      '2026-06-19',
      '2026-09-07',
      '2026-10-12',
      '2026-11-11',
      '2026-11-26',
      '2026-12-25',
    ]);
  });

  it('TARGET', () => {
    expect(holidays('ecb-target', 2026)).toEqual([
      '2026-01-01',
      '2026-04-03',
      '2026-04-06',
      '2026-05-01',
      '2026-12-25',
    ]);
    expect(holidays('ecb-target', 2000)).toContain('2000-12-26');
  });

  it('lists weekdays only, sorted, within the valid range', () => {
    for (const c of calendars.calendars) {
      expect([...c.holidays].sort()).toEqual(c.holidays);
      for (const d of c.holidays) {
        expect(new Date(`${d}T00:00:00Z`).getUTCDay() % 6).not.toBe(0);
        expect(d >= c.validFrom && d <= c.validTo).toBe(true);
      }
    }
  });
});
