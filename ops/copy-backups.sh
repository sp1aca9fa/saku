#!/usr/bin/env bash
# Copies the daily database backups of a Saku server (the machine running the app and the daily
# run) to this machine, so a dead server disk does not take them along, and refreshes this
# machine's analysis copy (the newest backup, unpacked) for read-only tools. Mirrors the server's
# backup folder: what the server prunes is pruned here too, unless the server suddenly holds fewer
# than 3 backups (a new or wiped disk): then nothing is deleted.
#
#   ops/copy-backups.sh <ssh host> [folder]            copy now
#   ops/copy-backups.sh install <ssh host> [folder]    Windows (from WSL): a task `saku-backup-copy`
#                                                 copying 10 minutes after logon and every 6 hours
#                                                 while the PC is on, in a hidden console
#                                                 (conhost --headless), so no window opens
#
# Folder for the copies: the argument, else SAKU_COPY_DIR, else ~/backups/saku (never this
# machine's own data folder, so local development backups do not mix with the server's).
# Remote folder: SAKU_REMOTE_BACKUP_DIR, else .local/share/saku/backups (relative to the ssh home).
# Analysis copy: SAKU_ANALYSIS_DB, else <data folder>/analysis/saku.db (SAKU_DATA_DIR replaces the
# saku folder, as in the app). Log: <state folder>/copy-backups.log (SAKU_STATE_DIR likewise).
#
# The ssh host must log in without a password (a key).
set -euo pipefail

if [ -n "${CI:-}" ] || [ -n "${VERCEL:-}" ]; then
  echo "copy-backups.sh refuses to run when CI or VERCEL is set (jobs run only on the server or the owner's PC)" >&2
  exit 1
fi

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/copy-backups.sh"
DATA="${SAKU_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/saku}"
ANALYSIS="${SAKU_ANALYSIS_DB:-$DATA/analysis/saku.db}"
REMOTE_DIR="${SAKU_REMOTE_BACKUP_DIR:-.local/share/saku/backups}"
STATE_DIR="${SAKU_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/saku}"
LOG="$STATE_DIR/copy-backups.log"

if [ "${1:-}" = "install" ]; then
  HOST="${2:?usage: copy-backups.sh install <ssh host> [folder]}"
  FOLDER="${3:+ $(realpath -m "$3")}"
  DISTRO="${WSL_DISTRO_NAME:?run this from inside WSL}"
  # These are baked into a command line inside quotes: refuse anything that could break out.
  for v in "$SELF" "$HOST" "${FOLDER# }" "$DISTRO"; do
    case "$v" in
      *[[:space:]]* | *\'* | *\"*)
        echo "install refuses whitespace, ' or \" in the script path, host, folder or distro name: $v" >&2
        exit 1
        ;;
    esac
  done
  powershell.exe -NoProfile -Command "
\$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless wsl.exe -d $DISTRO -- bash -lc \"$SELF $HOST$FOLDER\"'
\$logon = New-ScheduledTaskTrigger -AtLogOn -User \$env:USERNAME
\$logon.Delay = 'PT10M'
\$every = New-ScheduledTaskTrigger -Once -At 00:30 -RepetitionInterval (New-TimeSpan -Hours 6)
\$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
\$principal = New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'saku-backup-copy' -Description 'Saku: copies the server backups to this PC (WSL)' -Action \$action -Trigger \$logon,\$every -Settings \$settings -Principal \$principal -Force | Out-Null
Get-ScheduledTask -TaskName 'saku-backup-copy' | Select-Object TaskName,State | Format-Table -HideTableHeaders
"
  exit 0
fi

HOST="${1:?usage: copy-backups.sh <ssh host> [folder]}"
case "$REMOTE_DIR" in
  '' | *[!A-Za-z0-9._/~-]*)
    echo "SAKU_REMOTE_BACKUP_DIR may only contain letters, digits and . _ / ~ -" >&2
    exit 1
    ;;
esac
LOCAL_DIR="${2:-${SAKU_COPY_DIR:-$HOME/backups/saku}}"
mkdir -p "$LOCAL_DIR" "$STATE_DIR"
exec >>"$LOG" 2>&1
echo "=== $(date -Iseconds) from $HOST"

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"
# A failed count (ssh error, not a number) aborts: nothing is copied or deleted on a guess.
held="$(ssh $SSH_OPTS "$HOST" "find $REMOTE_DIR -maxdepth 1 -name 'saku-*.db.gz' -size +0c 2>/dev/null | wc -l")" || {
  echo "could not count the server's backups (ssh failed): nothing copied or deleted"
  exit 1
}
held="${held//[[:space:]]/}"
case "$held" in
  '' | *[!0-9]*)
    echo "the server's backup count is not a number ('$held'): nothing copied or deleted"
    exit 1
    ;;
esac
delete=()
if [ "$held" -ge 3 ]; then
  delete=(--delete)
else
  echo "the server holds $held non-empty backup(s): copying without deleting anything here"
fi
rsync -a ${delete[@]+"${delete[@]}"} --include='saku-*.db.gz' --exclude='*' -e "ssh $SSH_OPTS" \
  "$HOST:$REMOTE_DIR/" "$LOCAL_DIR/"
newest="$(ls "$LOCAL_DIR"/saku-*.db.gz 2>/dev/null | sort | tail -1 || true)"
echo "$(ls "$LOCAL_DIR"/saku-*.db.gz 2>/dev/null | wc -l) backup(s) here, newest $(basename "${newest:-none}")"

# The analysis copy follows the newest backup.
if [ -n "$newest" ] && [ "$newest" -nt "$ANALYSIS" ]; then
  mkdir -p "$(dirname "$ANALYSIS")"
  part="$ANALYSIS.part"
  if ! gunzip -c "$newest" >"$part"; then
    rm -f "$part"
    echo "could not unpack $(basename "$newest"): analysis copy left as it was"
    exit 1
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    if [ "$(sqlite3 "$part" 'PRAGMA integrity_check' 2>&1)" != "ok" ]; then
      rm -f "$part"
      echo "integrity check failed for $(basename "$newest"): analysis copy left as it was"
      exit 1
    fi
  else
    echo "sqlite3 not found: integrity check skipped"
  fi
  # A leftover write-ahead log of the old copy must not be applied to the new file.
  rm -f "$ANALYSIS-wal" "$ANALYSIS-shm"
  mv "$part" "$ANALYSIS"
  # Carry the backup's (server) mtime: a rewritten backup refreshes, clock skew does not matter.
  touch -r "$newest" "$ANALYSIS"
  echo "analysis copy refreshed"
fi
