#!/usr/bin/env bash
# Updates the Saku server (docs/setup.md) to the latest pushed code: both repos, the Node version
# the repo names (.nvmrc), packages, database migrations, then checks the new version: the plug-ins
# load, typecheck and tests pass. When a step fails, it goes back to the version before
# (migrations already run stay: they only add).
#
#   ops/update-server.sh          now, by hand: `ssh -t <server> code/saku/ops/update-server.sh`
#   ops/update-server.sh --auto   what the saku-update timer runs every 5 minutes: nothing to do
#                                 unless GitHub has new commits; then only once GitHub CI passed
#                                 on that exact commit (ops/ci-status.sh), and to that commit even
#                                 when a later one arrived meanwhile; never while a job runs (it
#                                 holds the jobs lock, so no job starts during it either); a
#                                 version that failed, here or in CI, is not tried again until a
#                                 newer push. Logs to ~/.local/state/saku/update.log; the result
#                                 goes to the activity log.
#
# By hand it prints the commit's CI status as a warning and updates anyway (the owner chose to).
# SAKU_UPDATE_REQUIRE_CI=0 (environment or .env) turns the CI gate off, for a fork without CI.
# The private plug-ins submodule is not gated (CI does not check it out); the main repo's commit is.
#
# The web app's build and restart join the steps when the app exists.
set -euo pipefail

# The services run Node through this link (their PATH), so a new Node needs no change to them.
NODE_LINK="$HOME/.local/share/saku/node"

# The Node version the repo names (.nvmrc): installed when missing (nvm) and the services' link
# pointed at it. nvm's default is left alone: other apps on the machine may use it.
ensure_node() {
  [ -f .nvmrc ] && command -v nvm >/dev/null || return 0
  local want dir
  want="$(tr -d ' \n' <.nvmrc)"
  if [ "$(nvm version "$want")" = "N/A" ]; then
    echo "installing Node $want"
    nvm install "$want" >/dev/null || return 1
  fi
  nvm use "$want" >/dev/null || return 1
  corepack enable || return 1
  dir="$(dirname "$(dirname "$(nvm which "$want")")")"
  if [ "$(readlink "$NODE_LINK" 2>/dev/null)" != "$dir" ]; then
    mkdir -p "$(dirname "$NODE_LINK")"
    ln -sfn "$dir" "$NODE_LINK"
    echo "Node $want now runs the services"
  fi
}

# The jobs' lock (packages/plugin-sdk/src/jobs/lock.ts): a file holding the holder's process ID;
# one left by a process that is gone is taken over.
take_lock() {
  local dir="$STATE_DIR/locks" holder
  mkdir -p "$dir"
  LOCK_FILE="$dir/jobs.lock"
  for _ in 1 2; do
    if (set -C && printf '%s' "$$" >"$LOCK_FILE") 2>/dev/null; then
      trap release_lock EXIT
      return 0
    fi
    holder="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [ -n "$holder" ] && [ "$holder" != "$$" ] && kill -0 "$holder" 2>/dev/null; then
      echo "a job is running (process $holder)"
      return 1
    fi
    rm -f "$LOCK_FILE"
  done
  return 1
}

release_lock() {
  [ "$(cat "$LOCK_FILE" 2>/dev/null)" = "$$" ] && rm -f "$LOCK_FILE"
  return 0
}

# A .env value as the jobs read it (process.loadEnvFile in packages/db/src/env.ts): the last line
# naming it (`export ` allowed); a quoted value up to its closing quote, else up to a `#` comment;
# CR and surrounding spaces dropped. No .env, or no such line: empty (sed's error must not end the
# script under pipefail).
env_value() {
  local v
  v="$({ sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=//p" .env 2>/dev/null || true; } |
    tail -n 1 | tr -d '\r')"
  while [[ "$v" == [[:space:]]* ]]; do v="${v#[[:space:]]}"; done
  case "$v" in
    \"*) v="${v#\"}" && v="${v%%\"*}" ;;
    \'*) v="${v#\'}" && v="${v%%\'*}" ;;
    *)
      v="${v%%#*}"
      while [[ "$v" == *[[:space:]] ]]; do v="${v%[[:space:]]}"; done
      ;;
  esac
  printf '%s\n' "$v"
}

# How long the server may go without updating while CI is not green (pending or unknown) before
# the admins are told, once per wait (the clock in update-ci); it keeps waiting after that.
CI_WAIT_ALERT_SECONDS=86400

# The CI gate is on unless SAKU_UPDATE_REQUIRE_CI is 0 (the environment wins over .env).
ci_required() {
  [ "${SAKU_UPDATE_REQUIRE_CI-$(env_value SAKU_UPDATE_REQUIRE_CI)}" != 0 ]
}

