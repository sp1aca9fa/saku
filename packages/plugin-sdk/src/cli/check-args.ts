// The arguments of `pnpm strategy check` (cli/strategy.ts), parsed without side effects so they can
// be tested. Anything not understood is refused with a message, never ignored.

export const CHECK_USAGE =
  'Usage: pnpm strategy check <file.json> [--registration [--user <username> | --library]]';

export interface CheckArgs {
  file: string;
  registration: boolean;
  user?: string;
  library: boolean;
}

/** `rest`: the arguments after `strategy check`. */
export function parseCheckArgs(rest: string[]): CheckArgs | { error: string } {
  let file: string | undefined;
  let registration = false;
  let library = false;
  let user: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--registration') registration = true;
    else if (arg === '--library') library = true;
    else if (arg === '--user') {
      const value = rest[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: `Give a username for --user.\n${CHECK_USAGE}` };
      }
      user = value;
      i++;
    } else if (arg.startsWith('--')) {
      return { error: `Unknown argument ${arg} for pnpm strategy check.\n${CHECK_USAGE}` };
    } else if (file === undefined) file = arg;
    else return { error: `Unexpected argument ${arg}.\n${CHECK_USAGE}` };
  }
  if (file === undefined) return { error: `Name the strategy file (JSON).\n${CHECK_USAGE}` };
  if ((user !== undefined || library) && !registration) {
    return { error: `--user and --library go with --registration.\n${CHECK_USAGE}` };
  }
  if (user !== undefined && library) return { error: `Give --user or --library, not both.` };
  return { file, registration, library, ...(user !== undefined && { user }) };
}
