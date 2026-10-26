// Regenerates REQUIREMENTS.md from the split files in docs/requirements/.
// The split files are the source of truth; never edit REQUIREMENTS.md directly.
// `--check` exits 1 when REQUIREMENTS.md is out of date (for CI).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const parts = [
  'docs/requirements/_header.md',
  'docs/requirements/00-index.md',
  'docs/requirements/01-vision-targets.md',
  'docs/requirements/02-process.md',
  'docs/requirements/03-assets.md',
  'docs/requirements/04-data-pipeline.md',
  'docs/requirements/05-strategy-model.md',
  'docs/requirements/06-indicators.md',
  'docs/requirements/07-accounts-tax.md',
  'docs/requirements/08-ux-language.md',
  'docs/requirements/09-analytics.md',
  'docs/requirements/10-mcp.md',
  'docs/requirements/11-alerts.md',
  'docs/requirements/12-architecture-stack.md',
  'docs/requirements/13-testing.md',
  'docs/requirements/14-decisions-log.md',
  'docs/requirements/stages/stage-a.md',
  'docs/requirements/stages/stage-b.md',
  'docs/requirements/stages/stage-c.md',
  'docs/requirements/stages/stage-d.md',
  'docs/requirements/stages/stage-e.md',
  'docs/requirements/stages/stage-f.md',
  'docs/evidence/backtests.md',
  'docs/backlog.md',
  'docs/stage-reviews.md',
  'docs/target-reviews.md',
];

const out = parts.map((p) => `<!-- split: ${p} -->\n${readFileSync(p, 'utf8')}`).join('');
const target = 'REQUIREMENTS.md';

if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current !== out) {
    console.error('REQUIREMENTS.md is out of date: run `pnpm docs:build`.');
    process.exit(1);
  }
  console.log('REQUIREMENTS.md is up to date.');
} else {
  writeFileSync(target, out);
  console.log(`REQUIREMENTS.md written from ${parts.length} files.`);
}
