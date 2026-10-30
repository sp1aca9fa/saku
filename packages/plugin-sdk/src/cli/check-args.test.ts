import { describe, expect, it } from 'vitest';
import { parseCheckArgs } from './check-args';

describe('parseCheckArgs', () => {
  it('takes the first non-flag argument as the file, wherever the flags are', () => {
    expect(parseCheckArgs(['--registration', 'a.json'])).toEqual({
      file: 'a.json',
      registration: true,
      library: false,
    });
    expect(parseCheckArgs(['a.json'])).toEqual({
      file: 'a.json',
      registration: false,
      library: false,
    });
  });

  it('refuses an unknown flag, so a typo never ends in a plain "valid"', () => {
    expect(parseCheckArgs(['a.json', '--registrations'])).toMatchObject({
      error: expect.stringContaining('Unknown argument --registrations'),
    });
  });

  it('reads --user and --library with --registration only', () => {
    expect(parseCheckArgs(['a.json', '--registration', '--user', 'ann'])).toMatchObject({
      user: 'ann',
    });
    expect(parseCheckArgs(['a.json', '--registration', '--library'])).toMatchObject({
      library: true,
    });
    expect(parseCheckArgs(['a.json', '--user', 'ann'])).toHaveProperty('error');
    expect(parseCheckArgs(['a.json', '--registration', '--user'])).toHaveProperty('error');
    expect(parseCheckArgs(['a.json', '--registration', '--user', 'a', '--library'])).toHaveProperty(
      'error',
    );
  });

  it('refuses a missing or second file', () => {
    expect(parseCheckArgs(['--registration'])).toHaveProperty('error');
    expect(parseCheckArgs(['a.json', 'b.json'])).toHaveProperty('error');
  });
});
