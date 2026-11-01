// `pnpm strategy register` and `pnpm strategy recompute` (cli/strategy.ts), as functions the tests
// call. Both hold the jobs lock, so they never run during a job: registration reads check results
// and bar grades a run may be rewriting, and recompute writes append-only annotations a run writes
// too (a race could store one twice or compute on half-rebuilt bars). The CLI prints the output
// and exits with the code.
import { type Strategy, type TradingDate, dependencies } from '@saku/core';
import type { Sessions } from '@saku/data';
import { type Db, registerVersion } from '@saku/db';
import { annotateStandInCorrections, recompute } from './forward';
import { costsLine, effectiveCosts } from './costs';
import { lock } from './lock';
import { registrationReport } from './registration';

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

/** Registration's inputs, shared by `register` and `check --registration`. */
interface RegistrationInput {
  strategy: Strategy;
  /** The latest session whose data is final now (`dailyTarget`). */
  through: TradingDate;
  /** The market calendar. */
  sessions: Sessions;
  /** The jobs lock's folder (default: the state dir's). */
  lockDir?: string;
}

const problemList = (problems: string[]) => problems.map((p) => `- ${p}`).join('\n');
/** Information that does not refuse (bars on closed days, left out), printed either way. */
const noteLines = (notes: string[]) =>
  notes.length > 0 ? ['Note:', ...notes.map((n) => `- ${n}`)] : [];

/**
 * What `register` would say, without registering: the same problems from the same function,
 * under the same lock. Writes nothing.
 */
export function previewRegistration(db: Db, o: RegistrationInput): Promise<CommandOutput> {
  return withJobsLock(o.lockDir, async () => {
    const { problems, notes, costs } = await registrationReport(db, o.strategy, {
      through: o.through,
      sessions: o.sessions,
    });
    if (problems.length > 0 || !costs) {
      return {
        ...refused(`Would not register:\n${problemList(problems)}`),
        stdout: noteLines(notes),
      };
    }
    return {
      exitCode: 0,
      stdout: ['Ready to register.', costsLine(costs), ...noteLines(notes)],
      stderr: [],
    };
  });
}

/**
 * `pnpm strategy check` after the file's summary: the costs it would run with and whether it is
 * valid. Unknown costs (a cost omitted with no usable `broker_costs`) exit 1, never read as 0.
 * With `registration`, every reason register would refuse is listed (`previewRegistration`), the
 * unknown costs among them, and the exit is 1 when there is any.
 */
export async function checkStrategy(
  db: Db,
  strategy: Strategy,
  registration?: Omit<RegistrationInput, 'strategy'>,
): Promise<CommandOutput> {
  const costs = await effectiveCosts(db, strategy);
  const known = !('problem' in costs);
  const lines = known
    ? [
        costsLine(costs),
        `${strategy.name}: valid; depends on ${dependencies(strategy).join(', ')}.`,
      ]
    : [];
  if (!registration) {
    return known
      ? { exitCode: 0, stdout: lines, stderr: [] }
      : refused(`Costs not known: ${(costs as { problem: string }).problem}`);
  }
  const out = await previewRegistration(db, { strategy, ...registration });
  // The preview repeats the costs line when ready; printed once.
  const preview = out.stdout.filter((l) => !lines.includes(l));
  return { ...out, stdout: [...lines, ...preview] };
}

/**
 * Registers the strategy when nothing refuses it (registration.ts); otherwise every reason. The
 * version stores the effective costs (the install's `broker_costs` for each the file omits), so a
 * later settings change never changes it.
 */
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
    const { problems, notes, costs } = await registrationReport(db, o.strategy, {
      through: o.through,
      sessions: o.sessions,
    });
    // `costs` is there whenever nothing refuses (an unknown cost is a problem); checked anyway.
    if (problems.length > 0 || !costs) {
      return { ...refused(`Not registered:\n${problemList(problems)}`), stdout: noteLines(notes) };
    }
    const v = await registerVersion(db, {
      ownerId: o.ownerId,
      name: costs.strategy.name,
      strategy: costs.strategy,
      costsResolved: true,
    });
    return {
      exitCode: 0,
      stdout: [
        `Registered ${o.strategy.name}: version ${v.id}, hash ${v.hash}.`,
        'Its forward record starts with the first close after now.',
        costsLine(costs),
        ...noteLines(notes),
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
  o: { code: string; sessions: Sessions; lockDir?: string },
): Promise<CommandOutput> {
  return withJobsLock(o.lockDir, async () => {
    const out: string[] = [];
    const c = await annotateStandInCorrections(db, null, o.sessions);
    if (c.annotations) out.push(`${c.annotations} stand-in corrections annotated.`);
    out.push(...c.errors);
    const r = await recompute(db, {
      runId: null,
      code: o.code,
      waiting: c.deferred,
      sessions: o.sessions,
    });
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
