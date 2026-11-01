#!/usr/bin/env bash
#
# MCHS Live Scores - restore the database from a backup.
#
#     sudo mchs-live-restore              # choose from a list of backups
#     sudo mchs-live-restore --latest     # newest backup
#     sudo mchs-live-restore /var/backups/mchs-live/live-20261030-041512.db
#
# The chosen file is checked first (SQLite integrity check, expected tables). Then
# the server is stopped, the current database is saved as a "pre-restore" backup,
# the backup is put in place and the server is started again. If the server does
# not come back healthy, the previous database is put back automatically.

set -Eeuo pipefail
shopt -s inherit_errexit

readonly SERVICE=mchs-live.service
readonly SERVICE_USER=mchslive
readonly ENV_FILE=/etc/mchs-live/mchs-live.env
readonly DEFAULT_DATA_DIR=/var/lib/mchs-live
readonly BACKUP_DIR=/var/backups/mchs-live

FILE=''
LATEST=0
LIST_ONLY=0
ASSUME_YES=0
WORK_DIR=''
ASIDE_DIR=''

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  C_BOLD=$'\e[1m' C_OK=$'\e[32m' C_WARN=$'\e[1;33m' C_ERR=$'\e[1;31m' C_RESET=$'\e[0m'
else
  C_BOLD='' C_OK='' C_WARN='' C_ERR='' C_RESET=''
fi

usage() {
  cat <<'EOF'
Usage: sudo mchs-live-restore [options] [BACKUP_FILE]

Restores the MCHS Live Scores database from a backup made by mchs-live-backup
(files live-*.db, optionally gzip-compressed as live-*.db.gz).

  BACKUP_FILE   Backup to restore (default: choose from /var/backups/mchs-live)
  --latest      Restore the newest backup in /var/backups/mchs-live
  --list        List the available backups and exit
  -y, --yes     Do not ask for confirmation
  -h, --help    Show this help
EOF
}

info() { printf '    %s\n' "$*"; }
ok() { printf '    %sok%s  %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '    %sWARNING:%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die() {
  printf '\n%sERROR:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2
  exit 1
}
# shellcheck disable=SC2329  # invoked by the ERR trap
on_error() {
  ((BASH_SUBSHELL == 0)) || exit "$1"
  printf '\n%sERROR:%s "%s" failed (exit status %s) at restore.sh line %s.\n' "$C_ERR" "$C_RESET" "$3" "$1" "$2" >&2
  if [[ -n $ASIDE_DIR && -d $ASIDE_DIR ]]; then
    printf 'The previous database files are in %s - move them back to the data directory\nif the server does not start: sudo systemctl status mchs-live\n' "$ASIDE_DIR" >&2
  fi
  exit "$1"
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  [[ -z $WORK_DIR ]] || rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

parse_args() {
  while (($# > 0)); do
    case $1 in
      --latest) LATEST=1; shift ;;
      --list) LIST_ONLY=1; shift ;;
      -y | --yes) ASSUME_YES=1; shift ;;
      -h | --help) usage; exit 0 ;;
      -*) die "Unknown option: $1 (see --help)" ;;
      *)
        [[ -z $FILE ]] || die "Only one backup file can be restored."
        FILE=$1
        shift
        ;;
    esac
  done
}

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

ask_yes_no() { # ask_yes_no "Question" y|n
  local reply hint='y/N'
  [[ $2 == y ]] && hint='Y/n'
  ((ASSUME_YES)) && return 0
  [[ -t 0 ]] || die "Not a terminal - pass --yes to restore without confirmation."
  while true; do
    read -r -p "    $1 [$hint]: " reply || return 1
    reply=${reply,,}
    [[ -n $reply ]] || reply=$2
    case $reply in
      y | yes) return 0 ;;
      n | no) return 1 ;;
    esac
  done
}

BACKUPS=()
load_backups() {
  BACKUPS=()
  [[ -d $BACKUP_DIR ]] || return 0
  mapfile -t BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'live-*.db' -o -name 'live-*.db.gz' \) \
    -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}

