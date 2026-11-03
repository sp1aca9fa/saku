// Typechecks the private submodule (private/) when it is checked out (it is not a workspace
// member, so `pnpm -r typecheck` does not reach it).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('private/tsconfig.json')) {
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'private'], { stdio: 'inherit' });
} else {
  console.log('private/ not present: skipped');
}
