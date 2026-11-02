import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../../ops/safe-shutdown.sh');

// A fake systemctl: records every call, keeps state in files. `active` lists the units that
// are active; `count/<unit>` holds how many more is-active checks answer "activating".
const FAKE = `#!/usr/bin/env bash
d="$FAKE_DIR"
echo "$*" >>"$d/calls"
cmd="$1"; shift
case "$cmd" in
  list-units)
    if [ -e "$d/list-fails" ]; then exit 1; fi
    type="\${4#--type=}"
    for u in $(cat "$d/units"); do [[ "$u" == *.$type ]] && echo "$u loaded active running desc"; done
    ;;
  is-active)
    u="$1"
    if [ -e "$d/fixed/$u" ]; then cat "$d/fixed/$u"; exit 0; fi
    if [ -e "$d/after/$u" ]; then
      n=$(cat "$d/after/$u")
      if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$d/after/$u"; echo inactive; exit 3; fi
      echo activating; exit 0
    fi
    if [ -e "$d/stopped/$u" ]; then echo inactive; exit 3; fi
    if [ -e "$d/count/$u" ]; then
      n=$(cat "$d/count/$u")
      if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$d/count/$u"; echo activating; exit 0; fi
      echo inactive; exit 3
    fi
    if grep -qx "$u" "$d/active"; then echo active; else echo inactive; exit 3; fi
    ;;
  show)
    u="\${4}"
    if [ -e "$d/unit/$u" ]; then cat "$d/unit/$u"; else echo "\${u%.timer}.service"; fi
    ;;
  poweroff) if [ -e "$d/poweroff-fails" ]; then exit 1; fi ;;
  stop) for u in "$@"; do touch "$d/stopped/$u"; done ;;
  start) for u in "$@"; do rm -f "$d/stopped/$u"; done ;;
esac
exit 0
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saku-shutdown-'));
  mkdirSync(join(dir, 'stopped'));
  mkdirSync(join(dir, 'count'));
  for (const sub of ['fixed', 'after', 'unit']) mkdirSync(join(dir, sub));
  writeFileSync(
    join(dir, 'units'),
    [
      'saku-daily.timer',
      'saku-daily.service',
      'saku-app.service',
      'other-sync.timer',
      'other-sync.service',
      'other-web.service',
      'unrelated.service',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'active'),
    ['saku-daily.timer', 'saku-app.service', 'other-sync.timer', 'other-web.service'].join('\n'),
  );
  writeFileSync(join(dir, 'systemctl'), FAKE);
  chmodSync(join(dir, 'systemctl'), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    input: 'n\n',
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      FAKE_DIR: dir,
      SAFE_SHUTDOWN_SYSTEMCTL: join(dir, 'systemctl'),
      SAFE_SHUTDOWN_POLL_SECONDS: '0.05',
      SAFE_SHUTDOWN_ALLOW_NONROOT: '1',
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
  } catch {
    // no systemctl call was made
  }
  return { status: r.status, out: r.stdout, err: r.stderr, calls };
}

const mutating = (calls: string[]) => calls.filter((c) => /^(stop|start|poweroff)/.test(c));

describe('ops/safe-shutdown.sh', () => {
  it('waits for a running job to end, stops the apps, powers off', () => {
    writeFileSync(join(dir, 'count/saku-daily.service'), '3');
    const r = run(['--wait', '1']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Waiting');
    expect(mutating(r.calls)).toEqual([
      'stop saku-daily.timer',
      'stop saku-app.service',
      'poweroff',
    ]);
  });

  it('with a job that never ends and no terminal: starts the timers again, exits 1', () => {
    writeFileSync(join(dir, 'count/saku-daily.service'), '999999');
    const r = run(['--wait', '0']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Still running: saku-daily.service. Stop them now?');
    expect(r.out).toContain('Nothing was shut down.');
    expect(mutating(r.calls)).toEqual(['stop saku-daily.timer', 'start saku-daily.timer']);
  });

  it('--dry-run changes nothing and names the units', () => {
    const r = run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('saku-daily.timer');
    expect(r.out).toContain('saku-app.service');
    expect(mutating(r.calls)).toEqual([]);
  });

  it('--also selects the extra prefix, nothing else', () => {
    const r = run(['--also', 'other', '--wait', '0']);
    expect(r.status).toBe(0);
    expect(mutating(r.calls)).toEqual([
      'stop other-sync.timer',
      'stop saku-daily.timer',
      'stop other-web.service',
      'stop saku-app.service',
      'poweroff',
    ]);
    expect(r.calls.join('\n')).not.toContain('unrelated');
  });

  it('without --also leaves the other prefix alone', () => {
    const r = run(['--wait', '0']);
    expect(r.calls.join('\n')).not.toContain('other-');
  });

  it('--no-poweroff keeps the timers stopped and says how to start them', () => {
    const r = run(['--no-poweroff', '--wait', '0']);
    expect(r.status).toBe(0);
    expect(mutating(r.calls)).toEqual(['stop saku-daily.timer', 'stop saku-app.service']);
    expect(r.out).toContain('sudo systemctl start saku-daily.timer');
  });

  it('aborts when the unit listing fails', () => {
    writeFileSync(join(dir, 'list-fails'), '');
    const r = run(['--wait', '0']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('cannot list units');
    expect(mutating(r.calls)).toEqual([]);
  });

  it('aborts when there is no saku unit', () => {
    writeFileSync(join(dir, 'units'), 'other-sync.timer\nother-sync.service');
    const r = run(['--wait', '0']);
    expect(r.status).toBe(1);
    expect(mutating(r.calls)).toEqual([]);
  });

  it('aborts when an --also prefix matches nothing', () => {
    const r = run(['--also', 'nothere', '--wait', '0']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('nothere');
    expect(mutating(r.calls)).toEqual([]);
  });

  it('starts the timers again when the power-off fails', () => {
    writeFileSync(join(dir, 'poweroff-fails'), '');
    const r = run(['--wait', '0']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Starting the stopped timers again');
    expect(mutating(r.calls).slice(-2)).toEqual(['poweroff', 'start saku-daily.timer']);
  });

  it('asks when a job starts after the wait; no means timers back, no power-off', () => {
    writeFileSync(join(dir, 'after/saku-daily.service'), '1');
    const r = run(['--wait', '0']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Still running: saku-daily.service');
    expect(mutating(r.calls)).toEqual(['stop saku-daily.timer', 'start saku-daily.timer']);
  });

  it('counts deactivating as running', () => {
    writeFileSync(join(dir, 'fixed/saku-daily.service'), 'deactivating');
    const r = run(['--wait', '0']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Still running: saku-daily.service');
  });

  it('waits for the unit a timer triggers through Unit=', () => {
    writeFileSync(
      join(dir, 'units'),
      ['saku-x.timer', 'saku-work.service', 'saku-app.service'].join('\n'),
    );
    writeFileSync(join(dir, 'active'), ['saku-x.timer', 'saku-app.service'].join('\n'));
    writeFileSync(join(dir, 'unit/saku-x.timer'), 'saku-work.service');
    writeFileSync(join(dir, 'count/saku-work.service'), '2');
    const r = run(['--wait', '1']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Waiting');
    expect(r.out).toContain('saku-work.service');
  });

  it('refuses malformed and system prefixes', () => {
    for (const prefix of ['bad;x', 'a b', 'systemd', 'sshd']) {
      const r = run(['--also', prefix, '--wait', '0']);
      expect(r.status).not.toBe(0);
      expect(mutating(r.calls)).toEqual([]);
    }
  });

  it('refuses without root unless dry-run or the test override', () => {
    if (process.getuid?.() === 0) return;
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        FAKE_DIR: dir,
        SAFE_SHUTDOWN_SYSTEMCTL: join(dir, 'systemctl'),
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Run as root');
  });
});