print_backups() {
  local i f
  for i in "${!BACKUPS[@]}"; do
    f=${BACKUPS[$i]}
    printf '    %3d)  %s   %6s   %s\n' "$((i + 1))" "$(date -r "$f" '+%Y-%m-%d %H:%M')" "$(du -h -- "$f" | cut -f1)" "$(basename -- "$f")"
  done
}

choose_backup() {
  if [[ -n $FILE ]]; then
    [[ -f $FILE && -r $FILE ]] || die "Backup file not found or not readable: $FILE"
    FILE=$(readlink -f -- "$FILE")
    return 0
  fi
  load_backups
  ((${#BACKUPS[@]})) || die "No backups found in $BACKUP_DIR. Pass the path of a backup file."
  if ((LATEST)); then
    FILE=${BACKUPS[0]}
    return 0
  fi
  [[ -t 0 ]] || die "Not a terminal - pass a backup file or --latest."
  printf '\n%sAvailable backups (newest first):%s\n' "$C_BOLD" "$C_RESET"
  print_backups
  local choice
  while true; do
    read -r -p "    Restore which backup? [1]: " choice || die "Cancelled."
    choice=${choice:-1}
    if [[ $choice =~ ^[0-9]+$ ]] && ((10#$choice >= 1 && 10#$choice <= ${#BACKUPS[@]})); then
      FILE=${BACKUPS[$((10#$choice - 1))]}
      return 0
    fi
    info "Enter a number from 1 to ${#BACKUPS[@]}."
  done
}

DB_SUMMARY=''
# Checks a database file; sets DB_SUMMARY. Status 1 with a message on stderr when unusable.
inspect_db() {
  local db=$1 check tables users games last
  check=$(sqlite3 -batch "$db" 'PRAGMA integrity_check;' 2>&1 || true)
  if [[ $check != ok ]]; then
    printf '%s\n' "$check" | head -n 5 >&2
    return 1
  fi
  tables=$(sqlite3 -batch "$db" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'games', 'devices');" 2>&1 || true)
  if [[ $tables != 3 ]]; then
    printf 'not an MCHS Live Scores database (users/games/devices tables missing)\n' >&2
    return 1
  fi
  users=$(sqlite3 -batch "$db" 'SELECT COUNT(*) FROM users;')
  games=$(sqlite3 -batch "$db" 'SELECT COUNT(*) FROM games;')
  last=$(sqlite3 -batch "$db" "SELECT COALESCE(datetime(MAX(updated_at) / 1000, 'unixepoch', 'localtime'), 'never') FROM games;")
  DB_SUMMARY="$users user(s), $games game(s), last game change: $last"
}

health_url() {
  local host port
  host=$(env_value HOST)
  port=$(env_value PORT)
  case ${host:-127.0.0.1} in
    0.0.0.0 | :: | localhost | 127.0.0.1) host=127.0.0.1 ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s/api/health' "$host" "${port:-8080}"
}

wait_for_health() {
  local url i
  url=$(health_url)
  for ((i = 0; i < 45; i++)); do
    curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null && return 0
    [[ $(systemctl is-active "$SERVICE" 2>/dev/null || true) == failed ]] && return 1
    sleep 1
  done
  return 1
}

backup_command() {
  if [[ -x /usr/local/sbin/mchs-live-backup ]]; then
    printf '%s' /usr/local/sbin/mchs-live-backup
  else
    printf '%s' "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/backup.sh"
  fi
}

main() {
  parse_args "$@"
  ((EUID == 0)) || die "Run as root: sudo $0"
  command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is not installed (sudo apt-get install sqlite3)."
  id -u "$SERVICE_USER" >/dev/null 2>&1 || die "The service user $SERVICE_USER does not exist - is MCHS Live Scores installed?"

  if ((LIST_ONLY)); then
    load_backups
    ((${#BACKUPS[@]})) || die "No backups found in $BACKUP_DIR."
    print_backups
    exit 0
  fi

  local data_dir db service_installed=0
  data_dir=$(env_value DATA_DIR)
  data_dir=${data_dir:-$DEFAULT_DATA_DIR}
  data_dir=${data_dir%/}
  db=$data_dir/live.db
  [[ -d $data_dir ]] || die "Data directory $data_dir does not exist."
  if systemctl cat "$SERVICE" >/dev/null 2>&1; then service_installed=1; fi

  choose_backup
  printf '\n%sChecking %s%s\n' "$C_BOLD" "$FILE" "$C_RESET"
  WORK_DIR=$(mktemp -d -t mchs-live-restore.XXXXXX)
  local candidate=$WORK_DIR/restore.db
  if [[ $FILE == *.gz ]]; then
    gzip -dc -- "$FILE" >"$candidate" || die "Could not decompress $FILE."
  else
    cp -- "$FILE" "$candidate"
  fi
  inspect_db "$candidate" || die "$FILE is not a usable backup (see above). Nothing was changed."
  ok "Backup is valid: $DB_SUMMARY"
  if [[ -f $db ]]; then
    local current_copy=$WORK_DIR/current.db
    # Inspect a snapshot of the live database, never the file the server is using.
    if runuser -u "$SERVICE_USER" -- sqlite3 -batch -cmd '.timeout 10000' "$db" ".backup '$data_dir/.restore-inspect-$$.db'" 2>/dev/null; then
      mv -f -- "$data_dir/.restore-inspect-$$.db" "$current_copy"
      if inspect_db "$current_copy" 2>/dev/null; then info "Current database: $DB_SUMMARY"; fi
    fi
    rm -f -- "$data_dir/.restore-inspect-$$.db" "$current_copy"
  fi

  printf '\n'
  info "This replaces the current database with the backup above."
  if ((service_installed)); then
    info "The server is stopped for a few seconds; viewers reconnect automatically."
  fi
  ask_yes_no "Restore now?" n || die "Cancelled - nothing was changed."

  printf '\n'
  if ((service_installed)); then
    systemctl stop "$SERVICE"
    ok "Server stopped"
  fi

  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  if [[ -f $db ]]; then
    local out
    if ! out=$(bash "$(backup_command)" --data-dir "$data_dir" --dest "$BACKUP_DIR" --keep-days 0 --label pre-restore 2>&1); then
      if ((service_installed)); then systemctl start "$SERVICE" || true; fi
      die "Could not back up the current database, so nothing was changed. ($out)"
    fi
    ok "${out#Backup written: }"
    ok "(pre-restore copy of the current database)"
  fi

  # Move the current files aside (same directory = instant rename) so a failed
  # start can be rolled back exactly.
  ASIDE_DIR=$data_dir/.pre-restore-$stamp
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ASIDE_DIR"
  local suffix
  for suffix in '' -wal -shm -journal; do
    if [[ -e $db$suffix ]]; then mv -f -- "$db$suffix" "$ASIDE_DIR/"; fi
  done
  install -m 0640 -o "$SERVICE_USER" -g "$SERVICE_USER" "$candidate" "$data_dir/.live.db.restoring"
  mv -f -- "$data_dir/.live.db.restoring" "$db"
  ok "Backup put in place as $db"

  if ((!service_installed)); then
    rm -rf -- "$ASIDE_DIR"
    ASIDE_DIR=''
    ok "Restored. (The mchs-live service is not installed, so nothing was started.)"
    exit 0
  fi

  systemctl start "$SERVICE" || true
  if wait_for_health; then
    rm -rf -- "$ASIDE_DIR"
    ASIDE_DIR=''
    ok "Server is running again with the restored database"
    printf '\n%sRestore complete.%s Changes made after this backup was taken are gone - check the\nportal for games that were scheduled, live or scored since then.\n' "$C_BOLD" "$C_RESET"
    exit 0
  fi

  warn "The server did not become healthy with the restored database - putting the previous database back."
  journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true
  systemctl stop "$SERVICE" || true
  rm -f -- "$db" "$db-wal" "$db-shm" "$db-journal"
  local f
  for f in "$ASIDE_DIR"/live.db*; do
    if [[ -e $f ]]; then mv -f -- "$f" "$data_dir/"; fi
  done
  rmdir -- "$ASIDE_DIR" 2>/dev/null || true
  ASIDE_DIR=''
  systemctl start "$SERVICE" || true
  if wait_for_health; then
    die "Restore failed; the previous database is back and the server is running. See the log above."
  fi
  die "Restore failed and the server does not start with the previous database either. Check: journalctl -u mchs-live -n 100"
}

main "$@"