# GitHub CI's verdict on a commit: success, failure, pending or unknown (never empty).
ci_status() {
  local word
  word="$(bash ops/ci-status.sh "$1" 2>/dev/null)" || true
  case "$word" in
    success | failure | pending) echo "$word" ;;
    *) echo unknown ;;
  esac
}

# The CI gate's state (--auto), one line in update-ci:
#   <here> <target> <status> <since> <told> <logged>
# here: the server's commit; target: the new commit last asked about and its status; since (epoch
# seconds): when the server, on `here`, first had a commit waiting. The 24 h clock runs from
# there: a newer push does not restart it, an update (which moves HEAD) does. told: the admins'
# alert for this state (the 24 h wait, or a CI failure): 0 not tried, 2 tried and not sent (tried
# again each check), 1 sent. logged: the CI failure's activity-log entry written (1) or not (0).
# Reads and sets ci_here ci_target ci_status ci_since ci_told ci_logged; uses main's target, short,
# failed_file and ci_file.
ci_read() {
  ci_here="" ci_target="" ci_status="" ci_since="" ci_told=0 ci_logged=0
  if [ -f "$ci_file" ]; then
    read -r ci_here ci_target ci_status ci_since ci_told ci_logged <"$ci_file" || true
  fi
  [[ "$ci_told" =~ ^[012]$ ]] || ci_told=0
  [[ "$ci_logged" =~ ^[01]$ ]] || ci_logged=0
}

ci_write() {
  echo "$ci_here $ci_target $ci_status $ci_since $ci_told $ci_logged" >"$ci_file"
}

# Tells the admins (the command given) for the state's `told`: logs the first try and the first
# failure only, so a 5-minute timer does not fill the log.
ci_tell() {
  local what="$1"
  shift
  [ "$ci_told" = 0 ] && echo "$(date -Iseconds) telling the admins: $what"
  if "$@"; then
    [ "$ci_told" = 2 ] && echo "$(date -Iseconds) the admins are told: $what"
    ci_told=1
  else
    [ "$ci_told" = 0 ] && echo "$(date -Iseconds) could not tell the admins ($what); trying again at each check"
    ci_told=2
  fi
}

# A CI failure's alert and activity entry not done yet (the alert's channels failed): tried again
# at each check while the failed commit is the newest; then nothing more.
ci_failure_retry() {
  local here
  here="$(git rev-parse --short HEAD)"
  ci_read
  [ "$ci_here" = "$here" ] && [ "$ci_target" = "$target" ] && [ "$ci_status" = failure ] || return 0
  if [ "$ci_logged" != 1 ] && pnpm --silent update:log --from "$here" --to "$short" --failed ci; then
    ci_logged=1
  fi
  if [ "$ci_told" != 1 ]; then
    ci_tell "CI failed on $short" pnpm --silent alert update-failed --from "$here" --to "$short" --step ci
  fi
  ci_write
}

# A new commit whose CI has not passed (failure, pending or unknown), in --auto. Nothing changes in
# the code, so it needs no jobs lock.
ci_waits() {
  local status="$1" here now last
  here="$(git rev-parse --short HEAD)"
  now="$(date +%s)"
  ci_read
  if [ "$ci_here" != "$here" ] || ! [[ "$ci_since" =~ ^[0-9]+$ ]]; then
    ci_here="$here" ci_target="" ci_status="" ci_since="$now" ci_told=0
  fi
  # The last status logged for this commit (none for a newer one).
  last=""
  [ "$ci_target" = "$target" ] && last="$ci_status"
  # A CI failure was already reported: the wait for the next commit is a new one, with its own
  # 24 h clock and its own alert.
  if [ "$ci_status" = failure ] && [ "$status" != failure ]; then ci_since="$now" ci_told=0; fi
  ci_target="$target" ci_status="$status"
  if [ "$status" = failure ]; then
    # Like a failed update: not tried again until a newer push (a later tick sees update-failed
    # and does not ask GitHub again; it only retries the alert while it was not sent).
    echo "=== $(date -Iseconds) CI failed on $short: not updating; staying on $here until a newer push."
    echo "$target" >"$failed_file"
    ci_told=0 ci_logged=0
    if pnpm --silent update:log --from "$here" --to "$short" --failed ci; then ci_logged=1; fi
    ci_tell "CI failed on $short" pnpm --silent alert update-failed --from "$here" --to "$short" --step ci
    ci_write
    return 0
  fi
  ci_logged=1
  [ "$last" = "$status" ] || echo "$(date -Iseconds) new commit $short, waiting: CI is $status"
  if [ "$ci_told" != 1 ] && [ $((now - ci_since)) -ge "$CI_WAIT_ALERT_SECONDS" ]; then
    ci_tell "no update for 24 h; $short waits for CI ($status)" \
      pnpm --silent alert update-waiting --from "$here" --to "$short" --status "$status"
  fi
  ci_write
}

