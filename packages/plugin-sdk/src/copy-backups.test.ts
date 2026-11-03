import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Absolute path of a tool on the real PATH (undefined when absent).
function which(tool: string): string | undefined {
  for (const d of (process.env.PATH ?? '').split(':')) {
    const f = join(d, tool);
    if (d && existsSync(f)) return f;
  }
  return undefined;
}
const bashPath = which('bash') ?? 'bash';

const SCRIPT = join(import.meta.dirname, '../../../ops/copy-backups.sh');

// Fake ssh: ignores options and host, runs the command inside the fake server's home.
const FAKE_SSH = `#!/usr/bin/env bash
if [ -e "$FAKE_DIR/ssh-fails" ]; then exit 255; fi
if [ -e "$FAKE_DIR/ssh-garbage" ]; then echo "not a number"; exit 0; fi
for last; do :; done
cd "$FAKE_DIR/server" && bash -c "$last"
`;

// Fake rsync: copies the server's saku-*.db.gz files to the destination (keeping mtimes and
// skipping identical ones, like rsync -a), removing destination files the server lacks when --delete is given.
const FAKE_RSYNC = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/rsync-calls"
del=0; inc=0; exc=0
for a in "$@"; do
  [ "$a" = "--delete" ] && del=1
  [ "$a" = "--include=saku-*.db.gz" ] && inc=1
  [ "$a" = "--exclude=*" ] && exc=1
done
[ $inc = 1 ] && [ $exc = 1 ] || exit 2
args=("$@"); src="\${args[$# - 2]}"; dst="\${args[$# - 1]}"
srcdir="$FAKE_DIR/server/\${src#*:}"
for f in "$srcdir"/saku-*.db.gz; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  if [ -e "$dst$b" ] && cmp -s "$f" "$dst$b" && [ "$(stat -c %Y "$f")" = "$(stat -c %Y "$dst$b")" ]; then continue; fi
  cp -p "$f" "$dst$b"
done
if [ $del = 1 ]; then
  for f in "$dst"saku-*.db.gz; do
    [ -e "$f" ] || continue
    [ -e "$srcdir/$(basename "$f")" ] || rm -f "$f"
  done
