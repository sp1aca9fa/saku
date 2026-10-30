// The arguments of the jobs CLI (cli/jobs.ts), parsed without side effects so they can be tested.
// Anything not understood is refused with a message, never ignored (a typo such as `--form`, or
// `--from=<date>`, must not silently run with the default).

export const JOBS = ['bootstrap', 'daily', 'weekly', 'verify', 'checks', 'probe', 'spike'] as const;
export type Job = (typeof JOBS)[number];

export const USAGE =
  'Usage: pnpm bootstrap | pnpm daily [--force] | pnpm weekly | pnpm verify | pnpm checks | ' +
  'pnpm probe | pnpm spike [--from <YYYY-MM-DD>]';

export interface JobArgs {
  job: Job;
  /** `pnpm daily --force`: run again for the latest final day. */
  force: boolean;
  /** `pnpm spike --from <value>`: as given (checked against the calendar by `spikeFrom`). */
  from?: string;
}

/** `argv`: the arguments from the job name on (`process.argv.slice(2)`). */
export function parseJobArgs(argv: string[]): JobArgs | { error: string } {
  const [name, ...rest] = argv;
  if (!name || !(JOBS as readonly string[]).includes(name)) {
    return { error: name ? `Unknown job ${name}.\n${USAGE}` : USAGE };
  }
  const job = name as Job;
  let force = false;
  let from: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (job === 'daily' && arg === '--force') {
      if (force) return { error: 'Give --force once.' };
      force = true;
      continue;
    }
    if (job === 'spike' && arg === '--from') {
      if (from !== undefined) return { error: 'Give --from once.' };
      const value = rest[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: 'Give a date for --from, like --from 2026-10-30.' };
      }
      from = value;
      i++;
      continue;
    }
    return { error: `Unknown argument ${arg} for pnpm ${job}.\n${USAGE}` };
  }
  return { job, force, ...(from !== undefined && { from }) };
}
