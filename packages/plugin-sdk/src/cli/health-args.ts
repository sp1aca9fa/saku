// The arguments of `pnpm health` (cli/health.ts), parsed without side effects so they can be
// tested. Anything not understood is refused with a message, never ignored.
import { PER_GROUP_DEFAULT, PER_GROUP_MAX, VALUES_CAP } from '../jobs/health-values';

export const USAGE =
  'Usage: pnpm health [--date <YYYY-MM-DD>] [--days <N>] [--lang <code>] ' +
  '(default: the last 5 trading days up to the latest graded date)\n' +
  '       pnpm health --summary [--run <id>] [--lang <code>] ' +
  '(the non-green check results of one full-history run, default the latest)\n' +
  '       pnpm health --summary [--run <id>] --check <name> [--symbol <ticker>] ' +
  "[--source <id>] (that check's dates)\n" +
  '       pnpm health --summary --values [--run <id>] [--per-group <N>] ' +
  `[--status red|yellow|all] (the stored values behind up to N dates per group, default ` +
  `${PER_GROUP_DEFAULT}, red only; with --check: behind each listed date, at most ${VALUES_CAP})`;

export type StatusFilter = 'red' | 'yellow' | 'all';

export type HealthArgs =
  | { mode: 'days'; date?: string; days?: string; lang?: string }
  | {
      mode: 'summary';
      run?: string;
      check?: string;
      symbol?: string;
      source?: string;
      lang?: string;
      /** Show the stored values behind the results (`--values`). */
      values?: true;
      /** Dates per group with `--values` (1 to PER_GROUP_MAX). */
      perGroup?: number;
      /** The groups `--values` shows (default red). */
      status?: StatusFilter;
    };

const DAYS_FLAGS = ['date', 'days', 'lang'];
const SUMMARY_FLAGS = ['run', 'check', 'symbol', 'source', 'lang', 'per-group', 'status'];
const VALUES_FLAGS = ['per-group', 'status'];

/** The parsed arguments, or the message to refuse them with. */
export function parseHealthArgs(args: string[]): HealthArgs | { error: string } {
  const named = new Map<string, string>();
  let summary = false;
  let values = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--summary') {
      if (summary) return { error: 'Give --summary once.' };
      summary = true;
      continue;
    }
    if (arg === '--values') {
      if (values) return { error: 'Give --values once.' };
      values = true;
      continue;
    }
    const name = arg.startsWith('--') ? arg.slice(2) : undefined;
    if (!name || ![...DAYS_FLAGS, ...SUMMARY_FLAGS].includes(name)) {
      return { error: `Unknown argument ${arg}.\n${USAGE}` };
    }
    if (named.has(name)) return { error: `Give --${name} once.` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--') || value === '') {
      return { error: `Give a value for --${name}.` };
    }
    named.set(name, value);
    i++;
  }
  if (values && !summary) return { error: `--values needs --summary.\n${USAGE}` };
  const allowed = summary ? SUMMARY_FLAGS : DAYS_FLAGS;
  for (const name of named.keys()) {
    if (!allowed.includes(name)) {
      return {
        error: summary
          ? `--${name} does not go with --summary.\n${USAGE}`
          : `--${name} needs --summary.\n${USAGE}`,
      };
    }
  }
  const get = (name: string) => named.get(name);
  const opt = (name: string) => {
    const v = get(name);
    return v === undefined ? {} : { [name]: v };
  };
  if (!summary) return { mode: 'days', ...opt('date'), ...opt('days'), ...opt('lang') };
  if (!named.has('check') && (named.has('symbol') || named.has('source'))) {
    return { error: `--symbol and --source pick dates within --check <name>.\n${USAGE}` };
  }
  for (const name of VALUES_FLAGS) {
    if (!named.has(name)) continue;
    if (!values) return { error: `--${name} needs --values.\n${USAGE}` };
    // A --check listing shows every date of the check (at most VALUES_CAP), not groups.
    if (named.has('check')) {
      return {
        error: `--${name} picks groups; with --check every listed date is shown.\n${USAGE}`,
      };
    }
  }
  let perGroup: number | undefined;
  const n = get('per-group');
  if (n !== undefined) {
    perGroup = /^\d+$/.test(n) ? Number(n) : Number.NaN;
    if (!Number.isInteger(perGroup) || perGroup < 1 || perGroup > PER_GROUP_MAX) {
      return { error: `--per-group is a whole number from 1 to ${PER_GROUP_MAX}.` };
    }
  }
  const status = get('status');
  if (status !== undefined && !['red', 'yellow', 'all'].includes(status)) {
    return { error: `--status is red, yellow or all, not ${status}.` };
  }
  return {
    mode: 'summary',
    ...opt('run'),
    ...opt('check'),
    ...opt('symbol'),
    ...opt('source'),
    ...opt('lang'),
    ...(values && { values: true as const }),
    ...(perGroup !== undefined && { perGroup }),
    ...(status !== undefined && { status: status as StatusFilter }),
  };
}
