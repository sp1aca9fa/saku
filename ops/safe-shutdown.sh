#!/usr/bin/env bash
# Turns the server off safely (docs/running.md, "Turning the server off"): lets running jobs and
# updates finish, stops the apps, then powers the machine off.
#
#   sudo ops/safe-shutdown.sh [--also <prefix>]... [--wait <minutes>] [--no-poweroff] [--dry-run]
#
#   --also <prefix>   also handle the systemd units named <prefix>-* (repeatable); `saku-*` always
#   --wait <minutes>  how long to wait for running jobs to finish (default 15)
#   --no-poweroff     do everything except the power-off; the timers stay stopped
#   --dry-run         print each step with the units found and change nothing (no root needed)
#
# Order: stop the matching timers (stop only, never disable: they return at the next boot), wait
# for the jobs they trigger, ask before stopping a job that is still running after the wait (its
# work is redone after the restart), stop the other matching services, sync, power off. Ctrl-C or
# any failure before the power-off starts the stopped timers again.
#
# Test-only environment (never set on the server): SAFE_SHUTDOWN_SYSTEMCTL (the systemctl to
# call, default `systemctl`), SAFE_SHUTDOWN_POLL_SECONDS (seconds between checks, default 15),
# SAFE_SHUTDOWN_ALLOW_NONROOT=1 (skips the root check).
set -euo pipefail

SYSTEMCTL="${SAFE_SHUTDOWN_SYSTEMCTL:-systemctl}"
POLL="${SAFE_SHUTDOWN_POLL_SECONDS:-15}"

usage() {
  echo "usage: ops/safe-shutdown.sh [--also <prefix>]... [--wait <minutes>] [--no-poweroff] [--dry-run]" >&2
  exit 2
}

PREFIXES=(saku)
WAIT_MIN=15
POWEROFF=1
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --also)
      [ $# -ge 2 ] && [[ "$2" =~ ^[A-Za-z0-9_.@-]+$ ]] || usage
      PREFIXES+=("$2")
      shift 2
      ;;
    --wait)
      [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]] || usage
      WAIT_MIN="$2"
      shift 2
      ;;
    --no-poweroff) POWEROFF=0 && shift ;;
    --dry-run) DRY=1 && shift ;;
    *) usage ;;
  esac
done

if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ] && [ "${SAFE_SHUTDOWN_ALLOW_NONROOT:-}" != 1 ]; then
  echo "Run as root: sudo ops/safe-shutdown.sh" >&2
  exit 1
fi

# Every loaded unit named <prefix>-*, of one type (timer or service), one per line.
find_units() {
  local type="$1" pattern="" p
  for p in "${PREFIXES[@]}"; do pattern="$pattern${pattern:+|}$p"; done
  "$SYSTEMCTL" list-units --all --plain --no-legend --type="$type" |
    awk -v re="^($pattern)-.*\\\\.$type\$" '{ u = $1; sub(/^●/, "", u); if (u ~ re) print u }' |
    sort -u
}

is_running() {
  local state
  state="$("$SYSTEMCTL" is-active "$1" 2>/dev/null || true)"
  [ "$state" = active ] || [ "$state" = activating ]
}

# Names from the lines on stdin, joined with spaces.
join_names() { paste -sd' ' -; }

TIMERS=()
SERVICES=()
while IFS= read -r u; do [ -n "$u" ] && TIMERS+=("$u"); done < <(find_units timer)
while IFS= read -r u; do [ -n "$u" ] && SERVICES+=("$u"); done < <(find_units service)

# The services the timers trigger (<name>.timer runs <name>.service): the jobs to wait for.
JOBS=()
for t in "${TIMERS[@]+"${TIMERS[@]}"}"; do
  for s in "${SERVICES[@]+"${SERVICES[@]}"}"; do
    [ "$s" = "${t%.timer}.service" ] && JOBS+=("$s")
  done
done

list() { [ $# -gt 0 ] && printf '%s\n' "$@" | join_names || echo "none"; }

if [ "$DRY" = 1 ]; then
  echo "Dry run: nothing is changed."
  echo "1. Would stop the timers (they return at the next boot): $(list "${TIMERS[@]+"${TIMERS[@]}"}")"
  running=()
  for s in "${JOBS[@]+"${JOBS[@]}"}"; do is_running "$s" && running+=("$s"); done
  echo "2. Would wait up to $WAIT_MIN min for the jobs: $(list "${JOBS[@]+"${JOBS[@]}"}") (running now: $(list "${running[@]+"${running[@]}"}"))"
  echo "3. Would ask before stopping any job still running after the wait."
  echo "4. Would stop the services: $(list "${SERVICES[@]+"${SERVICES[@]}"}")"
  echo "5. Would sync, then $([ "$POWEROFF" = 1 ] && echo "power off." || echo "not power off (--no-poweroff).")"
  exit 0
fi

STOPPED=()
restore_timers() {
  [ ${#STOPPED[@]} -gt 0 ] || return 0
  echo "Starting the stopped timers again: ${STOPPED[*]}"
  "$SYSTEMCTL" start "${STOPPED[@]}" || echo "Could not start them: run sudo systemctl start ${STOPPED[*]}" >&2
  STOPPED=()
}
trap 'echo; echo "Interrupted: nothing was shut down."; exit 130' INT TERM
trap 'restore_timers' EXIT

for t in "${TIMERS[@]+"${TIMERS[@]}"}"; do
  if is_running "$t"; then
    "$SYSTEMCTL" stop "$t"
    STOPPED+=("$t")
  fi
done
echo "Stopped the timers (they return at the next boot): $(list "${STOPPED[@]+"${STOPPED[@]}"}")"

# Wait while any job service runs.
running=()
check_running() {
  running=()
  local s
  for s in "${JOBS[@]+"${JOBS[@]}"}"; do is_running "$s" && running+=("$s"); done
  return 0
}
start=$SECONDS
last=-15
check_running
while [ ${#running[@]} -gt 0 ] && [ $((SECONDS - start)) -lt $((WAIT_MIN * 60)) ]; do
  if [ $((SECONDS - last)) -ge 15 ]; then
    echo "Waiting ($((SECONDS - start)) s): $(list "${running[@]}")"
    last=$SECONDS
  fi
  sleep "$POLL"
  check_running
done

if [ ${#running[@]} -gt 0 ]; then
  echo "Still running: ${running[*]}. Stop them now? Their work is redone after the restart. [y/N]"
  answer=""
  # No terminal means no.
  if [ -t 0 ]; then read -r answer || answer=""; fi
  case "$answer" in
    y | Y | yes | YES) ;;
    *)
      restore_timers
      echo "Nothing was shut down."
      exit 1
      ;;
  esac
fi

for s in "${SERVICES[@]+"${SERVICES[@]}"}"; do
  if is_running "$s"; then
    echo "Stopping $s"
    "$SYSTEMCTL" stop "$s"
  fi
done
sync

if [ "$POWEROFF" = 1 ]; then
  echo "Powering off."
  STOPPED=()
  "$SYSTEMCTL" poweroff
else
  echo "Not powering off (--no-poweroff). The timers stay stopped until the next boot, or run: sudo systemctl start ${STOPPED[*]}"
  STOPPED=()
fi
