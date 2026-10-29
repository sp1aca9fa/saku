import { execFileSync } from 'node:child_process';
import { findRepoRoot } from '@saku/db/env';

/** The checked-out commit (named in recompute annotations), or `unknown`. */
export function codeVersion(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: findRepoRoot(),
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}
