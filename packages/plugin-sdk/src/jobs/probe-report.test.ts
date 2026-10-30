import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Calendar } from '@saku/core';
import { Sessions } from '@saku/data';
import { describe, expect, it } from 'vitest';
import type { ProbeLine } from './probe';
import { closeInstant, probeReport, readProbeFile } from './probe-report';

const bar = (at: string, date: string, close: number, source = 'alpha'): ProbeLine => ({
  at,
  source,
  ticker: 'T',
  date,
  close,
  divCash: 0,
});

const cal: Calendar = {
  id: 'xnys',
  version: 'test-1',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: ['2026-11-26'],
  earlyCloses: { from: '2026-01-01', to: '2026-12-31', time: '13:00', dates: ['2026-11-27'] },
};
const sessions = new Sessions(cal);

describe('closeInstant', () => {
  it('is 16:00 New York on both sides of daylight saving time', () => {
    expect(new Date(closeInstant('2026-03-06')).toISOString()).toBe('2026-03-06T21:00:00.000Z');
    expect(new Date(closeInstant('2026-03-09')).toISOString()).toBe('2026-03-09T20:00:00.000Z');
    expect(new Date(closeInstant('2026-10-30')).toISOString()).toBe('2026-10-30T20:00:00.000Z');
    expect(new Date(closeInstant('2026-11-02')).toISOString()).toBe('2026-11-02T21:00:00.000Z');
  });

  it('takes an early close time', () => {
    expect(new Date(closeInstant('2026-11-27', '13:00')).toISOString()).toBe(
      '2026-11-27T18:00:00.000Z',
    );
    expect(new Date(closeInstant('2025-07-03', '13:00')).toISOString()).toBe(
      '2025-07-03T17:00:00.000Z',
    );
  });
});

