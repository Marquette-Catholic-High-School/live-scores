#!/usr/bin/env bash
#
# MCHS Live Scores - online backup of the SQLite database (sqlite3 ".backup").
#
# Safe while the server is running: the backup API copies a consistent snapshot
# (including data still in the WAL file). Installed as /usr/local/sbin/mchs-live-backup
# and run daily by mchs-live-backup.timer as the service user. By hand:
#
#     sudo mchs-live-backup                     # into /var/backups/mchs-live
#     sudo mchs-live-backup --label before-season
#     sudo mchs-live-backup --dest /root --keep-days 0

set -Eeuo pipefail
shopt -s inherit_errexit

readonly ENV_FILE=/etc/mchs-live/mchs-live.env
readonly DEFAULT_DATA_DIR=/var/lib/mchs-live
readonly SERVICE_USER=mchslive

DEST=/var/backups/mchs-live
KEEP_DAYS=14
LABEL=''
DATA_DIR=''
QUIET=0
SNAPSHOT=''

usage() {
  cat <<'EOF'
Usage: mchs-live-backup [options]

Writes a consistent copy of live.db to live-YYYYmmdd-HHMMSS[-LABEL].db and deletes
unlabelled backups older than --keep-days. Run as root (sudo) or as the service user.

  --dest DIR         Backup directory (default /var/backups/mchs-live)
  --keep-days N      Delete unlabelled backups (live-YYYYmmdd-HHMMSS.db) in DIR older than
                     N days; 0 = keep all (default 14). Labelled backups are never deleted.
  --label TEXT       Suffix for the file name (letters, digits, - and _)
  --data-dir DIR     Directory containing live.db (default: DATA_DIR from
                     /etc/mchs-live/mchs-live.env, else /var/lib/mchs-live)
  -q, --quiet        Only print errors
  -h, --help         Show this help
EOF
}

log() { ((QUIET)) || printf '%s\n' "$*"; }
die() {
  printf 'mchs-live-backup: %s\n' "$*" >&2
  exit 1
}
# shellcheck disable=SC2329  # invoked by the ERR trap
on_error() {
  ((BASH_SUBSHELL == 0)) || exit "$1"
  printf 'mchs-live-backup: "%s" failed (exit status %s, line %s)\n' "$3" "$1" "$2" >&2
  exit "$1"
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  [[ -n $SNAPSHOT ]] || return 0
  rm -f -- "$SNAPSHOT" "$SNAPSHOT-journal" "$SNAPSHOT-wal" "$SNAPSHOT-shm"
}
trap cleanup EXIT

need_arg() { (($# >= 2)) || die "option $1 needs a value"; }

parse_args() {
  while (($# > 0)); do
    case $1 in
      --*=*) set -- "${1%%=*}" "${1#*=}" "${@:2}"; continue ;;
      --dest) need_arg "$@"; DEST=$2; shift 2 ;;
      --keep-days) need_arg "$@"; KEEP_DAYS=$2; shift 2 ;;
      --label) need_arg "$@"; LABEL=$2; shift 2 ;;
      --data-dir) need_arg "$@"; DATA_DIR=$2; shift 2 ;;
      -q | --quiet) QUIET=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
}

# Value of KEY in the env file (last uncommented assignment, quotes removed).
env_value() {
  local line value=''
  [[ -r $ENV_FILE ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    if [[ $line == "$1="* ]]; then value=${line#*=}; fi
  done <"$ENV_FILE"
  value=${value%"${value##*[![:space:]]}"}
  if [[ ${#value} -ge 2 && ($value == \"*\" || $value == \'*\') ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}

main() {
  parse_args "$@"
  [[ $KEEP_DAYS =~ ^[0-9]+$ ]] || die "--keep-days must be a whole number"
  [[ $LABEL =~ ^[A-Za-z0-9_-]{0,40}$ ]] || die "--label may only contain letters, digits, - and _ (max. 40)"
  command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is not installed (sudo apt-get install sqlite3)"

  [[ -n $DATA_DIR ]] || DATA_DIR=$(env_value DATA_DIR)
  [[ -n $DATA_DIR ]] || DATA_DIR=$DEFAULT_DATA_DIR
  DATA_DIR=${DATA_DIR%/}
  DEST=${DEST%/}
  [[ $DATA_DIR == /* && $DEST == /* ]] || die "--data-dir and --dest must be absolute paths"
  # The paths end up inside a quoted sqlite3 dot-command.
  [[ $DATA_DIR != *"'"* && $DEST != *"'"* ]] || die "paths must not contain single quotes"

  local db=$DATA_DIR/live.db
  [[ -f $db ]] || die "database not found: $db"

  # sqlite3 runs as the database owner, so WAL/SHM files it may create can never
  # end up owned by root and lock the server out.
  local owner me
  local -a as_owner=()
  owner=$(stat -c %U -- "$db")
  me=$(id -un)
  if [[ $me != "$owner" ]]; then
    ((EUID == 0)) || die "run as root (sudo) or as $owner"
    as_owner=(runuser -u "$owner" -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8)
  fi

  if [[ ! -d $DEST ]]; then
    ((EUID == 0)) || die "backup directory does not exist: $DEST"
    install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DEST" 2>/dev/null || install -d -m 0750 "$DEST"
  fi
  [[ -w $DEST ]] || die "backup directory is not writable: $DEST"

  local stamp name target check
  stamp=$(date +%Y%m%d-%H%M%S)
  name="live-$stamp${LABEL:+-$LABEL}.db"
  target=$DEST/$name

  # Snapshot next to the database (writable by its owner), then move it into place.
  SNAPSHOT=$DATA_DIR/.backup-$stamp-$$.db
  "${as_owner[@]}" sqlite3 -batch -bail -cmd '.timeout 30000' "$db" ".backup '$SNAPSHOT'"
  check=$("${as_owner[@]}" sqlite3 -batch "$SNAPSHOT" 'PRAGMA quick_check;')
  [[ $check == ok ]] || die "integrity check of the new backup failed: $check"

  mv -f -- "$SNAPSHOT" "$DEST/.$name.partial"
  SNAPSHOT=$DEST/.$name.partial
  chmod 0640 -- "$SNAPSHOT"
  if ((EUID == 0)); then
    chown --reference="$DEST" -- "$SNAPSHOT"
  fi
  mv -f -- "$SNAPSHOT" "$target"
  SNAPSHOT=''
  log "Backup written: $target ($(du -h -- "$target" | cut -f1))"

  # Only unlabelled backups (the daily ones) expire; labelled ones (before-season,
  # pre-upgrade, pre-restore, ...) are kept until someone deletes them.
  if ((KEEP_DAYS > 0)); then
    local old
    while IFS= read -r -d '' old; do
      rm -f -- "$old"
      log "Deleted old backup: $old"
    done < <(find "$DEST" -maxdepth 1 -type f -name 'live-????????-??????.db' ! -name "$name" -mtime "+$((KEEP_DAYS - 1))" -print0)
  fi
  find "$DEST" -maxdepth 1 -type f -name '.live-*.partial' -mmin +60 -delete 2>/dev/null || true
}

main "$@"
exit 0