# The new version starts and passes its own checks.
check_version() {
  pnpm --silent plugins >/dev/null && pnpm typecheck && pnpm test
}

# The whole run is one function, read in full before it starts: the update may rewrite this file.
main() {
  AUTO=0
  [ "${1:-}" = "--auto" ] && AUTO=1
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  # Same folder as the jobs (packages/db/src/env.ts), including SAKU_STATE_DIR from .env.
  local from_env
  from_env="$(env_value SAKU_STATE_DIR)"
  STATE_DIR="${SAKU_STATE_DIR:-${from_env:-${XDG_STATE_HOME:-$HOME/.local/state}/saku}}"
  mkdir -p "$STATE_DIR"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  local failed_file="$STATE_DIR/update-failed"
  # The CI gate's state (ci_read): a 5-minute timer logs a waiting commit once per status change
  # and tells the admins once when the server went 24 h without updating.
  local ci_file="$STATE_DIR/update-ci"
  # The commit this run updates to: the upstream as fetched now, never a later one fetched after
  # its CI status was read.
  local target short status
  if [ "$AUTO" = 1 ]; then
    exec >>"$STATE_DIR/update.log" 2>&1
    git fetch -q origin
    target="$(git rev-parse '@{u}')"
    if [ "$(git rev-parse HEAD)" = "$target" ]; then
      # Nothing waits: no 24 h clock running.
      rm -f "$ci_file"
      return 0
    fi
    short="$(git rev-parse --short "$target")"
    if [ "$(cat "$failed_file" 2>/dev/null)" = "$target" ]; then
      ci_failure_retry
      return 0
    fi
    if ci_required; then
      # Only a green CI run updates: pending, unknown (no answer, an error, a rate limit) and
      # failure leave the server as it is. The API is called only while a commit waits here.
      status="$(ci_status "$target")"
      if [ "$status" != success ]; then
        ci_waits "$status"
        return 0
      fi
    fi
    # A job reads the code as it runs: wait for it (the next check tries again).
    if ! take_lock; then
      echo "$(date -Iseconds) new commits, waiting: a job is running"
      return 0
    fi
    rm -f "$ci_file"
    echo "=== $(date -Iseconds) update"
  else
    take_lock || return 1
    if ! git fetch -q origin; then
      echo "Could not fetch from GitHub: nothing changed."
      return 1
    fi
    target="$(git rev-parse '@{u}')"
    short="$(git rev-parse --short "$target")"
    if [ "$(git rev-parse HEAD)" != "$target" ] && ci_required; then
      status="$(ci_status "$target")"
      if [ "$status" = success ]; then
        echo "CI passed on $short."
      else
        echo "Warning: CI on $short is $status (not passed); updating anyway, by hand."
      fi
    fi
  fi

  local before step=pull
  before="$(git rev-parse --short HEAD)"
  run() {
    step="$1"
    shift
    "$@"
  }
  if run pull git merge -q --ff-only "$target" &&
    run pull git submodule update --init &&
    run node ensure_node &&
    run install pnpm install --frozen-lockfile &&
    run migrate pnpm db:migrate &&
    run check check_version; then
    local after
    after="$(git rev-parse --short HEAD)"
    rm -f "$failed_file" "$ci_file"
    echo "Saku is up: $before -> $after (plug-ins $(git -C plugins rev-parse --short HEAD 2>/dev/null || echo none))."
    if [ "$before" != "$after" ]; then
      pnpm --silent update:log --from "$before" --to "$after" || true
    fi
    return 0
  fi

  echo "$target" >"$failed_file"
  target="$short"
  echo "Update to $target failed at '$step': going back to $before."
  git reset -q --hard "$before"
  git submodule update --init
  local stuck=""
  if ensure_node && pnpm install --frozen-lockfile; then
    echo "Back on $before."
  else
    echo "Going back failed too: the jobs may not run. Run ops/update-server.sh by hand."
    stuck="--stuck"
  fi
  pnpm --silent update:log --from "$before" --to "$target" --failed "$step" || true
  # shellcheck disable=SC2086
  pnpm --silent alert update-failed --from "$before" --to "$target" --step "$step" $stuck || true
  # Stuck, the alert above probably could not run either: report a failure to healthchecks.io.
  if [ -n "$stuck" ]; then
    local hc
    # As dotenv reads it: a quoted value up to its closing quote; else up to a " #" comment.
    hc="$(env_value HEALTHCHECK_URL)"
    [ -n "$hc" ] && curl -fsS -m 10 --retry 2 "$hc/fail" >/dev/null || true
  fi
  return 1
}

main "$@"
exit
