import type { Calendar, TradingDate } from '@saku/core';

const DAY = 86_400_000;
const toMs = (date: TradingDate) => Date.parse(`${date}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** How a session closes: at the regular time, early, or not known from the calendar. */
export type SessionClose = 'regular' | 'early' | 'unknown';

/** A calendar with fast lookups. Dates outside its valid range throw (never guess). */
export class Sessions {
  private readonly holidays: Set<string>;
  private readonly earlyCloses: Set<string>;

  constructor(readonly calendar: Calendar) {
    this.holidays = new Set(calendar.holidays);
    this.earlyCloses = new Set(calendar.earlyCloses?.dates ?? []);
    this.checkEarlyCloses();
  }

  /**
   * A table whose early closes are not sessions inside their own range, or whose range or time is
   * malformed, is refused when loaded: a wrong close time is never used.
   */
  private checkEarlyCloses(): void {
    const e = this.calendar.earlyCloses;
    if (!e) return;
    const bad = (why: string) => {
      throw new Error(`Calendar ${this.calendar.version}: early closes ${why}.`);
    };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time)) bad(`time ${e.time} is not HH:MM`);
    if (!(e.from <= e.to && e.from >= this.calendar.validFrom && e.to <= this.calendar.validTo))
      bad(
        `range ${e.from}..${e.to} is not inside ${this.calendar.validFrom}..${this.calendar.validTo}`,
      );
    for (const d of e.dates) {
      if (d < e.from || d > e.to) bad(`date ${d} is outside ${e.from}..${e.to}`);
      if (!this.isSession(d)) bad(`date ${d} is not a session`);
    }
  }

  private inRange(date: TradingDate): void {
    if (date < this.calendar.validFrom || date > this.calendar.validTo) {
      throw new Error(`${date} is outside calendar ${this.calendar.version}`);
    }
  }

  isSession(date: TradingDate): boolean {
    this.inRange(date);
    const wd = new Date(toMs(date)).getUTCDay();
    return wd !== 0 && wd !== 6 && !this.holidays.has(date);
  }

  /**
   * How the session on `date` closes (requirements 04, Calendars: half-days from the table):
   * `early` at the table's early-close time, `regular`, or `unknown` outside the range the table's
   * early-close list is complete for (or with no list). Unknown is never read as a full day.
   * Throws for a date with no session.
   */
  closeOf(date: TradingDate): SessionClose {
    if (!this.isSession(date))
      throw new Error(`${date} is not a session of ${this.calendar.version}`);
    const e = this.calendar.earlyCloses;
    if (!e || date < e.from || date > e.to) return 'unknown';
    return this.earlyCloses.has(date) ? 'early' : 'regular';
  }

  /** Session dates from `from` to `to`, both inclusive. */
  between(from: TradingDate, to: TradingDate): TradingDate[] {
    const out: TradingDate[] = [];
    for (let ms = toMs(from); ms <= toMs(to); ms += DAY) {
      const date = fromMs(ms);
      if (this.isSession(date)) out.push(date);
    }
    return out;
  }

  /** The session `n` sessions before `date` (n = 1: the previous session). */
  before(date: TradingDate, n = 1): TradingDate {
    let ms = toMs(date);
    for (let left = n; left > 0;) {
      ms -= DAY;
      if (this.isSession(fromMs(ms))) left--;
    }
    return fromMs(ms);
  }

  /** The next session after `date`. */
  after(date: TradingDate): TradingDate {
    let ms = toMs(date) + DAY;
    while (!this.isSession(fromMs(ms))) ms += DAY;
    return fromMs(ms);
  }

  /** The latest session on or before `date`. */
  onOrBefore(date: TradingDate): TradingDate {
    return this.isSession(date) ? date : this.before(date);
  }
}
