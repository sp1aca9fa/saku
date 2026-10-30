# Running Saku

Jobs run only on the server, never from a web request, and refuse to start when `CI` or `VERCEL`
is set. Commands run from the repository folder. Setup is in `docs/setup.md`.

## Jobs

| Command | What it does |
|---|---|
| `pnpm bootstrap` | Full history from every source, then the checks (layers A-C). First install, new symbols |
| `pnpm daily` | Once per trading day, at the first check after the day's data is final (after 20:00 New York time by default); exits at once when the day is done. `--force` runs again for the latest final day |
| `pnpm weekly` | Full-history refetch (changed values go to the revision log and the admins get a summary), checks, recompute of every recorded day, and layer E |
| `pnpm verify` (alias `pnpm checks`) | The checks and layer E (core vs reference, incremental vs full) on stored data, no fetching |
| `pnpm probe` | The last sessions of one ticker from every bar source, to a log, to learn when data becomes final |
| `pnpm spike [--from <YYYY-MM-DD>]` | The A1 gate, session by session; `--from` counts from the first session on or after the date |

`pnpm daily` does, in order: fetch (every source, every active symbol), verify, record the
forward results, recompute, send alerts, back up, then stamp the day and ping the heartbeat, the
last two only when every source answered for every item. Details: `docs/data-pipeline.md`.

## Other commands

| Command | What it does |
|---|---|
| `pnpm db:migrate` | Applies database migrations. Run after every update (the update script does) |
| `pnpm settings set <name> <value>` | Install settings, such as `base_currency`, `time_zone`, `primary_language` |
| `pnpm symbols import <file>` | Loads a universe file (see `templates/universe/`) |
| `pnpm user create <username>` | Creates an account (the first is an admin) |
| `pnpm plugins` | Loads and validates every plug-in and lists them |
| `pnpm sources list` | Source roles per data kind. `pnpm sources set <bars\|series\|fx\|issuer> <key> <primary\|secondary\|check>`, `pnpm sources remove <kind> <key>`, `pnpm sources issuer-stats [--years N]`, `pnpm sources readjustments [--source <key>] [--run <id>]` (see `docs/data-pipeline.md`) |
| `pnpm csv import <file> --ticker <T> --prices raw\|split-adjusted [--source csv-<name>]` | Imports daily bars from a CSV as their own source (give it a role to use it) |
| `pnpm health [--date <D>] [--days <N>] [--lang <code>]` | The data-health report; the last 5 trading days by default |
| `pnpm strategy check\|register\|list\|show\|verify\|recompute` | Strategy definitions, versions and the forward record (`templates/strategies/` has examples). `register` refuses `same_close` execution and any ticker the strategy reads or holds (safe state included) whose full history has not passed the checks: the latest full check (`pnpm verify`, weekly or bootstrap; an interrupted or failed one refuses) must have succeeded, graded it from its first stored bar through the latest final session and found no red day, and no stored bar may be red, ungraded, or on a day the market was closed. `register` and `recompute` refuse while a job runs (they take the jobs lock) |
| `pnpm journal add\|list` | What you did with a signal |
| `pnpm channel add\|list\|disable\|enable\|test` | Alert channels (Discord, Telegram) |
| `pnpm backup`, `pnpm restore <file>` | See `docs/backups.md` |
| `pnpm drill red [--date <D>]` | A simulated red day, to prove the safe-state alert arrives (see "Red-day drill" in `docs/troubleshooting.md`) |

Run a command without arguments, or with a wrong one, to see its usage line.

## Schedule

Units are in `ops/systemd/`; install steps are in `docs/setup.md`. Replace `<user>` when copying.

| Timer | When | Runs |
|---|---|---|
| `saku-daily.timer` | Every hour at :20 | `pnpm probe` (its failure never stops the next step), then `pnpm daily` |
| `saku-weekly.timer` | Sundays at 10:37 | `pnpm weekly` |
| `saku-update.timer` | Every 5 minutes | `ops/update-server.sh --auto`: pulls new commits, installs, migrates, checks, rolls back on failure |

The timers use `Persistent=true` (daily, weekly), so a run missed while the machine was off
happens at the next start. Services run at lower priority with a CPU cap.

## Locks, stamps and catching up

- Only one job runs at a time (a lock file in the state folder, `locks/`). A second one logs
  "Another job is running" and exits with code 0. A lock left by a process that is gone is taken
  over.
- A successful daily run writes a stamp for its trading day (`stamps/`). The hourly check does
  nothing more once the day is stamped.
- A run that fails, or where a source or an alert failed, writes no stamp, so the next hourly
  check tries again. A day or several days missed (machine off) are caught up from the 10-session
  window of the next run, and by the weekly full-history run.
- Jobs are safe to repeat: stored data is never overwritten, a changed value is a new revision.

## Heartbeat

After a fully successful daily run, Saku pings `HEALTHCHECK_URL` (healthchecks.io). When pings
stop, the service alerts you. A failed ping is retried at the next check without redoing the run.

The weekly refetch pings `HEALTHCHECK_WEEKLY_URL` the same way, after a fully successful run
(optional; empty means no ping). Make it a second check on healthchecks.io with period 7 days and
grace 1 day (the weekly run is long). A failed weekly ping is logged and does not fail the run; the
weekly run is not repeated for it.

## Logs and where things live

- `journalctl -u saku-daily` (and `saku-weekly`, `saku-update`): the service output.
- JSON lines per job in `~/.local/state/saku/logs/<job>.log`; the probe's measurements in
  `~/.local/state/saku/probe.jsonl`; the update log in `~/.local/state/saku/update.log`.
- The state folder (logs, stamps, locks) is `SAKU_STATE_DIR` or `~/.local/state/saku`. The data
  folder (database, backups) is `SAKU_DATA_DIR` or `~/.local/share/saku`.
- Run status, activity and revisions are in the database; `pnpm health` shows the latest run
  (type, target, status, error, heartbeat).

## Exit codes

| Command | 0 | 1 |
|---|---|---|
| `pnpm daily`, `bootstrap`, `weekly` | The run completed (or nothing was due, or another job holds the lock) | The run could not start or did not complete |
| `pnpm health` | Every shown date is green overall and per symbol | Anything not green, not graded, or a wrong argument |
| `pnpm drill red` | The day was red, every registered strategy applied its safe state and its alert reached a channel | Anything else, or a refusal (no registered strategy, CI or Vercel set, another job running) |
| Other commands | Done | An error or wrong usage, with a message |

A command run against an unmigrated database stops and says to run `pnpm db:migrate`.
