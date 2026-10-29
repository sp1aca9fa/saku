#!/usr/bin/env bash
# Updates the Saku server (docs/setup.md) to the latest pushed code: both repos, the Node version
# the repo names (.nvmrc), packages, database migrations, then checks the new version: the plug-ins
# load, typecheck and tests pass. When a step fails, it goes back to the version before
# (migrations already run stay: they only add).
#
#   ops/update-server.sh          now, by hand: `ssh -t <server> code/saku/ops/update-server.sh`
#   ops/update-server.sh --auto   what the saku-update timer runs every 5 minutes: nothing to do
#                                 unless GitHub has new commits; never while a job runs (it holds
#                                 the jobs lock, so no job starts during it either); a version that
#                                 failed is not tried again until a newer push. Logs to
#                                 ~/.local/state/saku/update.log; the result goes to the activity
#                                 log.
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

# The new version starts and passes its own checks.
check_version() {
  pnpm --silent plugins >/dev/null && pnpm typecheck && pnpm test
}

# The whole run is one function, read in full before it starts: `git pull` may rewrite this file.
main() {
  AUTO=0
  [ "${1:-}" = "--auto" ] && AUTO=1
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  # Same folder as the jobs (packages/db/src/env.ts), including SAKU_STATE_DIR from .env.
  local from_env
  from_env="$(sed -n 's/^SAKU_STATE_DIR=//p' .env 2>/dev/null | tail -n 1)"
  STATE_DIR="${SAKU_STATE_DIR:-${from_env:-${XDG_STATE_HOME:-$HOME/.local/state}/saku}}"
  mkdir -p "$STATE_DIR"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  local failed_file="$STATE_DIR/update-failed"
  if [ "$AUTO" = 1 ]; then
    exec >>"$STATE_DIR/update.log" 2>&1
    git fetch -q origin
    local upstream
    upstream="$(git rev-parse '@{u}')"
    [ "$(git rev-parse HEAD)" = "$upstream" ] && return 0
    [ "$(cat "$failed_file" 2>/dev/null)" = "$upstream" ] && return 0
    # A job reads the code as it runs: wait for it (the next check tries again).
    if ! take_lock; then
      echo "$(date -Iseconds) new commits, waiting: a job is running"
      return 0
    fi
    echo "=== $(date -Iseconds) update"
  else
    take_lock || return 1
  fi

  local before step=pull
  before="$(git rev-parse --short HEAD)"
  run() {
    step="$1"
    shift
    "$@"
  }
  if run pull git pull --ff-only &&
    run pull git submodule update --init &&
    run node ensure_node &&
    run install pnpm install --frozen-lockfile &&
    run migrate pnpm db:migrate &&
    run check check_version; then
    local after
    after="$(git rev-parse --short HEAD)"
    rm -f "$failed_file"
    echo "Saku is up: $before -> $after (plug-ins $(git -C plugins rev-parse --short HEAD 2>/dev/null || echo none))."
    if [ "$before" != "$after" ]; then
      pnpm --silent update:log --from "$before" --to "$after" || true
    fi
    return 0
  fi

  local target
  target="$(git rev-parse --short '@{u}')"
  echo "Update to $target failed at '$step': going back to $before."
  git rev-parse '@{u}' >"$failed_file"
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
    hc="$(sed -n 's/^HEALTHCHECK_URL=//p' .env 2>/dev/null | tail -n 1)"
    [ -n "$hc" ] && curl -fsS -m 10 --retry 2 "$hc/fail" >/dev/null || true
  fi
  return 1
}

main "$@"
exit
