import type { Calendar, TradingDate } from '@saku/core';

const DAY = 86_400_000;
const toMs = (date: TradingDate) => Date.parse(`${date}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A calendar with fast lookups. Dates outside its valid range throw (never guess). */
export class Sessions {
  private readonly holidays: Set<string>;

  constructor(readonly calendar: Calendar) {
    this.holidays = new Set(calendar.holidays);
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

  /** The latest session on or before `date`. */
  onOrBefore(date: TradingDate): TradingDate {
    return this.isSession(date) ? date : this.before(date);
  }
}
