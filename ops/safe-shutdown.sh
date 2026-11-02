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
      [ $# -ge 2 ] && [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || usage
      case "$2" in
        systemd | user | dbus | getty | ssh | sshd | network | snap | session | init | multi | sys | dev | cloud | polkit | apt | cron | ufw | tailscaled)
          echo "Refusing --also $2: that prefix belongs to the system." >&2
          exit 1
          ;;
      esac
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

# Every loaded unit named <prefix>-*, of one type (timer or service), one per line. A failed
# listing stops the run: an empty list would look like "nothing to do".
find_units() {
  local type="$1" pattern="" p raw
  for p in "${PREFIXES[@]}"; do pattern="$pattern${pattern:+|}$p"; done
  raw="$("$SYSTEMCTL" list-units --all --plain --no-legend --type="$type")" || return 1
  awk -v re="^($pattern)-.*\\\\.$type\$" '{ u = $1; sub(/^●/, "", u); if (u ~ re) print u }' <<<"$raw" |
    sort -u
}

# Running is any state but inactive, failed or unknown (activating, deactivating, reloading...).
is_running() {
  local state
  state="$("$SYSTEMCTL" is-active "$1" 2>/dev/null || true)"
  case "$state" in inactive | failed | unknown) return 1 ;; *) return 0 ;; esac
}

# Names from the lines on stdin, joined with spaces.
join_names() { paste -sd' ' -; }
list() { [ $# -gt 0 ] && printf '%s\n' "$@" | join_names || echo "none"; }

TIMERS=()
SERVICES=()
timer_out="$(find_units timer)" || {
  echo "cannot list units" >&2
  exit 1
}
service_out="$(find_units service)" || {
  echo "cannot list units" >&2
  exit 1
}
while IFS= read -r u; do [ -n "$u" ] && TIMERS+=("$u"); done <<<"$timer_out"
while IFS= read -r u; do [ -n "$u" ] && SERVICES+=("$u"); done <<<"$service_out"

# No unit for a prefix: probably a typo, and nothing would be waited for or stopped.
for p in "${PREFIXES[@]}"; do
  found=0
  for u in "${TIMERS[@]+"${TIMERS[@]}"}" "${SERVICES[@]+"${SERVICES[@]}"}"; do
    [[ "$u" == "$p"-* ]] && found=1
  done
  if [ "$found" = 0 ]; then
    echo "No $p-* unit found: nothing was changed." >&2
    exit 1
  fi
done

# The services the timers trigger (each timer's Unit=): the jobs to wait for.
JOBS=()
for t in "${TIMERS[@]+"${TIMERS[@]}"}"; do
  triggered="$("$SYSTEMCTL" show -p Unit --value "$t")" || {
    echo "cannot read the unit $t triggers" >&2
    exit 1
  }
  [ -n "$triggered" ] || {
    echo "cannot read the unit $t triggers" >&2
    exit 1
  }
  in_jobs=0
  for j in "${JOBS[@]+"${JOBS[@]}"}"; do [ "$j" = "$triggered" ] && in_jobs=1; done
  [ "$in_jobs" = 1 ] || JOBS+=("$triggered")
done

is_job() {
  local j
  for j in "${JOBS[@]+"${JOBS[@]}"}"; do [ "$j" = "$1" ] && return 0; done
  return 1
}

running=()
check_running() {
  running=()
  local s
  for s in "${JOBS[@]+"${JOBS[@]}"}"; do is_running "$s" && running+=("$s"); done
  return 0
}

if [ "$DRY" = 1 ]; then
  echo "Dry run: nothing is changed."
  echo "1. Would stop the timers (they return at the next boot): $(list "${TIMERS[@]+"${TIMERS[@]}"}")"
  check_running
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
start=$SECONDS
last=-15
check_running
while [ ${#running[@]} -gt 0 ] && [ $((SECONDS - start)) -lt $((WAIT_MIN * 60)) ]; do
  if [ $((SECONDS - last)) -ge 15 ]; then
    echo "Waiting ($((SECONDS - start)) s): $(list "${running[@]}")"
    last=$SECONDS
  fi
  # In the background so a TERM is handled at once.
  sleep "$POLL" &
  wait $!
  check_running
done

# Stopping a running job needs a yes for exactly the jobs running now.
ASKED=""
ask_stop() {
  local now="${running[*]}" answer=""
  [ ${#running[@]} -gt 0 ] || return 0
  [ "$now" != "$ASKED" ] || return 0
  echo "Still running: $now. Stop them now? Their work is redone after the restart. [y/N]"
  # No terminal means no.
  if [ -t 0 ]; then read -r answer || answer=""; fi
  case "$answer" in
    y | Y | yes | YES) ASKED="$now" ;;
    *)
      restore_timers
      echo "Nothing was shut down."
      exit 1
      ;;
  esac
}
ask_stop

# A job may have started since the check above.
check_running
ask_stop

for s in "${SERVICES[@]+"${SERVICES[@]}"}"; do
  # A job service is stopped only after a yes.
  if is_job "$s" && [ -z "$ASKED" ]; then continue; fi
  if is_running "$s"; then
    echo "Stopping $s"
    "$SYSTEMCTL" stop "$s"
  fi
done
sync

if [ "$POWEROFF" = 1 ]; then
  echo "Powering off."
  if "$SYSTEMCTL" poweroff; then
    STOPPED=()
  else
    echo "Power-off failed." >&2
    restore_timers
    exit 1
  fi
else
  echo "Not powering off (--no-poweroff). The timers stay stopped until the next boot, or run: sudo systemctl start ${STOPPED[*]}"
  STOPPED=()
fi
