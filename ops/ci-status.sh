#!/usr/bin/env bash
# GitHub CI's verdict on one commit of this repo, as one word (docs/setup.md "Updates"):
#
#   ops/ci-status.sh <full 40-character commit sha>
#
#   success   at least one check run, all completed, each concluded success, neutral or skipped
#   failure   a completed check run concluded anything else (failure, cancelled, timed out, ...)
#   pending   a check run is not completed yet, or there are none yet (GitHub may not have
#             started them)
#   unknown   no answer to trust: the remote is not github.com, the sha is not a full sha, curl
#             failed, GitHub answered an error (a rate limit too) or something unreadable
#
# The update script (ops/update-server.sh --auto) installs a commit only on `success`; anything
# else never counts as green. Check runs (GitHub Actions) are the signal; the older commit status
# API is not read. No token: the repo is public (60 calls an hour per address unauthenticated).
# It never prints GitHub's answer, only the word; it always exits 0.
set -uo pipefail

say() {
  echo "$1"
  exit 0
}

sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || say unknown

cd "$(dirname "${BASH_SOURCE[0]}")/.." || say unknown
url="$(git remote get-url origin 2>/dev/null)" || say unknown
# git@github.com:o/r(.git), ssh://git@github.com[:22]/o/r(.git), https://[user@]github.com/o/r(.git)
re='^(git@github\.com:|ssh://git@github\.com(:22)?/|https://([^/@]+@)?github\.com/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?$'
[[ "$url" =~ $re ]] || say unknown
owner="${BASH_REMATCH[4]}"
repo="${BASH_REMATCH[5]%.git}"
# Not "." or ".." (curl would resolve them out of the path).
[[ "$owner" =~ ^\.*$ || "$repo" =~ ^\.*$ ]] && say unknown

body="$(mktemp)" || say unknown
trap 'rm -f "$body"' EXIT
# A renamed repo answers with a redirect: followed (https only, at most 3); the code checked is
# the final answer's.
code="$(curl -s -m 20 -L --max-redirs 3 --proto-redir =https -o "$body" -w '%{http_code}' \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "https://api.github.com/repos/$owner/$repo/commits/$sha/check-runs?per_page=100" 2>/dev/null)" ||
  say unknown
[ "$code" = 200 ] || say unknown

# Reads the answer with node (the server has no jq). Order matters: one failed run is a failure
# even while others still run; runs beyond the 100 on this page leave the verdict unknown unless
# a visible one failed.
word="$(
  node -e '
    const fs = require("node:fs");
    let out = "unknown";
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const runs = j && j.check_runs;
      const total = j && j.total_count;
      if (Array.isArray(runs) && Number.isInteger(total) && total >= runs.length) {
        const ok = new Set(["success", "neutral", "skipped"]);
        const valid = runs.every((r) => r && typeof r === "object" && typeof r.status === "string");
        if (!valid) out = "unknown";
        else if (runs.some((r) => r.status === "completed" && !ok.has(r.conclusion))) out = "failure";
        else if (runs.some((r) => r.status !== "completed")) out = "pending";
        else if (total > runs.length) out = "unknown";
        else if (runs.length === 0) out = "pending";
        else out = "success";
      }
    } catch {
      out = "unknown";
    }
    console.log(out);
  ' "$body" 2>/dev/null
)"
case "$word" in
  success | failure | pending) say "$word" ;;
  *) say unknown ;;
esac
