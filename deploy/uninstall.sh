#!/usr/bin/env bash
#
# MCHS Live Scores - uninstaller.
#
#     sudo ./deploy/uninstall.sh          # or: sudo mchs-live-uninstall
#
# By default this removes the service, the daily backup timer, the Caddy site or the
# Cloudflare Tunnel connector, and the application code, and KEEPS the database, the
# configuration (including the APNs key and tunnel token) and the backups, so a later
# install continues where it left off.
# See --help for --purge, --close-ports and --remove-packages.

set -Eeuo pipefail
shopt -s inherit_errexit

# Same paths as install.sh.
readonly SERVICE=mchs-live.service
readonly BACKUP_SERVICE=mchs-live-backup.service
readonly BACKUP_TIMER=mchs-live-backup.timer
readonly SERVICE_USER=mchslive
readonly APP_DIR=/opt/mchs-live
readonly CONF_DIR=/etc/mchs-live
readonly ENV_FILE=$CONF_DIR/mchs-live.env
readonly STATE_FILE=$CONF_DIR/install.state
readonly UFW_RULES_FILE=$CONF_DIR/ufw-rules
readonly HOME_DIR=/var/lib/mchs-live
readonly BACKUP_DIR=/var/backups/mchs-live
readonly SYSTEMD_DIR=/etc/systemd/system
readonly SBIN_DIR=/usr/local/sbin
readonly HELPERS=(mchs-live-cli mchs-live-backup mchs-live-restore mchs-live-uninstall)
readonly CADDYFILE=/etc/caddy/Caddyfile
readonly CADDY_CONF_D=/etc/caddy/conf.d
readonly CADDY_SITE_FILE=$CADDY_CONF_D/mchs-live.caddy
readonly CADDY_KEYRING=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
readonly CADDY_APT_LIST=/etc/apt/sources.list.d/caddy-stable.list
readonly TUNNEL_SERVICE=mchs-live-tunnel.service
readonly CLOUDFLARED_KEYRING=/usr/share/keyrings/cloudflare-main.gpg
readonly CLOUDFLARED_APT_LIST=/etc/apt/sources.list.d/cloudflared.list
readonly NODESOURCE_FILES=(/etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources
  /etc/apt/keyrings/nodesource.gpg /usr/share/keyrings/nodesource.gpg
  /etc/apt/preferences.d/nodejs /etc/apt/preferences.d/nsolid)
readonly MARK_MANAGED='# Managed by mchs-live install.sh'
readonly MARK_GLOBAL_BEGIN='# >>> mchs-live global options (added by install.sh) >>>'
readonly MARK_GLOBAL_END='# <<< mchs-live global options <<<'
readonly MARK_IMPORT_BEGIN='# >>> mchs-live import (added by install.sh) >>>'
readonly MARK_IMPORT_END='# <<< mchs-live import <<<'

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  C_BOLD=$'\e[1m' C_STEP=$'\e[1;34m' C_OK=$'\e[32m' C_WARN=$'\e[1;33m' C_ERR=$'\e[1;31m' C_RESET=$'\e[0m'
else
  C_BOLD='' C_STEP='' C_OK='' C_WARN='' C_ERR='' C_RESET=''
fi

PURGE=0
CLOSE_PORTS=0
REMOVE_PACKAGES=0
ASSUME_YES=0
FINAL_BACKUP=1
INTERACTIVE=0
DATA_DIR=$HOME_DIR
FINAL_BACKUP_FILE=''
NODE_PREINSTALLED=''
CADDY_PREINSTALLED=''
NODESOURCE_ADDED=''
CLOUDFLARED_PREINSTALLED=''
CLOUDFLARED_REPO_ADDED=''
HTTPS_MODE=''
TUNNEL_INSTALLED=0
TUNNEL_CREATED=0
REMOVED=()
KEPT=()
WARNINGS=()

