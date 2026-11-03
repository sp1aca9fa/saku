# Backups

## What is backed up

The whole database (one SQLite file): market data, check results, runs, strategies, forward
records, users and their encrypted alert targets. Not backed up: `.env` (keep it and especially
`AUTH_SECRET` in a password manager; a restored database needs the same `AUTH_SECRET`) and the
logs.

## Where and when

- Each daily run writes `saku-<YYYY-MM-DD>.db.gz` (the date in the server's time zone) to
  `~/.local/share/saku/backups/`, after its steps. The weekly run also makes one before it
  refetches full history. `pnpm backup` makes one now.
- A consistent snapshot is taken (`VACUUM INTO`), checked with SQLite's integrity check, then
  compressed. The file appears whole or not at all; a copy that fails the check is not kept and
  the run fails.
- Kept: the newest 30 days, plus the first backup of each of the 12 newest months. Older ones are
  removed.
- Folders can be moved with `SAKU_DATA_DIR` or `SAKU_BACKUP_DIR` in `.env`.

## Off-machine copy

A backup on the same machine does not survive losing the machine. `ops/copy-backups.sh` copies
the server's backups to the PC you read results on, over ssh (the ssh host must log in with a key,
no password; the script never prompts), and keeps an analysis copy there (the newest backup,
unpacked) for read-only tools.

```bash
ops/copy-backups.sh <server> [folder]            # copy now
ops/copy-backups.sh install <server> [folder]    # Windows, from WSL: register the scheduled task
```

- `install` registers (or replaces) the Windows task `saku-backup-copy`: it runs 10 minutes after
  logon and every 6 hours from 00:30 while the PC is on, catches up after sleep, and runs in a
  hidden console (no window). The folder is made absolute and stored in the task.
- Folder for the copies: the argument, else `SAKU_COPY_DIR`, else `~/backups/saku`. It is never
  this machine's own data folder, so local development backups do not mix with the server's.
- Remote folder: `SAKU_REMOTE_BACKUP_DIR`, else `.local/share/saku/backups` (relative to the ssh
  user's home). Only `saku-*.db.gz` files are copied.
- The copy mirrors the server's pruning (`--delete`), but only when the server holds 3 or more
  non-empty backups. With fewer (a new or wiped disk) nothing is deleted here and the log says so. If the
  count itself fails (ssh error), the run stops without copying or deleting.
- Analysis copy: `SAKU_ANALYSIS_DB`, else `saku/analysis/saku.db` under the data folder
  (`SAKU_DATA_DIR`, else `$XDG_DATA_HOME` or `~/.local/share`). It is refreshed only when the
  newest local backup is newer. The backup is unpacked to a `.part` file, checked with SQLite's
  integrity check (if `sqlite3` is installed; otherwise the log says the check was skipped), then
  moved into place. If that fails, the old copy stays and the run exits with an error.
- The script refuses to run when `CI` or `VERCEL` is set.
- Log: `copy-backups.log` in the state folder (`SAKU_STATE_DIR`, else `$XDG_STATE_HOME` or
  `~/.local/state`, under `saku`), one dated header per run, the number of local backups and the
  newest name. Check now and then that the newest name is recent:
  `tail -n 20 ~/.local/state/saku/copy-backups.log`.

## Restore

Restoring only ever writes a new database file; it never overwrites an existing one.

```bash
# Stop the timers first so no job runs during the restore.
sudo systemctl stop saku-daily.timer saku-weekly.timer
pnpm restore ~/saku-backups/saku-2026-01-15.db.gz /path/to/new-saku.db
```

Without a target, `pnpm restore <file>` writes to the configured database, which must not exist:
move the broken one aside first (never delete it before the restored copy works). The restored
file is checked with SQLite's integrity check. Then:

```bash
pnpm db:migrate        # brings an older backup up to the current schema
pnpm health            # the last graded days are there
sudo systemctl start saku-daily.timer saku-weekly.timer
```

Days after the backup are fetched again by the next runs (the daily run covers 10 sessions; run
`pnpm bootstrap` to refill a longer gap). Forward records are append-only and hash-chained:
`pnpm strategy verify` recomputes every chain after a restore.
