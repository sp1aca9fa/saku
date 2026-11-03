import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The CI gate of ops/update-server.sh, on throwaway local git repos (no network): a bare
// "origin", a clone that pushes, and the server's clone holding a copy of the script. pnpm and
// ops/ci-status.sh are fakes.
const SCRIPT = join(import.meta.dirname, '../../../ops/update-server.sh');

// Fake pnpm: records each call; every step succeeds unless the file "pnpm-fails" names it.
const FAKE_PNPM = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/pnpm-calls"
[ -e "$FAKE_DIR/pnpm-fails" ] && [[ "$*" == *"$(cat "$FAKE_DIR/pnpm-fails")"* ]] && exit 1
exit 0
`;

// Fake curl (only the healthchecks.io ping uses it here): records its arguments.
const FAKE_CURL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/curl-calls"
`;

// Fake ci-status: records the sha, prints the file "ci" (the verdict); with "ci-push" it first
// pushes a newer commit, as if one arrived while CI was being read.
const FAKE_CI = `#!/usr/bin/env bash
echo "$1" >>"$FAKE_DIR/ci-calls"
if [ -e "$FAKE_DIR/ci-push" ]; then
  rm -f "$FAKE_DIR/ci-push"
  echo later >>"$FAKE_DIR/work/file.txt"
  git -C "$FAKE_DIR/work" commit -qam later && git -C "$FAKE_DIR/work" push -q origin main
fi
cat "$FAKE_DIR/ci"
`;

let dir: string;
let repo: string;
let state: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function gitEnv(): Record<string, string | undefined> {
  // Without the caller's GIT_* (a git hook running the tests sets GIT_DIR and others).
  const outer = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return {
    ...outer,
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: join(dir, 'home'),
  };
}

