import { describe, expect, it } from 'vitest';
import { parseHealthArgs } from './health-args';

describe('parseHealthArgs', () => {
  it('reads the per-day report and the summary', () => {
    expect(parseHealthArgs([])).toEqual({ mode: 'days' });
    expect(parseHealthArgs(['--date', '2026-01-05', '--lang', 'ja'])).toEqual({
      mode: 'days',
      date: '2026-01-05',
      lang: 'ja',
    });
    expect(parseHealthArgs(['--summary'])).toEqual({ mode: 'summary' });
    expect(
      parseHealthArgs(['--run', 'r1', '--summary', '--check', 'close_match', '--symbol', 'AAA']),
    ).toEqual({ mode: 'summary', run: 'r1', check: 'close_match', symbol: 'AAA' });
  });

  it('refuses unknown, repeated, valueless and mismatched flags', () => {
    const error = (args: string[]) => {
      const r = parseHealthArgs(args);
      return 'error' in r ? r.error : undefined;
    };
    expect(error(['--sumary'])).toMatch(/Unknown argument --sumary/);
    expect(error(['extra'])).toMatch(/Unknown argument extra/);
    expect(error(['--summary', '--summary'])).toMatch(/once/);
    expect(error(['--date', '2026-01-05', '--date', '2026-01-06'])).toMatch(/once/);
    expect(error(['--summary', '--run'])).toMatch(/value for --run/);
    expect(error(['--summary', '--run', '--check', 'x'])).toMatch(/value for --run/);
    expect(error(['--run', 'r1'])).toMatch(/needs --summary/);
    expect(error(['--check', 'x'])).toMatch(/needs --summary/);
    expect(error(['--summary', '--date', '2026-01-05'])).toMatch(/does not go with --summary/);
    expect(error(['--summary', '--days', '3'])).toMatch(/does not go with --summary/);
    expect(error(['--summary', '--symbol', 'AAA'])).toMatch(/within --check/);
    expect(error(['--summary', '--source', 's2'])).toMatch(/within --check/);
  });

  it('reads --values with its group options, and refuses what does not fit', () => {
    expect(parseHealthArgs(['--summary', '--values'])).toEqual({ mode: 'summary', values: true });
    expect(
      parseHealthArgs(['--summary', '--values', '--per-group', '12', '--status', 'all']),
    ).toEqual({ mode: 'summary', values: true, perGroup: 12, status: 'all' });
    expect(
      parseHealthArgs(['--summary', '--check', 'close_match', '--values', '--symbol', 'AAA']),
    ).toEqual({ mode: 'summary', check: 'close_match', symbol: 'AAA', values: true });
    expect(parseHealthArgs(['--summary', '--values', '--per-group', '1'])).toMatchObject({
      perGroup: 1,
    });
    expect(parseHealthArgs(['--summary', '--values', '--per-group', '50'])).toMatchObject({
      perGroup: 50,
    });
    const error = (args: string[]) => {
      const r = parseHealthArgs(args);
      return 'error' in r ? r.error : undefined;
    };
    expect(error(['--values'])).toMatch(/--values needs --summary/);
    expect(error(['--summary', '--values', '--values'])).toMatch(/once/);
    expect(error(['--summary', '--per-group', '3'])).toMatch(/--per-group needs --values/);
    expect(error(['--summary', '--status', 'red'])).toMatch(/--status needs --values/);
    expect(error(['--per-group', '3'])).toMatch(/needs --summary/);
    for (const n of ['0', '51', '2.5', '-1', 'five', '1e1']) {
      expect(error(['--summary', '--values', '--per-group', n])).toMatch(/1 to 50/);
    }
    expect(error(['--summary', '--values', '--status', 'green'])).toMatch(/red, yellow or all/);
    expect(error(['--summary', '--values', '--status', 'RED'])).toMatch(/red, yellow or all/);
    expect(error(['--summary', '--values', '--check', 'close_match', '--per-group', '3'])).toMatch(
      /with --check every listed date/,
    );
    expect(error(['--summary', '--values', '--check', 'x', '--status', 'all'])).toMatch(
      /with --check every listed date/,
    );
  });
});
