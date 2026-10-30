// FRED withdrawals (spec 2026-10-30 withdrawn-values): a '.' vintage after a numeric one of the
// same date is a withdrawal; a '.' with no numeric vintage before it stays "no observation".
import { zonedInstant } from '@saku/core';
import { fixtureContext } from '@saku/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { FRED_VINTAGES_PER_WINDOW, fredFx, fredSeries } from '../src/fred';

type Row = { realtime_start: string; realtime_end: string; date: string; value: string };
const row = (date: string, value: string, start: string, end: string): Row => ({
  realtime_start: start,
  realtime_end: end,
  date,
  value,
});
const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const at18NY = (date: string) => zonedInstant(date, '18:00', 'America/New_York');

/** FRED's two endpoints: the vintage list, and observations per real-time window start. */
function context(vintages: string[], answers: (start: string) => Row[]) {
  return fixtureContext(
    (url: URL) => {
      if (url.pathname.endsWith('/vintagedates')) {
        return { count: vintages.length, offset: 0, vintage_dates: vintages };
      }
      const rows = answers(url.searchParams.get('realtime_start')!);
      return { count: rows.length, offset: 0, observations: rows };
    },
    { apiKey: 'abc' },
  );
}

describe('FRED withdrawn values', () => {
  const vintages = ['2026-01-05', '2026-01-06', '2026-01-08', '2026-01-12'];
  const rows = [
    // A: published, then withdrawn ('.'), then a value again (restored).
    row('2026-01-02', '3.61', '2026-01-05', '2026-01-07'),
    row('2026-01-02', '.', '2026-01-08', '2026-01-11'),
    row('2026-01-02', '3.65', '2026-01-12', '9999-12-31'),
    // B: '.' only: no observation, as before.
    row('2026-01-05', '.', '2026-01-06', '9999-12-31'),
    // C: '.' first, then a value, then '.' twice (a split period): one withdrawal.
    row('2026-01-06', '.', '2026-01-06', '2026-01-07'),
    row('2026-01-06', '3.7', '2026-01-08', '2026-01-08'),
    row('2026-01-06', '.', '2026-01-09', '2026-01-11'),
    row('2026-01-06', '.', '2026-01-12', '9999-12-31'),
  ];

  it('emits a withdrawal only for a missing value that follows a numeric vintage', async () => {
    const ctx = context(vintages, () => rows);
    expect(await fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', ctx)).toEqual([
      { date: '2026-01-02', value: 3.61, publishedAt: at18NY('2026-01-05') },
      { date: '2026-01-02', withdrawn: true, publishedAt: at18NY('2026-01-08') },
      { date: '2026-01-02', value: 3.65, publishedAt: at18NY('2026-01-12') },
      { date: '2026-01-06', value: 3.7, publishedAt: at18NY('2026-01-08') },
      { date: '2026-01-06', withdrawn: true, publishedAt: at18NY('2026-01-09') },
    ]);
  });

  it('reads rows in real-time order even when one window sends them out of order', async () => {
    // One window (4 vintages); the same rows as above, reversed.
    const ctx = context(vintages, () => [...rows].reverse());
    expect(await fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', ctx)).toEqual([
      { date: '2026-01-02', value: 3.61, publishedAt: at18NY('2026-01-05') },
      { date: '2026-01-02', withdrawn: true, publishedAt: at18NY('2026-01-08') },
      { date: '2026-01-02', value: 3.65, publishedAt: at18NY('2026-01-12') },
      { date: '2026-01-06', value: 3.7, publishedAt: at18NY('2026-01-08') },
      { date: '2026-01-06', withdrawn: true, publishedAt: at18NY('2026-01-09') },
    ]);
  });

  it('maps a withdrawal of an H.10 rate to an FX withdrawal', async () => {
    const ctx = context(vintages, () => rows.slice(0, 2));
    expect(await fredFx.fetchRates('USDJPY', '2026-01-01', '2026-01-06', ctx)).toEqual([
      { pair: 'USDJPY', date: '2026-01-02', rate: 3.61, publishedAt: at18NY('2026-01-05') },
      { pair: 'USDJPY', date: '2026-01-02', withdrawn: true, publishedAt: at18NY('2026-01-08') },
    ]);
  });

  describe('across a real-time window boundary', () => {
    // 1500 vintages, one per day: two windows.
    const v = Array.from({ length: 1500 }, (_, i) => addDays('2010-01-01', i));
    const w1 = v[FRED_VINTAGES_PER_WINDOW]!;
    const end0 = addDays(w1, -1);

    it('a withdrawal on the boundary vintage is a new vintage there', async () => {
      const ctx = context(v, (start) =>
        start === w1
          ? [row('2009-12-01', '.', w1, '9999-12-31')]
          : [row('2009-12-01', '1.00', v[0]!, end0)],
      );
      expect(await fredSeries.fetchSeries('DTB3', '2009-12-01', '2009-12-01', ctx)).toEqual([
        { date: '2009-12-01', value: 1, publishedAt: at18NY(v[0]!) },
        { date: '2009-12-01', withdrawn: true, publishedAt: at18NY(w1) },
      ]);
    });

    it('a withdrawal continuing across the boundary is one withdrawal', async () => {
      const ctx = context(v, (start) =>
        start === w1
          ? [row('2009-12-01', '.', w1, '9999-12-31')]
          : [row('2009-12-01', '1.00', v[0]!, v[9]!), row('2009-12-01', '.', v[10]!, end0)],
      );
      expect(await fredSeries.fetchSeries('DTB3', '2009-12-01', '2009-12-01', ctx)).toEqual([
        { date: '2009-12-01', value: 1, publishedAt: at18NY(v[0]!) },
        { date: '2009-12-01', withdrawn: true, publishedAt: at18NY(v[10]!) },
      ]);
    });
  });
});
