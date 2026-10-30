# Troubleshooting

First look: `pnpm health` (the data-health report, exit code 1 when anything is not green) and
`journalctl -u saku-daily -n 100`. Job logs are in `~/.local/state/saku/logs/`. See
`docs/running.md`.

## "Database is missing migration(s)"

A command stopped with `Run pnpm db:migrate first`. The code is newer than the database. Run
`pnpm db:migrate`. After a restore from a backup, run it too.

## A provider answers 403 (or 429, or a challenge page)

The error text carries the provider's reason (a short excerpt, with keys masked). Saku stops that
source for the run and never works around a block. The run is incomplete: no stamp, no healthcheck
ping, retried at the next hourly check. Common reasons: a wrong or expired key (check the variable
in `.env`), a plan that does not include the data requested, a request from a place the provider
blocks, or too many requests. Fix the cause; do not shorten the pause between requests.

## "N of M requests per day used (80% cap)" (a quota stop)

The client keeps under 80% of each limit the plug-in declares and stops when waiting would be too
long (a per-day cap, or symbols per month). The run is incomplete and retried. A daily limit
clears the next day. If it repeats, there are too many symbols for the plan: remove symbols or
use another source. Check that the plug-in's `limits` match your plan.

## A source is skipped

A missing key variable skips the source and marks the run incomplete. Fill the variable in
`.env`. A plug-in with no role is loaded but not used: `pnpm sources list`, then
`pnpm sources set <kind> <key> <role>`.

## The cash rate is stale

`pnpm health` shows a reason like `DTB3:stale(3)@fred`. One business day behind is normal (the
provider publishes the next day). 2 to 5 business days behind is yellow, more or none is red for
the day overall, and the admins are alerted. An unknown rate is never taken as 0%: the equity of
the forward record is left unknown on days that need it. A stale rate does not change a
strategy's signal. Usually the source failed for several days: see the failed run below. The
same rules apply to index series and the base-currency exchange rate.

## A red day

- Yellow: the signal is computed with a visible warning (for example a check at the edge of its
  tolerance, or an issuer site that was down).
- Red: Saku does not present a normal signal for strategies that depend on the affected data.
  Each strategy declares a safe state (for leveraged strategies by default 1x of the underlying;
  you can choose cash). The alert says what to do exactly, and the forward record stores that the
  safe state was signaled. Follow it that day. Do not override the check. When the data is
  corrected and the checks pass, the next day is normal. The cause is in `pnpm health --date
  <YYYY-MM-DD>` (the reasons are in words) and in the revision log if a value changed.

## A failed run and catch-up

The run did not complete (a source down, an alert not delivered, a backup failed). No stamp is
written and no heartbeat sent, so the next hourly check runs again. Several missed days are
covered by the next daily run's 10-session window; `pnpm weekly` refetches the full history.
Look at `journalctl -u saku-daily` and the run's error in `pnpm health` (the header names the
latest run). To run now: `pnpm daily --force`. When a delivery channel is broken the run stays
incomplete: `pnpm channel test <id> --user <name>`, or `pnpm channel disable`.

"Another job is running" is not an error: the lock is held by another job (or by an update).
A lock left by a dead process is taken over on the next start.

## No healthchecks.io ping

Pings only follow a fully successful run: the daily one (`HEALTHCHECK_URL`) and the weekly one
(`HEALTHCHECK_WEEKLY_URL`). Check the last run in `pnpm health`, the timer
(`systemctl list-timers 'saku-*'`), and that the variable is set.

## An update rolled back

The update script goes back to the previous version when a step fails and does not retry that
version until a newer push; the admins are alerted. The reason is in
`~/.local/state/saku/update.log`.

## Jobs refuse to run

Jobs and plug-ins run only on the server and stop when `CI` or `VERCEL` is set in the
environment. Unset it.