fi
`;

// Fake sqlite3: "ok" unless the file says BAD.
const FAKE_SQLITE = `#!/usr/bin/env bash
if grep -q BAD "$1"; then echo "malformed"; else echo ok; fi
`;

// Fake powershell.exe: records its arguments (the script is the last one).
const FAKE_POWERSHELL = `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FAKE_DIR/powershell-args"
`;

let dir: string;
let home: string;
let server: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'saku-copy-')));
  home = join(dir, 'home');
  server = join(dir, 'server', 'backups');
  mkdirSync(home);
  mkdirSync(server, { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of [
    ['ssh', FAKE_SSH],
    ['rsync', FAKE_RSYNC],
    ['sqlite3', FAKE_SQLITE],
    ['powershell.exe', FAKE_POWERSHELL],
  ] as const) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function serverBackup(name: string, content = 'db ' + name) {
  writeFileSync(join(server, name), gzipSync(content));
}

function run(args: string[], extra: Record<string, string> = {}, path?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: path ?? `${join(dir, 'bin')}:${process.env.PATH}`,
    HOME: home,
    FAKE_DIR: dir,
    SAKU_REMOTE_BACKUP_DIR: 'backups',
    ...extra,
  };
  for (const k of [
    'CI',
    'VERCEL',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'SAKU_DATA_DIR',
    'SAKU_STATE_DIR',
    'SAKU_COPY_DIR',
    'SAKU_ANALYSIS_DB',
    'SAKU_REMOTE_BACKUP_DIR_UNSET',
    'WSL_DISTRO_NAME',
  ]) {
    if (!(k in extra)) delete env[k];
  }
  return spawnSync(bashPath, [SCRIPT, ...args], { encoding: 'utf8', env, cwd: dir });
}

const defaultCopies = () => join(home, 'backups', 'saku');
const analysis = () => join(home, '.local', 'share', 'saku', 'analysis', 'saku.db');
const log = () => readFileSync(join(home, '.local', 'state', 'saku', 'copy-backups.log'), 'utf8');

describe('delete guard', () => {
  it('deletes nothing when the server holds fewer than 3 backups', () => {
    mkdirSync(defaultCopies(), { recursive: true });
    writeFileSync(join(defaultCopies(), 'saku-2020-01-01.db.gz'), 'old');
    serverBackup('saku-2026-01-01.db.gz');
    serverBackup('saku-2026-01-02.db.gz');
    expect(run(['srv']).status).toBe(0);
    expect(readdirSync(defaultCopies()).sort()).toEqual([
      'saku-2020-01-01.db.gz',
      'saku-2026-01-01.db.gz',
      'saku-2026-01-02.db.gz',
    ]);
    expect(log()).toContain('without deleting anything');
    expect(readFileSync(join(dir, 'rsync-calls'), 'utf8')).not.toContain('--delete');
  });

  it('prunes what the server no longer holds at 3 or more, and ignores other files', () => {
    mkdirSync(defaultCopies(), { recursive: true });
    writeFileSync(join(defaultCopies(), 'saku-2020-01-01.db.gz'), 'old');
    for (const d of ['01', '02', '03']) serverBackup(`saku-2026-01-${d}.db.gz`);
    serverBackup('other-2026-01-04.db.gz');
    expect(run(['srv']).status).toBe(0);
    expect(readdirSync(defaultCopies()).sort()).toEqual([
      'saku-2026-01-01.db.gz',
      'saku-2026-01-02.db.gz',
      'saku-2026-01-03.db.gz',
    ]);
    expect(log()).toContain('3 backup(s) here, newest saku-2026-01-03.db.gz');
  });
});

describe('folder precedence', () => {
  it('argument beats SAKU_COPY_DIR beats the default under HOME', () => {
    serverBackup('saku-2026-01-01.db.gz');
    const viaEnv = join(dir, 'env-copies');
    const viaArg = join(dir, 'arg-copies');
    expect(run(['srv', viaArg], { SAKU_COPY_DIR: viaEnv }).status).toBe(0);
    expect(existsSync(join(viaArg, 'saku-2026-01-01.db.gz'))).toBe(true);
    expect(existsSync(viaEnv)).toBe(false);
    expect(run(['srv'], { SAKU_COPY_DIR: viaEnv }).status).toBe(0);
    expect(existsSync(join(viaEnv, 'saku-2026-01-01.db.gz'))).toBe(true);
    expect(existsSync(defaultCopies())).toBe(false);
    expect(run(['srv']).status).toBe(0);
    expect(existsSync(join(defaultCopies(), 'saku-2026-01-01.db.gz'))).toBe(true);
  });
});

describe('analysis copy', () => {
  it('is created, left alone when not newer, rewritten when newer', () => {
    serverBackup('saku-2026-01-01.db.gz', 'first');
    expect(run(['srv']).status).toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('first');

    writeFileSync(analysis(), 'marker');
    expect(run(['srv']).status).toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('marker');

    serverBackup('saku-2026-01-02.db.gz', 'second');
    expect(run(['srv']).status).toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('second');
    expect(existsSync(`${analysis()}.part`)).toBe(false);
  });

  it('carries the backup mtime: older than now but newer than the copy refreshes', () => {
    serverBackup('saku-2026-01-01.db.gz', 'first');
    utimesSync(
      join(server, 'saku-2026-01-01.db.gz'),
      new Date('2020-01-01'),
      new Date('2020-01-01'),
    );
    expect(run(['srv']).status).toBe(0);
    expect(statSync(analysis()).mtime.toISOString()).toBe('2020-01-01T00:00:00.000Z');

    serverBackup('saku-2026-01-02.db.gz', 'second');
    utimesSync(
      join(server, 'saku-2026-01-02.db.gz'),
      new Date('2021-01-01'),
      new Date('2021-01-01'),
    );
    expect(run(['srv']).status).toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('second');
    expect(statSync(analysis()).mtime.toISOString()).toBe('2021-01-01T00:00:00.000Z');

    // Unchanged: left alone.
    writeFileSync(analysis(), 'marker');
    utimesSync(analysis(), new Date('2021-01-01'), new Date('2021-01-01'));
    expect(run(['srv']).status).toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('marker');
  });

  it('refreshes when the same backup is rewritten with a later mtime', () => {
    const f = join(server, 'saku-2026-01-01.db.gz');
    serverBackup('saku-2026-01-01.db.gz', 'v1');
    utimesSync(f, new Date('2020-01-01'), new Date('2020-01-01'));
    expect(run(['srv']).status).toBe(0);
    serverBackup('saku-2026-01-01.db.gz', 'v2');
    utimesSync(f, new Date('2020-06-01'), new Date('2020-06-01'));
    expect(run(['srv']).status).toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('v2');
  });

  it('removes a leftover -wal and -shm of the old copy', () => {
    serverBackup('saku-2026-01-01.db.gz', 'first');
    expect(run(['srv']).status).toBe(0);
    writeFileSync(`${analysis()}-wal`, 'w');
    writeFileSync(`${analysis()}-shm`, 's');
    serverBackup('saku-2026-01-02.db.gz', 'second');
    utimesSync(
      join(server, 'saku-2026-01-02.db.gz'),
      new Date('2099-01-01'),
      new Date('2099-01-01'),
    );
    expect(run(['srv']).status).toBe(0);
    expect(existsSync(`${analysis()}-wal`)).toBe(false);
    expect(existsSync(`${analysis()}-shm`)).toBe(false);
  });

  it('honors SAKU_ANALYSIS_DB and SAKU_DATA_DIR (replaces the saku folder)', () => {
    serverBackup('saku-2026-01-01.db.gz', 'x');
    const a = join(dir, 'custom', 'a.db');
    expect(run(['srv'], { SAKU_ANALYSIS_DB: a }).status).toBe(0);
    expect(readFileSync(a, 'utf8')).toBe('x');
    const data = join(dir, 'data');
    expect(run(['srv'], { SAKU_DATA_DIR: data }).status).toBe(0);
    expect(readFileSync(join(data, 'analysis', 'saku.db'), 'utf8')).toBe('x');
  });

  it('keeps the old copy when the newest backup is not a valid gzip', () => {
    serverBackup('saku-2026-01-01.db.gz', 'good');
    expect(run(['srv']).status).toBe(0);
    writeFileSync(join(server, 'saku-2026-01-02.db.gz'), 'not gzip at all');
    const r = run(['srv']);
    expect(r.status).not.toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('good');
    expect(existsSync(`${analysis()}.part`)).toBe(false);
    expect(log()).toContain('could not unpack saku-2026-01-02.db.gz');
  });

  it('keeps the old copy when the integrity check fails', () => {
    serverBackup('saku-2026-01-01.db.gz', 'good');
    expect(run(['srv']).status).toBe(0);
    serverBackup('saku-2026-01-02.db.gz', 'BAD');
    expect(run(['srv']).status).not.toBe(0);
    expect(readFileSync(analysis(), 'utf8')).toBe('good');
    expect(existsSync(`${analysis()}.part`)).toBe(false);
    expect(log()).toContain('integrity check failed for saku-2026-01-02.db.gz');
  });

  it('skips the integrity check, with a log line, when sqlite3 is missing', () => {
    // A PATH with only the fake bin dir (no sqlite3) plus links to the tools the script needs.
    const only = join(dir, 'only-bin');
    mkdirSync(only);
    for (const t of readdirSync(join(dir, 'bin'))) {
      if (t !== 'sqlite3') symlinkSync(join(dir, 'bin', t), join(only, t));
    }
    for (const t of [
      'env',
      'bash',
      'gunzip',
      'gzip',
      'mkdir',
      'date',
      'ls',
      'sort',
      'tail',
      'wc',
      'basename',
      'dirname',
      'rm',
      'mv',
      'touch',
      'cat',
      'cmp',
      'cp',
      'stat',
      'find',
      'realpath',
      'sed',
    ]) {
      const f = which(t);
      if (f) symlinkSync(f, join(only, t));
    }
    rmSync(join(dir, 'bin', 'sqlite3'));
    serverBackup('saku-2026-01-01.db.gz', 'BAD');
    expect(run(['srv'], {}, only).status).toBe(0);
    expect(log()).toContain('integrity check skipped');
    expect(readFileSync(analysis(), 'utf8')).toBe('BAD');
  });
});

describe('failures and refusals', () => {
  it('aborts without copying when ssh fails', () => {
    serverBackup('saku-2026-01-01.db.gz');
    writeFileSync(join(dir, 'ssh-fails'), '');
    expect(run(['srv']).status).not.toBe(0);
    expect(existsSync(join(dir, 'rsync-calls'))).toBe(false);
    expect(existsSync(analysis())).toBe(false);
  });

  it('aborts when the count is not a number', () => {
    serverBackup('saku-2026-01-01.db.gz');
    writeFileSync(join(dir, 'ssh-garbage'), '');
    expect(run(['srv']).status).not.toBe(0);
    expect(existsSync(join(dir, 'rsync-calls'))).toBe(false);
  });

  it('refuses to run when CI or VERCEL is set', () => {
    for (const k of ['CI', 'VERCEL']) {
      const r = run(['srv'], { [k]: '1' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('refuses to run');
    }
    expect(existsSync(join(dir, 'rsync-calls'))).toBe(false);
  });

  it('rejects a remote folder with whitespace or shell metacharacters before any ssh', () => {
    serverBackup('saku-2026-01-01.db.gz');
    for (const bad of ['a b', 'a;rm', '$(x)', "a'b", 'a*']) {
      const r = run(['srv'], { SAKU_REMOTE_BACKUP_DIR: bad });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('SAKU_REMOTE_BACKUP_DIR');
    }
    expect(existsSync(join(dir, 'rsync-calls'))).toBe(false);
  });

  it('counts only non-empty backups on the server', () => {
    for (const d of ['01', '02', '03']) writeFileSync(join(server, `saku-2026-01-${d}.db.gz`), '');
    mkdirSync(defaultCopies(), { recursive: true });
    writeFileSync(join(defaultCopies(), 'saku-2020-01-01.db.gz'), 'old');
    run(['srv']); // the empty newest file then fails to unpack; only the guard matters here
    expect(existsSync(join(defaultCopies(), 'saku-2020-01-01.db.gz'))).toBe(true);
    expect(readFileSync(join(dir, 'rsync-calls'), 'utf8')).not.toContain('--delete');
    expect(log()).toContain('0 non-empty backup(s)');
  });

  it('needs a host', () => {
    expect(run([]).status).not.toBe(0);
  });
});

describe('install', () => {
  const ps = () => readFileSync(join(dir, 'powershell-args'), 'utf8');

  it('registers the hidden task with the resolved folder and the schedule', () => {
    const r = run(['install', 'srv', 'rel/copies'], { WSL_DISTRO_NAME: 'TestDistro' });
    expect(r.status).toBe(0);
    const text = ps();
    expect(text).toContain("-TaskName 'saku-backup-copy'");
    expect(text).toContain("-Execute 'conhost.exe'");
    expect(text).toContain('--headless wsl.exe -d TestDistro -- bash -lc');
    expect(text).toContain(
      `${SCRIPT.replace('/packages/plugin-sdk/src/../../../', '/')} srv ${join(dir, 'rel/copies')}`,
    );
    expect(text).toContain("$logon.Delay = 'PT10M'");
    expect(text).toContain('-Once -At 00:30 -RepetitionInterval (New-TimeSpan -Hours 6)');
    for (const flag of [
      '-StartWhenAvailable',
      '-RunOnlyIfNetworkAvailable',
      '-AllowStartIfOnBatteries',
      '-DontStopIfGoingOnBatteries',
      '-ExecutionTimeLimit (New-TimeSpan -Minutes 30)',
      '-MultipleInstances IgnoreNew',
      '-LogonType Interactive -RunLevel Limited',
    ]) {
      expect(text).toContain(flag);
    }
  });

  it('refuses outside WSL and unsafe characters', () => {
    const noDistro = run(['install', 'srv']);
    expect(noDistro.status).not.toBe(0);
    const space = run(['install', 'srv', 'a folder'], { WSL_DISTRO_NAME: 'TestDistro' });
    expect(space.status).toBe(1);
    expect(space.stderr).toContain('refuses');
    expect(run(['install', 'a b', 'x'], { WSL_DISTRO_NAME: 'TestDistro' }).status).toBe(1);
    expect(run(['install', 'srv'], { WSL_DISTRO_NAME: "Test'Distro" }).status).toBe(1);
    expect(existsSync(join(dir, 'powershell-args'))).toBe(false);
  });
});
