import { describe, expect, it } from 'vitest';
import { parseAuditArgs } from './audit-args';

describe('parseAuditArgs', () => {
  it('reads the month and the language', () => {
    expect(parseAuditArgs([])).toEqual({});
    expect(parseAuditArgs(['--month', '2026-10', '--lang', 'ja'])).toEqual({
      month: '2026-10',
      lang: 'ja',
    });
  });

  it('refuses unknown, repeated, valueless and malformed arguments', () => {
    const error = (args: string[]) => {
      const r = parseAuditArgs(args);
      return 'error' in r ? r.error : undefined;
    };
    expect(error(['--mnth', '2026-10'])).toMatch(/Unknown argument --mnth/);
    expect(error(['2026-10'])).toMatch(/Unknown argument 2026-10/);
    expect(error(['--month=2026-10'])).toMatch(/Unknown argument --month=2026-10/);
    expect(error(['--month', '2026-10', '--month', '2026-09'])).toMatch(/once/);
    expect(error(['--month'])).toMatch(/value for --month/);
    expect(error(['--month', '--lang', 'ja'])).toMatch(/value for --month/);
    for (const bad of ['2026-13', '2026-1', '26-10', '2026-10-01']) {
      expect(error(['--month', bad])).toMatch(/YYYY-MM/);
    }
  });
});
