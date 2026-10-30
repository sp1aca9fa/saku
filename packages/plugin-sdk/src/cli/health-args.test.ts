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
});
