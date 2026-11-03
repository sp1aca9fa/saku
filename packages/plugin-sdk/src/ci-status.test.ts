import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../../ops/ci-status.sh');
const SHA = 'a'.repeat(40);

// Fake git: answers `remote get-url origin` with the file "remote" (fails when it is missing).
const FAKE_GIT = `#!/usr/bin/env bash
[ "$*" = "remote get-url origin" ] && [ -e "$FAKE_DIR/remote" ] && { cat "$FAKE_DIR/remote"; exit 0; }
exit 1
`;

// Fake curl: records its arguments, writes the file "body" to -o and prints the file "code"
// (default 200) for -w; exits with the file "curl-exit" when it exists, printing nothing.
const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FAKE_DIR/curl-args"
[ -e "$FAKE_DIR/curl-exit" ] && exit "$(cat "$FAKE_DIR/curl-exit")"
out=""
while [ $# -gt 0 ]; do
  [ "$1" = "-o" ] && out="$2"
  shift
done
cat "$FAKE_DIR/body" >"$out"
if [ -e "$FAKE_DIR/code" ]; then cat "$FAKE_DIR/code"; else printf 200; fi
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saku-ci-'));
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of [
    ['git', FAKE_GIT],
    ['curl', FAKE_CURL],
  ] as const) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  writeFileSync(join(dir, 'remote'), 'git@github.com:example-org/example-app.git\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[] = [SHA]) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE_DIR: dir, HOME: dir },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const curlArgs = () => readFileSync(join(dir, 'curl-args'), 'utf8').trim().split('\n');
const runOf = (status: string, conclusion: string | null = null) => ({
  id: 1,
  name: 'check',
  status,
  conclusion,
});
function answer(runs: object[], total = runs.length) {
  writeFileSync(join(dir, 'body'), JSON.stringify({ total_count: total, check_runs: runs }));
}

/** The script's whole output must be the one word (and nothing on stderr). */
function expectWord(word: string, args?: string[]) {
  const r = run(args);
  expect(r).toEqual({ status: 0, out: `${word}\n`, err: '' });
}

describe('ops/ci-status.sh', () => {
  it('success: every run completed as success, neutral or skipped', () => {
    answer([
      runOf('completed', 'success'),
      runOf('completed', 'skipped'),
      runOf('completed', 'neutral'),
    ]);
    expectWord('success');
  });

  it('asks the check runs of that commit, with the JSON Accept header, a 20 s limit and no token', () => {
    answer([runOf('completed', 'success')]);
    run();
    const args = curlArgs();
    expect(args).toContain(
      `https://api.github.com/repos/example-org/example-app/commits/${SHA}/check-runs?per_page=100`,
    );
    expect(args).toContain('Accept: application/vnd.github+json');
    expect(args.join(' ')).toContain('-m 20');
    // A renamed repo answers 301: followed (https only, a few hops); the final answer counts.
    expect(args.join(' ')).toContain('-L --max-redirs 3 --proto-redir =https');
    expect(args.join(' ').toLowerCase()).not.toContain('authorization');
  });

  it('reads the owner and repo from ssh and https remotes', () => {
    answer([runOf('completed', 'success')]);
    for (const remote of [
      'git@github.com:example-org/example-app.git',
      'git@github.com:example-org/example-app',
      'ssh://git@github.com/example-org/example-app.git',
      'ssh://git@github.com:22/example-org/example-app',
      'https://github.com/example-org/example-app.git',
      'https://github.com/example-org/example-app/',
      'https://someone@github.com/example-org/example-app.git',
    ]) {
      writeFileSync(join(dir, 'remote'), `${remote}\n`);
      rmSync(join(dir, 'curl-args'), { force: true });
      expectWord('success');
      expect(curlArgs()).toContain(
        `https://api.github.com/repos/example-org/example-app/commits/${SHA}/check-runs?per_page=100`,
      );
    }
  });

  it('failure: a completed run with any other conclusion, even while others still run', () => {
    for (const conclusion of [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'stale',
      null,
    ]) {
      answer([runOf('completed', 'success'), runOf('completed', conclusion), runOf('in_progress')]);
      expectWord('failure');
    }
  });

  it('pending: a run not completed yet, or no runs at all', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      answer([runOf('completed', 'success'), runOf(status)]);
      expectWord('pending');
    }
    answer([]);
    expectWord('pending');
  });

  it('unknown: curl fails (no network, timeout)', () => {
    answer([runOf('completed', 'success')]);
    // 47: too many redirects.
    for (const code of ['6', '28', '47']) {
      writeFileSync(join(dir, 'curl-exit'), code);
      expectWord('unknown');
    }
  });

  it('unknown: an HTTP error or rate limit, without printing the answer', () => {
    for (const code of ['403', '429', '404', '500', '000', '301']) {
      writeFileSync(
        join(dir, 'body'),
        JSON.stringify({
          message: 'API rate limit exceeded for 203.0.113.9',
          total_count: 1,
          check_runs: [runOf('completed', 'success')],
        }),
      );
      writeFileSync(join(dir, 'code'), code);
      expectWord('unknown');
    }
  });

  it('unknown: an answer it cannot read', () => {
    for (const body of [
      'not json',
      '',
      'null',
      '[]',
      '{"total_count":1}',
      '{"check_runs":[]}',
      '{"total_count":"1","check_runs":[]}',
      '{"total_count":1,"check_runs":[null]}',
      '{"total_count":1,"check_runs":[{"conclusion":"success"}]}',
    ]) {
      writeFileSync(join(dir, 'body'), body);
      expectWord('unknown');
    }
  });

  it('unknown: more runs than the page shows, unless a visible one failed', () => {
    answer([runOf('completed', 'success')], 101);
    expectWord('unknown');
    answer([runOf('completed', 'failure')], 101);
    expectWord('failure');
  });

  it('unknown without calling GitHub: a remote that is not github.com, or none', () => {
    answer([runOf('completed', 'success')]);
    for (const remote of [
      'git@gitlab.example:example-org/example-app.git',
      'https://github.com.example/example-org/example-app.git',
      'https://example.com/@github.com/example-org/example-app.git',
      'https://github.com/example-org/example-app/extra',
      'https://github.com/../example-app',
      'https://github.com/example-org/..',
      '/srv/git/example-app.git',
    ]) {
      writeFileSync(join(dir, 'remote'), `${remote}\n`);
      expectWord('unknown');
    }
    rmSync(join(dir, 'remote'));
    expectWord('unknown');
    expect(existsSync(join(dir, 'curl-args'))).toBe(false);
  });

  it('unknown without calling GitHub: not a full lowercase sha', () => {
    answer([runOf('completed', 'success')]);
    for (const sha of [
      '',
      'abc1234',
      'A'.repeat(40),
      `${SHA}0`,
      'g'.repeat(40),
      `$(touch x)${SHA}`,
    ]) {
      expectWord('unknown', [sha]);
    }
    expectWord('unknown', []);
    expect(existsSync(join(dir, 'curl-args'))).toBe(false);
  });

  it('unknown when node gives something other than a verdict', () => {
    answer([runOf('completed', 'success')]);
    writeFileSync(join(dir, 'bin', 'node'), '#!/usr/bin/env bash\necho "success extra"\n');
    chmodSync(join(dir, 'bin', 'node'), 0o755);
    expectWord('unknown');
    writeFileSync(join(dir, 'bin', 'node'), '#!/usr/bin/env bash\nexit 1\n');
    expectWord('unknown');
  });
});
