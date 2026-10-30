import type { RawBar } from '@saku/core';
import { describe, expect, it } from 'vitest';
import { Sessions } from './calendar';
import type { CheckResult } from './checks';
import {
  type StandInInput,
  seriesHealth,
  seriesHealthAtOpen,
  standIns,
  symbolHealth,
} from './health';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  closeIsSplitAdjusted: false,
  volume: 1000,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
// Mon 2026-01-05 to Fri 2026-01-09.
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
const series = (closes: number[], dates = D) => closes.map((c, i) => bar(dates[i]!, c));

const input = (o: Partial<StandInInput>): StandInInput => ({
  primary: [bar(D[0]!, 100), bar(D[1]!, 101)],
  secondaries: [],
  sessions,
  leverage: 1,
  to: D[2]!,
  ...o,
});

describe('standIns', () => {
  it('takes a valid secondary bar for a missing primary day, with the base band if unchecked', () => {
    const r = standIns(input({ secondaries: [['s1', series([100, 101, 102])]] }));
    expect(r.refused).toEqual([]);
    expect(r.standIns).toMatchObject([
      { date: D[2], source: 's1', basis: 'unchecked', band: 0.005 },
    ]);
    expect(r.standIns[0]!.bar.close).toBe(102);
  });

  it('uses the layer B band when two secondaries agree, and refuses when they disagree', () => {
    const agree = standIns(
      input({
        secondaries: [
          ['s1', series([100, 101, 102])],
          ['s2', series([100, 101, 102.03])],
        ],
      }),
    );
    expect(agree.standIns).toMatchObject([
      { source: 's1', basis: 'secondaries_agree', band: 0.0005 },
    ]);
    const disagree = standIns(
      input({
        secondaries: [
          ['s1', series([100, 101, 102])],
          ['s2', series([100, 101, 103])],
        ],
      }),
    );
    expect(disagree.standIns).toEqual([]);
    expect(disagree.refused).toEqual([{ date: D[2], reason: 'secondaries_disagree' }]);
  });

  it('refuses a secondary bar that fails layer A, and skips it when another one passes', () => {
    const broken = [bar(D[0]!, 100), bar(D[1]!, 101), bar(D[2]!, 102, { high: 90 })];
    expect(standIns(input({ secondaries: [['s1', broken]] })).refused).toEqual([
      { date: D[2], reason: 'no_valid_secondary' },
    ]);
    const r = standIns(
      input({
        secondaries: [
          ['s1', broken],
          ['s2', series([100, 101, 102])],
        ],
      }),
    );
    expect(r.standIns).toMatchObject([{ source: 's2', basis: 'unchecked' }]);
  });

  it('allows two stand-in days in a row; the third and later are refused', () => {
    const r = standIns(
      input({
        primary: [bar(D[0]!, 100)],
        secondaries: [['s1', series([100, 101, 102, 103, 104])]],
        to: D[4]!,
      }),
    );
    expect(r.standIns.map((s) => s.date)).toEqual([D[1], D[2]]);
    expect(r.refused).toEqual([
      { date: D[3], reason: 'too_many_days' },
      { date: D[4], reason: 'too_many_days' },
    ]);
  });

  it('checks a leveraged fund against its underlying (layer C) and takes that band', () => {
    const underlying = series([100, 100, 101]); // +1% on the missing day
    const fund = (close: number) =>
      standIns(
        input({
          leverage: 2,
          underlying,
          secondaries: [['s1', series([100, 101, close])]],
        }),
      );
    const ok = fund(101 * 1.02);
    expect(ok.standIns[0]!.basis).toBe('layer_c');
    expect(ok.standIns[0]!.band).toBeCloseTo(0.005 + 0.1 * 0.02, 12);
    expect(fund(101 * 1.1).refused).toEqual([{ date: D[2], reason: 'layer_c' }]);
  });

  it('checks a fund against its index and takes the index band', () => {
    const index = [
      { date: D[1]!, value: 1000 },
      { date: D[2]!, value: 1010 },
    ];
    const ok = standIns(input({ index, secondaries: [['s1', series([100, 101, 102.01])]] }));
    expect(ok.standIns).toMatchObject([{ basis: 'index', band: 0.001 }]);
    const off = standIns(input({ index, secondaries: [['s1', series([100, 101, 103])]] }));
    expect(off.refused).toEqual([{ date: D[2], reason: 'index' }]);
  });
});