/** A new commit on origin's main; returns its sha. */
function push(text: string): string {
  writeFileSync(join(dir, 'work', 'file.txt'), `${text}\n`);
  git(join(dir, 'work'), 'commit', '-qam', text);
  git(join(dir, 'work'), 'push', '-q', 'origin', 'main');
  return git(join(dir, 'work'), 'rev-parse', 'HEAD');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saku-update-'));
  repo = join(dir, 'repo');
  state = join(dir, 'state');
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(
    join(dir, 'gitconfig'),
    // File transport for the private submodule's throwaway repo (the server uses ssh).
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n' +
      '[protocol "file"]\n\tallow = always\n',
  );
  git(dir, 'init', '-q', '--bare', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'work');
  writeFileSync(join(dir, 'work', 'file.txt'), 'first\n');
  git(join(dir, 'work'), 'add', 'file.txt');
  git(join(dir, 'work'), 'commit', '-qm', 'first');
  git(join(dir, 'work'), 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', 'origin.git', 'repo');
  mkdirSync(join(repo, 'ops'));
  copyFileSync(SCRIPT, join(repo, 'ops', 'update-server.sh'));
  writeFileSync(join(repo, 'ops', 'ci-status.sh'), FAKE_CI);
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'ops/\n.env\n');
  for (const [name, body] of [
    ['pnpm', FAKE_PNPM],
    ['curl', FAKE_CURL],
  ] as const) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[] = ['--auto'], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...gitEnv(),
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    FAKE_DIR: dir,
    SAKU_STATE_DIR: state,
    NVM_DIR: join(dir, 'no-nvm'),
    ...extra,
  };
  for (const k of ['SAKU_UPDATE_REQUIRE_CI', 'XDG_STATE_HOME', 'CI', 'VERCEL']) {
    if (!(k in extra)) delete env[k];
  }
  const r = spawnSync('bash', [join(repo, 'ops', 'update-server.sh'), ...args], {
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const read = (name: string) => {
  const f = join(dir, name);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};
const head = () => git(repo, 'rev-parse', 'HEAD');
const log = () => {
  const f = join(state, 'update.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};
const ci = (verdict: string) => writeFileSync(join(dir, 'ci'), `${verdict}\n`);
const shortOf = (sha: string) => git(repo, 'rev-parse', '--short', sha);
const ciState = () => readFileSync(join(state, 'update-ci'), 'utf8');
const count = (re: RegExp) => read('pnpm-calls').match(re)?.length ?? 0;
const installed = () => read('pnpm-calls').includes('install --frozen-lockfile');

describe('ops/update-server.sh --auto: the CI gate', () => {
  it('success: updates to the checked commit, not a later one that arrived meanwhile', () => {
    const checked = push('second');
    ci('success');
    writeFileSync(join(dir, 'ci-push'), '');
    const r = run();
    expect(r.status).toBe(0);
    expect(read('ci-calls').trim()).toBe(checked);
    expect(head()).toBe(checked);
    expect(git(join(dir, 'work'), 'rev-parse', 'HEAD')).not.toBe(checked);
    expect(installed()).toBe(true);
    expect(read('pnpm-calls')).toContain('db:migrate');
    expect(existsSync(join(state, 'update-failed'))).toBe(false);
    expect(log()).toContain('Saku is up');
  });

  it('pending: no change, exit 0, one log line per status change', () => {
    const before = head();
    const waiting = push('second');
    ci('pending');
    for (let i = 0; i < 3; i++) expect(run().status).toBe(0);
    expect(head()).toBe(before);
    expect(installed()).toBe(false);
    expect(read('ci-calls').trim().split('\n')).toEqual([waiting, waiting, waiting]);
    expect(log().match(/waiting: CI is pending/g)).toHaveLength(1);
    expect(existsSync(join(state, 'update-failed'))).toBe(false);

    ci('unknown');
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    expect(log().match(/waiting: CI is unknown/g)).toHaveLength(1);
    expect(head()).toBe(before);

    // A newer commit, still pending: logged again.
    push('third');
    ci('pending');
    expect(run().status).toBe(0);
    expect(log().match(/waiting: CI is pending/g)).toHaveLength(2);
    expect(head()).toBe(before);
  });

  it('anything but a verdict counts as unknown', () => {
    const before = head();
    push('second');
    for (const word of ['', 'SUCCESS', 'success now', 'green']) {
      ci(word);
      expect(run().status).toBe(0);
    }
    expect(head()).toBe(before);
    expect(installed()).toBe(false);
  });

  it('failure: no change, the sha recorded, admins told once with step ci', () => {
    const before = head();
    const failed = push('second');
    ci('failure');
    expect(run().status).toBe(0);
    expect(head()).toBe(before);
    expect(installed()).toBe(false);
    expect(readFileSync(join(state, 'update-failed'), 'utf8').trim()).toBe(failed);
    const short = git(repo, 'rev-parse', '--short', failed);
    const here = git(repo, 'rev-parse', '--short', before);
    const calls = read('pnpm-calls');
    expect(calls).toContain(`alert update-failed --from ${here} --to ${short} --step ci`);
    expect(calls).toContain(`update:log --from ${here} --to ${short} --failed ci`);
    expect(log()).toContain(`CI failed on ${short}`);

    // Not tried again (no API call, no second alert) until a newer push.
    expect(run().status).toBe(0);
    expect(read('ci-calls').trim().split('\n')).toEqual([failed]);
    expect(read('pnpm-calls').match(/alert update-failed/g)).toHaveLength(1);

    const newer = push('third');
    ci('success');
    expect(run().status).toBe(0);
    expect(head()).toBe(newer);
    expect(existsSync(join(state, 'update-failed'))).toBe(false);
  });

  it('failure while a job runs: recorded and told at once (no code changes, no lock needed)', () => {
    const before = head();
    const failed = push('second');
    ci('failure');
    mkdirSync(join(state, 'locks'), { recursive: true });
    writeFileSync(join(state, 'locks', 'jobs.lock'), String(process.pid));
    expect(run().status).toBe(0);
    expect(head()).toBe(before);
    expect(readFileSync(join(state, 'update-failed'), 'utf8').trim()).toBe(failed);
    expect(ciState()).toMatch(new RegExp(`^${shortOf(before)} ${failed} failure \\d+ 1 1\n$`));
    expect(read('pnpm-calls')).toContain('alert update-failed');
    expect(readFileSync(join(state, 'locks', 'jobs.lock'), 'utf8')).toBe(String(process.pid));
    // A later tick sees update-failed: no API call, no second alert.
    expect(run().status).toBe(0);
    expect(read('ci-calls').trim().split('\n')).toEqual([failed]);
    expect(count(/alert update-failed/g)).toBe(1);
  });

  it('a CI-failure alert no channel took is tried again at each check until sent', () => {
    const before = head();
    const failed = push('second');
    ci('failure');
    writeFileSync(join(dir, 'pnpm-fails'), 'alert update-failed');
    for (let i = 0; i < 3; i++) expect(run().status).toBe(0);
    expect(count(/alert update-failed/g)).toBe(3);
    expect(count(/update:log/g)).toBe(1);
    expect(ciState()).toMatch(/ failure \d+ 2 1\n$/);
    expect(log().match(/telling the admins: CI failed/g)).toHaveLength(1);
    expect(log().match(/could not tell the admins/g)).toHaveLength(1);
    rmSync(join(dir, 'pnpm-fails'));
    expect(run().status).toBe(0);
    expect(count(/alert update-failed/g)).toBe(4);
    expect(ciState()).toMatch(/ failure \d+ 1 1\n$/);
    expect(log()).toContain('the admins are told: CI failed');
    // Sent: nothing more, and GitHub was asked once.
    expect(run().status).toBe(0);
    expect(count(/alert update-failed/g)).toBe(4);
    expect(read('ci-calls').trim().split('\n')).toEqual([failed]);
    expect(head()).toBe(before);
  });

  it("a CI failure's activity entry that could not be written is written at the next check", () => {
    push('second');
    ci('failure');
    writeFileSync(join(dir, 'pnpm-fails'), 'update:log');
    expect(run().status).toBe(0);
    expect(ciState()).toMatch(/ failure \d+ 1 0\n$/);
    rmSync(join(dir, 'pnpm-fails'));
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    expect(count(/update:log/g)).toBe(2);
    expect(count(/alert update-failed/g)).toBe(1);
    expect(ciState()).toMatch(/ failure \d+ 1 1\n$/);
  });

  describe('24 h without an update while CI is not green', () => {
    const seen = (target: string, status: string, ago: number, told = 0) => {
      mkdirSync(state, { recursive: true });
      writeFileSync(
        join(state, 'update-ci'),
        `${shortOf(head())} ${target} ${status} ${Math.floor(Date.now() / 1000) - ago} ${told} 1\n`,
      );
    };
    const waits = () => count(/alert update-waiting/g);

    it('tells the admins once, then keeps waiting', () => {
      const before = head();
      const waiting = push('second');
      ci('pending');
      seen(waiting, 'pending', 86_401);
      expect(run().status).toBe(0);
      const short = shortOf(waiting);
      expect(read('pnpm-calls')).toContain(
        `alert update-waiting --from ${shortOf(before)} --to ${short} --status pending`,
      );
      expect(log()).toContain(
        `telling the admins: no update for 24 h; ${short} waits for CI (pending)`,
      );
      // Not again on this commit of the server, whatever CI does next.
      expect(run().status).toBe(0);
      ci('unknown');
      expect(run().status).toBe(0);
      expect(waits()).toBe(1);
      expect(head()).toBe(before);
      expect(ciState()).toMatch(/ unknown \d+ 1 1\n$/);
    });

    it("runs from the server's commit: daily pushes do not restart it", () => {
      const before = head();
      const first = push('second');
      ci('unknown');
      seen(first, 'unknown', 80_000);
      expect(run().status).toBe(0);
      const since = ciState().split(' ')[3];
      // Newer pushes, each still waiting: the clock goes on.
      push('third');
      ci('pending');
      expect(run().status).toBe(0);
      expect(waits()).toBe(0);
      expect(ciState().split(' ')[3]).toBe(since);
      const last = push('fourth');
      seen(last, 'pending', 86_401);
      expect(run().status).toBe(0);
      expect(waits()).toBe(1);
      expect(read('pnpm-calls')).toContain(`--to ${shortOf(last)} --status pending`);
      expect(head()).toBe(before);
    });

    it('a reported CI failure starts the clock again for the next commit', () => {
      const failed = push('second');
      seen(failed, 'failure', 90_000, 1);
      push('third');
      ci('pending');
      expect(run().status).toBe(0);
      expect(waits()).toBe(0);
      const since = Number(ciState().split(' ')[3]);
      expect(Math.floor(Date.now() / 1000) - since).toBeLessThan(600);
    });

    it('an update moves the server: the clock starts again', () => {
      const waiting = push('second');
      ci('pending');
      seen(waiting, 'pending', 80_000);
      expect(run([]).status).toBe(0);
      expect(head()).toBe(waiting);
      expect(existsSync(join(state, 'update-ci'))).toBe(false);
      push('third');
      expect(run().status).toBe(0);
      const since = Number(ciState().split(' ')[3]);
      expect(Math.abs(since - Date.now() / 1000)).toBeLessThan(120);
      expect(ciState().startsWith(`${shortOf(waiting)} `)).toBe(true);
    });

    it('nothing waiting any more clears it', () => {
      const waiting = push('second');
      ci('pending');
      seen(waiting, 'pending', 80_000);
      git(repo, 'fetch', '-q', 'origin');
      git(repo, 'merge', '-q', '--ff-only', waiting);
      expect(run().status).toBe(0);
      expect(existsSync(join(state, 'update-ci'))).toBe(false);
    });

    it('not before 24 h', () => {
      const waiting = push('second');
      ci('unknown');
      seen(waiting, 'unknown', 86_000);
      expect(run().status).toBe(0);
      expect(waits()).toBe(0);
    });

    it('an alert no channel took is tried at each check, logged once', () => {
      const waiting = push('second');
      ci('pending');
      seen(waiting, 'pending', 86_401);
      writeFileSync(join(dir, 'pnpm-fails'), 'update-waiting');
      expect(run().status).toBe(0);
      expect(run().status).toBe(0);
      expect(ciState()).toMatch(/ 2 1\n$/);
      expect(log().match(/telling the admins/g)).toHaveLength(1);
      expect(log().match(/could not tell the admins/g)).toHaveLength(1);
      rmSync(join(dir, 'pnpm-fails'));
      expect(run().status).toBe(0);
      expect(run().status).toBe(0);
      expect(waits()).toBe(3);
      expect(ciState()).toMatch(/ 1 1\n$/);
      expect(log()).toContain('the admins are told');
    });
  });

  it('a failed step after a green CI still goes back and records the checked sha', () => {
    const before = head();
    const checked = push('second');
    ci('success');
    writeFileSync(join(dir, 'ci-push'), '');
    writeFileSync(join(dir, 'pnpm-fails'), 'db:migrate');
    expect(run().status).not.toBe(0);
    expect(head()).toBe(before);
    expect(readFileSync(join(state, 'update-failed'), 'utf8').trim()).toBe(checked);
    expect(read('pnpm-calls')).toContain(
      `--to ${git(repo, 'rev-parse', '--short', checked)} --step migrate`,
    );
  });

  it('nothing new: no CI call', () => {
    ci('success');
    expect(run().status).toBe(0);
    expect(read('ci-calls')).toBe('');
  });

  it('runs without a .env, in the default state folder', () => {
    const second = push('second');
    ci('success');
    expect(existsSync(join(repo, '.env'))).toBe(false);
    expect(run(['--auto'], { SAKU_STATE_DIR: '' }).status).toBe(0);
    expect(head()).toBe(second);
    expect(
      readFileSync(join(dir, 'home', '.local', 'state', 'saku', 'update.log'), 'utf8'),
    ).toContain('Saku is up');
  });

  it('reads .env as the jobs do: quotes, # comments, CR, export', () => {
    ci('failure');
    const second = push('second');
    writeFileSync(join(repo, '.env'), 'SAKU_UPDATE_REQUIRE_CI=0  # no CI on this fork\n');
    expect(run().status).toBe(0);
    expect(head()).toBe(second);

    // The state folder from .env (quoted, with a comment after it).
    const other = join(dir, 'other state');
    const third = push('third');
    writeFileSync(
      join(repo, '.env'),
      `export SAKU_STATE_DIR="${other}" # second copy\r\nSAKU_UPDATE_REQUIRE_CI='0'\r\n`,
    );
    expect(run(['--auto'], { SAKU_STATE_DIR: '' }).status).toBe(0);
    expect(head()).toBe(third);
    expect(readFileSync(join(other, 'update.log'), 'utf8')).toContain('Saku is up');
  });

  it('stuck going back: pings healthchecks.io /fail at the URL .env names', () => {
    push('second');
    ci('success');
    writeFileSync(
      join(repo, '.env'),
      'HEALTHCHECK_URL="https://hc.example/ping/abc" # daily\r\nOTHER=1\n',
    );
    writeFileSync(join(dir, 'pnpm-fails'), 'install');
    expect(run().status).not.toBe(0);
    expect(read('pnpm-calls')).toContain('--stuck');
    expect(read('curl-calls')).toContain('https://hc.example/ping/abc/fail');
  });

  it('SAKU_UPDATE_REQUIRE_CI=0 (environment or .env) turns the gate off', () => {
    ci('failure');
    const second = push('second');
    expect(run(['--auto'], { SAKU_UPDATE_REQUIRE_CI: '0' }).status).toBe(0);
    expect(head()).toBe(second);

    const third = push('third');
    writeFileSync(join(repo, '.env'), 'SAKU_UPDATE_REQUIRE_CI="0"\r\n');
    expect(run().status).toBe(0);
    expect(head()).toBe(third);
    expect(read('ci-calls')).toBe('');

    // The environment wins over .env; any other value keeps the gate on.
    const fourth = push('fourth');
    expect(run(['--auto'], { SAKU_UPDATE_REQUIRE_CI: '1' }).status).toBe(0);
    expect(head()).toBe(third);
    expect(read('ci-calls').trim()).toBe(fourth);
  });
});

describe('ops/update-server.sh by hand', () => {
  it('prints the CI status as a warning and updates anyway', () => {
    const second = push('second');
    ci('pending');
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      `Warning: CI on ${git(repo, 'rev-parse', '--short', second)} is pending (not passed)`,
    );
    expect(head()).toBe(second);
  });

  it('with failure: warns, updates, records nothing', () => {
    const second = push('second');
    ci('failure');
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('is failure (not passed); updating anyway, by hand.');
    expect(head()).toBe(second);
    expect(existsSync(join(state, 'update-failed'))).toBe(false);
  });

  it('nothing new: no CI call, the checks still run', () => {
    ci('failure');
    expect(run([]).status).toBe(0);
    expect(read('ci-calls')).toBe('');
    expect(installed()).toBe(true);
  });

  it('origin unreachable: exit 1, nothing recorded, nothing run', () => {
    push('second');
    ci('success');
    git(repo, 'remote', 'set-url', 'origin', join(dir, 'gone.git'));
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Could not fetch from GitHub');
    expect(existsSync(join(state, 'update-failed'))).toBe(false);
    expect(read('pnpm-calls')).toBe('');
    expect(read('ci-calls')).toBe('');
  });

  it('says so when CI passed', () => {
    const second = push('second');
    ci('success');
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`CI passed on ${git(repo, 'rev-parse', '--short', second)}.`);
    expect(head()).toBe(second);
  });
});

// The private submodule's folder move (plugins/ to private/, its name staying `plugins`), as the
// server's checkout lives it: a bare private repo, the old layout on origin, the server's clone
// with its own submodule url (the deploy-key alias; the url in .gitmodules does not exist here).
describe('ops/update-server.sh: the private folder move', () => {
  const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  // Fake git: the real one, recording each call in "git-calls", except that a call starting with
  // the first line of "git-fails" fails from its Nth time on (N: the second line).
  const FAKE_GIT = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/git-calls"
if [ -e "$FAKE_DIR/git-fails" ] && [[ "$*" == "$(sed -n 1p "$FAKE_DIR/git-fails")"* ]]; then
  n=$(( $(cat "$FAKE_DIR/git-count" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"$FAKE_DIR/git-count"
  if [ "$n" -ge "$(sed -n 2p "$FAKE_DIR/git-fails")" ]; then echo "fake git: $* failed" >&2; exit 1; fi
fi
exec ${REAL_GIT} "$@"
`;
  let priv: string;
  let p0: string;
  let c0: string;

  const pwork = () => join(dir, 'pwork');
  const work = () => join(dir, 'work');

  /** A new commit on the private repo's main, its src/index.ts holding `text`; returns its sha. */
  function pushPrivate(text: string): string {
    writeFileSync(join(pwork(), 'src', 'index.ts'), `${text}\n`);
    git(pwork(), 'commit', '-qam', text);
    git(pwork(), 'push', '-q', 'origin', 'main');
    return git(pwork(), 'rev-parse', 'HEAD');
  }

  /** A commit on origin's main with the submodule `name` at `path` on `sha`; returns its sha. */
  function pushLayout(message: string, path: string, sha: string, name = 'plugins'): string {
    for (const old of ['plugins', 'private']) {
      git(work(), 'rm', '-q', '--cached', '--ignore-unmatch', old);
      rmSync(join(work(), old), { recursive: true, force: true });
    }
    writeFileSync(
      join(work(), '.gitmodules'),
      `[submodule "${name}"]\n\tpath = ${path}\n\turl = /nonexistent/saku-private.git\n`,
    );
    git(work(), 'update-index', '--add', '--cacheinfo', `160000,${sha},${path}`);
    git(work(), 'add', '.gitmodules');
    git(work(), 'commit', '-qm', message);
    git(work(), 'push', '-q', 'origin', 'main');
    // Not checked out in this clone: an empty folder, so `commit -a` keeps the submodule.
    mkdirSync(join(work(), path), { recursive: true });
    return git(work(), 'rev-parse', 'HEAD');
  }

  /** A commit moving the submodule (at `path`) to the private repo's `sha`. */
  function pushBump(sha: string, path = 'private'): string {
    git(work(), 'update-index', '--cacheinfo', `160000,${sha},${path}`);
    git(work(), 'commit', '-qm', `bump ${path}`);
    git(work(), 'push', '-q', 'origin', 'main');
    return git(work(), 'rev-parse', 'HEAD');
  }

  const raw = (...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() }).stdout;
  const porcelain = () => git(repo, 'status', '--porcelain');
  const worktree = () =>
    git(repo, 'config', '-f', join('.git', 'modules', 'plugins', 'config'), 'core.worktree');
  const content = (folder: string) =>
    readFileSync(join(repo, folder, 'src', 'index.ts'), 'utf8').trim();
  const up = (from: string, to: string, sub: string) =>
    `Saku is up: ${shortOf(from)} -> ${shortOf(to)} (plug-ins ${sub.slice(0, 7)}).`;

  beforeEach(() => {
    priv = join(dir, 'priv.git');
    git(dir, 'init', '-q', '--bare', 'priv.git');
    git(dir, 'clone', '-q', 'priv.git', 'pwork');
    mkdirSync(join(pwork(), 'src'));
    writeFileSync(join(pwork(), 'src', 'index.ts'), 'v0\n');
    git(pwork(), 'add', 'src');
    git(pwork(), 'commit', '-qm', 'v0');
    git(pwork(), 'push', '-q', 'origin', 'main');
    p0 = git(pwork(), 'rev-parse', 'HEAD');
    c0 = pushLayout('old layout', 'plugins', p0);
    // The server on the old layout, its private checkout made as docs/setup.md says.
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'merge', '-q', '--ff-only', 'origin/main');
    git(repo, 'config', 'submodule.plugins.url', priv);
    git(repo, 'submodule', 'update', '--init', '-q');
    expect(content('plugins')).toBe('v0');
    ci('success');
  });

  it('moves: the same module folder, the deploy-key url kept, the old folder left untracked', () => {
    const c1 = pushLayout('move', 'private', p0);
    const r = run();
    expect(r.status).toBe(0);
    expect(head()).toBe(c1);
    expect(readFileSync(join(repo, 'private', '.git'), 'utf8').trim()).toBe(
      'gitdir: ../.git/modules/plugins',
    );
    expect(worktree()).toBe('../../../private');
    expect(git(repo, 'config', 'submodule.plugins.url')).toBe(priv);
    expect(git(join(repo, 'private'), 'remote', 'get-url', 'origin')).toBe(priv);
    expect(raw('config', '--get', 'submodule.private.url')).toBe('');
    expect(raw('submodule', 'status')).toMatch(new RegExp(`^ ${p0} private `));
    expect(porcelain()).toBe('?? plugins/');
    expect(content('private')).toBe('v0');
    expect(log()).toContain(up(c0, c1, p0));
    expect(existsSync(join(state, 'update-failed'))).toBe(false);
  });

  it('a failed check goes back across the move and alerts (not stuck)', () => {
    const c1 = pushLayout('move', 'private', p0);
    writeFileSync(join(dir, 'pnpm-fails'), 'test');
    expect(run().status).toBe(1);
    expect(head()).toBe(c0);
    expect(log()).toContain(
      `Update to ${shortOf(c1)} failed at 'check': going back to ${shortOf(c0)}.`,
    );
    expect(log()).toContain(`Back on ${shortOf(c0)}.`);
    expect(read('pnpm-calls')).toContain(
      `alert update-failed --from ${shortOf(c0)} --to ${shortOf(c1)} --step check\n`,
    );
    expect(read('pnpm-calls')).not.toContain('--stuck');
    expect(raw('submodule', 'status')).toMatch(new RegExp(`^ ${p0} plugins `));
    expect(worktree()).toBe('../../../plugins');
    expect(porcelain()).toBe('?? private/');
    expect(content('plugins')).toBe('v0');
    expect(readFileSync(join(state, 'update-failed'), 'utf8').trim()).toBe(c1);
  });

  it('after a failed move, the next push moves again; a later bump lands in private/', () => {
    pushLayout('move', 'private', p0);
    writeFileSync(join(dir, 'pnpm-fails'), 'test');
    expect(run().status).toBe(1);
    rmSync(join(dir, 'pnpm-fails'));
    const c2 = push('second');
    expect(run().status).toBe(0);
    expect(head()).toBe(c2);
    expect(worktree()).toBe('../../../private');
    expect(porcelain()).toBe('?? plugins/');

    const p1 = pushPrivate('v1');
    const c3 = pushBump(p1);
    expect(run().status).toBe(0);
    expect(head()).toBe(c3);
    expect(content('private')).toBe('v1');
    expect(content('plugins')).toBe('v0');
    expect(log()).toContain(up(c2, c3, p1));
  });

  it('undo after the move: a commit moving back recreates plugins/ from the module folder', () => {
    pushLayout('move', 'private', p0);
    expect(run().status).toBe(0);
    renameSync(join(repo, 'plugins'), join(dir, 'old-plugins-folder'));
    const back = pushLayout('move back', 'plugins', p0);
    expect(run().status).toBe(0);
    expect(head()).toBe(back);
    expect(content('plugins')).toBe('v0');
    expect(raw('submodule', 'status')).toMatch(new RegExp(`^ ${p0} plugins `));
    expect(worktree()).toBe('../../../plugins');
    expect(porcelain()).toBe('?? private/');
  });

  it('undo after a bump: moving back keeps the bumped private commit', () => {
    pushLayout('move', 'private', p0);
    expect(run().status).toBe(0);
    renameSync(join(repo, 'plugins'), join(dir, 'old-plugins-folder'));
    const p1 = pushPrivate('v1');
    pushBump(p1);
    expect(run().status).toBe(0);
    const back = pushLayout('move back', 'plugins', p1);
    expect(run().status).toBe(0);
    expect(head()).toBe(back);
    expect(content('plugins')).toBe('v1');
    expect(raw('submodule', 'status')).toMatch(new RegExp(`^ ${p1} plugins `));
    expect(porcelain()).toBe('?? private/');
  });

  it('undo after a bump with the old plugins/ folder still there: it gets the bumped commit', () => {
    pushLayout('move', 'private', p0);
    expect(run().status).toBe(0);
    const p1 = pushPrivate('v1');
    pushBump(p1);
    expect(run().status).toBe(0);
    // The leftover holds the old commit's files, its .git file pointing at the shared module.
    expect(content('plugins')).toBe('v0');
    const back = pushLayout('move back', 'plugins', p1);
    expect(run().status).toBe(0);
    expect(head()).toBe(back);
    expect(content('plugins')).toBe('v1');
    expect(raw('submodule', 'status')).toMatch(new RegExp(`^ ${p1} plugins `));
    expect(worktree()).toBe('../../../plugins');
    expect(git(join(repo, 'plugins'), 'status', '--porcelain')).toBe('');
    expect(porcelain()).toBe('?? private/');
  });

  it('a move that also bumps the private commit, then fails: back on the old commit, clean', () => {
    const p1 = pushPrivate('v1');
    const c1 = pushLayout('move and bump', 'private', p1);
    writeFileSync(join(dir, 'pnpm-fails'), 'test');
    expect(run().status).toBe(1);
    expect(head()).toBe(c0);
    expect(log()).toContain(`Back on ${shortOf(c0)}.`);
    expect(read('pnpm-calls')).toContain(`--to ${shortOf(c1)} --step check\n`);
    expect(read('pnpm-calls')).not.toContain('--stuck');
    expect(raw('submodule', 'status')).toMatch(new RegExp(`^ ${p0} plugins `));
    expect(content('plugins')).toBe('v0');
    expect(git(join(repo, 'plugins'), 'status', '--porcelain')).toBe('');

    // The next push moves again over the copy that failed: private/ at the bumped commit, clean.
    rmSync(join(dir, 'pnpm-fails'));
    const c2 = push('second');
    expect(run().status).toBe(0);
    expect(head()).toBe(c2);
    expect(content('private')).toBe('v1');
    expect(raw('submodule', 'status')).toMatch(new RegExp(`^ ${p1} private `));
    expect(worktree()).toBe('../../../private');
    expect(git(join(repo, 'private'), 'status', '--porcelain')).toBe('');
    expect(porcelain()).toBe('?? plugins/');
    expect(log()).toContain(up(c0, c2, p1));
  });

  for (const [what, call, nth] of [
    ['the submodule update', 'submodule update', '2'],
    ['the reset', 'reset', '1'],
  ] as const) {
    it(`${what} failing on the way back: stuck, alerted, healthchecks.io told, logged`, () => {
      writeFileSync(join(dir, 'bin', 'git'), FAKE_GIT);
      chmodSync(join(dir, 'bin', 'git'), 0o755);
      writeFileSync(join(dir, 'git-fails'), `${call}\n${nth}\n`);
      writeFileSync(join(repo, '.env'), 'HEALTHCHECK_URL=https://hc.example/ping/abc\n');
      const c1 = pushLayout('move', 'private', p0);
      writeFileSync(join(dir, 'pnpm-fails'), 'test');
      expect(run().status).toBe(1);
      expect(log()).toContain(`fake git: ${call}`);
      // The stuck line gives the way back by hand, with the version to go back to.
      expect(log()).toContain(
        `Going back failed too: the jobs may not run. Go back by hand, in ${repo}: ` +
          `git reset --hard ${shortOf(c0)} && git submodule update --init --force, then the Node ` +
          'link and pnpm install --frozen-lockfile (docs/troubleshooting.md, "An update rolled back")',
      );
      expect(log()).not.toContain('Back on');
      expect(read('pnpm-calls')).toContain(
        `alert update-failed --from ${shortOf(c0)} --to ${shortOf(c1)} --step check --stuck`,
      );
      expect(read('pnpm-calls')).toContain(
        `update:log --from ${shortOf(c0)} --to ${shortOf(c1)} --failed check`,
      );
      // Installed going forward and again on the way back, after the failed step.
      expect(read('pnpm-calls').match(/install --frozen-lockfile/g)).toHaveLength(2);
      expect(read('curl-calls')).toContain('https://hc.example/ping/abc/fail');
      // Each step of the way back runs even when the one before it failed.
      const calls = read('git-calls').split('\n');
      const reset = calls.indexOf(`reset -q --hard ${shortOf(c0)}`);
      expect(reset).toBeGreaterThan(-1);
      expect(calls.lastIndexOf('submodule update --init --force')).toBeGreaterThan(reset);
    });
  }

  it('a renamed submodule name loses the deploy-key url: fails at pull, goes back', () => {
    const c1 = pushLayout('move, renamed', 'private', p0, 'private');
    expect(run().status).toBe(1);
    expect(head()).toBe(c0);
    expect(log()).toContain(`Update to ${shortOf(c1)} failed at 'pull'`);
    expect(log()).toContain(`Back on ${shortOf(c0)}.`);
    expect(read('pnpm-calls')).toContain(`--to ${shortOf(c1)} --step pull\n`);
    expect(git(repo, 'config', 'submodule.plugins.url')).toBe(priv);
    expect(content('plugins')).toBe('v0');
  });
});
