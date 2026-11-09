# Running Saku

Jobs run only on the server, never from a web request, and refuse to start when `CI` or `VERCEL`
is set. Commands run from the repository folder. Setup is in `docs/setup.md`.

## Jobs

| Command | What it does |
|---|---|
| `pnpm bootstrap` | Full history from every source, then the checks (layers A-C). First install, new symbols |
| `pnpm daily` | Once per trading day, at the first check after the day's data is final (after 20:00 New York time by default); exits at once when the day is done, unless a red day waits for its re-check (see "Red re-check runs" below). `--force` runs again for the latest final day |
| `pnpm weekly` | Full-history refetch (changed values go to the revision log and the admins get a summary), checks, recompute of every recorded day, and layer E |
| `pnpm monthly` | The audit report of the previous month (and of any earlier month not done since the first run, up to 12 back): stored in the activity log and, after the A1 gate, sent once in short form to the admin channels. A month is done once its report is stored and its alert delivered (or waiting for the gate); a done month is not produced again. A month that ended before `forward_records_from` (or any month while it is unset) is stored and done without an alert, so a catch-up after the gate sends no pre-gate month |
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
| `pnpm settings set <name> <value>` | Install settings, such as `base_currency`, `time_zone`, `primary_language`, `broker_costs` (the list and their rules: `docs/setup.md`, "Settings"). `pnpm settings list` shows each value or "(not set)" |
| `pnpm settings deposit-rate add <ratePct> <from YYYY-MM-DD> <currency>` | Adds an entry to the base currency's deposit rate series (append-only; after the latest entry or before the earliest; `docs/setup.md`, "Deposit rate"). `pnpm settings deposit-rate correct <from> <ratePct> --reason "..."` corrects an entry's rate through the revision log; `pnpm settings deposit-rate list` lists the entries with their corrections |
| `pnpm symbols import <file>` | Loads a universe file (see `templates/universe/`). Each symbol states `ticker`, `tier`, `assetClass`, `currency` and `leverageFactor` (1 for an unleveraged fund, 2 for 2x, -1 for inverse; required, so a leveraged fund is never taken for an unleveraged one), and optionally `underlying`, `issuer`, `indexSeries` and `domicile` (ISO 3166-1 alpha-2, where its dividends come from: withholding at source). An optional field left out of a re-import keeps the stored value; `null` clears it. A file with any problem is refused whole, nothing written |
| `pnpm user create <username>` | Creates an account (the first is an admin) |
| `pnpm plugins` | Loads and validates every plug-in and lists them |
| `pnpm plugins tax-regime <key>` | Sets the install's tax regime (`tax_regime`) to a loaded regime plug-in; an unknown key is refused, and so is a change once users have tax data (`pnpm settings set tax_regime` is refused: it cannot check the key) |
| `pnpm tax-accounts list\|open <type>\|close <type> --user <username>` | A user's tax accounts under the install's regime (requirements 07). `list` shows the implied `taxable` account (every user holds it; never opened or closed), the user's stored accounts (open or closed, with their dates) and the types that can still be opened. `open <type> [--opened-on YYYY-MM-DD]` opens a tax-advantaged account type the regime declares (refused: `taxable`, an unknown type, one already open, a regime not set or changed since set); the first account locks `tax_regime`. `close <type> [--on YYYY-MM-DD]` closes the open account on that date (default: today in the install's `time_zone`; without `time_zone`, `--on` is required); not before its opening date. No date is later than today in the install's `time_zone` (without one: later than today anywhere, UTC+14). Periods of one type never overlap: after a closed account of the type, reopening needs `--opened-on`, later than its latest close; rows are kept, a reopened account is a new row. Opening an account and changing `tax_regime` each run in one write transaction, so they never interleave. Each change is in the activity log |
| `pnpm plugins benchmarks <file.json>` | Sets the benchmark set (`benchmarks`) from a JSON file (`templates/benchmarks/example.json`); each benchmark's `account` must be an account type of the install's tax regime, so the regime is set first (`pnpm settings set benchmarks` is refused: it cannot check the account). The whole list each time; prints each benchmark's name with its holdings |
| `pnpm sources list` | Source roles per data kind. `pnpm sources set <bars\|series\|fx\|tax_fx\|issuer> <key> <primary\|secondary\|check>`, `pnpm sources remove <kind> <key>`, `pnpm sources issuer-stats [--years N]`, `pnpm sources readjustments [--source <key>] [--run <id>]`, `pnpm sources stand-in list [--open]`, `pnpm sources stand-in close <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin>`, `pnpm sources closed-event list [--open]`, `pnpm sources closed-event resolve <TICKER> <YYYY-MM-DD> --reason "<text>" --user <admin>` (see `docs/data-pipeline.md`, `docs/troubleshooting.md`) |
| `pnpm csv import <file> --ticker <T> --prices raw\|split-adjusted [--source csv-<name>]` | Imports daily bars from a CSV as their own source (give it a role to use it) |
| `pnpm health [--date <D>] [--days <N>] [--lang <code>]` | The data-health report; the last 5 trading days by default. Its second line is the database size and the disk used and free (`Database 3.0 MB; disk 41.2% used, 20.1 GB free.`); the daily run alerts the admins once a day when the disk is 70% full or more |
| `pnpm health --summary [--run <id>] [--check <name> [--symbol <T>] [--source <id>]] [--values [--per-group <N>] [--status red\|yellow\|all]]` | The non-green results of one full-history run, grouped; `--values` adds the stored values behind up to N dates per group (default 5, red groups) or behind each `--check` date, as stored now (see `docs/data-pipeline.md`) |
| `pnpm audit-report [--month <YYYY-MM>] [--lang <code>]` | The monthly audit report, read-only (default: the previous calendar month in the install's time zone, `time_zone`, else the server's; a month is refused until it is over in that time zone and in UTC (the quota ledger's days), its last trading day's data is final and a complete daily run has processed that day). Sections: 1. trading days by grade (green, yellow, red, not graded; each day not green with its reasons, as `pnpm health`); 2. bar revisions detected in the month by symbol and source, the 20 largest relative changes, and re-adjustments; 3. quota use per provider from the provider ledger (UTC days: requests, the peak day and distinct symbols against the declared daily and monthly-symbol limits, flagged above 80%; days the ledger may have pruned, 31 days back, or a UTC month not over yet make the counts "at least"; a provider that sent requests without known limits is flagged); 4. the forward records: every chain and anchor verified now (as `pnpm strategy verify`), entries dated in the month per version with their data status, safe-state days and the days the forward step records for it (after the A1 gate and the version's registration) without an entry, annotations added by kind; 5. runs started in the month by type and status, each failed or unfinished one with the first line of its error; 6. stand-ins dated in the month: resolved, closed, open, reopened. It ends with `Verdict: all clear.` or `Verdict: needs attention (...)`. Not `pnpm audit`: that is pnpm's own command |
| `pnpm strategy check\|register\|list\|show\|verify\|recompute` | Strategy definitions, versions and the forward record. A strategy file is YAML (`.yaml` or `.yml`, YAML 1.2; comments welcome) or JSON (`.json`); `templates/strategies/` has examples. Anything that could be read two ways is refused with its line: duplicate keys (JSON files too), unknown keys (a typo such as `tolerencePct`), keys that are not plain names, anchors and aliases, merge keys (`<<`), tags, several documents, and a comment right after unquoted text (`name: Setup #1` would read as "Setup"; quote it). A YAML file and the same strategy in JSON register the same version. `check` prints what the file says as read (name, account, execution, safe state, signals, allocations) and the costs it would run with (the install's `broker_costs` for any the file leaves out, named as such; exit 1 when a cost is not known); `register` prints it before it writes and stores the effective costs in the version. Costs are limited like `broker_costs` (slippage at most 1000 bps, fee and FX spread below 100%). `register` refuses `same_close` execution and any ticker the strategy reads or holds (safe state included) whose full history has not passed the checks: the latest full check (`pnpm verify`, weekly or bootstrap; an interrupted or failed one refuses) must have succeeded, graded it from its first stored bar through the latest final session and found no red day (a closed day red only for a bar dated on it does not count), and no stored bar may be red, ungraded, or on a day the calendar does not cover; bars on days the market was closed are left out of the series and listed as a note. `check <file> --registration` prints every reason `register` would refuse (or "Ready to register."; exit 1 with problems) and writes nothing. `register`, `check --registration` and `recompute` refuse while a job runs (they take the jobs lock) |
| `pnpm journal add\|list` | What you did with a signal |
| `pnpm channel add\|list\|disable\|enable\|test` | Alert channels (Discord, Telegram) |
| `pnpm backup`, `pnpm restore <file>` | See `docs/backups.md` |
| `pnpm drill red [--date <D>]` | A simulated red day, to prove the provisional message and the final "safe state stands" arrive (see "Red-day drill" in `docs/troubleshooting.md`) |

Run a command without arguments, or with a wrong one, to see its usage line.

## Schedule

Units are in `ops/systemd/`; install steps are in `docs/setup.md`. Replace `<user>` when copying.

| Timer | When | Runs |
|---|---|---|
| `saku-daily.timer` | Every hour at :20 | `pnpm probe` (its failure never stops the next step), then `pnpm daily` |
| `saku-weekly.timer` | Sundays at 10:37 | `pnpm weekly` |
| `saku-monthly.timer` | The 1st of each month at 11:47 (the 2nd and 3rd retry a month not done) | `pnpm monthly` |
| `saku-update.timer` | Every 5 minutes | `ops/update-server.sh --auto`: pulls new commits, installs, migrates, checks, rolls back on failure |

The timers use `Persistent=true` (daily, weekly, monthly), so a run missed while the machine was off
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

## Turning the server off

```bash
sudo ops/safe-shutdown.sh [--also <prefix>]... [--wait <minutes>] [--no-poweroff] [--dry-run]
```

It stops the `saku-*` timers (and `<prefix>-*` for each `--also`, for other apps on the machine),
waits up to `--wait` minutes (default 15) while a job or update they trigger is running, stops the
other matching services, syncs, and powers off. `--dry-run` lists what it would do and changes
nothing. If a job is still running after the wait it asks before stopping it; with no answer (no
terminal) it starts the timers again and shuts nothing down (exit 1). A stopped job is redone after
the restart: its lock is taken over and the next run catches up (see "Locks, stamps and catching
up"). The timers are only stopped, never disabled, so they come back at boot (with
`--no-poweroff`, also by `sudo systemctl start <timers>`, which the script prints).

## Red re-check runs

A strategy's day that is red at its first grading (after the A1 gate) is not recorded at once
(requirements 04 "Red re-check before execution"). Its owner gets a provisional message: the data
problem, that the day is checked again every hour, the deadline, and the safe state that applies if
nothing changes. The deadline is the next session's regular US open (09:30 New York, daylight saving
followed) less `red_recheck_minutes_before_open` (default 60; `docs/setup.md`), shown in the
install's time zone.

- While a re-check is open, the hourly check runs the daily job again for that day although it is
  stamped: fetch of the 10-session window, checks, the forward step for the waiting day only,
  alerts, backup. These runs are recorded as daily runs marked `recheck` (`job_runs.recheck`); they
  write no stamp and send no session ping (that stays the day's own run); a failed one withholds the
  keep-alive and the retry of a failed session ping (see "Heartbeat"). A re-check run that
  finished every step is complete whatever the day grades (red is data, not a failure); one that
  did not is a failed run as any other (admins told, retried at the next check).
- The day turns not red before the deadline: its normal decision is recorded (yellow rules if
  yellow) and the owner gets one final message with the normal instruction. Still red at the last
  check before the deadline (the check at :20 within the hour before it): the safe state is
  recorded and the final message says it stands. Exactly one final message per strategy and day.
- The entry stores what was finally signaled with the time it was decided (`finalDecidedAt` in
  the hashed text); the time the final message was sent is a `red_recheck_sent` annotation, and
  the first red grading (time, reasons, deadline) a `red_recheck` annotation. Corrections after
  the deadline are annotations, as before. `pnpm strategy list` shows an open re-check on the
  version's line (`<date> red, re-check open until <deadline>`).
- Whether a run is the last check before the deadline is decided by when it started its work
  (after taking the jobs lock; normally just after the :20 tick, later when the machine was busy or
  asleep), not by how long its steps took. A final message, or the safe-state alert of a day not
  re-checked, sent after the open says the instruction applied at that open.
- A final message that reached no channel (a library version, an owner with no channel) records
  no sending time and no `red_recheck_sent` annotation; the re-check still closes.
- A re-check that cannot close (the latest re-check run after its deadline failed for that
  strategy, e.g. its definition no longer parses) is not run again every hour: that run's
  job-failure alert stands; fix the cause, then `pnpm daily --force`.
- The machine was off at the deadline: the next run records the safe state as the provisional
  message gave it (nothing known after the deadline is used) and the final message says it is late.
  A first grading with no check left before the deadline (a late catch-up) records the safe state
  at once, without a provisional message; its alert says so.
- The next day's entry waits for the open day (the chain order); by construction the open day is
  final before the next day's close. The monthly audit waits for an open re-check of its month
  (after its deadline that counts as the daily job being stuck); `pnpm spike` leaves re-check runs
  out.
- Over a weekend the re-check runs hourly from Friday evening to Monday morning: about 60 runs,
  each asking every source for the 10-session window (within the quota guard).

## Heartbeat

After a fully successful daily run, Saku pings `HEALTHCHECK_URL` (healthchecks.io). When pings
stop, the service alerts you. A failed ping is retried at the next check without redoing the run,
but only while the latest daily run (re-check and forced runs included) still succeeded; otherwise
the check logs `No session ping retry` with the reason and sends nothing.

Sessions are weekdays only, so the hourly check also sends the same check a keep-alive: one ping per
New York calendar date with no session ping due (a date with no session, and the first session
after such dates), while the latest final session is done and pinged, the latest daily run
(re-check and forced runs included) succeeded for it, no red re-check is stuck, and that session is
at most 7 calendar days old. On a session's own evening and on the next calendar day when that day is also a
session, the session ping carries the check alone, as before. Otherwise it sends none and logs `No heartbeat keep-alive`
with the reason. A day not done takes the run path and logs no keep-alive line: the run's own
`daily not complete` line is the reason. So an outage still alerts within 30 hours of the last
ping. A missed 20:20 run on a weekday alerts about 6 hours later. On the first session after a
weekend or holiday it alerts about 10 hours later, up to about 29 if that day's keep-alive was only
answered late. An unanswered keep-alive is tried at the next check. Its stamp is `keepalive`
(`pending <date>` until answered); it never touches the `daily` or `heartbeat` stamps.

The weekly refetch pings `HEALTHCHECK_WEEKLY_URL` the same way, after a fully successful run
(optional; empty means no ping). Make it a second check on healthchecks.io with period 7 days and
grace 1 day (the weekly run is long). A failed weekly ping is logged and does not fail the run; the
weekly run is not repeated for it. The monthly audit report pings `HEALTHCHECK_MONTHLY_URL` the same
way (optional; period 31 days, grace 3 days). A monthly run that audited no month because no complete
daily run has processed the latest month's last trading day yet completes without the ping and logs
the reason as a warning, so the grace period alerts you when the daily job stays stuck; a month that
is only not over or not final yet is the normal wait and still pings.

## Logs and where things live

- `journalctl -u saku-daily` (and `saku-weekly`, `saku-monthly`, `saku-update`): the service output.
- JSON lines per job in `~/.local/state/saku/logs/<job>.log`; the probe's measurements in
  `~/.local/state/saku/probe.jsonl`; the update log in `~/.local/state/saku/update.log`.
- The state folder (logs, stamps, locks) is `SAKU_STATE_DIR` or `~/.local/state/saku`. The data
  folder (database, backups) is `SAKU_DATA_DIR` or `~/.local/share/saku`.
- Run status, activity and revisions are in the database; `pnpm health` shows the latest run
  (type, target, status, error, heartbeat).

## Exit codes

| Command | 0 | 1 |
|---|---|---|
| `pnpm daily`, `bootstrap`, `weekly`, `monthly` | The run completed (or nothing was due, or another job holds the lock); a re-check run that finds the day still red is complete | The run could not start or did not complete |
| `pnpm health` (also `--summary`) | The report was produced, whatever the grades (its last line, `Verdict: ...`, says them) | An error: a wrong argument, no database, an unknown run, check, symbol or source, nothing graded yet |
| `pnpm audit-report` | The report was produced, whatever it found (its last line, `Verdict: ...`, says it) | An error: a wrong argument, no database, no xnys calendar, a month not over yet or not processed by a daily run |
| `pnpm drill red` | The day was red, every registered strategy applied its safe state, its provisional message reached a channel, and at the simulated last re-check before the deadline it was still red and its final "safe state stands" reached a channel | Anything else, or a refusal (no registered strategy, CI or Vercel set, another job running) |
| Other commands | Done | An error or wrong usage, with a message |

A command run against an unmigrated database stops and says to run `pnpm db:migrate`.