describe('symbolHealth', () => {
  const result = (date: string, status: CheckResult['status'], extra: Partial<CheckResult> = {}) =>
    ({ layer: 'B', check: 'close_match', source: 's1', date, status, ...extra }) as CheckResult;
  const base = {
    dates: D.slice(0, 4),
    primary: 'p',
    primaryDates: new Set(D.slice(0, 2)),
    sources: new Map([
      [D[0]!, 2],
      [D[1]!, 2],
      [D[2]!, 1],
      [D[3]!, 2],
    ]),
    standIns: [
      { date: D[2]!, source: 's1', bar: bar(D[2]!, 1), band: 0.005, basis: 'layer_c' as const },
    ],
    refused: [],
  };

  it('grades each day by its worst result, with reason codes', () => {
    const h = symbolHealth({
      ...base,
      results: [result(D[0]!, 'green'), result(D[1]!, 'red')],
    });
    expect(h.get(D[0]!)).toEqual({ status: 'green', reasons: [] });
    expect(h.get(D[1]!)).toEqual({ status: 'red', reasons: ['B.close_match@s1'] });
  });

  it('marks a stand-in day yellow (and single source), a day with no primary and no stand-in red', () => {
    const h = symbolHealth({
      ...base,
      results: [{ layer: 'A', check: 'missing_day', source: 'p', date: D[2]!, status: 'red' }],
    });
    expect(h.get(D[2]!)).toEqual({ status: 'yellow', reasons: ['stand_in@s1', 'single_source'] });
    expect(h.get(D[3]!)).toEqual({ status: 'red', reasons: ['primary_missing'] });
  });

  it('is red on a refused stand-in', () => {
    const h = symbolHealth({
      ...base,
      standIns: [],
      refused: [{ date: D[2]!, reason: 'layer_c' }],
      results: [],
    });
    expect(h.get(D[2]!)!.status).toBe('red');
    expect(h.get(D[2]!)!.reasons).toContain('stand_in_refused:layer_c');
  });
});

describe('seriesHealth', () => {
  const fed = new Sessions({
    id: 'f',
    version: 'f',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    holidays: ['2026-01-19'],
  });
  it('allows the publication lag and holidays, warns on a gap, is red past 5 business days', () => {
    expect(seriesHealth(fed, '2026-01-08', '2026-01-08')).toEqual({ status: 'green', behind: 0 });
    expect(seriesHealth(fed, '2026-01-08', '2026-01-07').status).toBe('green');
    // Friday's value on Tuesday after a Monday holiday: one business day behind.
    expect(seriesHealth(fed, '2026-01-20', '2026-01-16').status).toBe('green');
    expect(seriesHealth(fed, '2026-01-08', '2026-01-05')).toEqual({ status: 'yellow', behind: 3 });
    expect(seriesHealth(fed, '2026-01-12', '2026-01-05').status).toBe('yellow');
    expect(seriesHealth(fed, '2026-01-13', '2026-01-05')).toEqual({ status: 'red', behind: 6 });
    expect(seriesHealth(fed, '2026-01-13', undefined).status).toBe('red');
  });
});

describe('seriesHealthAtOpen', () => {
  const fed = new Sessions({
    id: 'f',
    version: 'f',
    validFrom: '2026-01-01',
    validTo: '2026-12-31',
    holidays: ['2026-01-19'],
  });
  it('counts business days strictly before the read date: the previous one missing is green', () => {
    // Thursday read at the open with Tuesday's value: Wednesday's is not yet published.
    expect(seriesHealthAtOpen(fed, '2026-01-08', '2026-01-06')).toEqual({
      status: 'green',
      behind: 1,
    });
    expect(seriesHealthAtOpen(fed, '2026-01-08', '2026-01-07')).toEqual({
      status: 'green',
      behind: 0,
    });
    // A value dated the read date (a fixed rate) is not behind.
    expect(seriesHealthAtOpen(fed, '2026-01-08', '2026-01-08')).toEqual({
      status: 'green',
      behind: 0,
    });
    // Tuesday after the Monday holiday with Thursday's value: only Friday is missing.
    expect(seriesHealthAtOpen(fed, '2026-01-20', '2026-01-15')).toEqual({
      status: 'green',
      behind: 1,
    });
    expect(seriesHealthAtOpen(fed, '2026-01-08', '2026-01-05')).toEqual({
      status: 'yellow',
      behind: 2,
    });
    expect(seriesHealthAtOpen(fed, '2026-01-13', '2026-01-05')).toEqual({
      status: 'yellow',
      behind: 5,
    });
    expect(seriesHealthAtOpen(fed, '2026-01-14', '2026-01-05')).toEqual({
      status: 'red',
      behind: 6,
    });
    expect(seriesHealthAtOpen(fed, '2026-01-13', undefined)).toEqual({
      status: 'red',
      behind: Infinity,
    });
  });

  it('outside the calendar the lag is unknown (never green)', () => {
    const date = { status: 'unknown', outside: 'date' };
    const last = { status: 'unknown', outside: 'lastObservation' };
    expect(seriesHealthAtOpen(fed, '2025-12-31', '2025-12-30')).toEqual(date);
    expect(seriesHealthAtOpen(fed, '2027-01-04', '2026-12-31')).toEqual(date);
    // The read date is inside, the last value before the calendar: the value is out of range.
    expect(seriesHealthAtOpen(fed, '2026-01-05', '2025-12-31')).toEqual(last);
    expect(seriesHealthAtOpen(fed, '2026-01-01', '2025-12-31')).toEqual(last);
    // A last value after the read date cannot be counted either.
    expect(seriesHealthAtOpen(fed, '2026-01-05', '2026-01-06')).toEqual(last);
    // Unknown before missing: a date outside the calendar is not graded red either.
    expect(seriesHealthAtOpen(fed, '2025-12-31', undefined)).toEqual(date);
  });
});