usage() {
  cat <<'EOF'
MCHS Live Scores uninstaller

Usage: sudo ./deploy/uninstall.sh [options]      (or: sudo mchs-live-uninstall [options])

Default: stops and removes the mchs-live service, the daily backup timer, the Caddy
site for the portal or the Cloudflare Tunnel connector (mchs-live-tunnel), and the
application code in /opt/mchs-live. The database (/var/lib/mchs-live), configuration,
APNs key and tunnel token (/etc/mchs-live) and backups (/var/backups/mchs-live) are
kept - re-running install.sh brings everything back. The tunnel itself lives in your
Cloudflare account: delete it there when you no longer need it.

  --purge             Also delete the database, configuration, APNs key, tunnel token,
                      backups and the mchslive user. A final database backup is saved
                      in /root first.
  --no-final-backup   With --purge: skip that final backup.
  --close-ports       Remove the firewall (ufw) rules the installer added for 80/tcp,
                      443/tcp and 443/udp. SSH rules are always kept.
  --remove-packages   Also remove the caddy, cloudflared and nodejs packages and their
                      apt repositories - only those the installer installed: packages
                      that were there before it are kept. Other software on this
                      server may need them!
  -y, --yes           Do not ask for confirmation.
  -h, --help          Show this help.
EOF
}

step() { printf '\n%s==> %s%s\n' "$C_STEP" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '    %sok%s  %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() {
  printf '    %sWARNING:%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2
  WARNINGS+=("$*")
}
die() {
  printf '\n%sERROR:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2
  exit 1
}
# shellcheck disable=SC2329  # invoked by the ERR trap
on_error() {
  ((BASH_SUBSHELL == 0)) || exit "$1"
  printf '\n%sERROR:%s "%s" failed (exit status %s) at uninstall.sh line %s.\n' "$C_ERR" "$C_RESET" "$3" "$1" "$2" >&2
  printf 'The uninstall stopped part-way; it is safe to run it again.\n' >&2
  exit "$1"
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

parse_args() {
  while (($# > 0)); do
    case $1 in
      --purge) PURGE=1 ;;
      --no-final-backup) FINAL_BACKUP=0 ;;
      --close-ports) CLOSE_PORTS=1 ;;
      --remove-packages) REMOVE_PACKAGES=1 ;;
      -y | --yes) ASSUME_YES=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
    shift
  done
}

