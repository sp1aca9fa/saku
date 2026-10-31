// The arguments of `pnpm audit-report` (cli/audit.ts), parsed without side effects so they can be
// tested. Anything not understood is refused with a message, never ignored.
import { isMonth } from '../jobs/audit';

export const USAGE =
  'Usage: pnpm audit-report [--month <YYYY-MM>] [--lang <code>] ' +
  "(default: the previous calendar month in the install's time zone)";

export interface AuditArgs {
  month?: string;
  lang?: string;
}

/** The parsed arguments, or the message to refuse them with. */
export function parseAuditArgs(args: string[]): AuditArgs | { error: string } {
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.startsWith('--') ? arg.slice(2) : undefined;
    if (name !== 'month' && name !== 'lang') return { error: `Unknown argument ${arg}.\n${USAGE}` };
    if (named.has(name)) return { error: `Give --${name} once.` };
    const value = args[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { error: `Give a value for --${name}.` };
    }
    named.set(name, value);
    i++;
  }
  const month = named.get('month');
  if (month !== undefined && !isMonth(month)) {
    return { error: `Give --month as YYYY-MM, like --month 2026-10 (not ${month}).` };
  }
  const lang = named.get('lang');
  return { ...(month !== undefined && { month }), ...(lang !== undefined && { lang }) };
}
