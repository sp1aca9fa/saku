// Holiday tables as versioned data: NYSE (US equity sessions), the Federal Reserve's holidays
// (FRED's H.15 rates and H.10 exchange rates) and TARGET (ECB reference rates). Regular holidays
// follow each body's published rules; one-off closures are listed by hand. Change `version`
// whenever a table changes.
import type { Calendar, CalendarSource } from '@saku/plugin-sdk';

const FROM = 1990;
const TO = 2028;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The n-th given weekday (0 = Sunday) of a month; n = -1 for the last. */
function nthWeekday(y: number, m: number, day: number, n: number): string {
  if (n > 0) {
    const first = (day - weekday(y, m, 1) + 7) % 7;
    return iso(y, m, 1 + first + 7 * (n - 1));
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, last - ((weekday(y, m, last) - day + 7) % 7));
}

/** Easter Sunday (Gregorian, anonymous algorithm) as [month, day]. */
function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}

function shiftDays(y: number, m: number, d: number, days: number): string {
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * A fixed-date holiday moved off a weekend: Saturday to Friday, Sunday to Monday. With
 * `saturdayKept`, a Saturday holiday is not observed at all (NYSE rule 7.2: no Friday close when
 * the Friday ends a month or quarter, which in practice is New Year's Day).
 */
function observed(y: number, m: number, d: number, saturdayKept = false): string | null {
  const wd = weekday(y, m, d);
  if (wd === 6) return saturdayKept ? null : shiftDays(y, m, d, -1);
  if (wd === 0) return shiftDays(y, m, d, 1);
  return iso(y, m, d);
}

/** NYSE one-off closures (weekdays). */
const NYSE_SPECIAL = [
  '1994-04-27', // President Nixon's funeral
  '2001-09-11',
  '2001-09-12',
  '2001-09-13',
  '2001-09-14', // September 11 attacks
  '2004-06-11', // President Reagan's funeral
  '2007-01-02', // President Ford's funeral
  '2012-10-29',
  '2012-10-30', // Hurricane Sandy
  '2018-12-05', // President George H. W. Bush's funeral
  '2025-01-09', // President Carter's funeral
];

function nyseHolidays(y: number): (string | null)[] {
  const [em, ed] = easter(y);
  return [
    observed(y, 1, 1, true),
    y >= 1998 ? nthWeekday(y, 1, 1, 3) : null, // Martin Luther King Jr. Day
    nthWeekday(y, 2, 1, 3), // Washington's Birthday
    shiftDays(y, em, ed, -2), // Good Friday
    nthWeekday(y, 5, 1, -1), // Memorial Day
    y >= 2022 ? observed(y, 6, 19) : null, // Juneteenth
    observed(y, 7, 4),
    nthWeekday(y, 9, 1, 1), // Labor Day
    nthWeekday(y, 11, 4, 4), // Thanksgiving
    observed(y, 12, 25),
  ];
}

/** Federal Reserve holidays (no H.15 or H.10 values): federal holidays, Saturday ones not moved. */
function fedHolidays(y: number): (string | null)[] {
  return [
    observed(y, 1, 1, true),
    y >= 1986 ? nthWeekday(y, 1, 1, 3) : null,
    nthWeekday(y, 2, 1, 3),
    nthWeekday(y, 5, 1, -1),
    y >= 2021 ? observed(y, 6, 19, true) : null,
    observed(y, 7, 4, true),
    nthWeekday(y, 9, 1, 1),
    nthWeekday(y, 10, 1, 2), // Columbus Day
    observed(y, 11, 11, true), // Veterans Day
    nthWeekday(y, 11, 4, 4),
    observed(y, 12, 25, true),
  ];
}

/** TARGET closing days (since 2002; 1999-2001 also closed on 31 December). */
function targetHolidays(y: number): (string | null)[] {
  const [em, ed] = easter(y);
  return [
    iso(y, 1, 1),
    shiftDays(y, em, ed, -2),
    shiftDays(y, em, ed, 1), // Easter Monday
    iso(y, 5, 1),
    iso(y, 12, 25),
    iso(y, 12, 26),
    y >= 1999 && y <= 2001 ? iso(y, 12, 31) : null,
  ];
}

function table(
  id: string,
  version: string,
  from: number,
  rule: (y: number) => (string | null)[],
  special: string[] = [],
): Calendar {
  const holidays = new Set(special);
  for (let y = from; y <= TO; y++) {
    for (const date of rule(y)) {
      // Weekends are always closed, so a holiday falling on one is not listed.
      const [yy, mm, dd] = (date ?? '').split('-').map(Number);
      if (date && weekday(yy!, mm!, dd!) % 6 !== 0) holidays.add(date);
    }
  }
  return {
    id,
    version,
    validFrom: `${from}-01-01`,
    validTo: `${TO}-12-31`,
    holidays: [...holidays].sort(),
  };
}

export const calendars: CalendarSource = {
  info: {
    key: 'calendars',
    kind: 'calendar',
    name: 'Holiday calendars (NYSE, Federal Reserve, TARGET)',
    provides: { markets: ['xnys', 'us-fed', 'ecb-target'] },
    suggestedRole: 'primary',
    termsUrl: 'https://www.nyse.com/markets/hours-calendars',
  },
  calendars: [
    table('xnys', 'xnys-2026.1', FROM, nyseHolidays, NYSE_SPECIAL),
    table('us-fed', 'us-fed-2026.1', FROM, fedHolidays),
    table('ecb-target', 'ecb-target-2026.1', 1999, targetHolidays),
  ],
};
