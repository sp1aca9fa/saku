# Setup (server)

Saku runs on one always-on Linux machine (Ubuntu Server 24.04 here) as systemd services under your
user, no Docker. Commands run on the server unless said otherwise; `<user>` is your user there and
the code is cloned to `~/code/saku`. The machine itself (updates, ssh keys, power-loss restart) is
set up as for any home server; nothing below is specific to one.

Stage A1 sets up the data jobs only: the web app (and its Tailscale Funnel address) comes later.
Related guides: `docs/running.md` (jobs, schedule, logs), `docs/backups.md`, `docs/troubleshooting.md`,
`docs/plugins.md`.

## 1. Node and the code

```bash
git clone https://github.com/<you>/saku.git ~/code/saku && cd ~/code/saku
# Optional: your private plug-ins (see "Private plug-ins" below). The submodule's folder is
# private/; its git name stays plugins (the url setting below uses the name).
git config submodule.plugins.url git@github-saku-private:<you>/saku-private.git
git submodule update --init

# Node with nvm, the version in .nvmrc (the machine's default Node is left alone).
nvm install && nvm use && corepack enable
# A stable path the services run Node through (move the link when .nvmrc changes).
mkdir -p ~/.local/share/saku
ln -sfn "$(dirname "$(dirname "$(nvm which "$(cat .nvmrc)")")")" ~/.local/share/saku/node
pnpm --version   # corepack fetches the pinned pnpm once
pnpm install
```

Private plug-ins: the server reads that repo with its own read-only deploy key.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/saku-private-deploy -N "" -C "server saku-private"
cat ~/.ssh/saku-private-deploy.pub   # GitHub: the private repo > Settings > Deploy keys, write access off
cat >> ~/.ssh/config <<'EOF'

Host github-saku-private
  HostName github.com
  User git
  IdentityFile ~/.ssh/saku-private-deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T github-saku-private          # "Hi <you>/saku-private! ..."