kv_get() { # kv_get FILE KEY
  local line value=''
  [[ -r $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    if [[ $line == "$2="* ]]; then value=${line#*=}; fi
  done <"$1"
  value=${value%"${value##*[![:space:]]}"}
  if [[ ${#value} -ge 2 && ($value == \"*\" || $value == \'*\') ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}

ask_yes_no() { # ask_yes_no "Question" y|n
  local reply hint='y/N'
  [[ $2 == y ]] && hint='Y/n'
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

pkg_installed() { [[ $(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null || true) == installed ]]; }

# removable caddy|cloudflared|nodejs -> status 0 when --remove-packages may remove the
# package and its apt repository: never one that was installed before MCHS Live Scores.
removable() {
  case $1 in
    # Older installers always installed Caddy and recorded it; a tunnel install that found
    # no Caddy records nothing, and one that found Caddy records 1.
    caddy) [[ $CADDY_PREINSTALLED == 0 || (-z $CADDY_PREINSTALLED && $HTTPS_MODE != cloudflare-tunnel) ]] ;;
    # Only installers that offer the Cloudflare Tunnel install cloudflared, and they record it.
    cloudflared) [[ $CLOUDFLARED_PREINSTALLED == 0 ]] ;;
    nodejs) [[ $NODE_PREINSTALLED != 1 ]] ;;
    *) return 1 ;;
  esac
}

# True when install.sh added the NodeSource repository (one set up before it may serve
# other software). Older install.state files lack NODESOURCE_ADDED; those installers
# always added it when Node.js was missing.
nodesource_added() { [[ $NODESOURCE_ADDED == 1 || (-z $NODESOURCE_ADDED && $NODE_PREINSTALLED == 0) ]]; }

apt_get() {
  apt-get -q -y -o DPkg::Lock::Timeout=300 "$@"
}

# Refuses to delete anything that is obviously not a dedicated data directory.
safe_to_delete_dir() {
  case $1 in
    '' | / | /etc | /usr | /usr/* | /opt | /var | /var/lib | /var/backups | /home | /root | /tmp | /bin | /sbin | /boot | /proc | /sys | /dev) return 1 ;;
  esac
  [[ $1 == /?* ]]
}

# ---------------------------------------------------------------------------
plan_and_confirm() {
  printf '%sMCHS Live Scores uninstaller%s\n' "$C_BOLD" "$C_RESET"
  step "Plan"
  info "Remove:  the mchs-live service and daily backup timer, the application code in"
  info "         $APP_DIR and the mchs-live-* commands"
  if ((TUNNEL_INSTALLED)); then info "         the Cloudflare Tunnel connector (${TUNNEL_SERVICE%.service})"; fi
  if [[ -f $CADDY_SITE_FILE ]]; then info "         the Caddy site for the portal"; fi
  if ((PURGE)); then
    info "Purge:   database ($DATA_DIR), configuration, APNs key and tunnel token ($CONF_DIR),"
    info "         backups ($BACKUP_DIR) and the $SERVICE_USER user"
    if [[ -f $DATA_DIR/live.db ]]; then
      if ((FINAL_BACKUP)); then
        info "         (a final database backup is saved in /root first)"
      else
        info "         (NO final backup: --no-final-backup)"
      fi
    fi
  else
    info "Keep:    database ($DATA_DIR), configuration ($CONF_DIR), backups ($BACKUP_DIR)"
  fi
  if ((CLOSE_PORTS)); then
    info "Firewall: remove the installer's rules for 80/tcp, 443/tcp, 443/udp (SSH rules stay)"
  fi
  if ((REMOVE_PACKAGES)); then
    local pkg
    for pkg in caddy cloudflared nodejs; do
      [[ $pkg != nodejs ]] && ! pkg_installed "$pkg" && continue
      if ! removable "$pkg"; then
        info "Packages: keep $pkg - it was installed before MCHS Live Scores"
      elif [[ $pkg == nodejs ]] && ! nodesource_added; then
        info "Packages: remove nodejs (the NodeSource repository was not added by the installer and stays)"
      else
        info "Packages: remove $pkg and its apt repository"
      fi
    done
    printf '    %sOther software on this server may use Caddy, cloudflared or Node.js.%s\n' "$C_WARN" "$C_RESET"
  fi

  if ((ASSUME_YES)); then
    return 0
  fi
  ((INTERACTIVE)) || die "stdin is not a terminal - pass --yes to uninstall without questions."
  printf '\n'
  if ((PURGE)); then
    local answer
    read -r -p "    This permanently deletes all scores, accounts and backups. Type 'purge' to confirm: " answer ||
      die "Cancelled - nothing was changed."
    [[ $answer == purge ]] || die "Cancelled - nothing was changed."
    if [[ -f $DATA_DIR/live.db ]] && ((FINAL_BACKUP)); then
      ask_yes_no "Save a final database backup in /root first?" y || FINAL_BACKUP=0
    fi
  else
    ask_yes_no "Uninstall MCHS Live Scores?" n || die "Cancelled - nothing was changed."
  fi
}

backup_command() {
  local here
  here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  if [[ -x $SBIN_DIR/mchs-live-backup ]]; then
    printf '%s' "$SBIN_DIR/mchs-live-backup"
  elif [[ -f $here/backup.sh ]]; then
    printf '%s' "$here/backup.sh"
  fi
}

final_backup() {
  [[ -f $DATA_DIR/live.db ]] || return 0
  if ((!FINAL_BACKUP)); then
    info "No final backup (as requested)."
    return 0
  fi
  step "Saving a final database backup"
  local cmd out
  cmd=$(backup_command)
  if [[ -n $cmd ]] && command -v sqlite3 >/dev/null 2>&1; then
    out=$(bash "$cmd" --data-dir "$DATA_DIR" --dest /root --keep-days 0 --label mchs-live-final 2>&1) ||
      die "The final backup failed - nothing was removed. ($out)"
    FINAL_BACKUP_FILE=${out#Backup written: }
    FINAL_BACKUP_FILE=${FINAL_BACKUP_FILE% (*}
  else
    # Without sqlite3: copy the files of the stopped database (the WAL file holds recent changes).
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    FINAL_BACKUP_FILE=/root/live-$(date +%Y%m%d-%H%M%S)-mchs-live-final.db
    cp -- "$DATA_DIR/live.db" "$FINAL_BACKUP_FILE"
    if [[ -f $DATA_DIR/live.db-wal ]]; then
      cp -- "$DATA_DIR/live.db-wal" "$FINAL_BACKUP_FILE-wal"
      chmod 0600 -- "$FINAL_BACKUP_FILE-wal"
    fi
  fi
  chmod 0600 -- "$FINAL_BACKUP_FILE"
  ok "Final backup: $FINAL_BACKUP_FILE"
  KEPT+=("final database backup: $FINAL_BACKUP_FILE")
}

remove_units() {
  step "Removing the service and the backup timer"
  local unit found=0
  for unit in "$TUNNEL_SERVICE" "$BACKUP_TIMER" "$BACKUP_SERVICE" "$SERVICE"; do
    if [[ -e $SYSTEMD_DIR/$unit ]] || systemctl cat "$unit" >/dev/null 2>&1; then
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
      found=1
    fi
  done
  for unit in "$TUNNEL_SERVICE" "$BACKUP_TIMER" "$BACKUP_SERVICE" "$SERVICE"; do
    if [[ -e $SYSTEMD_DIR/$unit ]]; then
      rm -f -- "$SYSTEMD_DIR/$unit"
      REMOVED+=("systemd unit $SYSTEMD_DIR/$unit")
    fi
    if [[ -d $SYSTEMD_DIR/$unit.d ]]; then
      rm -rf -- "${SYSTEMD_DIR:?}/$unit.d"
      REMOVED+=("systemd drop-ins $SYSTEMD_DIR/$unit.d")
    fi
  done
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE" "$BACKUP_SERVICE" "$TUNNEL_SERVICE" >/dev/null 2>&1 || true
  if ((found)); then ok "Service and timer stopped and removed"; else ok "No service installed"; fi
}

remove_caddy_site() {
  step "Removing the Caddy site"
  local changed=0
  if [[ -f $CADDY_SITE_FILE ]]; then
    rm -f -- "$CADDY_SITE_FILE"
    REMOVED+=("Caddy site $CADDY_SITE_FILE")
    changed=1
  fi

  if [[ -f $CADDYFILE ]]; then
    local others='' backup
    others=$(find -L "$CADDY_CONF_D" -maxdepth 1 -type f -name '*.caddy' -print 2>/dev/null || true)
    if [[ -n $others ]]; then
      KEPT+=("the import of $CADDY_CONF_D/*.caddy in $CADDYFILE (other sites there still use it)")
    elif grep -Fq "$MARK_MANAGED" "$CADDYFILE"; then
      backup=$(kv_get "$STATE_FILE" CADDYFILE_BACKUP)
      if [[ -n $backup && -f $backup ]]; then
        cp -- "$backup" "$CADDYFILE"
        chmod 0644 -- "$CADDYFILE"
        REMOVED+=("installer-managed $CADDYFILE (original restored from $backup)")
        changed=1
      else
        KEPT+=("$CADDYFILE (written by the installer; it now serves no sites)")
      fi
    elif grep -Fq -e "$MARK_IMPORT_BEGIN" -e "$MARK_GLOBAL_BEGIN" "$CADDYFILE"; then
      local tmp
      tmp=$(mktemp "$CADDYFILE.XXXXXX")
      awk -v b1="$MARK_GLOBAL_BEGIN" -v e1="$MARK_GLOBAL_END" -v b2="$MARK_IMPORT_BEGIN" -v e2="$MARK_IMPORT_END" '
        $0 == b1 || $0 == b2 { skip = 1; next }
        $0 == e1 || $0 == e2 { skip = 0; next }
        !skip { print }
      ' "$CADDYFILE" >"$tmp"
      chmod 0644 -- "$tmp"
      mv -f -- "$tmp" "$CADDYFILE"
      REMOVED+=("the lines the installer added to $CADDYFILE")
      changed=1
    fi
  fi
  if [[ -d $CADDY_CONF_D ]]; then rmdir --ignore-fail-on-non-empty -- "$CADDY_CONF_D"; fi

  if ((changed)) && command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy; then
    local tmpdir out
    tmpdir=$(mktemp -d)
    if out=$(HOME=$tmpdir XDG_DATA_HOME=$tmpdir XDG_CONFIG_HOME=$tmpdir caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1); then
      systemctl reload caddy || systemctl restart caddy
      ok "Caddy reloaded - it no longer serves the portal"
    else
      warn "Caddy's remaining configuration does not validate, so Caddy was not reloaded: $(printf '%s' "$out" | tail -n 1)"
    fi
    rm -rf -- "$tmpdir"
  else
    ok "Caddy configuration updated"
  fi
}

remove_app() {
  step "Removing the application code and commands"
  if [[ -d $APP_DIR ]]; then
    rm -rf -- "${APP_DIR:?}"
    REMOVED+=("application code $APP_DIR")
  fi
  local helper
  for helper in "${HELPERS[@]}"; do
    if [[ -e $SBIN_DIR/$helper ]]; then
      rm -f -- "${SBIN_DIR:?}/$helper"
      REMOVED+=("command $SBIN_DIR/$helper")
    fi
  done
  ok "Done"
}

close_ports() {
  step "Removing the firewall rules"
  if ! command -v ufw >/dev/null 2>&1; then
    info "ufw is not installed - nothing to do."
    return 0
  fi
  if [[ ! -f $UFW_RULES_FILE ]]; then
    info "No record of firewall rules added by the installer - check 'sudo ufw status numbered' yourself."
    return 0
  fi
  local tag spec
  local -a words keep=()
  while IFS='|' read -r tag spec; do
    [[ -n $spec ]] || continue
    if [[ $tag == web ]]; then
      read -r -a words <<<"$spec"
      if ufw delete "${words[@]}" >/dev/null 2>&1; then
        REMOVED+=("firewall rule: ufw $spec")
      else
        warn "Could not remove the firewall rule 'ufw $spec' (already gone?)."
      fi
    else
      keep+=("$tag|$spec")
      KEPT+=("firewall rule: ufw $spec (SSH - kept so you do not lose access)")
    fi
  done <"$UFW_RULES_FILE"
  if ((${#keep[@]})); then
    printf '%s\n' "${keep[@]}" >"$UFW_RULES_FILE"
  else
    rm -f -- "$UFW_RULES_FILE"
  fi
  ok "Ports 80 and 443 are closed in ufw (cloud firewalls/security groups are not changed)"
}

purge_data() {
  step "Deleting data, configuration, backups and the service user"
  if [[ -d $DATA_DIR ]]; then
    if [[ $DATA_DIR == "$HOME_DIR" ]]; then
      rm -rf -- "$HOME_DIR"
    elif safe_to_delete_dir "$DATA_DIR"; then
      # A custom DATA_DIR may hold other files: remove only what the server created.
      rm -f -- "$DATA_DIR"/live.db "$DATA_DIR"/live.db-wal "$DATA_DIR"/live.db-shm "$DATA_DIR"/live.db-journal
      rmdir -- "$DATA_DIR" 2>/dev/null || KEPT+=("other files in $DATA_DIR")
    fi
    REMOVED+=("database $DATA_DIR/live.db")
  fi
  if [[ -d $HOME_DIR ]]; then rm -rf -- "$HOME_DIR"; fi
  if [[ -d $BACKUP_DIR ]]; then
    rm -rf -- "$BACKUP_DIR"
    REMOVED+=("backups $BACKUP_DIR")
  fi
  if [[ -d $CONF_DIR ]]; then
    rm -rf -- "$CONF_DIR"
    REMOVED+=("configuration and APNs key $CONF_DIR")
  fi
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    userdel "$SERVICE_USER" 2>/dev/null || warn "Could not delete the user $SERVICE_USER (userdel failed)."
    REMOVED+=("system user $SERVICE_USER")
  fi
  if getent group "$SERVICE_USER" >/dev/null 2>&1; then
    groupdel "$SERVICE_USER" 2>/dev/null || warn "Could not delete the group $SERVICE_USER."
  fi
  ok "Done"
}

remove_packages() {
  step "Removing the caddy, cloudflared and nodejs packages"
  local -a pkgs=() extra=() repo_files=()
  local name
  for name in caddy cloudflared nodejs; do
    [[ $name != nodejs ]] && ! pkg_installed "$name" && continue
    if ! removable "$name"; then
      KEPT+=("package $name and its apt repository (installed before MCHS Live Scores)")
    elif pkg_installed "$name"; then
      pkgs+=("$name")
    fi
  done
  if ((${#pkgs[@]})); then
    # apt would silently remove packages that depend on these as well - show them first.
    while IFS= read -r name; do
      [[ $name == caddy || $name == cloudflared || $name == nodejs ]] || extra+=("$name")
    done < <(apt-get -s remove "${pkgs[@]}" 2>/dev/null | awk '$1 == "Remv" { print $2 }' || true)
    if ((${#extra[@]})); then
      warn "Removing ${pkgs[*]} would also remove: ${extra[*]}"
      if ((!INTERACTIVE)) || ! ask_yes_no "Remove those packages too?" n; then
        KEPT+=("packages ${pkgs[*]} (other installed packages depend on them)")
        return 0
      fi
    fi
    apt_get remove "${pkgs[@]}"
    REMOVED+=("packages: ${pkgs[*]} (Caddy's certificates in /var/lib/caddy and /etc/caddy are kept; 'apt-get purge caddy' removes them)")
  fi
  if removable caddy; then repo_files+=("$CADDY_APT_LIST" "$CADDY_KEYRING"); fi
  if removable cloudflared && [[ $CLOUDFLARED_REPO_ADDED == 1 ]]; then
    repo_files+=("$CLOUDFLARED_APT_LIST")
    # Other Cloudflare repositories may share the keyring.
    local keyring_users
    keyring_users=$(grep -lsF "$CLOUDFLARED_KEYRING" /etc/apt/sources.list /etc/apt/sources.list.d/*.list \
      /etc/apt/sources.list.d/*.sources 2>/dev/null | grep -vFx "$CLOUDFLARED_APT_LIST" || true)
    [[ -n $keyring_users ]] || repo_files+=("$CLOUDFLARED_KEYRING")
  fi
  if removable nodejs; then
    if nodesource_added; then
      repo_files+=("${NODESOURCE_FILES[@]}")
    elif compgen -G '/etc/apt/sources.list.d/nodesource.*' >/dev/null; then
      KEPT+=("the NodeSource apt repository (not added by the installer)")
    fi
  fi
  local f removed_repo=0
  for f in "${repo_files[@]}"; do
    if [[ -e $f ]]; then
      rm -f -- "$f"
      removed_repo=1
    fi
  done
  if ((removed_repo)); then
    REMOVED+=("the apt repositories of the removed packages")
    apt_get update >/dev/null 2>&1 || warn "apt-get update failed after removing the repositories - check your apt sources."
  fi
  ok "Done"
}

print_summary() {
  local item
  printf '\n%s%s%s\n' "$C_BOLD" '======================================================================' "$C_RESET"
  printf '%s MCHS Live Scores has been uninstalled%s\n' "$C_BOLD" "$C_RESET"
  printf '%s%s%s\n' "$C_BOLD" '======================================================================' "$C_RESET"
  printf '  Removed\n'
  if ((${#REMOVED[@]})); then
    for item in "${REMOVED[@]}"; do printf '    - %s\n' "$item"; done
  else
    printf '    (nothing - it was not installed)\n'
  fi
  if ((!PURGE)); then
    if [[ -d $DATA_DIR ]]; then KEPT+=("database $DATA_DIR (re-running install.sh uses it again)"); fi
    if [[ -d $CONF_DIR ]]; then KEPT+=("configuration, APNs key and tunnel token (if any) $CONF_DIR"); fi
    if [[ -d $BACKUP_DIR ]]; then KEPT+=("backups $BACKUP_DIR"); fi
    if id -u "$SERVICE_USER" >/dev/null 2>&1; then KEPT+=("system user $SERVICE_USER (owns the kept data)"); fi
  fi
  if ((!CLOSE_PORTS)) && [[ -f $UFW_RULES_FILE ]] && grep -q '^web|' "$UFW_RULES_FILE"; then
    KEPT+=("firewall rules for 80/tcp, 443/tcp, 443/udp (remove with --close-ports)")
  fi
  if ((!REMOVE_PACKAGES)); then
    if pkg_installed cloudflared; then
      KEPT+=("packages caddy, cloudflared and nodejs, as installed (remove with --remove-packages)")
    else
      KEPT+=("packages caddy and nodejs (remove with --remove-packages)")
    fi
  fi
  local backups=0
  # /etc/caddy does not exist on a VM that only ever used the Cloudflare Tunnel.
  if [[ -d /etc/caddy ]]; then
    backups=$(find /etc/caddy -maxdepth 1 -name 'Caddyfile.mchs-live-backup-*' -print 2>/dev/null | wc -l || true)
  fi
  if ((backups > 0)); then KEPT+=("$backups Caddyfile backup(s) /etc/caddy/Caddyfile.mchs-live-backup-*"); fi
  printf '  Kept\n'
  for item in "${KEPT[@]}"; do printf '    - %s\n' "$item"; done
  if ((TUNNEL_CREATED)); then
    printf '  Cloudflare\n'
    printf '    - The tunnel still exists in your Cloudflare account. Unless you reinstall, delete it\n'
    printf '      (Networking > Tunnels) and the CNAME record for the portal that points to it\n'
    printf '      (DNS > Records).\n'
  fi
  if ((${#WARNINGS[@]})); then
    printf '  %sWarnings%s\n' "$C_WARN" "$C_RESET"
    for item in "${WARNINGS[@]}"; do printf '    - %s\n' "$item"; done
  fi
  printf '\n'
}

main() {
  parse_args "$@"
  ((EUID == 0)) || die "Run as root: sudo $0"
  if ((!ASSUME_YES)) && [[ -t 0 ]]; then INTERACTIVE=1; fi
  ((PURGE)) || FINAL_BACKUP=0

  local dir
  dir=$(kv_get "$ENV_FILE" DATA_DIR)
  dir=${dir%/}
  if [[ -n $dir ]]; then
    safe_to_delete_dir "$dir" || die "DATA_DIR=$dir in $ENV_FILE looks wrong - refusing to continue."
    DATA_DIR=$dir
  fi
  NODE_PREINSTALLED=$(kv_get "$STATE_FILE" NODE_PREINSTALLED)
  CADDY_PREINSTALLED=$(kv_get "$STATE_FILE" CADDY_PREINSTALLED)
  NODESOURCE_ADDED=$(kv_get "$STATE_FILE" NODESOURCE_ADDED)
  CLOUDFLARED_PREINSTALLED=$(kv_get "$STATE_FILE" CLOUDFLARED_PREINSTALLED)
  CLOUDFLARED_REPO_ADDED=$(kv_get "$STATE_FILE" CLOUDFLARED_REPO_ADDED)
  HTTPS_MODE=$(kv_get "$STATE_FILE" HTTPS_MODE)
  # What is installed counts, not the last mode chosen (a switch may have stopped half-way).
  if [[ -e $SYSTEMD_DIR/$TUNNEL_SERVICE ]]; then TUNNEL_INSTALLED=1; fi
  # A tunnel exists in Cloudflare once a token was given, even if it never connected here.
  if ((TUNNEL_INSTALLED)) || [[ -e $CONF_DIR/cloudflare-tunnel.token || $HTTPS_MODE == cloudflare-tunnel ]]; then
    TUNNEL_CREATED=1
  fi

  plan_and_confirm
  if ((PURGE)); then final_backup; fi
  remove_units
  remove_caddy_site
  remove_app
  if ((CLOSE_PORTS)); then close_ports; fi
  if ((PURGE)); then purge_data; fi
  if ((REMOVE_PACKAGES)); then remove_packages; fi
  print_summary
}

main "$@"
exit 0
