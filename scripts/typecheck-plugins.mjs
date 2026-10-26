// Typechecks the private plugins/ submodule when it is checked out (it is not a workspace
// member, so `pnpm -r typecheck` does not reach it).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('plugins/tsconfig.json')) {
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'plugins'], { stdio: 'inherit' });
} else {
  console.log('plugins/ not present: skipped');
}
