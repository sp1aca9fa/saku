// `pnpm strategy register` and `pnpm strategy recompute` (cli/strategy.ts), as functions the tests
// call. Both hold the jobs lock, so they never run during a job: registration reads check results
// and bar grades a run may be rewriting, and recompute writes append-only annotations a run writes
// too (a race could store one twice or compute on half-rebuilt bars). The CLI prints the output
// and exits with the code.
import type { Strategy, TradingDate } from '@saku/core';
import type { Sessions } from '@saku/data';
import { type Db, registerVersion } from '@saku/db';
import { annotateStandInCorrections, recompute } from './forward';
import { lock } from './lock';
import { registrationProblems } from './registration';

export interface CommandOutput {
  exitCode: 0 | 1;
  stdout: string[];
  stderr: string[];
}

const refused = (message: string): CommandOutput => ({
  exitCode: 1,
  stdout: [],
  stderr: [message],
});

/** Runs `fn` holding the jobs lock, or refuses while a job holds it. */
async function withJobsLock(
  lockDir: string | undefined,
  fn: () => Promise<CommandOutput>,
): Promise<CommandOutput> {
  const held = lockDir ? lock('jobs', lockDir) : lock('jobs');
  if ('heldBy' in held) {
    return refused(`A job is running (process ${held.heldBy}); try again when it is done.`);
  }
  try {
    return await fn();
  } finally {
    held.release();
  }
}

/** Registers the strategy when nothing refuses it (registration.ts); otherwise every reason. */
export function registerStrategy(
  db: Db,
  o: {
    strategy: Strategy;
    ownerId: string | null;
    /** The latest session whose data is final now (`dailyTarget`). */
    through: TradingDate;
    /** The market calendar. */
    sessions: Sessions;
    /** The jobs lock's folder (default: the state dir's). */
    lockDir?: string;
  },
): Promise<CommandOutput> {
  return withJobsLock(o.lockDir, async () => {
    const problems = await registrationProblems(db, o.strategy, {
      through: o.through,
      sessions: o.sessions,
    });
    if (problems.length > 0) {
      return refused(`Not registered:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    }
    const v = await registerVersion(db, {
      ownerId: o.ownerId,
      name: o.strategy.name,
      strategy: o.strategy,
    });
    return {
      exitCode: 0,
      stdout: [
        `Registered ${o.strategy.name}: version ${v.id}, hash ${v.hash}.`,
        'Its forward record starts with the first close after now.',
      ],
      stderr: [],
    };
  });
}

/**
 * The current engine against every recorded day: corrected stand-ins first, as the runs do (a day
 * one explains is not a recompute difference), then the differences annotated. Exit 1 when there
 * is a difference or something could not be checked.
 */
export function recomputeRecords(
  db: Db,
  o: { code: string; lockDir?: string },
): Promise<CommandOutput> {
  return withJobsLock(o.lockDir, async () => {
    const out: string[] = [];
    const c = await annotateStandInCorrections(db, null);
    if (c.annotations) out.push(`${c.annotations} stand-in corrections annotated.`);
    out.push(...c.errors);
    const r = await recompute(db, { runId: null, code: o.code });
    for (const d of r.differences) {
      out.push(`${d.version} ${d.date}: recorded ${d.recorded}, now ${d.now} (annotated)`);
    }
    for (const e of r.errors) {
      const what = e.kind === 'parse' ? 'definition does not parse' : 'could not evaluate';
      out.push(`${e.version}: ${what} (${e.error})`);
    }
    if (r.differences.length) out.push('The next daily run alerts the admins.');
    out.push(`${r.checked} recorded days, ${r.differences.length} new differences.`);
    const bad = r.differences.length || r.errors.length || c.errors.length;
    return { exitCode: bad ? 1 : 0, stdout: out, stderr: [] };
  });
}
