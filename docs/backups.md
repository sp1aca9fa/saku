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

A backup on the same machine does not survive losing the machine. Copy them elsewhere, for
example from another computer with `rsync` (placeholder host and user):

```bash
rsync -a --delete <user>@<server>:.local/share/saku/backups/ ~/saku-backups/
```

Run it from a scheduler on that computer (cron or a systemd timer), and check now and then that
the newest file is recent. `--delete` mirrors the server's pruning; drop it to keep everything.

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