describe('probeReport', () => {
  const lines: ProbeLine[] = [
    // Winter date: close 21:00Z. Seen 21:30Z, changed 23:30Z, stable after.
    bar('2026-03-06T21:30:00.000Z', '2026-03-06', 10),
    bar('2026-03-06T23:30:00.000Z', '2026-03-06', 10.5),
    bar('2026-03-07T10:00:00.000Z', '2026-03-06', 10.5),
    // Summer date: close 20:00Z. First seen 19:00Z (before the close), never changed.
    bar('2026-03-09T19:00:00.000Z', '2026-03-09', 11),
    bar('2026-03-09T20:30:00.000Z', '2026-03-09', 11),
    bar('2026-03-10T21:00:00.000Z', '2026-03-10', 12),
    { at: '2026-03-09T20:30:00.000Z', source: 'alpha', ticker: 'T', error: 'rate limited' },
    { at: '2026-03-09T21:30:00.000Z', source: 'alpha', ticker: 'T', error: 'rate limited' },
    { at: '2026-03-09T22:30:00.000Z', source: 'alpha', ticker: 'T', error: 'no bars' },
  ].sort((a, b) => a.at.localeCompare(b.at));

  it('lists times and minutes after the close, the summary and the resolution', () => {
    const text = probeReport({ lines, unreadable: 0, sessions });
    expect(text).toContain('at most one hour late');
    expect(text).toMatch(
      /2026-03-06\s+16:00\s+2026-03-06 16:30\s+30\s+2026-03-06 18:30\s+150\s+1\s*$/m,
    );
    expect(text).toMatch(
      /2026-03-09\s+16:00\s+2026-03-09 15:00\s+-60\s+2026-03-09 15:00\s+-60\s+0\s*$/m,
    );
    expect(text).toMatch(/2026-03-10 .*\s0\s+may still change/);
    expect(text).toContain('dates seen 3');
    expect(text).toContain('median 45 min, maximum 150 min (1 left out, may still change)');
    expect(text).toContain('error lines 3, most frequent: rate limited (2x)');
  });

  it('filters by --from and reports unreadable lines', () => {
    const text = probeReport({ lines, unreadable: 2, from: '2026-03-09', sessions });
    expect(text).toContain('Unreadable lines in the file (not counted below): 2.');
    expect(text).toContain('dates seen 2');
    expect(text).not.toMatch(/^2026-03-06/m);
  });

  it('sorts out-of-order lines and says what the last probe was', () => {
    const text = probeReport({ lines: [...lines].reverse(), unreadable: 0, sessions });
    expect(text).toMatch(
      /2026-03-06\s+16:00\s+2026-03-06 16:30\s+30\s+2026-03-06 18:30\s+150\s+1\s*$/m,
    );
    expect(text).toContain('last probe: 2026-03-10 17:00, ok');
    expect(text).toContain('from calendar test-1');
    expect(text).toContain('or the early close on a half-day ("13:00 early")');
  });

  it('shows a source whose last probe failed, and one with only errors', () => {
    const text = probeReport({
      lines: [
        bar('2026-03-06T21:30:00.000Z', '2026-03-06', 10),
        { at: '2026-03-07T10:00:00.000Z', source: 'alpha', ticker: 'T', error: 'timeout' },
        { at: '2026-03-07T10:00:00.000Z', source: 'beta', ticker: 'T', error: 'no bars' },
      ],
      unreadable: 0,
      sessions,
    });
    expect(text).toContain('last probe: 2026-03-07 05:00, error: timeout');
    expect(text).toContain('last probe: 2026-03-07 05:00, error: no bars');
    expect(text).toContain('Summary beta: dates seen 0; last change after close: no settled dates');
  });

  it('has no settled dates when only one probe remains', () => {
    const text = probeReport({
      lines: [bar('2026-03-06T21:30:00.000Z', '2026-03-06', 10)],
      unreadable: 0,
      sessions,
    });
    expect(text).toContain('no settled dates (1 left out, may still change)');
  });

  it('counts from 13:00 on an early close from the calendar', () => {
    // 2026-11-27 (New York UTC-5): close 18:00Z. Seen 18:30Z, changed 20:30Z, stable after.
    const text = probeReport({
      lines: [
        bar('2026-11-27T18:30:00.000Z', '2026-11-27', 10),
        bar('2026-11-27T20:30:00.000Z', '2026-11-27', 10.5),
        bar('2026-11-28T10:00:00.000Z', '2026-11-27', 10.5),
      ],
      unreadable: 0,
      sessions,
    });
    expect(text).toMatch(
      /2026-11-27\s+13:00 early\s+2026-11-27 13:30\s+30\s+2026-11-27 15:30\s+150\s+1\s*$/m,
    );
    expect(text).toContain('median 150 min, maximum 150 min (0 left out, may still change)');
  });

  it('counts from 16:00 where early closes are unknown, says so and leaves the date out', () => {
    const partial = new Sessions({
      ...cal,
      earlyCloses: { ...cal.earlyCloses!, from: '2026-06-01' },
    });
    const day = [
      bar('2026-03-06T21:30:00.000Z', '2026-03-06', 10),
      bar('2026-03-06T23:30:00.000Z', '2026-03-06', 10.5),
      bar('2026-03-07T10:00:00.000Z', '2026-03-06', 10.5),
      bar('2026-03-09T21:00:00.000Z', '2026-03-09', 11),
    ];
    const row = /2026-03-06\s+16:00 \?\s+2026-03-06 16:30\s+30\s+2026-03-06 18:30\s+150\s+1\s*$/m;
    const left = 'no settled dates (1 left out, may still change; 1 left out, close time unknown)';
    // Before the calendar's early-close range.
    let text = probeReport({ lines: day, unreadable: 0, sessions: partial });
    expect(text).toMatch(row);
    expect(text).toContain(left);
    // No calendar loaded.
    text = probeReport({ lines: day, unreadable: 0 });
    expect(text).toContain('no calendar is loaded');
    // Without a calendar the header makes no early-close claim.
    expect(text).not.toContain('13:00');
    expect(text).not.toContain('early close on a half-day');
    expect(text).toMatch(row);
    expect(text).toContain(left);
    // A date outside the calendar, and one that is no session (a Saturday): no throw.
    text = probeReport({
      lines: [
        bar('2027-01-04T22:00:00.000Z', '2027-01-04', 10),
        bar('2026-03-07T22:00:00.000Z', '2026-03-07', 10),
        bar('2027-01-05T22:00:00.000Z', '2027-01-05', 10),
      ],
      unreadable: 0,
      sessions,
    });
    expect(text).toMatch(/^2027-01-04\s+16:00 \?/m);
    expect(text).toMatch(/^2026-03-07\s+16:00 \?/m);
    expect(text).toContain('2 left out, close time unknown');
  });

  it('says so with no lines', () => {
    expect(probeReport({ lines: [], unreadable: 0 })).toContain('No probe lines.');
  });
});

describe('readProbeFile', () => {
  it('counts lines that are not JSON or lack the fields', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'probe-')), 'probe.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify(bar('2026-03-06T21:30:00.000Z', '2026-03-06', 10)),
        '{not json',
        JSON.stringify({ source: 'a' }),
        JSON.stringify({ at: 'x', source: 'a' }),
        JSON.stringify({ ...bar('2026-03-06T21:30:00.000Z', '2026-02-30', 1) }),
        JSON.stringify({ ...bar('2026-03-06T21:30:00.000Z', '2026-13-45', 1) }),
        '',
      ].join('\n'),
    );
    const r = readProbeFile(file);
    expect(r.lines).toHaveLength(1);
    expect(r.unreadable).toBe(5);
  });
});
