// The arguments of `pnpm health` (cli/health.ts), parsed without side effects so they can be
// tested. Anything not understood is refused with a message, never ignored.

export const USAGE =
  'Usage: pnpm health [--date <YYYY-MM-DD>] [--days <N>] [--lang <code>] ' +
  '(default: the last 5 trading days up to the latest graded date)\n' +
  '       pnpm health --summary [--run <id>] [--lang <code>] ' +
  '(the non-green check results of one full-history run, default the latest)\n' +
  '       pnpm health --summary [--run <id>] --check <name> [--symbol <ticker>] ' +
  "[--source <id>] (that check's dates)";

export type HealthArgs =
  | { mode: 'days'; date?: string; days?: string; lang?: string }
  | {
      mode: 'summary';
      run?: string;
      check?: string;
      symbol?: string;
      source?: string;
      lang?: string;
    };

const DAYS_FLAGS = ['date', 'days', 'lang'];
const SUMMARY_FLAGS = ['run', 'check', 'symbol', 'source', 'lang'];

/** The parsed arguments, or the message to refuse them with. */
export function parseHealthArgs(args: string[]): HealthArgs | { error: string } {
  const values = new Map<string, string>();
  let summary = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--summary') {
      if (summary) return { error: 'Give --summary once.' };
      summary = true;
      continue;
    }
    const name = arg.startsWith('--') ? arg.slice(2) : undefined;
    if (!name || ![...DAYS_FLAGS, ...SUMMARY_FLAGS].includes(name)) {
      return { error: `Unknown argument ${arg}.\n${USAGE}` };
    }
    if (values.has(name)) return { error: `Give --${name} once.` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--') || value === '') {
      return { error: `Give a value for --${name}.` };
    }
    values.set(name, value);
    i++;
  }
  const allowed = summary ? SUMMARY_FLAGS : DAYS_FLAGS;
  for (const name of values.keys()) {
    if (!allowed.includes(name)) {
      return {
        error: summary
          ? `--${name} does not go with --summary.\n${USAGE}`
          : `--${name} needs --summary.\n${USAGE}`,
      };
    }
  }
  const get = (name: string) => values.get(name);
  const opt = (name: string) => {
    const v = get(name);
    return v === undefined ? {} : { [name]: v };
  };
  if (!summary) return { mode: 'days', ...opt('date'), ...opt('days'), ...opt('lang') };
  if (!values.has('check') && (values.has('symbol') || values.has('source'))) {
    return { error: `--symbol and --source pick dates within --check <name>.\n${USAGE}` };
  }
  return {
    mode: 'summary',
    ...opt('run'),
    ...opt('check'),
    ...opt('symbol'),
    ...opt('source'),
    ...opt('lang'),
  };
}
