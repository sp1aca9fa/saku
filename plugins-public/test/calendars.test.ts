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

  // NYSE holiday and early closings calendars (2026-2028 announcement of 2025-12-23).
  describe('NYSE early closes', () => {
    const xnys = calendars.calendars.find((c) => c.id === 'xnys')!;
    const early = (year: number) => xnys.earlyCloses!.dates.filter((d) => d.startsWith(`${year}-`));

    it('lists the published half-days at 13:00', () => {
      expect(xnys.earlyCloses!.time).toBe('13:00');
      expect(early(2024)).toEqual(['2024-07-03', '2024-11-29', '2024-12-24']);
      expect(early(2025)).toEqual(['2025-07-03', '2025-11-28', '2025-12-24']);
      // July 3 is the Independence Day holiday (July 4 a Saturday): no July 2 or 3 early close.
      expect(early(2026)).toEqual(['2026-11-27', '2026-12-24']);
      // July 4 a Sunday (July 5 closed); December 24 is the Christmas holiday.
      expect(early(2027)).toEqual(['2027-11-26']);
      // July 3 a Monday before Independence Day; December 24 a Sunday.
      expect(early(2028)).toEqual(['2028-07-03', '2028-11-24']);
      // July 4 a Monday, December 24 a Saturday: the day after Thanksgiving only.
      expect(early(2016)).toEqual(['2016-11-25']);
    });

    it('is complete only from 2013 through 2028: other years are unknown', () => {
      expect(xnys.earlyCloses!.from).toBe('2013-01-01');
      expect(xnys.earlyCloses!.to).toBe('2028-12-31');
      expect(xnys.version).toBe('xnys-2026.3');
      expect(early(2012)).toEqual([]);
    });

    it('never lists a holiday or a weekend, and stays sorted inside its range', () => {
      const e = xnys.earlyCloses!;
      expect([...e.dates].sort()).toEqual(e.dates);
      for (const d of e.dates) {
        expect(new Date(`${d}T00:00:00Z`).getUTCDay() % 6).not.toBe(0);
        expect(xnys.holidays).not.toContain(d);
        expect(d >= e.from && d <= e.to).toBe(true);
      }
      // Every year in the range has the day after Thanksgiving.
      for (let y = 2013; y <= 2028; y++)
        expect(early(y).some((d) => d.slice(5, 7) === '11')).toBe(true);
    });
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
