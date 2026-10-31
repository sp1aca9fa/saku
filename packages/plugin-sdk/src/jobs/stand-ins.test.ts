import { Sessions } from '@saku/data';
import type { StandInListRow } from '@saku/db';
import { describe, expect, it } from 'vitest';
import { ageInSessions, standInListText } from './stand-ins';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-01-19'],
});

const row = (over: Partial<StandInListRow> = {}): StandInListRow => ({
  ticker: 'AAA',
  date: '2026-01-07',
  source: 's',
  close: 100.5,
  band: 0.001,
  basis: 'index',
  createdAt: '2026-01-07T21:30:00.000Z',
  primaryClose: null,
  deviation: null,
  resolvedAt: null,
  closedAt: null,
  closedBy: null,
  closeReason: null,
  canonical: { source: 's', standIn: true, divCash: 0 },
  ...over,
});

describe('pnpm sources stand-in list', () => {
  it('ages in sessions, unknown outside the calendar', () => {
    expect(ageInSessions(sessions, '2026-01-07', '2026-01-07')).toBe(0);
    expect(ageInSessions(sessions, '2026-01-07', '2026-01-08')).toBe(1);
    // A weekend and a holiday are not sessions.
    expect(ageInSessions(sessions, '2026-01-16', '2026-01-20')).toBe(1);
    expect(ageInSessions(sessions, '2019-03-04', '2026-01-08')).toBeUndefined();
  });

  it('says whether a canonical bar uses it, and an open one without a bar is refused', () => {
    const lines = standInListText(
      [
        row(),
        row({ ticker: 'BBB', canonical: { source: 's', standIn: true, divCash: 0.25 } }),
        row({ ticker: 'CCC', canonical: null }),
        row({
          ticker: 'DDD',
          canonical: null,
          closedAt: '2026-02-01T10:00:00.000Z',
          closedBy: 'ada',
          closeReason: 'primary will not deliver',
        }),
        row({
          ticker: 'EEE',
          canonical: { source: 'p', standIn: false, divCash: 0 },
          resolvedAt: '2026-01-08T21:30:00.000Z',
          deviation: 0.0012,
        }),
        row({ ticker: 'FFF', date: '2019-03-04' }),
      ],
      { sessions, today: '2026-01-09', open: false },
    );
    expect(lines).toEqual([
      'ticker  date  source  close  band  age (sessions to 2026-01-09)  state  canonical bar',
      'AAA  2026-01-07  s  100.5  0.100%  2  open  canonical bar uses it (from s)',
      'BBB  2026-01-07  s  100.5  0.100%  2  open  canonical bar uses it (from s), distribution ' +
        'day (0.25: total-return signals read it at any age)',
      'CCC  2026-01-07  s  100.5  0.100%  2  open  refused, no canonical bar (the day reads as ' +
        'missing; still holds corrections back until resolved or closed)',
      'DDD  2026-01-07  s  100.5  0.100%  2  closed 2026-02-01T10:00:00.000Z by ada: primary ' +
        'will not deliver  no canonical bar',
      'EEE  2026-01-07  s  100.5  0.100%  2  resolved 2026-01-08T21:30:00.000Z (primary off by ' +
        '0.120%)  canonical bar from p (not a stand-in)',
      'FFF  2019-03-04  s  100.5  0.100%  unknown (outside the calendar)  open  canonical bar ' +
        'uses it (from s)',
    ]);
  });

  it('the open list names the close command; an empty list says so', () => {
    expect(standInListText([], { sessions, today: '2026-01-09', open: true })).toEqual([
      'No open stand-ins.',
    ]);
    expect(standInListText([], { sessions, today: '2026-01-09', open: false })).toEqual([
      'No stand-ins stored.',
    ]);
    expect(
      standInListText([row()], { sessions, today: '2026-01-09', open: true }).at(-1),
    ).toContain('pnpm sources stand-in close <TICKER> <YYYY-MM-DD> --reason');
  });
});
