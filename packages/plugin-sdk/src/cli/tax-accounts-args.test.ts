import { describe, expect, it } from 'vitest';
import { dateIn, parseTaxAccountsArgs } from './tax-accounts-args';

describe('pnpm tax-accounts arguments', () => {
  it('reads list, open and close', () => {
    expect(parseTaxAccountsArgs(['list', '--user', 'alice'])).toEqual({
      command: 'list',
      user: 'alice',
    });
    expect(parseTaxAccountsArgs(['open', 'saver', '--user', 'alice'])).toEqual({
      command: 'open',
      user: 'alice',
      accountType: 'saver',
    });
    expect(
      parseTaxAccountsArgs(['open', '--opened-on', '2026-01-05', 'saver', '--user', 'alice']),
    ).toEqual({ command: 'open', user: 'alice', accountType: 'saver', openedOn: '2026-01-05' });
    expect(
      parseTaxAccountsArgs(['close', 'saver', '--user', 'alice', '--on', '2026-06-30']),
    ).toEqual({ command: 'close', user: 'alice', accountType: 'saver', closedOn: '2026-06-30' });
  });

  it('refuses what it does not understand', () => {
    const error = (argv: string[]) => (parseTaxAccountsArgs(argv) as { error: string }).error;
    expect(error([])).toMatch(/^Usage/);
    expect(error(['delete', 'saver', '--user', 'a'])).toMatch(/^Usage/);
    expect(error(['list'])).toMatch(/--user <username>/);
    expect(error(['list', '--user'])).toMatch(/Give a value for --user/);
    expect(error(['list', '--user', '--on'])).toMatch(/Give a value for --user/);
    expect(error(['list', 'saver', '--user', 'a'])).toMatch(/Unexpected argument saver/);
    expect(error(['open', '--user', 'a'])).toMatch(/Name the account type/);
    expect(error(['open', 'saver', 'other', '--user', 'a'])).toMatch(/Unexpected argument other/);
    expect(error(['open', 'saver', '--user', 'a', '--on', '2026-01-01'])).toMatch(
      /Unknown argument --on for pnpm tax-accounts open/,
    );
    expect(error(['close', 'saver', '--user', 'a', '--opened-on', '2026-01-01'])).toMatch(
      /Unknown argument --opened-on/,
    );
    expect(error(['close', 'saver', '--user', 'a', '--user', 'b'])).toMatch(/given twice/);
  });

  it("gives today's date in a time zone", () => {
    const now = new Date('2026-01-05T20:00:00Z');
    expect(dateIn('Asia/Tokyo', now)).toBe('2026-01-06');
    expect(dateIn('America/New_York', now)).toBe('2026-01-05');
  });
});
