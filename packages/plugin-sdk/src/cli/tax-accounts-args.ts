// The arguments of `pnpm tax-accounts` (cli/tax-accounts.ts), parsed without side effects so they
// can be tested. Anything not understood is refused with a message, never ignored.

export const TAX_ACCOUNTS_USAGE = [
  'Usage: pnpm tax-accounts list --user <username>',
  '       pnpm tax-accounts open <account type> --user <username> [--opened-on YYYY-MM-DD]',
  '       pnpm tax-accounts close <account type> --user <username> [--on YYYY-MM-DD]',
].join('\n');

export type TaxAccountsArgs =
  | { command: 'list'; user: string }
  | { command: 'open'; user: string; accountType: string; openedOn?: string }
  | { command: 'close'; user: string; accountType: string; closedOn?: string };

/** `argv`: the arguments after `tax-accounts`. */
export function parseTaxAccountsArgs(argv: string[]): TaxAccountsArgs | { error: string } {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'open' && command !== 'close') {
    return { error: TAX_ACCOUNTS_USAGE };
  }
  const allowed: Record<string, string[]> = {
    list: ['--user'],
    open: ['--user', '--opened-on'],
    close: ['--user', '--on'],
  };
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      if (!allowed[command]!.includes(arg)) {
        return {
          error: `Unknown argument ${arg} for pnpm tax-accounts ${command}.\n${TAX_ACCOUNTS_USAGE}`,
        };
      }
      const value = rest[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: `Give a value for ${arg}.\n${TAX_ACCOUNTS_USAGE}` };
      }
      if (arg in flags) return { error: `${arg} is given twice.` };
      flags[arg] = value;
      i++;
    } else positional.push(arg);
  }
  const user = flags['--user'];
  if (user === undefined)
    return { error: `Name the account: --user <username>.\n${TAX_ACCOUNTS_USAGE}` };
  if (command === 'list') {
    if (positional.length > 0)
      return { error: `Unexpected argument ${positional[0]}.\n${TAX_ACCOUNTS_USAGE}` };
    return { command, user };
  }
  if (positional.length === 0) return { error: `Name the account type.\n${TAX_ACCOUNTS_USAGE}` };
  if (positional.length > 1)
    return { error: `Unexpected argument ${positional[1]}.\n${TAX_ACCOUNTS_USAGE}` };
  const accountType = positional[0]!;
  if (command === 'open') {
    const openedOn = flags['--opened-on'];
    return { command, user, accountType, ...(openedOn !== undefined && { openedOn }) };
  }
  const closedOn = flags['--on'];
  return { command, user, accountType, ...(closedOn !== undefined && { closedOn }) };
}
