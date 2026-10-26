/** Environment variables that mark a hosted or CI environment, where jobs and plug-ins never run. */
export const FORBIDDEN_ENV = ['VERCEL', 'CI'] as const;

/** Throws when jobs or plug-ins would run on Vercel or in CI. Call at the start of every job. */
export function assertServerOnly(env: NodeJS.ProcessEnv = process.env): void {
  const found = FORBIDDEN_ENV.filter((name) => env[name] !== undefined && env[name] !== '');
  if (found.length > 0) {
    throw new Error(
      `Jobs and plug-ins run only on the server; refusing because ${found.join(', ')} is set.`,
    );
  }
}