```

"Repository not found" means GitHub got another key: check the key is on the private repo, and
that no earlier block in `~/.ssh/config` (`Host *`) offers a different key first.

## 2. Settings and keys

```bash
cp .env.example .env && chmod 600 .env
```

Fill in `AUTH_SECRET` (`openssl rand -base64 48`, kept in a password manager) and the keys of the
sources you use (free accounts: Tiingo, Alpaca, Massive, FRED; ECB needs none). Then:

```bash
pnpm db:migrate
pnpm settings set base_currency <ISO code, e.g. EUR>   # once, before any data
pnpm settings set time_zone <IANA zone, e.g. Europe/Paris>
pnpm settings set red_recheck_minutes_before_open 60       # optional; 60 is the default
pnpm symbols import templates/universe/us-etf-tier0.json
# Tier 1 (benchmarks, diversification; 03-assets, stage C2): only when you start C2
# pnpm symbols import templates/universe/us-etf-tier1.json
pnpm user create <your username>                         # the first account is an admin
```

`red_recheck_minutes_before_open` (whole minutes, 0 to 600; default 60): a day red at its first
grading is checked again every hour until this many minutes before the next session's regular US
open (09:30 New York, daylight saving followed), then its final instruction is sent (requirements
04 "Red re-check before execution"; `docs/running.md`, "Red re-check runs"). A later deadline gives a
corrected source more time but leaves you less time to read the final message before the open.
A re-check already open keeps the deadline it opened with.

### Settings

`pnpm settings list` shows every setting. Rates are decimal text in quotes (`"0.1"`, never `0.1`,
no sign, exponent or comma; at most 15 significant digits); JSON values are checked strictly: an
unknown or missing key, or a key given twice, is refused with every reason.

| Setting | Value | Notes |
|---|---|---|
| `base_currency` | ISO 4217 code | Once, before any data; never changed |
| `time_zone` | IANA zone | Display only; trading dates stay America/New_York |
| `primary_language` | language code | Default for users who chose none |
| `red_recheck_minutes_before_open` | 0 to 600 | Default 60 (above) |
| `issuer_nav_tolerance` | JSON map | `docs/data-pipeline.md` |
| `forward_records_from` | date | Set when the A1 gate passes |
| `tax_regime` | regime key | `pnpm plugins tax-regime <key>`; refused while the stored benchmarks name an account type the regime does not define |
| `broker_costs` | `{"slippageBps":"5","feePct":"0.1","fxSpreadPct":"0.2"}` | Your broker's costs: slippage in basis points (at most 1000), fee and FX spread in percent of the amount traded (each below 100; a strategy's own costs have the same limits). All three required (write `"0"` for none). The FX spread applies only to conversions between USD holdings and `CASH_BASE` (none with base currency USD) |
| `benchmarks` | JSON list | `pnpm plugins benchmarks <file>` (below) |

**Costs.** A strategy's `costs` may leave out any of `slippageBps`, `feePct`, `fxSpreadPct`; each
left out is the install's `broker_costs` value. When one is left out and `broker_costs` is not set
(or no longer parses), registration is refused with the reason and `pnpm strategy check` exits 1:
a cost is never read as 0. Registration writes the effective costs into the registered version, so
a later change of `broker_costs` never changes a registered version's results; `pnpm strategy
check` and `register` print the costs used and name those taken from the install. A version
registered before this existed is read as registered: an omitted cost is charged as 0, as when it
was recorded, and a cost above today's limits still parses (stored versions are never re-validated
by a limit added later).

**Deposit rate.** The base currency's deposit rate (for `CASH_BASE` and a bank-deposits
benchmark) is a dated series, not a single value: `pnpm settings deposit-rate add <ratePct>
<from YYYY-MM-DD> <currency>` adds an entry (percent a year as decimal text, below 1000; the
base currency, so set `base_currency` first), in force from that date until the next entry.
Entries are append-only: never edited or removed, and not dated after today's New York date. A new
entry starts after the latest one, or before the earliest (a backfill: every reader saw no rate
there); one on or between existing dates is refused, since it would change what those dates
already read. A wrong rate is corrected, never overwritten: `pnpm settings deposit-rate correct
<from> <ratePct> --reason "..."` adds a row to the revision log (the entry, the rate it replaces,
the new rate, the reason, who and when). Readers get the rate as corrected; a reader asking what
was known at an earlier instant gets the entries and corrections made by then. `pnpm settings
deposit-rate list` shows each entry with its corrections. A date before the first entry has no
rate (unknown, never a guess).

**Benchmarks.** A JSON list; each benchmark has exactly `id` (unique; lowercase letters, digits and
`_`, starting with a letter), `holdings` (`[{ "ticker": "SPY", "weight": 100 }]`: tickers as in a
strategy, or `DEPOSIT` for the deposit rate; weights add up to 100), `feePctPerYear` (decimal text,
the fee of the fund the benchmark models, percent a year) and `account` (an account type key of
the install's tax regime: requirements 01 assume index benchmarks in the regime's best
tax-advantaged account). Start from `templates/benchmarks/example.json` (made-up compositions,
all in `taxable`), then `pnpm plugins benchmarks <your file>`. A benchmark's name is the text
`benchmarks.<id>` in `packages/content` when there is one (a generic name such as "US stocks");
otherwise its id is shown. Wherever a benchmark is shown, what it holds is shown next to its name
(`US stocks (SPY 100%)`). A benchmark whose account type the install's regime does not define is
not read (and the regime cannot be changed to one that lacks it).

## 3. First data

```bash
pnpm bootstrap   # full history from every source, then layers A-C over it
pnpm spike       # (after daily runs) the A1 gate, day by day (--from <YYYY-MM-DD>: count from that date)
```

The bootstrap takes a few minutes (the slowest source sets the pace: 5 calls per minute on
Massive's free plan). Source roles are set from the plug-ins' suggestions the first time (one
primary per data kind, logged in the activity log).

## 4. The hourly check

`ops/systemd/saku-daily.service` and `.timer` run every hour at :20: the finalization probe, then
the daily job, which does its work once per trading day (the first check after 20:00 New York
time, after the day's data is final) and exits at once otherwise. Copy them, replace `<user>`:

```bash
sudo cp ops/systemd/saku-daily.* /etc/systemd/system/
sudo sed -i "s/<user>/$USER/g" /etc/systemd/system/saku-daily.service
sudo systemctl daemon-reload && sudo systemctl enable --now saku-daily.timer
```

The service runs at lower priority (`Nice=10`) with a CPU cap, so other apps on the machine stay
responsive. Logs: `journalctl -u saku-daily` and JSON lines in `~/.local/state/saku/logs/`; the
probe's measurements in `~/.local/state/saku/probe.jsonl`.

### The weekly run (after the A1 gate)

`ops/systemd/saku-weekly.service` and `.timer` run on Sundays at 10:37: a full-history refetch
from every source (changed values go to the revision log and the admins get a summary), the
checks over the full history, the recompute of every recorded day, and layer E on the stored data
(core vs reference, incremental vs full; the same as `pnpm verify`). A failure alerts the admins.

```bash
sudo cp ops/systemd/saku-weekly.* /etc/systemd/system/
sudo sed -i "s/<user>/$USER/g" /etc/systemd/system/saku-weekly.service
sudo systemctl daemon-reload && sudo systemctl enable --now saku-weekly.timer
```

`pnpm verify` runs the checks and layer E without fetching, any time.

### The monthly audit report

`ops/systemd/saku-monthly.service` and `.timer` run on the 1st of each month at 11:47 (server
time): the audit report of the previous month (`pnpm monthly`): its trading days by grade with
the reasons, revisions and re-adjustments, quota use per provider, the forward records' chain
verified, failed runs and stand-ins. It is stored in the activity log and, after the A1 gate, its
short form goes to the admin channels once. The timer also fires on the 2nd and 3rd; those runs
only retry a month that is not done (another job held the lock, an alert was not delivered, no
daily run had yet graded the month's last trading day) and
change nothing otherwise. Set the server's time zone to the install's (`pnpm settings set
time_zone`), or the month may be judged in another zone; a month missed is caught up by the next
run. It can be installed before the gate.

```bash
sudo cp ops/systemd/saku-monthly.* /etc/systemd/system/
sudo sed -i "s/<user>/$USER/g" /etc/systemd/system/saku-monthly.service
sudo systemctl daemon-reload && sudo systemctl enable --now saku-monthly.timer
```

`pnpm audit-report [--month <YYYY-MM>]` prints a month's report at any time (not `pnpm audit`,
which is pnpm's own security check).

## 5. Outside watch

Create a check on healthchecks.io (free): period 1 day, grace 6 hours, and put its URL in `.env`
as `HEALTHCHECK_URL`. Each fully successful daily run pings it, and while the latest daily run
succeeded the hourly check sends one keep-alive on each day with no session ping due, so weekends
and holidays are not outages (`docs/running.md`, "Heartbeat"); when pings stop (the machine is
down, a source keeps failing, a backup failed), healthchecks.io tells you. The machine cannot report
its own outage.

Optional: a second check for the weekly refetch (period 7 days, grace 1 day) as
`HEALTHCHECK_WEEKLY_URL`, and a third for the monthly audit report (period 31 days, grace 3 days)
as `HEALTHCHECK_MONTHLY_URL`.

Alerts (strategy changes, data health, failed runs for admins) go to Discord or Telegram:

```sh
# Discord: Server Settings > Integrations > Webhooks > New Webhook, copy its URL.
# Telegram: create a bot with @BotFather, put TELEGRAM_BOT_TOKEN in .env, send the bot a message,
# then read your chat id from https://api.telegram.org/bot<token>/getUpdates.
pnpm channel add discord --user <name> --admin   # asks for the target; --admin: also operational alerts
pnpm channel list --user <name>
pnpm channel test <channel id> --user <name>
```

Admin channels get failed runs, failed self-updates, disk space warnings and days whose data is
not green. Before forward records start (the A1 gate) only the operational ones arrive: a failed
run, a failed self-update and the disk warning, as soon as an admin channel exists. Their last line
then states the data-health grade alone (for example `Data health: red.`), with nothing about
signals, since none are live yet. Everything else (strategy changes, data health, revisions,
calculation and parity checks, recompute differences, stand-in corrections, the monthly audit
report) starts at the gate.
A failed run's alert lists what failed, one line each (the check's name and the first 200
characters of its reason, up to 5 lines, the rest counted), so before the gate a failed
calculation or testfol parity check arrives there, not as an alert of its own.
`pnpm channel test` works at any time.
After the gate, an alert that could not be delivered leaves the run incomplete; it is retried at
the next hourly check, so a broken channel also stops the healthchecks.io ping. Before the gate an
undelivered disk warning is only logged (the run still completes and pings) and is tried again at
the next daily run, so a channel problem never fails an A1 gate day. `pnpm channel disable` turns
one off.
Users' languages: `pnpm settings set primary_language ja` (the default for users who chose none).

## 6. Backups

Each daily run writes `~/.local/share/saku/backups/saku-<date>.db.gz` (checked with SQLite's
integrity check before it is kept) and keeps 30 days plus the first of each month for 12 months.
`pnpm backup` makes one now. Copy them off the machine with `ops/copy-backups.sh` from another
computer (a Windows scheduled task can run it; see `docs/backups.md`):

```bash
ops/copy-backups.sh <server>
```

`pnpm restore <file> [target.db]` unpacks a backup into a new database file only (never over an
existing one); then `pnpm db:migrate`. A restored database needs the same `AUTH_SECRET`.

## 7. Updates

The server updates itself: every 5 minutes it checks GitHub, and when there are new commits it
pulls both repos, installs the Node version in `.nvmrc` when it changed (nvm's default is left
alone), installs packages, migrates, and checks the new version (the plug-ins load, typecheck,
tests). Never while a job runs (it waits for the next check), and no job starts during it. When a
step fails, it goes back to the version before and does not try that version again until a newer
push. Every update is in the activity log; the log is `~/.local/state/saku/update.log`.

It installs a new commit only after GitHub CI passed on that exact commit (`ops/ci-status.sh` reads
its check runs; the repo is public, so no token), and updates to that commit even when a later one
arrived meanwhile (that one waits for its own CI). While CI runs, or when GitHub gives no usable
answer (no network, an error, its rate limit), nothing changes and the next check asks again; the
update log notes it once per commit and status. When the server has gone 24 hours without updating
because CI is not green (counted from the server's own version, so newer pushes do not restart it;
an update or a reported CI failure does), the admins are told once and it keeps waiting. An alert no admin channel took is
sent again at each check until one does. Only a passed run counts: a failed or unanswered check
never updates the server. When CI failed, the server stays where it is, does not ask about that
commit again until a newer push, and the admins get the failed-update alert with the step `ci` (in
the activity log too). The private plug-ins are not gated (CI does not check them out). By hand, the
script prints the commit's CI status as a warning and updates anyway. A fork without CI sets
`SAKU_UPDATE_REQUIRE_CI=0` in `.env`.

- CI failed, then a re-run passed on the same commit: the server does not notice by itself. Run
  `ops/update-server.sh` by hand, or delete `~/.local/state/saku/update-failed` and the next check
  updates.
- A commit CI never runs on (`[skip ci]` in its message, a push that changes only ignored paths, a
  disabled workflow) is never installed by the automatic update: it waits, and the 24-hour alert
  says so. Push a commit CI runs on, or update by hand.

```bash
sudo cp ops/systemd/saku-update.* /etc/systemd/system/
sudo sed -i "s/<user>/$USER/g" /etc/systemd/system/saku-update.service
sudo systemctl daemon-reload && sudo systemctl enable --now saku-update.timer
```

By hand, any time: `ssh -t <server> code/saku/ops/update-server.sh`.

Installs from before 2026-11-04 have the private checkout at `plugins/`. The update that brings the
move checks the same private commit out in `private/` (same submodule url, same module folder) and
leaves the old `plugins/` folder untracked (`git status`: `?? plugins/`); nothing reads it any
more. Git commands inside the leftover `plugins/` act on `private/`: never run git there.
Once `update.log` shows that update as up, move the old folder away (it is kept, not deleted; any
`diff` line means it holds something the private repo does not: look before moving):

```bash
cd ~/code/saku
test -z "$(git ls-files plugins)" && test -n "$(git ls-files private)" &&
  diff -rq --exclude=.git plugins private && mv -T -n plugins ~/.local/state/saku/old-plugins-folder
! test -e plugins && test -z "$(git status --porcelain)" && echo OK   # OK only
```

To turn the server off safely (waits for running jobs): see "Turning the server off" in `docs/running.md`.
