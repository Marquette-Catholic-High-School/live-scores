#!/usr/bin/env bash
#
# MCHS Live Scores - installer and upgrader.
#
# Supported: Ubuntu 24.04 LTS / 26.04 LTS and Debian 12 / 13 with systemd,
# on x86_64 (amd64) or arm64. Run as root from inside the live-scores folder
# (git clone https://github.com/Marquette-Catholic-High-School/live-scores.git):
#
#     sudo ./deploy/install.sh            # interactive
#     sudo ./deploy/install.sh --help     # every option
#
# Re-running the script upgrades the application code and keeps the existing
# configuration, database and backups. Only the settings you pass as options
# (or change at the prompts) are modified.

set -Eeuo pipefail
shopt -s inherit_errexit

# ---------------------------------------------------------------------------
# Constants (uninstall.sh, backup.sh, restore.sh and mchs-live-cli.sh use the
# same paths - keep them in sync).
# ---------------------------------------------------------------------------
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
readonly BACKUP_KEEP_DAYS=14
readonly SYSTEMD_DIR=/etc/systemd/system
readonly SBIN_DIR=/usr/local/sbin
readonly CLI=$SBIN_DIR/mchs-live-cli
readonly CADDYFILE=/etc/caddy/Caddyfile
readonly CADDY_CONF_D=/etc/caddy/conf.d
readonly CADDY_SITE_FILE=$CADDY_CONF_D/mchs-live.caddy
readonly CADDY_IMPORT_LINE='import /etc/caddy/conf.d/*.caddy'
readonly CADDY_KEYRING=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
readonly CADDY_APT_LIST=/etc/apt/sources.list.d/caddy-stable.list
readonly CADDY_REPO_BASE=https://dl.cloudsmith.io/public/caddy/stable
readonly TUNNEL_SERVICE=mchs-live-tunnel.service
readonly TUNNEL_TOKEN_FILE=$CONF_DIR/cloudflare-tunnel.token
readonly TUNNEL_METRICS=127.0.0.1:20246
readonly CLOUDFLARED_BIN=/usr/bin/cloudflared
readonly CLOUDFLARED_KEYRING=/usr/share/keyrings/cloudflare-main.gpg
readonly CLOUDFLARED_APT_LIST=/etc/apt/sources.list.d/cloudflared.list
readonly CLOUDFLARED_REPO_BASE=https://pkg.cloudflare.com
readonly MARK_MANAGED='# Managed by mchs-live install.sh'
readonly MARK_GLOBAL_BEGIN='# >>> mchs-live global options (added by install.sh) >>>'
readonly MARK_GLOBAL_END='# <<< mchs-live global options <<<'
readonly MARK_IMPORT_BEGIN='# >>> mchs-live import (added by install.sh) >>>'
readonly MARK_IMPORT_END='# <<< mchs-live import <<<'
readonly NODE_BIN=/usr/bin/node
readonly MIN_NODE_MAJOR=24
readonly DEFAULT_NODE_MAJOR=26
readonly DEFAULT_TEAM_ID=92KVHUHC4C
readonly DEFAULT_BUNDLE_ID=org.marquettecatholic.app
readonly DEFAULT_APNS_ENVS=production,sandbox
readonly DEFAULT_SCHOOL_TIMEZONE=America/Chicago
readonly ZONEINFO_DIR=/usr/share/zoneinfo
readonly UFW_COMMENT=mchs-live
readonly STEP_TOTAL=14

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SRC_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
readonly SCRIPT_DIR SRC_DIR

export DEBIAN_FRONTEND=noninteractive
# Ubuntu's needrestart would otherwise restart unrelated services (sshd...) mid-install.
export NEEDRESTART_SUSPEND=1

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_STEP=$'\e[1;34m' C_OK=$'\e[32m' C_WARN=$'\e[1;33m' C_ERR=$'\e[1;31m' C_RESET=$'\e[0m'
else
  C_BOLD='' C_DIM='' C_STEP='' C_OK='' C_WARN='' C_ERR='' C_RESET=''
fi

STEP_NO=0
WARNINGS=()

step() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n%s==> [%d/%d] %s%s\n' "$C_STEP" "$STEP_NO" "$STEP_TOTAL" "$*" "$C_RESET"
}
section() { printf '\n%s==> %s%s\n' "$C_STEP" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '    %sok%s  %s\n' "$C_OK" "$C_RESET" "$*"; }
# Input problems at a prompt: shown, but not repeated in the final summary.
problem() { printf '    %s%s%s\n' "$C_WARN" "$*" "$C_RESET" >&2; }
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
  local status=$1 line=$2 cmd=$3
  # Inside $(...) just propagate; the top level reports the failure once.
  ((BASH_SUBSHELL == 0)) || exit "$status"
  printf '\n%sERROR:%s "%s" failed (exit status %s) at install.sh line %s.\n' \
    "$C_ERR" "$C_RESET" "$cmd" "$status" "$line" >&2
  printf 'The installation did not finish. Fix the problem above and run the installer again;\nit is safe to re-run and keeps everything that was already set up.\n' >&2
  exit "$status"
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

TMP_DIR=$(mktemp -d -t mchs-live-install.XXXXXX)
readonly TMP_DIR
TMP_FILES=()
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local f
  for f in "${TMP_FILES[@]}"; do rm -f -- "$f"; done
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
MCHS Live Scores installer / upgrader

Usage: sudo ./deploy/install.sh [options]

Run it from inside the live-scores folder (the git clone). Without --yes it asks for
everything it needs; each option can also be given as the environment
variable shown in brackets (options win over variables).

  --domain NAME             Public DNS name of the portal, e.g. live.example.org [MCHS_DOMAIN]
  --caddy                   Serve HTTPS from this VM with Caddy and Let's Encrypt (ports 80/443
                            open to the internet). The default for new installs [MCHS_HTTPS_MODE=caddy]
  --cloudflare-tunnel       Reach the server through a Cloudflare Tunnel instead: Cloudflare
                            provides HTTPS and no inbound port is opened [MCHS_HTTPS_MODE=cloudflare-tunnel]
  --tunnel-token-file FILE  The tunnel's token (Cloudflare dashboard) from the first line of FILE
                            (/dev/stdin when piped in); implies --cloudflare-tunnel. Otherwise you
                            are asked [MCHS_TUNNEL_TOKEN_FILE, or the token itself in MCHS_TUNNEL_TOKEN].
                            Never put the token on the command line.
  --email ADDRESS           ACME (Let's Encrypt) contact e-mail; optional, Caddy only [MCHS_EMAIL]
  --apns-key-path FILE      APNs auth key (.p8) on this server; copied to $CONF_DIR [MCHS_APNS_KEY_PATH]
  --apns-key-id ID          10-character Key ID (read from AuthKey_<ID>.p8 if omitted) [MCHS_APNS_KEY_ID]
  --apns-team-id ID         Apple Developer Team ID (default $DEFAULT_TEAM_ID) [MCHS_APNS_TEAM_ID]
  --bundle-id ID            iOS app bundle id (default $DEFAULT_BUNDLE_ID) [MCHS_BUNDLE_ID]
  --apns-environments LIST  production,sandbox | production | sandbox (default $DEFAULT_APNS_ENVS) [MCHS_APNS_ENVIRONMENTS]
  --school-timezone ZONE    The school's IANA time zone for game times, e.g. America/New_York
                            (default $DEFAULT_SCHOOL_TIMEZONE) [MCHS_SCHOOL_TIMEZONE]
  --admin-username NAME     First admin account (default admin) [MCHS_ADMIN_USERNAME]
  --admin-display-name TEXT Display name of the first admin (default Administrator) [MCHS_ADMIN_DISPLAY_NAME]
  --admin-password-file FILE
                            Read its password (min. 8 characters) from the first line of FILE
                            (/dev/stdin when piped in); otherwise you are asked, or with --yes
                            one is generated and printed once [MCHS_ADMIN_PASSWORD_FILE, or the
                            password itself in MCHS_ADMIN_PASSWORD]. Never put a password on the
                            command line: sudo logs it and every user can see it in ps.
  --ssh-from CIDR[,CIDR]    Only allow SSH from these addresses; "any" removes a
                            restriction set earlier [MCHS_SSH_FROM]
  --ssh-port PORT           SSH port to allow in the firewall (default: detected) [MCHS_SSH_PORT]
  --no-firewall             Do not install or configure ufw [MCHS_NO_FIREWALL=1]
  --node-major 24|26        Node.js line to install when Node is missing or older than 24
                            (default $DEFAULT_NODE_MAJOR) [MCHS_NODE_MAJOR]
  --skip-apns-check         Do not run the APNs end-to-end check at the end
  --skip-os-check           Continue on an untested OS release (not recommended)
  -y, --yes                 Non-interactive: use the options above and defaults, never prompt [MCHS_YES=1]
  -h, --help                Show this help

Examples:
  sudo ./deploy/install.sh
  sudo ./deploy/install.sh --yes --domain live.example.org --email it@example.org \\
       --apns-key-path ~/AuthKey_ABCDE12345.p8 --ssh-from 203.0.113.0/24
  sudo ./deploy/install.sh --yes --domain live.example.org --tunnel-token-file ~/tunnel-token.txt \\
       --apns-key-path ~/AuthKey_ABCDE12345.p8 --ssh-from 203.0.113.0/24
EOF
}

OPT_DOMAIN=${MCHS_DOMAIN-}
OPT_EMAIL=${MCHS_EMAIL-}
OPT_KEY_PATH=${MCHS_APNS_KEY_PATH-}
OPT_KEY_ID=${MCHS_APNS_KEY_ID-}
OPT_TEAM_ID=${MCHS_APNS_TEAM_ID-}
OPT_BUNDLE_ID=${MCHS_BUNDLE_ID-}
OPT_APNS_ENVS=${MCHS_APNS_ENVIRONMENTS-}
OPT_SCHOOL_TIMEZONE=${MCHS_SCHOOL_TIMEZONE-}
OPT_ADMIN_USERNAME=${MCHS_ADMIN_USERNAME-}
OPT_ADMIN_DISPLAY_NAME=${MCHS_ADMIN_DISPLAY_NAME-}
OPT_ADMIN_PASSWORD=${MCHS_ADMIN_PASSWORD-}
OPT_ADMIN_PASSWORD_FILE=${MCHS_ADMIN_PASSWORD_FILE-}
OPT_SSH_FROM=${MCHS_SSH_FROM-}
OPT_SSH_PORT=${MCHS_SSH_PORT-}
OPT_NODE_MAJOR=${MCHS_NODE_MAJOR-}
OPT_HTTPS_MODE=${MCHS_HTTPS_MODE-}
OPT_TUNNEL_TOKEN=${MCHS_TUNNEL_TOKEN-}
OPT_TUNNEL_TOKEN_FILE=${MCHS_TUNNEL_TOKEN_FILE-}
SET_TUNNEL_TOKEN=$([[ -v MCHS_TUNNEL_TOKEN ]] && echo 1 || echo 0)
SET_DOMAIN=$([[ -v MCHS_DOMAIN ]] && echo 1 || echo 0)
SET_EMAIL=$([[ -v MCHS_EMAIL ]] && echo 1 || echo 0)
SET_KEY_PATH=$([[ -v MCHS_APNS_KEY_PATH ]] && echo 1 || echo 0)
SET_KEY_ID=$([[ -v MCHS_APNS_KEY_ID ]] && echo 1 || echo 0)
SET_TEAM_ID=$([[ -v MCHS_APNS_TEAM_ID ]] && echo 1 || echo 0)
SET_BUNDLE_ID=$([[ -v MCHS_BUNDLE_ID ]] && echo 1 || echo 0)
SET_APNS_ENVS=$([[ -v MCHS_APNS_ENVIRONMENTS ]] && echo 1 || echo 0)
SET_SCHOOL_TIMEZONE=$([[ -v MCHS_SCHOOL_TIMEZONE ]] && echo 1 || echo 0)
SET_ADMIN_USERNAME=$([[ -v MCHS_ADMIN_USERNAME ]] && echo 1 || echo 0)
SET_ADMIN_PASSWORD=$([[ -v MCHS_ADMIN_PASSWORD ]] && echo 1 || echo 0)
SET_SSH_FROM=$([[ -v MCHS_SSH_FROM ]] && echo 1 || echo 0)
SET_NODE_MAJOR=$([[ -v MCHS_NODE_MAJOR ]] && echo 1 || echo 0)
NO_FIREWALL=$([[ ${MCHS_NO_FIREWALL:-0} == 1 ]] && echo 1 || echo 0)
ASSUME_YES=$([[ ${MCHS_YES:-0} == 1 ]] && echo 1 || echo 0)
# Kept in shell variables only: the package and repository scripts run below never see them.
unset MCHS_ADMIN_PASSWORD MCHS_TUNNEL_TOKEN
SKIP_APNS_CHECK=0
SKIP_OS_CHECK=0

need_arg() {
  (($# >= 2)) || die "Option $1 needs a value (see --help)."
}

parse_args() {
  while (($# > 0)); do
    case $1 in
      --*=*) set -- "${1%%=*}" "${1#*=}" "${@:2}"; continue ;;
      -h | --help) usage; exit 0 ;;
      -y | --yes) ASSUME_YES=1; shift ;;
      --domain) need_arg "$@"; OPT_DOMAIN=$2; SET_DOMAIN=1; shift 2 ;;
      --email) need_arg "$@"; OPT_EMAIL=$2; SET_EMAIL=1; shift 2 ;;
      --apns-key-path) need_arg "$@"; OPT_KEY_PATH=$2; SET_KEY_PATH=1; shift 2 ;;
      --apns-key-id) need_arg "$@"; OPT_KEY_ID=$2; SET_KEY_ID=1; shift 2 ;;
      --apns-team-id) need_arg "$@"; OPT_TEAM_ID=$2; SET_TEAM_ID=1; shift 2 ;;
      --bundle-id) need_arg "$@"; OPT_BUNDLE_ID=$2; SET_BUNDLE_ID=1; shift 2 ;;
      --apns-environments) need_arg "$@"; OPT_APNS_ENVS=$2; SET_APNS_ENVS=1; shift 2 ;;
      --school-timezone) need_arg "$@"; OPT_SCHOOL_TIMEZONE=$2; SET_SCHOOL_TIMEZONE=1; shift 2 ;;
      --admin-username) need_arg "$@"; OPT_ADMIN_USERNAME=$2; SET_ADMIN_USERNAME=1; shift 2 ;;
      --admin-display-name) need_arg "$@"; OPT_ADMIN_DISPLAY_NAME=$2; shift 2 ;;
      --admin-password-file) need_arg "$@"; OPT_ADMIN_PASSWORD_FILE=$2; shift 2 ;;
      --admin-password) die "--admin-password is not supported: sudo logs the command line and every user can read it in ps. Use --admin-password-file FILE (see --help)." ;;
      --caddy) OPT_HTTPS_MODE=caddy; shift ;;
      --cloudflare-tunnel) OPT_HTTPS_MODE=cloudflare-tunnel; shift ;;
      --tunnel-token-file) need_arg "$@"; OPT_TUNNEL_TOKEN_FILE=$2; shift 2 ;;
      --tunnel-token) die "--tunnel-token is not supported: sudo logs the command line and every user can read it in ps. Save the token in a file and use --tunnel-token-file FILE (see --help)." ;;
      --ssh-from) need_arg "$@"; OPT_SSH_FROM=$2; SET_SSH_FROM=1; shift 2 ;;
      --ssh-port) need_arg "$@"; OPT_SSH_PORT=$2; shift 2 ;;
      --node-major) need_arg "$@"; OPT_NODE_MAJOR=$2; SET_NODE_MAJOR=1; shift 2 ;;
      --no-firewall) NO_FIREWALL=1; shift ;;
      --skip-apns-check) SKIP_APNS_CHECK=1; shift ;;
      --skip-os-check) SKIP_OS_CHECK=1; shift ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Prompts (only used when INTERACTIVE=1)
# ---------------------------------------------------------------------------
INTERACTIVE=0

# ask VAR "Question" [default]
ask() {
  local __var=$1 __prompt=$2 __default=${3-} __reply=''
  [[ -n $__default ]] && __prompt+=" [$__default]"
  read -r -p "    $__prompt: " __reply || die "Input closed. Use --yes with options for a non-interactive install."
  [[ -n $__reply ]] || __reply=$__default
  printf -v "$__var" '%s' "$__reply"
}

# ask_yes_no "Question" y|n  -> status 0 for yes
ask_yes_no() {
  local prompt=$1 def=$2 reply hint
  if ((!INTERACTIVE)); then [[ $def == y ]]; return; fi
  [[ $def == y ]] && hint='Y/n' || hint='y/N'
  while true; do
    read -r -p "    $prompt [$hint]: " reply || return 1
    reply=${reply,,}
    [[ -n $reply ]] || reply=$def
    case $reply in
      y | yes) return 0 ;;
      n | no) return 1 ;;
      *) info "Please answer y or n." ;;
    esac
  done
}

# ask_new_password VAR "Question"  (empty answer = let the installer generate one)
ask_new_password() {
  local __var=$1 __prompt=$2 __first __second
  while true; do
    # IFS= keeps leading/trailing spaces: the password must be stored exactly as typed.
    IFS= read -r -s -p "    $__prompt: " __first || die "Input closed."
    printf '\n'
    if [[ -z $__first ]]; then
      printf -v "$__var" '%s' ''
      return 0
    fi
    if ((${#__first} < 8)); then
      info "Use at least 8 characters."
      continue
    fi
    IFS= read -r -s -p "    Repeat the password: " __second || die "Input closed."
    printf '\n'
    if [[ $__first == "$__second" ]]; then
      printf -v "$__var" '%s' "$__first"
      return 0
    fi
    info "The passwords do not match - try again."
  done
}

# read_password_file VAR FILE -> first line of FILE, exactly as written (a trailing CR is dropped)
read_password_file() {
  local __var=$1 __file=$2 __line=''
  [[ -r $__file ]] || die "Cannot read the admin password file $__file."
  IFS= read -r __line <"$__file" || [[ -n $__line ]] || die "The admin password file $__file is empty."
  printf -v "$__var" '%s' "${__line%$'\r'}"
}

# read_token_file VAR FILE -> the Cloudflare Tunnel token in FILE (see tunnel_token_from)
read_token_file() {
  local __var=$1 __file=$2 __text=''
  [[ -r $__file ]] || die "Cannot read the tunnel token file $__file."
  IFS= read -r -d '' __text <"$__file" || true
  [[ -n ${__text//[[:space:]]/} ]] || die "The tunnel token file $__file is empty."
  printf -v "$__var" '%s' "$(tunnel_token_canonical "$(tunnel_token_from "$__text")")"
}

# saved_tunnel_token -> the token install.sh saved earlier (empty if none)
saved_tunnel_token() {
  local line=''
  [[ -r $TUNNEL_TOKEN_FILE ]] || return 0
  IFS= read -r line <"$TUNNEL_TOKEN_FILE" || true
  printf '%s' "$(tunnel_token_canonical "$(tunnel_token_from "$line")")"
}

# tunnel_token_from TEXT -> the token in TEXT. The dashboard shows it inside a command
# ("cloudflared service install eyJ..."), and people often copy the whole command.
# Builtins only: the token never appears in a process's arguments.
tunnel_token_from() {
  local text=${1//[$'\r\n\t']/ }
  if [[ $text =~ (^|[[:space:]])(eyJ[A-Za-z0-9+/_=-]+)([[:space:]]|$) ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
  else
    text=${text#"${text%%[![:space:]]*}"}
    printf '%s' "${text%"${text##*[![:space:]]}"}"
  fi
}

# tunnel_token_canonical TOKEN -> TOKEN as cloudflared reads it: standard base64 with
# padding. A copy that lost its trailing "=" or uses the URL-safe alphabet still works.
tunnel_token_canonical() {
  local t=$1
  [[ $t =~ ^[A-Za-z0-9+/_-]+=*$ ]] || { printf '%s' "$t"; return 0; }
  t=${t%%=*}
  t=${t//-/+}
  t=${t//_//}
  while ((${#t} % 4)); do t+='='; done
  printf '%s' "$t"
}

# tunnel_id_of TOKEN -> the tunnel's UUID; status 1 when TOKEN (canonical form) is not a
# tunnel token (base64 of {"a":"<account tag>","t":"<tunnel UUID>","s":"<secret>"}).
tunnel_id_of() {
  local t=$1 json uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
  [[ $t =~ ^[A-Za-z0-9+/]+={0,2}$ ]] && ((${#t} % 4 == 0)) || return 1
  json=$(printf '%s' "$t" | base64 -d 2>/dev/null) || return 1
  [[ $json =~ \"a\"[[:space:]]*:[[:space:]]*\"[^\"]+\" && $json =~ \"s\"[[:space:]]*:[[:space:]]*\"[^\"]+\" ]] || return 1
  [[ $json =~ \"t\"[[:space:]]*:[[:space:]]*\"($uuid)\" ]] || return 1
  printf '%s' "${BASH_REMATCH[1],,}"
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
valid_domain() {
  local re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
  [[ ${#1} -le 253 && $1 =~ $re && $1 != *.example.com && $1 != example.com ]]
}
valid_email() {
  local re='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
  [[ $1 =~ $re ]]
}
valid_apple_id() { [[ $1 =~ ^[A-Z0-9]{10}$ ]]; }
valid_bundle_id() {
  local re='^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
  [[ $1 =~ $re ]]
}
valid_username() { [[ $1 =~ ^[a-z0-9._-]{3,32}$ ]]; }
valid_port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
valid_cidr() {
  local ip=${1%/*} prefix='' octet
  [[ $1 == */* ]] && prefix=${1#*/}
  if [[ $ip == *:* ]]; then
    [[ $ip =~ ^[0-9a-fA-F:.]+$ ]] || return 1
    [[ -z $prefix ]] || { [[ $prefix =~ ^[0-9]{1,3}$ ]] && ((10#$prefix <= 128)); }
  else
    [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    for octet in "${BASH_REMATCH[@]:1}"; do ((10#$octet <= 255)) || return 1; done
    [[ -z $prefix ]] || { [[ $prefix =~ ^[0-9]{1,2}$ ]] && ((10#$prefix <= 32)); }
  fi
}
# valid_timezone ZONE -> status 0 for an IANA name (America/Chicago) that this server's
# time zone database knows: timedatectl's list, else a TZif file in /usr/share/zoneinfo.
# Without either (no tzdata) only the form is checked; write_config checks the name
# again with Node, the way the server does at startup.
valid_timezone() {
  local zone=$1 re='^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' zones magic
  [[ ${#zone} -le 64 && $zone =~ $re ]] || return 1
  case $zone in posixrules | localtime | Factory | posix/* | right/*) return 1 ;; esac
  zones=$(timedatectl list-timezones 2>/dev/null || true)
  if [[ -n $zones ]] && grep -Fxq -- "$zone" <<<"$zones"; then return 0; fi
  if [[ -f $ZONEINFO_DIR/$zone ]]; then
    magic=$(head -c 4 -- "$ZONEINFO_DIR/$zone" 2>/dev/null || true)
    [[ $magic == TZif ]]
    return
  fi
  [[ -z $zones && ! -d $ZONEINFO_DIR ]]
}
# Values end up inside double quotes in a file read by both systemd and Node.
safe_env_value() { [[ $1 != *[\"\\\$\`]* && $1 != *$'\n'* ]]; }

# normalize_envs "Production, sandbox" -> "production,sandbox" (empty output = invalid)
normalize_envs() {
  local item out=() seen=' '
  local -a items
  IFS=',' read -r -a items <<<"${1,,}"
  for item in "${items[@]}"; do
    item=${item//[[:space:]]/}
    [[ -z $item ]] && continue
    [[ $item == production || $item == sandbox ]] || return 0
    [[ $seen == *" $item "* ]] && continue
    seen+="$item "
    out+=("$item")
  done
  ((${#out[@]})) || return 0
  local IFS=,
  printf '%s' "${out[*]}"
}

# normalize_ssh_from "1.2.3.0/24, 2001:db8::/32" -> "1.2.3.0/24,2001:db8::/32"; "any" -> ""
# Returns 1 when an entry is not an address/CIDR.
normalize_ssh_from() {
  local raw=${1//[[:space:]]/} item out=()
  local -a items
  case ${raw,,} in '' | any | anywhere | all | 0.0.0.0/0) return 0 ;; esac
  IFS=',' read -r -a items <<<"$raw"
  for item in "${items[@]}"; do
    [[ -z $item ]] && continue
    valid_cidr "$item" || return 1
    out+=("$item")
  done
  local IFS=,
  printf '%s' "${out[*]}"
}

# ---------------------------------------------------------------------------
# Files: env file, installer state, generic writers
# ---------------------------------------------------------------------------
# kv_get FILE KEY -> value of the last uncommented KEY= line, surrounding quotes removed
kv_get() {
  local file=$1 key=$2 line value=''
  [[ -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    if [[ $line == "$key="* ]]; then value=${line#*=}; fi
  done <"$file"
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  if [[ ${#value} -ge 2 && ($value == \"*\" || $value == \'*\') ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}
env_get() { kv_get "$ENV_FILE" "$1"; }
state_get() { kv_get "$STATE_FILE" "$1"; }

# kv_set FILE KEY LINE MODE OWNER -> replaces the first KEY= line (also a commented-out
# "#KEY=" placeholder), drops later duplicates, appends LINE when the key is absent.
kv_set() {
  local file=$1 key=$2 line=$3 mode=$4 owner=$5 tmp
  tmp=$(mktemp "$(dirname -- "$file")/.$(basename -- "$file").XXXXXX")
  TMP_FILES+=("$tmp")
  if [[ -f $file ]]; then
    awk -v key="$key" -v line="$line" '
      BEGIN { done = 0 }
      {
        probe = $0
        sub(/^[ \t]*#?[ \t]*/, "", probe)
        if (index(probe, key "=") == 1) {
          if (!done) { print line; done = 1 }
          next
        }
        print
      }
      END { if (!done) print line }
    ' "$file" >"$tmp"
  else
    printf '%s\n' "$line" >"$tmp"
  fi
  chmod "$mode" -- "$tmp"
  chown "$owner" -- "$tmp"
  mv -f -- "$tmp" "$file"
}
env_set() {
  safe_env_value "$2" || die "Refusing to write $1: the value contains a quote, backslash, \$ or backtick."
  kv_set "$ENV_FILE" "$1" "$1=\"$2\"" 0640 "root:$SERVICE_USER"
}
state_set() { kv_set "$STATE_FILE" "$1" "$1=$2" 0600 root:root; }
state_set_once() { [[ -n $(state_get "$1") ]] || state_set "$1" "$2"; }

FILE_CHANGED=0
# write_file PATH MODE OWNER:GROUP < content   (atomic; sets FILE_CHANGED)
write_file() {
  local path=$1 mode=$2 owner=$3 tmp
  tmp=$(mktemp "$(dirname -- "$path")/.$(basename -- "$path").XXXXXX")
  TMP_FILES+=("$tmp")
  cat >"$tmp"
  if [[ -f $path ]] && cmp -s -- "$tmp" "$path"; then
    rm -f -- "$tmp"
    chmod "$mode" -- "$path"
    chown "$owner" -- "$path"
    FILE_CHANGED=0
    return 0
  fi
  chmod "$mode" -- "$tmp"
  chown "$owner" -- "$tmp"
  mv -f -- "$tmp" "$path"
  FILE_CHANGED=1
}

backup_file() { # backup_file PATH -> prints the backup path
  local backup
  backup="$1.mchs-live-backup-$(date +%Y%m%d-%H%M%S)"
  cp -p -- "$1" "$backup"
  printf '%s' "$backup"
}

# ---------------------------------------------------------------------------
# System helpers
# ---------------------------------------------------------------------------
os_release_get() {
  sed -n -E "/^$1=/{s/^$1=\"?([^\"]*)\"?\$/\\1/p;q}" /etc/os-release
}

pkg_installed() { [[ $(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null || true) == installed ]]; }

apt_busy() { pgrep -x 'apt|apt-get|dpkg|unattended-upgr|aptitude' >/dev/null 2>&1; }

# apt_get ARGS... - waits for other package operations (cloud-init and
# unattended-upgrades are often busy on a freshly booted VM) instead of failing.
apt_get() {
  local attempt status
  for attempt in $(seq 1 60); do
    status=0
    apt-get -q -y -o DPkg::Lock::Timeout=120 \
      -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@" || status=$?
    ((status == 0)) && return 0
    if apt_busy && ((attempt < 60)); then
      info "Another package operation is running; waiting 10 s (attempt $attempt)..."
      sleep 10
      continue
    fi
    return "$status"
  done
}
apt_install() { apt_get install --no-install-recommends "$@"; }

wait_for_cloud_init() {
  command -v cloud-init >/dev/null 2>&1 || return 0
  local status
  status=$(cloud-init status 2>/dev/null || true)
  [[ $status == *running* ]] || return 0
  info "cloud-init is still configuring this VM; waiting for it to finish (max. 10 min)..."
  timeout 600 cloud-init status --wait >/dev/null 2>&1 ||
    warn "cloud-init reported a problem or did not finish within 10 minutes ('cloud-init status --long' shows why); continuing."
}

node_version() { [[ -x $NODE_BIN ]] && "$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true; }
node_major() { local v; v=$(node_version); printf '%s' "${v%%.*}"; }

# run_as_service_user CMD... (clean environment; never leaves root-owned files in the data dir)
run_as_service_user() {
  runuser -u "$SERVICE_USER" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME_DIR" LANG=C.UTF-8 "$@"
}

db_query() { # db_query SQL -> prints the result; status 1 if the database cannot be read
  local db=$DATA_DIR/live.db
  [[ -f $db ]] && command -v sqlite3 >/dev/null 2>&1 && id -u "$SERVICE_USER" >/dev/null 2>&1 || return 1
  run_as_service_user sqlite3 -batch -noheader -cmd '.timeout 5000' "$db" "$1" 2>/dev/null
}

generate_password() { head -c 15 /dev/urandom | base64 | tr '+/' '-_'; }

# "~/AuthKey.p8" typed at the prompt means the home of the user who ran sudo.
expand_tilde() {
  local p=$1 home=''
  if [[ $p == \~ || $p == \~/* ]]; then
    home=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6 || true)
    p=${home:-$HOME}${p:1}
  fi
  printf '%s' "$p"
}

check_p8_file() {
  if [[ ! -f $1 || ! -r $1 ]]; then
    problem "APNs key file not found or not readable: $1"
    return 1
  fi
  if ! grep -q -- '-----BEGIN PRIVATE KEY-----' "$1"; then
    problem "$1 does not look like an APNs auth key (.p8 file with a BEGIN PRIVATE KEY block)."
    return 1
  fi
}

json_get() { # json_get JSON dotted.path
  "$NODE_BIN" -e '
    let v; try { v = JSON.parse(process.argv[1]); } catch { process.exit(0); }
    for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
    if (v !== undefined && v !== null) process.stdout.write(Array.isArray(v) ? v.join(",") : String(v));
  ' "$1" "$2" 2>/dev/null || true
}

health_url() {
  local host=$APP_HOST
  case $host in
    '' | 0.0.0.0 | :: | localhost) host=127.0.0.1 ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s' "$host" "$APP_PORT"
}

HEALTH_JSON=''
wait_for_health() {
  local url i
  url="$(health_url)/api/health"
  for ((i = 0; i < 60; i++)); do
    if HEALTH_JSON=$(curl -fsS --max-time 2 "$url" 2>/dev/null); then return 0; fi
    [[ $(systemctl is-active "$SERVICE" 2>/dev/null || true) == failed ]] && return 1
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# Step 1 - preflight
# ---------------------------------------------------------------------------
OS_ID='' OS_VERSION='' OS_PRETTY='' ARCH=''
APP_HOST=127.0.0.1 APP_PORT=8080 DATA_DIR=$HOME_DIR
FRESH_INSTALL=1

preflight() {
  step "Checking this server"
  ((EUID == 0)) || die "Run the installer as root:  sudo $0"

  [[ -r /etc/os-release ]] || die "Cannot read /etc/os-release - unsupported operating system."
  OS_ID=$(os_release_get ID)
  OS_VERSION=$(os_release_get VERSION_ID)
  OS_PRETTY=$(os_release_get PRETTY_NAME)
  case "$OS_ID:$OS_VERSION" in
    ubuntu:24.04 | ubuntu:26.04 | debian:12 | debian:13) ok "Operating system: $OS_PRETTY" ;;
    *)
      if ((SKIP_OS_CHECK)); then
        warn "Untested operating system ($OS_PRETTY); continuing because of --skip-os-check."
      else
        die "Unsupported operating system: ${OS_PRETTY:-unknown}. Use Ubuntu 24.04/26.04 LTS or Debian 12/13 (or pass --skip-os-check at your own risk)."
      fi
      ;;
  esac
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
    die "apt/dpkg not found - this installer needs a Debian-family system."
  fi

  ARCH=$(dpkg --print-architecture)
  case $ARCH in
    amd64 | arm64) ok "Architecture: $ARCH" ;;
    *) die "Unsupported CPU architecture: $ARCH (use x86_64/amd64 or arm64)." ;;
  esac

  [[ -d /run/systemd/system ]] || die "systemd is not running (containers without systemd are not supported)."

  local f
  for f in package.json server/index.js server/cli.js public; do
    [[ -e $SRC_DIR/$f ]] || die "$SRC_DIR/$f is missing. Run the installer from inside a complete copy of the live-scores folder: cd live-scores && sudo ./deploy/install.sh"
  done
  for f in backup.sh restore.sh uninstall.sh mchs-live-cli.sh; do
    [[ -f $SCRIPT_DIR/$f ]] || die "$SCRIPT_DIR/$f is missing - clone or copy the whole live-scores folder."
    if grep -q $'\r' "$SCRIPT_DIR/$f"; then
      die "$SCRIPT_DIR/$f has Windows (CRLF) line endings. Convert the deploy/ scripts with: sed -i 's/\\r\$//' deploy/*.sh"
    fi
  done
  ok "Application source: $SRC_DIR"

  local mem_kb swap_kb disk_kb
  mem_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  swap_kb=$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)
  disk_kb=$(df -Pk / | awk 'NR == 2 { print $4 }')
  if ((mem_kb < 900000)); then
    warn "Only $((mem_kb / 1024)) MB RAM. The minimum is 1 GB (2 GB recommended)."
  elif ((mem_kb < 1900000 && swap_kb == 0)); then
    warn "$((mem_kb / 1024)) MB RAM and no swap - adding 1-2 GB of swap is recommended (see README)."
  fi
  if ((disk_kb < 1048576)); then
    die "Less than 1 GB free on / ($((disk_kb / 1024)) MB). Free some space or enlarge the disk."
  elif ((disk_kb < 3145728)); then
    warn "Only $((disk_kb / 1024)) MB free on /. 10 GB total disk is the minimum."
  fi
  ok "Resources: $(nproc) vCPU, $((mem_kb / 1024)) MB RAM, $((swap_kb / 1024)) MB swap, $((disk_kb / 1024)) MB free on /"

  if [[ -f $ENV_FILE ]]; then
    FRESH_INSTALL=0
    APP_HOST=$(env_get HOST)
    APP_PORT=$(env_get PORT)
    DATA_DIR=$(env_get DATA_DIR)
    APP_HOST=${APP_HOST:-127.0.0.1}
    APP_PORT=${APP_PORT:-8080}
    DATA_DIR=${DATA_DIR:-$HOME_DIR}
    DATA_DIR=${DATA_DIR%/}
    valid_port "$APP_PORT" || die "PORT in $ENV_FILE is not a valid port: $APP_PORT"
    [[ $DATA_DIR == /?* && $DATA_DIR != *[[:space:]\'\"]* ]] || die "DATA_DIR in $ENV_FILE must be an absolute path without spaces or quotes (got '$DATA_DIR')."
    case $DATA_DIR in
      /etc | /etc/* | /usr | /usr/* | /opt | /opt/mchs-live* | /var | /var/lib | /home | /root | /tmp | /bin | /sbin | /boot | /proc | /sys | /dev)
        die "DATA_DIR=$DATA_DIR in $ENV_FILE is not a suitable data directory - use $HOME_DIR." ;;
    esac
    case $APP_HOST in
      127.0.0.1 | ::1 | localhost) ;;
      *) warn "HOST=$APP_HOST in $ENV_FILE: Node listens beyond loopback. Set HOST=\"127.0.0.1\" - only Caddy should be reachable." ;;
    esac
    ok "Existing installation found - upgrading (configuration and data are kept)"
  else
    ok "No existing installation - fresh install"
  fi

  if command -v ss >/dev/null 2>&1; then
    local line
    if ! systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      line=$(ss -Hltnp "( sport = :$APP_PORT )" 2>/dev/null || true)
      [[ -z $line ]] || die "Port $APP_PORT is already in use by another program: $line"
    fi
    ok "Port $APP_PORT is available"
  fi
}

# Caddy only: it must own ports 80 and 443 (a Cloudflare Tunnel needs neither).
check_web_ports() {
  [[ $HTTPS_MODE == caddy ]] || return 0
  command -v ss >/dev/null 2>&1 || return 0
  local line conflicts=()
  while IFS= read -r line; do
    [[ -z $line || $line == *'"caddy"'* ]] && continue
    conflicts+=("$line")
  done < <(ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null || true)
  if ((${#conflicts[@]})); then
    printf '        %s\n' "${conflicts[@]}" >&2
    die "Ports 80/443 are already used by another program (shown above, e.g. apache2 or nginx). Caddy must own them: stop and disable that web server, then re-run."
  fi
}

# ---------------------------------------------------------------------------
# Configuration (prompts / options / existing values)
# ---------------------------------------------------------------------------
DOMAIN='' ACME_EMAIL='' SCHOOL_TZ=$DEFAULT_SCHOOL_TIMEZONE APNS_KEY_ID='' APNS_TEAM_ID='' BUNDLE_ID='' APNS_ENVS=''
HTTPS_MODE=caddy PREVIOUS_HTTPS_MODE='' TUNNEL_TOKEN='' TUNNEL_ID=''
KEY_SRC='' APNS_KEY_DEST='' SSH_FROM='' SSH_PORT='' NODE_MAJOR=$DEFAULT_NODE_MAJOR
ADMIN_NEEDED=1 ADMIN_USERNAME=admin ADMIN_DISPLAY_NAME=Administrator ADMIN_PASSWORD='' ADMIN_PASSWORD_GENERATED=0
EXIST_PUBLIC_URL='' EXIST_KEY_PATH='' EXIST_KEY_ID='' EXIST_TEAM_ID='' EXIST_BUNDLE_ID='' EXIST_ENVS=''
LIVE_GAMES=0
DNS_RESOLVES=1

domain_from_url() {
  local d=$1
  d=${d#*://}
  d=${d%%/*}
  d=${d%%:*}
  printf '%s' "${d,,}"
}

detect_ssh_port() {
  local port=''
  if command -v ss >/dev/null 2>&1; then
    port=$(ss -Hltnp 2>/dev/null | awk '/"sshd"/ { n = split($4, a, ":"); print a[n]; exit }' || true)
  fi
  if [[ -z $port ]]; then
    port=$(cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null |
      awk 'tolower($1) == "port" && $2 ~ /^[0-9]+$/ { print $2; exit }' || true)
  fi
  printf '%s' "${port:-22}"
}

collect_config() {
  section "Configuration"
  ((INTERACTIVE)) && info "Press Enter to accept the value in [brackets]."

  EXIST_PUBLIC_URL=$(env_get PUBLIC_URL)
  EXIST_KEY_PATH=$(env_get APNS_KEY_PATH)
  EXIST_KEY_ID=$(env_get APNS_KEY_ID)
  EXIST_TEAM_ID=$(env_get APNS_TEAM_ID)
  EXIST_BUNDLE_ID=$(env_get APNS_BUNDLE_ID)
  EXIST_ENVS=$(env_get APNS_ENVIRONMENTS)

  # --- Domain ---------------------------------------------------------------
  local exist_domain d
  exist_domain=$(domain_from_url "$EXIST_PUBLIC_URL")
  valid_domain "$exist_domain" || exist_domain=''
  if ((SET_DOMAIN)); then
    d=$(domain_from_url "$OPT_DOMAIN")
  elif ((INTERACTIVE)); then
    while true; do
      ask d "Public domain name of the portal (e.g. live.marquettecatholic.org)" "$exist_domain"
      d=$(domain_from_url "$d")
      d=${d%.}
      valid_domain "$d" && break
      info "Enter a real DNS name such as live.yourschool.org (no http://, no path)."
    done
  else
    d=$exist_domain
  fi
  d=${d%.}
  [[ -n $d ]] || die "A domain name is required: pass --domain live.yourschool.org"
  valid_domain "$d" || die "Not a valid public domain name: $d"
  DOMAIN=$d

  # --- How the internet reaches the server -----------------------------------
  local mode reply def
  PREVIOUS_HTTPS_MODE=$(state_get HTTPS_MODE)
  # Installations from before this choice existed always used Caddy.
  if [[ -z $PREVIOUS_HTTPS_MODE ]] && ((!FRESH_INSTALL)); then PREVIOUS_HTTPS_MODE=caddy; fi
  case $OPT_HTTPS_MODE in
    '' | caddy | cloudflare-tunnel) ;;
    *) die "MCHS_HTTPS_MODE must be caddy or cloudflare-tunnel (got '$OPT_HTTPS_MODE')." ;;
  esac
  if [[ -n $OPT_TUNNEL_TOKEN_FILE ]] || ((SET_TUNNEL_TOKEN)); then
    [[ $OPT_HTTPS_MODE != caddy ]] || die "--caddy cannot be combined with a Cloudflare Tunnel token."
    OPT_HTTPS_MODE=cloudflare-tunnel
  fi
  if [[ -n $OPT_HTTPS_MODE ]]; then
    mode=$OPT_HTTPS_MODE
  elif ((INTERACTIVE)); then
    info ""
    info "How will browsers and the iOS app reach this server?"
    info "  1  Directly: Caddy on this VM gets a free Let's Encrypt certificate."
    info "     Needs a public IP address with ports 80 and 443 open to the internet."
    info "  2  Through a Cloudflare Tunnel: Cloudflare provides HTTPS and this VM connects"
    info "     out to Cloudflare. No inbound ports; the domain must use Cloudflare DNS"
    info "     (README \"Cloudflare Tunnel\")."
    def=1
    [[ $PREVIOUS_HTTPS_MODE == cloudflare-tunnel ]] && def=2
    while true; do
      ask reply "Choose 1 or 2" "$def"
      case $reply in
        1) mode=caddy; break ;;
        2) mode=cloudflare-tunnel; break ;;
      esac
      info "Enter 1 or 2."
    done
  else
    mode=${PREVIOUS_HTTPS_MODE:-caddy}
  fi
  HTTPS_MODE=$mode

  # --- Cloudflare Tunnel token ----------------------------------------------
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    local exist_token token='' raw=''
    exist_token=$(saved_tunnel_token)
    if [[ -n $OPT_TUNNEL_TOKEN_FILE ]]; then
      read_token_file token "$OPT_TUNNEL_TOKEN_FILE"
      tunnel_id_of "$token" >/dev/null ||
        die "$OPT_TUNNEL_TOKEN_FILE does not hold a Cloudflare Tunnel token (the long text starting with eyJ - README \"Cloudflare Tunnel\")."
    elif ((SET_TUNNEL_TOKEN)); then
      token=$(tunnel_token_canonical "$(tunnel_token_from "$OPT_TUNNEL_TOKEN")")
      tunnel_id_of "$token" >/dev/null || die "MCHS_TUNNEL_TOKEN is not a Cloudflare Tunnel token (the long text starting with eyJ)."
    elif ((INTERACTIVE)); then
      info ""
      info "Paste the tunnel's token from the Cloudflare dashboard (README \"Cloudflare Tunnel\"):"
      info "the long text starting with eyJ after 'cloudflared service install' - pasting the"
      info "whole command works too. What you paste is not shown."
      while true; do
        IFS= read -r -s -p "    Tunnel token${exist_token:+ (Enter keeps the current one)}: " raw || die "Input closed."
        printf '\n'
        if [[ -z ${raw//[[:space:]]/} && -n $exist_token ]]; then
          token=$exist_token
          break
        fi
        token=$(tunnel_token_canonical "$(tunnel_token_from "$raw")")
        tunnel_id_of "$token" >/dev/null && break
        problem "That is not a tunnel token. Copy the long text that starts with eyJ."
      done
    else
      token=$exist_token
    fi
    [[ -n $token ]] || die "A Cloudflare Tunnel token is required: save it in a file and pass --tunnel-token-file FILE (README \"Cloudflare Tunnel\")."
    TUNNEL_ID=$(tunnel_id_of "$token") ||
      die "The tunnel token saved in $TUNNEL_TOKEN_FILE is not valid. Pass a new one with --tunnel-token-file FILE."
    TUNNEL_TOKEN=$token
  fi

  # --- ACME e-mail ----------------------------------------------------------
  local e
  if ((SET_EMAIL)); then
    e=$OPT_EMAIL
  elif ((INTERACTIVE)) && [[ $HTTPS_MODE == caddy ]]; then
    while true; do
      ask e "E-mail for Let's Encrypt certificate notices (optional; \"none\" = no e-mail)" "$(state_get ACME_EMAIL)"
      [[ ${e,,} == none ]] && e=''
      [[ -z $e ]] || valid_email "$e" && break
      info "That does not look like an e-mail address."
    done
  else
    e=$(state_get ACME_EMAIL)
  fi
  [[ ${e,,} == none ]] && e=''
  [[ -z $e ]] || valid_email "$e" || die "Not a valid e-mail address: $e"
  ACME_EMAIL=$e

  # --- School time zone -----------------------------------------------------
  local tz exist_tz
  exist_tz=$(env_get SCHOOL_TIMEZONE)
  if ((SET_SCHOOL_TIMEZONE)); then
    tz=$OPT_SCHOOL_TIMEZONE
  elif ((INTERACTIVE)); then
    while true; do
      ask tz "School time zone for game times (IANA name)" "${exist_tz:-$DEFAULT_SCHOOL_TIMEZONE}"
      valid_timezone "$tz" && break
      info "Enter a time zone name such as America/Chicago or America/New_York (all names: timedatectl list-timezones)."
    done
  else
    tz=${exist_tz:-$DEFAULT_SCHOOL_TIMEZONE}
  fi
  valid_timezone "$tz" || die "Not a time zone this server knows: '$tz'. Pass --school-timezone with a name such as America/Chicago (all names: timedatectl list-timezones)."
  SCHOOL_TZ=$tz

  # --- APNs -----------------------------------------------------------------
  local key_input='' prompt
  if ((SET_KEY_PATH)); then
    key_input=$(expand_tilde "$OPT_KEY_PATH")
    [[ -z $key_input ]] || check_p8_file "$key_input" || die "Fix --apns-key-path and re-run."
  elif ((INTERACTIVE)); then
    info ""
    info "Live Activities need an APNs auth key (.p8) from the Apple Developer account"
    info "(README: \"Apple Developer setup\"). Copy it to this server first, e.g. with scp."
    if [[ -n $EXIST_KEY_PATH ]]; then
      prompt="Path to a NEW .p8 key on this server (Enter keeps $EXIST_KEY_PATH)"
    else
      prompt="Path to the .p8 key on this server (Enter to skip for now)"
    fi
    while true; do
      ask key_input "$prompt" ''
      key_input=$(expand_tilde "$key_input")
      [[ -z $key_input ]] || check_p8_file "$key_input" && break
    done
  fi
  if [[ -n $key_input ]]; then
    key_input=$(readlink -f -- "$key_input")
    if [[ -z $EXIST_KEY_PATH || ! -e $EXIST_KEY_PATH || ! $key_input -ef $EXIST_KEY_PATH ]]; then
      KEY_SRC=$key_input
    fi
  fi

  local derived='' kid=''
  if [[ -n $KEY_SRC && $(basename -- "$KEY_SRC") =~ ^AuthKey_([A-Za-z0-9]{10})\.p8$ ]]; then
    derived=${BASH_REMATCH[1]^^}
  fi
  if ((SET_KEY_ID)); then
    kid=${OPT_KEY_ID^^}
  elif [[ -n $KEY_SRC ]] && ((INTERACTIVE)); then
    while true; do
      ask kid "APNs Key ID (10 characters, shown next to the key in the developer portal)" "$derived"
      kid=${kid^^}
      valid_apple_id "$kid" && break
      info "The Key ID is 10 letters/digits, e.g. ABCDE12345."
    done
  elif [[ -n $KEY_SRC ]]; then
    kid=$derived
    [[ -n $kid ]] || die "Pass --apns-key-id: it cannot be read from the file name $(basename -- "$KEY_SRC")."
  else
    kid=$EXIST_KEY_ID
  fi
  [[ -z $kid ]] || valid_apple_id "$kid" || die "Not a valid APNs Key ID (10 letters/digits): $kid"
  APNS_KEY_ID=$kid

  local tid
  if ((SET_TEAM_ID)); then
    tid=${OPT_TEAM_ID^^}
  elif [[ -n $KEY_SRC ]] && ((INTERACTIVE)); then
    while true; do
      ask tid "Apple Developer Team ID" "${EXIST_TEAM_ID:-$DEFAULT_TEAM_ID}"
      tid=${tid^^}
      valid_apple_id "$tid" && break
      info "The Team ID is 10 letters/digits."
    done
  else
    tid=${EXIST_TEAM_ID:-$DEFAULT_TEAM_ID}
  fi
  valid_apple_id "$tid" || die "Not a valid Apple Team ID (10 letters/digits): $tid"
  APNS_TEAM_ID=$tid

  if ((SET_BUNDLE_ID)); then BUNDLE_ID=$OPT_BUNDLE_ID; else BUNDLE_ID=${EXIST_BUNDLE_ID:-$DEFAULT_BUNDLE_ID}; fi
  valid_bundle_id "$BUNDLE_ID" || die "Not a valid bundle id: $BUNDLE_ID"

  local envs
  if ((SET_APNS_ENVS)); then
    envs=$(normalize_envs "$OPT_APNS_ENVS")
    [[ -n $envs ]] || die "--apns-environments must be production,sandbox or production or sandbox."
  elif [[ -n $KEY_SRC ]] && ((INTERACTIVE)); then
    while true; do
      ask envs "APNs environments to serve (production = App Store/TestFlight, sandbox = Xcode builds)" "${EXIST_ENVS:-$DEFAULT_APNS_ENVS}"
      envs=$(normalize_envs "$envs")
      [[ -n $envs ]] && break
      info "Enter production,sandbox or production or sandbox."
    done
  else
    envs=$(normalize_envs "${EXIST_ENVS:-$DEFAULT_APNS_ENVS}")
    envs=${envs:-$DEFAULT_APNS_ENVS}
  fi
  APNS_ENVS=$envs

  if [[ -n $KEY_SRC ]]; then
    [[ -n $APNS_KEY_ID ]] || die "An APNs Key ID is required together with the key file."
    APNS_KEY_DEST=$CONF_DIR/AuthKey_$APNS_KEY_ID.p8
  else
    APNS_KEY_DEST=$EXIST_KEY_PATH
  fi

  # --- Firewall / SSH -------------------------------------------------------
  if ((NO_FIREWALL)); then
    ((SET_SSH_FROM)) && [[ -n $OPT_SSH_FROM ]] && warn "--ssh-from is ignored together with --no-firewall."
  else
    local from exist_from
    exist_from=$(state_get SSH_FROM)
    if ((SET_SSH_FROM)); then
      from=$(normalize_ssh_from "$OPT_SSH_FROM") || die "--ssh-from: not a list of IP addresses/CIDRs: $OPT_SSH_FROM"
    elif ((INTERACTIVE)); then
      info ""
      info "The firewall can limit SSH to your admin network (recommended), e.g. 203.0.113.0/24."
      info "Several entries: comma-separated. \"any\" = from anywhere (rate-limited)."
      prompt="Allow SSH only from (Enter = anywhere)"
      [[ -z $exist_from ]] || prompt="Allow SSH only from"
      while true; do
        ask from "$prompt" "$exist_from"
        from=$(normalize_ssh_from "$from") && break
        problem "Enter addresses like 203.0.113.7 or 203.0.113.0/24, separated by commas."
      done
    else
      from=$(normalize_ssh_from "$exist_from") || from=''
    fi
    SSH_FROM=$from
    if [[ -n $OPT_SSH_PORT ]]; then
      valid_port "$OPT_SSH_PORT" || die "--ssh-port: not a valid port: $OPT_SSH_PORT"
      SSH_PORT=$OPT_SSH_PORT
    else
      SSH_PORT=$(detect_ssh_port)
    fi
  fi

  # --- Node.js line ---------------------------------------------------------
  if ((SET_NODE_MAJOR)); then
    [[ $OPT_NODE_MAJOR == 24 || $OPT_NODE_MAJOR == 26 ]] || die "--node-major must be 24 or 26."
    NODE_MAJOR=$OPT_NODE_MAJOR
  fi

  # --- First admin ----------------------------------------------------------
  local admins
  if admins=$(db_query "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0;") && [[ $admins =~ ^[0-9]+$ ]] && ((admins > 0)); then
    ADMIN_NEEDED=0
  fi
  LIVE_GAMES=$(db_query "SELECT COUNT(*) FROM games WHERE status = 'live';" || true)
  [[ $LIVE_GAMES =~ ^[0-9]+$ ]] || LIVE_GAMES=0
  [[ -n $OPT_ADMIN_DISPLAY_NAME ]] && ADMIN_DISPLAY_NAME=$OPT_ADMIN_DISPLAY_NAME
  if [[ -n $OPT_ADMIN_PASSWORD_FILE ]]; then
    read_password_file OPT_ADMIN_PASSWORD "$OPT_ADMIN_PASSWORD_FILE"
    SET_ADMIN_PASSWORD=1
  fi
  if ((ADMIN_NEEDED)); then
    local u
    if ((SET_ADMIN_USERNAME)); then
      u=${OPT_ADMIN_USERNAME,,}
    elif ((INTERACTIVE)); then
      info ""
      while true; do
        ask u "Username of the first portal admin" "admin"
        u=${u,,}
        valid_username "$u" && break
        info "3-32 characters: a-z, 0-9, dot, dash, underscore."
      done
    else
      u='admin'
    fi
    valid_username "$u" || die "Invalid admin username (3-32 of a-z 0-9 . _ -): $u"
    ADMIN_USERNAME=$u
    ((${#ADMIN_DISPLAY_NAME} <= 60)) || die "--admin-display-name must be at most 60 characters."
    if ((SET_ADMIN_PASSWORD)); then
      ((${#OPT_ADMIN_PASSWORD} >= 8)) || die "The admin password (--admin-password-file / MCHS_ADMIN_PASSWORD) must be at least 8 characters."
      ADMIN_PASSWORD=$OPT_ADMIN_PASSWORD
    elif ((INTERACTIVE)); then
      ask_new_password ADMIN_PASSWORD "Password for $ADMIN_USERNAME (min. 8 characters; Enter = generate one)"
    fi
  elif ((SET_ADMIN_PASSWORD)); then
    warn "An admin account already exists, so the given admin password was ignored. To change a password: sudo mchs-live-cli reset-password --username <name>"
  fi
}

show_plan() {
  section "Plan"
  if ((FRESH_INSTALL)); then
    info "Mode:            fresh install"
  else
    info "Mode:            upgrade - settings and data are kept, the database is backed up first"
  fi
  info "Portal URL:      https://$DOMAIN/"
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    info "HTTPS:           Cloudflare Tunnel $TUNNEL_ID (cloudflared on this VM, service ${TUNNEL_SERVICE%.service})"
    info "                 Its public hostname $DOMAIN must point at http://127.0.0.1:$APP_PORT (Cloudflare dashboard)"
    if [[ -f $CADDY_SITE_FILE ]]; then
      if caddy_keeps_other_sites; then
        info "                 Switching from Caddy: the portal's Caddy site is removed; Caddy and"
        info "                 ports 80/443 stay for your other sites"
      else
        info "                 Switching from Caddy: the portal's Caddy site is removed, Caddy is stopped"
        ((NO_FIREWALL)) || info "                 and the installer's firewall rules for ports 80/443 are deleted"
      fi
    fi
  else
    info "HTTPS:           Caddy with a Let's Encrypt certificate"
    info "ACME e-mail:     ${ACME_EMAIL:-(none)}"
    if [[ -e $SYSTEMD_DIR/$TUNNEL_SERVICE ]]; then
      info "                 Switching from the Cloudflare Tunnel: its connector service is removed"
      info "                 once Caddy is running"
    fi
  fi
  info "Time zone:       $SCHOOL_TZ"
  if [[ -n $KEY_SRC ]]; then
    info "APNs key:        $KEY_SRC -> $APNS_KEY_DEST (Key ID $APNS_KEY_ID)"
  elif [[ -n $APNS_KEY_DEST && -n $APNS_KEY_ID ]]; then
    info "APNs key:        $APNS_KEY_DEST (Key ID $APNS_KEY_ID, unchanged)"
  else
    info "APNs key:        not configured - the server runs, but sends no Live Activity pushes yet"
  fi
  info "APNs:            team $APNS_TEAM_ID, bundle $BUNDLE_ID, environments $APNS_ENVS"
  local nv
  nv=$(node_version)
  if [[ -z $nv ]]; then
    info "Node.js:         install Node.js $NODE_MAJOR (NodeSource)"
  elif ((${nv%%.*} < MIN_NODE_MAJOR || (SET_NODE_MAJOR && ${nv%%.*} < NODE_MAJOR))); then
    info "Node.js:         upgrade v$nv -> Node.js $NODE_MAJOR (NodeSource)"
  else
    info "Node.js:         keep v$nv"
  fi
  if ((NO_FIREWALL)); then
    info "Firewall:        not managed (--no-firewall)"
  elif [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    if tunnel_opens_web_ports; then
      info "Firewall (ufw):  SSH port $SSH_PORT from ${SSH_FROM:-anywhere (rate-limited)}; 80/tcp, 443/tcp, 443/udp for Caddy's other sites"
    elif caddy_keeps_other_sites; then
      info "Firewall (ufw):  SSH port $SSH_PORT from ${SSH_FROM:-anywhere (rate-limited)}; 80/443 as your own rules have them (Caddy's other sites)"
    else
      info "Firewall (ufw):  SSH port $SSH_PORT from ${SSH_FROM:-anywhere (rate-limited)}; nothing else (the tunnel connects outbound)"
    fi
  else
    info "Firewall (ufw):  SSH port $SSH_PORT from ${SSH_FROM:-anywhere (rate-limited)}; 80/tcp, 443/tcp, 443/udp from anywhere"
  fi
  if ((!ADMIN_NEEDED)); then
    info "Admin accounts:  already exist - unchanged"
  elif [[ -n $ADMIN_PASSWORD ]]; then
    info "First admin:     $ADMIN_USERNAME (with the password you entered)"
  else
    info "First admin:     $ADMIN_USERNAME (password generated and shown once at the end)"
  fi
  if ((LIVE_GAMES > 0)); then
    info "Live games now:  $LIVE_GAMES (the server restarts for a few seconds; viewers reconnect automatically)"
  fi

  local -a addrs=()
  local local_addrs a match=0
  read -r -a addrs <<<"$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)"
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    if ((${#addrs[@]} == 0)); then
      DNS_RESOLVES=0
      info "DNS:             $DOMAIN does not resolve yet - Cloudflare creates its record when you add"
      info "                 the public hostname to the tunnel (README \"Cloudflare Tunnel\")"
    else
      DNS_RESOLVES=1
      info "DNS:             $DOMAIN -> ${addrs[*]} (should be Cloudflare's addresses)"
    fi
  elif ((${#addrs[@]} == 0)); then
    DNS_RESOLVES=0
    warn "$DOMAIN does not resolve yet. Create its DNS A record (and AAAA for IPv6) pointing at this VM's public IP; HTTPS starts working once it does."
  else
    DNS_RESOLVES=1
    local_addrs=" $(ip -o addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); printf "%s ", a[1] }' || true) "
    for a in "${addrs[@]}"; do
      if [[ $local_addrs == *" $a "* ]]; then match=1; fi
    done
    if ((match)); then
      info "DNS:             $DOMAIN -> ${addrs[*]} (this server)"
    else
      info "DNS:             $DOMAIN -> ${addrs[*]}"
      info "                 (not an address on this VM's network interfaces - fine behind cloud NAT,"
      info "                 as long as it is this VM's public IP)"
    fi
  fi

  if ((INTERACTIVE)); then
    printf '\n'
    ask_yes_no "Proceed?" y || die "Cancelled - nothing was changed."
  fi
}

# ---------------------------------------------------------------------------
# Step 2 - base packages
# ---------------------------------------------------------------------------
install_base_packages() {
  step "Installing base packages"
  wait_for_cloud_init
  apt_get update
  # The Caddy and NodeSource repositories are pinned with signed-by keyrings, so
  # debian-keyring / debian-archive-keyring / apt-transport-https are not needed.
  local pkgs=(ca-certificates curl gnupg sqlite3 rsync iproute2 procps)
  ((NO_FIREWALL)) || pkgs+=(ufw)
  apt_install "${pkgs[@]}"
  ok "Installed: ${pkgs[*]}"

  local synced
  synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
  if [[ $synced == yes ]]; then
    ok "System clock is NTP-synchronized"
  else
    warn "The system clock is not NTP-synchronized yet. APNs rejects tokens from a wrong clock: allow outbound UDP 123 and check 'timedatectl status'."
  fi
}

# ---------------------------------------------------------------------------
# Step 3 - service account and directories
# ---------------------------------------------------------------------------
create_user_and_dirs() {
  step "Creating the service account and directories"
  if ! getent group "$SERVICE_USER" >/dev/null; then
    groupadd --system "$SERVICE_USER"
  fi
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SERVICE_USER" --home-dir "$HOME_DIR" --no-create-home \
      --shell /usr/sbin/nologin --comment "MCHS Live Scores" "$SERVICE_USER"
    ok "Created system user $SERVICE_USER"
  else
    ok "System user $SERVICE_USER exists"
  fi

  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$HOME_DIR"
  [[ $DATA_DIR == "$HOME_DIR" ]] || install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$BACKUP_DIR"
  install -d -m 0755 -o root -g root "$APP_DIR"
  # A database touched by root (e.g. a manual sqlite3 session) would lock the service out.
  find "$DATA_DIR" -maxdepth 1 -name 'live.db*' ! -user "$SERVICE_USER" -exec chown "$SERVICE_USER:$SERVICE_USER" {} +
  ok "$CONF_DIR (config), $DATA_DIR (data), $BACKUP_DIR (backups), $APP_DIR (code)"
}

# Recorded as soon as /etc/mchs-live exists: a re-run after a failure further on (or
# half-way through a switch) continues with this choice and this token.
save_https_choice() {
  state_set HTTPS_MODE "$HTTPS_MODE"
  [[ $HTTPS_MODE == cloudflare-tunnel ]] || return 0
  # Only the token: anyone who has it can run this tunnel. Root-only; systemd hands the
  # service a copy (LoadCredential). Replace it with: install.sh --tunnel-token-file FILE
  write_file "$TUNNEL_TOKEN_FILE" 0600 root:root < <(printf '%s\n' "$TUNNEL_TOKEN")
  if ((FILE_CHANGED)); then
    # The running connector still has the old token: restart it in step 11, even if
    # this run stops before then and the next one finds the file unchanged.
    state_set TUNNEL_RESTART_PENDING 1
    ok "Tunnel token saved in $TUNNEL_TOKEN_FILE (0600 root)"
  fi
}

# ---------------------------------------------------------------------------
# Step 4 - Node.js (NodeSource, pinned major)
# ---------------------------------------------------------------------------
install_node() {
  step "Installing Node.js"
  local current need=0
  current=$(node_major)
  # Remembered for "uninstall.sh --remove-packages" (first run only).
  if pkg_installed nodejs; then state_set_once NODE_PREINSTALLED 1; else state_set_once NODE_PREINSTALLED 0; fi

  if [[ -z $current ]]; then
    need=1
  elif ((current < MIN_NODE_MAJOR)); then
    info "Node.js v$(node_version) is too old (the server needs $MIN_NODE_MAJOR or newer)."
    need=1
  elif ((SET_NODE_MAJOR && current < NODE_MAJOR)); then
    need=1
  elif ((SET_NODE_MAJOR && current > NODE_MAJOR)); then
    warn "Node.js v$(node_version) is newer than the requested --node-major $NODE_MAJOR; keeping it."
  fi

  if ((need)); then
    # "uninstall.sh --remove-packages" removes the NodeSource repository only if this installer added it.
    if [[ -z $(state_get NODESOURCE_ADDED) ]]; then
      if compgen -G '/etc/apt/sources.list.d/nodesource.*' >/dev/null; then state_set NODESOURCE_ADDED 0; else state_set NODESOURCE_ADDED 1; fi
    fi
    info "Adding the NodeSource repository for Node.js $NODE_MAJOR.x"
    curl -fsSL --proto '=https' --tlsv1.2 "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$TMP_DIR/nodesource_setup.sh"
    # Run as root directly (never via "sudo -E": Ubuntu 26.04 uses sudo-rs).
    bash "$TMP_DIR/nodesource_setup.sh"
    apt_install nodejs
  elif pkg_installed nodejs; then
    # Pick up security/patch releases of the installed line.
    apt_get install --only-upgrade nodejs
  fi

  current=$(node_major)
  if [[ -z $current ]] || ((current < MIN_NODE_MAJOR)); then
    die "$NODE_BIN is missing or older than Node.js $MIN_NODE_MAJOR after installation. Check the output above."
  fi
  ok "Node.js v$(node_version) at $NODE_BIN"
}

# ---------------------------------------------------------------------------
# Step 5 - Caddy (official apt repository)
# ---------------------------------------------------------------------------
install_caddy() {
  step "Installing Caddy"
  if command -v caddy >/dev/null 2>&1 && ! pkg_installed caddy; then
    die "A caddy binary ($(command -v caddy)) exists that was not installed with apt. This installer manages Caddy through its official apt repository - remove that binary and its service first."
  fi
  if pkg_installed caddy; then state_set_once CADDY_PREINSTALLED 1; else state_set_once CADDY_PREINSTALLED 0; fi

  local changed=0 gnupg_home=$TMP_DIR/gnupg
  install -d -m 0700 "$gnupg_home"
  curl -fsSL --proto '=https' --tlsv1.2 "$CADDY_REPO_BASE/gpg.key" -o "$TMP_DIR/caddy.key"
  gpg --batch --yes --quiet --homedir "$gnupg_home" --dearmor -o "$TMP_DIR/caddy.gpg" "$TMP_DIR/caddy.key"
  write_file "$CADDY_KEYRING" 0644 root:root <"$TMP_DIR/caddy.gpg"
  ((FILE_CHANGED)) && changed=1
  curl -fsSL --proto '=https' --tlsv1.2 "$CADDY_REPO_BASE/debian.deb.txt" -o "$TMP_DIR/caddy.list"
  grep -q "$CADDY_KEYRING" "$TMP_DIR/caddy.list" || die "Unexpected content in Caddy's repository definition ($CADDY_REPO_BASE/debian.deb.txt)."
  write_file "$CADDY_APT_LIST" 0644 root:root <"$TMP_DIR/caddy.list"
  ((FILE_CHANGED)) && changed=1
  if ((changed)); then
    apt_get update
  fi
  apt_install caddy
  local version
  version=$(caddy version 2>/dev/null | awk '{ print $1 }' || true)
  [[ -n $version ]] || die "Caddy did not install correctly."
  ok "Caddy $version"
}

# ---------------------------------------------------------------------------
# Step 5 (Cloudflare Tunnel) - cloudflared (Cloudflare's apt repository)
# ---------------------------------------------------------------------------
CLOUDFLARED_UPGRADED=0
install_cloudflared() {
  step "Installing cloudflared (Cloudflare Tunnel)"
  if command -v cloudflared >/dev/null 2>&1 && ! pkg_installed cloudflared; then
    die "A cloudflared binary ($(command -v cloudflared)) exists that was not installed with apt. This installer manages cloudflared through Cloudflare's apt repository - remove that binary (and any service that runs it) first."
  fi
  if pkg_installed cloudflared; then state_set_once CLOUDFLARED_PREINSTALLED 1; else state_set_once CLOUDFLARED_PREINSTALLED 0; fi
  # A Caddy that is already here is not ours: uninstall --remove-packages must keep it.
  if pkg_installed caddy; then state_set_once CADDY_PREINSTALLED 1; fi
  local before
  before=$(dpkg-query -W -f='${Version}' cloudflared 2>/dev/null || true)

  # A Cloudflare repository set up earlier under another file name stays the only one:
  # two entries with different keyrings make apt refuse to update.
  local other changed=0
  other=$(grep -lsE '^[^#]*pkg\.cloudflare\.com/cloudflared' /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null |
    grep -vFx "$CLOUDFLARED_APT_LIST" | head -n 1 || true)
  if [[ -n $other ]]; then
    info "Using the Cloudflare apt repository already set up in $other"
  else
    curl -fsSL --proto '=https' --tlsv1.2 "$CLOUDFLARED_REPO_BASE/$(basename -- "$CLOUDFLARED_KEYRING")" -o "$TMP_DIR/cloudflare.key"
    if grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$TMP_DIR/cloudflare.key"; then
      local gnupg_home=$TMP_DIR/gnupg
      install -d -m 0700 "$gnupg_home"
      gpg --batch --yes --quiet --homedir "$gnupg_home" --dearmor -o "$TMP_DIR/cloudflare.gpg" "$TMP_DIR/cloudflare.key"
    else
      cp -- "$TMP_DIR/cloudflare.key" "$TMP_DIR/cloudflare.gpg"
    fi
    write_file "$CLOUDFLARED_KEYRING" 0644 root:root <"$TMP_DIR/cloudflare.gpg"
    ((FILE_CHANGED)) && changed=1
    write_file "$CLOUDFLARED_APT_LIST" 0644 root:root < <(
      printf 'deb [signed-by=%s] %s/cloudflared any main\n' "$CLOUDFLARED_KEYRING" "$CLOUDFLARED_REPO_BASE"
    )
    ((FILE_CHANGED)) && changed=1
    state_set_once CLOUDFLARED_REPO_ADDED 1
  fi
  if ((changed)); then
    apt_get update
  fi
  apt_install cloudflared
  [[ -x $CLOUDFLARED_BIN ]] || die "cloudflared did not install correctly ($CLOUDFLARED_BIN is missing)."
  if [[ $(dpkg-query -W -f='${Version}' cloudflared 2>/dev/null || true) != "$before" ]]; then
    CLOUDFLARED_UPGRADED=1
    state_set TUNNEL_RESTART_PENDING 1
  fi
  local version
  version=$("$CLOUDFLARED_BIN" --version 2>/dev/null | awk '{ print $3; exit }' || true)
  ok "cloudflared ${version:-(version unknown)}"
}

# ---------------------------------------------------------------------------
# Step 6 - application files
# ---------------------------------------------------------------------------
install_app_files() {
  step "Installing the application"
  if [[ -f $DATA_DIR/live.db ]]; then
    info "Backing up the database before upgrading"
    bash "$SCRIPT_DIR/backup.sh" --data-dir "$DATA_DIR" --dest "$BACKUP_DIR" --keep-days "$BACKUP_KEEP_DAYS" --label pre-upgrade |
      sed 's/^/    /'
  fi
  # Only what the server needs at runtime; the code stays root-owned and read-only for the service.
  rsync -a --delete --delete-excluded --chown=root:root --chmod=D0755,F0644 \
    --exclude='.DS_Store' --exclude='._*' --exclude='node_modules/' \
    --include='/package.json' --include='/server/***' --include='/public/***' --exclude='*' \
    "$SRC_DIR/" "$APP_DIR/"
  local version
  version=$("$NODE_BIN" -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)
  ok "Version $version installed in $APP_DIR"
}

# ---------------------------------------------------------------------------
# Step 7 - configuration file and APNs key
# ---------------------------------------------------------------------------
readonly ENV_KEYS=(HOST PORT PUBLIC_URL DATA_DIR TRUST_PROXY SCHOOL_NAME HOME_TEAM_NAME HOME_TEAM_CODE
  HOME_TEAM_COLOR START_WINDOW_MINUTES AUTO_FINAL_HOURS SCHOOL_TIMEZONE APNS_TEAM_ID APNS_KEY_ID APNS_KEY_PATH
  APNS_BUNDLE_ID APNS_ENVIRONMENTS APNS_CHANNEL_STORAGE_POLICY APNS_MIN_UPDATE_INTERVAL_MS
  SSE_MAX_PER_IP SSE_MAX_CONNECTIONS RATE_LIMIT_PER_MINUTE DEVICE_RATE_LIMIT_PER_MINUTE LOG_LEVEL)

env_default() {
  case $1 in
    HOST) printf '127.0.0.1' ;;
    PORT) printf '8080' ;;
    PUBLIC_URL) printf 'https://%s' "$DOMAIN" ;;
    DATA_DIR) printf '%s' "$HOME_DIR" ;;
    TRUST_PROXY) printf '1' ;;
    SCHOOL_NAME) printf 'Marquette Catholic' ;;
    HOME_TEAM_NAME) printf 'Marquette' ;;
    HOME_TEAM_CODE) printf 'MAR' ;;
    HOME_TEAM_COLOR) printf '#12214D' ;;
    START_WINDOW_MINUTES) printf '120' ;;
    AUTO_FINAL_HOURS) printf '4' ;;
    SCHOOL_TIMEZONE) printf '%s' "$SCHOOL_TZ" ;;
    APNS_TEAM_ID) printf '%s' "$APNS_TEAM_ID" ;;
    APNS_KEY_ID) printf '%s' "$APNS_KEY_ID" ;;
    APNS_KEY_PATH) printf '%s' "$APNS_KEY_DEST" ;;
    APNS_BUNDLE_ID) printf '%s' "$BUNDLE_ID" ;;
    APNS_ENVIRONMENTS) printf '%s' "$APNS_ENVS" ;;
    APNS_CHANNEL_STORAGE_POLICY) printf '0' ;;
    APNS_MIN_UPDATE_INTERVAL_MS) printf '5000' ;;
    SSE_MAX_PER_IP) printf '2000' ;;
    SSE_MAX_CONNECTIONS) printf '20000' ;;
    RATE_LIMIT_PER_MINUTE) printf '3000' ;;
    DEVICE_RATE_LIMIT_PER_MINUTE) printf '600' ;;
    LOG_LEVEL) printf 'info' ;;
  esac
}

# A key without a value is written as a commented-out placeholder.
env_line() {
  local value
  value=$(env_default "$1")
  if [[ -z $value ]]; then printf '#%s=""' "$1"; else printf '%s="%s"' "$1" "$value"; fi
}

write_new_env_file() {
  local key
  for key in "${ENV_KEYS[@]}"; do
    safe_env_value "$(env_default "$key")" || die "Invalid characters in the value for $key."
  done
  write_file "$ENV_FILE" 0640 "root:$SERVICE_USER" <<EOF
# MCHS Live Scores - server configuration (keys: ARCHITECTURE.md section 3 in the live-scores repository).
# Read by systemd (EnvironmentFile=) and by the admin CLI (node --env-file).
# Keep values in double quotes ('#' would otherwise start a comment for Node).
# After editing:  sudo systemctl restart mchs-live
# Re-running install.sh only changes the keys you pass to it as options.

# Network - Node listens on loopback only; Caddy is the only public listener.
$(env_line HOST)
$(env_line PORT)
$(env_line PUBLIC_URL)
$(env_line TRUST_PROXY)

# Storage (live.db lives here; backed up daily to $BACKUP_DIR)
$(env_line DATA_DIR)

# School / defaults for new games
$(env_line SCHOOL_NAME)
$(env_line HOME_TEAM_NAME)
$(env_line HOME_TEAM_CODE)
$(env_line HOME_TEAM_COLOR)
$(env_line START_WINDOW_MINUTES)
$(env_line AUTO_FINAL_HOURS)
# The school's IANA time zone, sent to the portal and app for game times (/api/config)
$(env_line SCHOOL_TIMEZONE)

# Apple Push Notification service (Live Activities). Without APNS_KEY_ID and
# APNS_KEY_PATH the server runs normally but sends no pushes.
$(env_line APNS_TEAM_ID)
$(env_line APNS_KEY_ID)
$(env_line APNS_KEY_PATH)
$(env_line APNS_BUNDLE_ID)
$(env_line APNS_ENVIRONMENTS)
$(env_line APNS_CHANNEL_STORAGE_POLICY)
$(env_line APNS_MIN_UPDATE_INTERVAL_MS)

# Capacity: live streams (one open connection each) per IP and in total, then API
# requests and device registrations per IP per minute. The per-IP limits are high
# because at a big game hundreds of fans share the school Wi-Fi's one public IP
# (README "Capacity"). Re-run install.sh after raising SSE_MAX_CONNECTIONS.
$(env_line SSE_MAX_PER_IP)
$(env_line SSE_MAX_CONNECTIONS)
$(env_line RATE_LIMIT_PER_MINUTE)
$(env_line DEVICE_RATE_LIMIT_PER_MINUTE)

# Logging: debug | info | warn | error
$(env_line LOG_LEVEL)
EOF
}

update_env_file() {
  local key current desired changed=()
  # Settings this installer controls: changed only when the value differs
  # (options and prompts default to the current value).
  local -A desired_values=(
    [PUBLIC_URL]="https://$DOMAIN"
    [SCHOOL_TIMEZONE]=$SCHOOL_TZ
    [APNS_TEAM_ID]=$APNS_TEAM_ID
    [APNS_KEY_ID]=$APNS_KEY_ID
    [APNS_KEY_PATH]=$APNS_KEY_DEST
    [APNS_BUNDLE_ID]=$BUNDLE_ID
    [APNS_ENVIRONMENTS]=$APNS_ENVS
  )
  for key in PUBLIC_URL SCHOOL_TIMEZONE APNS_TEAM_ID APNS_KEY_ID APNS_KEY_PATH APNS_BUNDLE_ID APNS_ENVIRONMENTS; do
    desired=${desired_values[$key]}
    current=$(env_get "$key")
    [[ -n $desired && $desired != "$current" ]] || continue
    env_set "$key" "$desired"
    changed+=("$key")
  done
  # Keys added to the contract after this file was written get their defaults.
  for key in "${ENV_KEYS[@]}"; do
    grep -Eq "^[[:space:]]*#?[[:space:]]*$key=" "$ENV_FILE" && continue
    # A hand-edited file may lack the final newline; never glue a key onto its last line.
    [[ -z $(tail -c 1 -- "$ENV_FILE") ]] || printf '\n' >>"$ENV_FILE"
    printf '%s\n' "$(env_line "$key")" >>"$ENV_FILE"
    changed+=("$key (added)")
  done
  chown "root:$SERVICE_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  if ((${#changed[@]})); then ok "Updated $ENV_FILE: ${changed[*]}"; else ok "$ENV_FILE unchanged"; fi
}

install_apns_key() {
  [[ -n $KEY_SRC ]] || return 0
  local check
  check=$("$NODE_BIN" -e '
    const { createPrivateKey } = require("node:crypto");
    try {
      const key = createPrivateKey(require("node:fs").readFileSync(process.argv[1]));
      const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
      if (key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
        process.stdout.write("not a P-256 EC key (" + key.asymmetricKeyType + " " + (curve || "") + ")");
      }
    } catch (err) { process.stdout.write(err.message); }
  ' "$KEY_SRC" 2>&1 || true)
  [[ -z $check ]] || die "$KEY_SRC is not a usable APNs auth key: $check"
  if [[ -e $APNS_KEY_DEST && $KEY_SRC -ef $APNS_KEY_DEST ]]; then
    chown "root:$SERVICE_USER" "$APNS_KEY_DEST"
    chmod 0640 "$APNS_KEY_DEST"
  else
    install -m 0640 -o root -g "$SERVICE_USER" "$KEY_SRC" "$APNS_KEY_DEST"
  fi
  ok "APNs key installed as $APNS_KEY_DEST (0640 root:$SERVICE_USER)"
  [[ $KEY_SRC == "$CONF_DIR"/* ]] || info "You can now delete the copy at $KEY_SRC."
}

write_config() {
  step "Writing the configuration"
  # The server checks SCHOOL_TIMEZONE with Node's own time zone data at startup; check
  # it the same way now, before a running server is restarted with it.
  if ! "$NODE_BIN" -e 'new Intl.DateTimeFormat("en-US", { timeZone: process.argv[1] })' "$SCHOOL_TZ" >/dev/null 2>&1; then
    die "Node.js does not know the time zone '$SCHOOL_TZ'. Re-run with --school-timezone and a name such as America/Chicago."
  fi
  install_apns_key
  if [[ -f $ENV_FILE ]]; then
    update_env_file
  else
    write_new_env_file
    ok "Created $ENV_FILE"
  fi
  if [[ -n $APNS_KEY_DEST && ! -r $APNS_KEY_DEST ]]; then
    warn "APNS_KEY_PATH points to $APNS_KEY_DEST, which does not exist. Re-run with --apns-key-path."
  fi

  state_set_once INSTALLED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  state_set UPDATED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  state_set ACME_EMAIL "$ACME_EMAIL"
}

# ---------------------------------------------------------------------------
# Step 8 - systemd units and helper commands
# ---------------------------------------------------------------------------
install_units() {
  step "Installing the systemd service, daily backup and helper commands"
  local name
  for name in backup restore uninstall cli; do
    local src=$SCRIPT_DIR/$name.sh
    [[ $name == cli ]] && src=$SCRIPT_DIR/mchs-live-cli.sh
    install -m 0755 -o root -g root "$src" "$SBIN_DIR/mchs-live-$name"
  done
  ok "Commands: mchs-live-cli, mchs-live-backup, mchs-live-restore, mchs-live-uninstall (in $SBIN_DIR)"

  local rw_paths=$HOME_DIR
  [[ $DATA_DIR == "$HOME_DIR" ]] || rw_paths+=" $DATA_DIR"

  # Every live stream (SSE) holds a socket: keep the descriptor limit well above
  # SSE_MAX_CONNECTIONS (the server accepts up to 1000000), but within the kernel's
  # default fs.nr_open (1048576) - systemd cannot start the service above it.
  local nofile=65536 sse_max
  sse_max=$(env_get SSE_MAX_CONNECTIONS)
  if [[ $sse_max =~ ^[0-9]{1,7}$ ]] && ((10#$sse_max + 8192 > nofile)); then nofile=$((10#$sse_max + 8192)); fi
  ((nofile <= 1048576)) || nofile=1048576

  write_file "$SYSTEMD_DIR/$SERVICE" 0644 root:root <<EOF
# Managed by mchs-live install.sh - re-running the installer overwrites this file.
# Local changes belong in a drop-in:  sudo systemctl edit mchs-live
[Unit]
Description=MCHS Live Scores server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning server/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
SyslogIdentifier=mchs-live
UMask=0027
LimitNOFILE=$nofile

# Sandboxing. Never add MemoryDenyWriteExecute=yes - it breaks V8's JIT.
StateDirectory=mchs-live
StateDirectoryMode=0750
ReadWritePaths=$rw_paths
ReadOnlyPaths=$CONF_DIR
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
# AF_NETLINK lets glibc/libuv enumerate local addresses (getaddrinfo with
# AI_ADDRCONFIG, os.networkInterfaces()); it grants no network access.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF

  write_file "$SYSTEMD_DIR/$BACKUP_SERVICE" 0644 root:root <<EOF
# Managed by mchs-live install.sh - re-running the installer overwrites this file.
[Unit]
Description=MCHS Live Scores database backup
After=$SERVICE

[Service]
Type=oneshot
User=$SERVICE_USER
Group=$SERVICE_USER
UMask=0027
ExecStart=$SBIN_DIR/mchs-live-backup --data-dir $DATA_DIR --dest $BACKUP_DIR --keep-days $BACKUP_KEEP_DAYS
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=$rw_paths $BACKUP_DIR
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
CapabilityBoundingSet=
EOF

  write_file "$SYSTEMD_DIR/$BACKUP_TIMER" 0644 root:root <<EOF
# Managed by mchs-live install.sh - re-running the installer overwrites this file.
[Unit]
Description=Daily MCHS Live Scores database backup

[Timer]
OnCalendar=*-*-* 04:15:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --quiet "$SERVICE"
  systemctl enable --now --quiet "$BACKUP_TIMER"
  ok "$SERVICE enabled; $BACKUP_TIMER active (daily, keeps $BACKUP_KEEP_DAYS days in $BACKUP_DIR)"
}

# ---------------------------------------------------------------------------
# Step 9 - firewall (ufw)
# ---------------------------------------------------------------------------
FIREWALL_STATE=''   # ufw | skipped | firewalld
SSH_RULE_DESC=''

ufw_added_rules() { ufw show added 2>/dev/null | sed -n 's/^ufw //p' || true; }

# ufw lists "allow proto tcp from X to any port P" as "allow from X to any port P proto tcp".
ufw_normalize() {
  local re='^(allow|limit) proto (tcp|udp) from ([^ ]+) to any port ([0-9]+)$'
  if [[ $1 =~ $re ]]; then
    printf '%s from %s to any port %s proto %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$1"
  fi
}

# Prints "ours" (has our comment), "foreign" (added by someone else) or nothing.
ufw_rule_owner() {
  local norm line
  norm=$(ufw_normalize "$1")
  while IFS= read -r line; do
    [[ ${line% comment *} == "$norm" ]] || continue
    if [[ $line == *"comment '$UFW_COMMENT'"* ]]; then printf 'ours'; else printf 'foreign'; fi
    return 0
  done < <(ufw_added_rules)
}

ufw_recorded() { # ufw_recorded TAG -> specs recorded for TAG
  [[ -f $UFW_RULES_FILE ]] || return 0
  awk -F'|' -v tag="$1" '$1 == tag { print $2 }' "$UFW_RULES_FILE"
}
ufw_record() {
  touch "$UFW_RULES_FILE"
  chmod 0600 "$UFW_RULES_FILE"
  grep -Fxq -- "$1|$2" "$UFW_RULES_FILE" || printf '%s|%s\n' "$1" "$2" >>"$UFW_RULES_FILE"
}
ufw_forget() {
  [[ -f $UFW_RULES_FILE ]] || return 0
  local tmp
  tmp=$(mktemp "$CONF_DIR/.ufw-rules.XXXXXX")
  TMP_FILES+=("$tmp")
  grep -Fxv -- "$1|$2" "$UFW_RULES_FILE" >"$tmp" || true
  chmod 0600 "$tmp"
  mv -f -- "$tmp" "$UFW_RULES_FILE"
}

# ufw_ensure TAG SPEC -> adds the rule (with our comment) unless someone else already added it.
ufw_ensure() {
  local tag=$1 spec=$2 owner out
  local -a words
  owner=$(ufw_rule_owner "$spec")
  if [[ $owner == foreign ]]; then
    info "Rule already present (left as is): ufw $spec"
    return 0
  fi
  read -r -a words <<<"$spec"
  out=$(ufw "${words[@]}" comment "$UFW_COMMENT" 2>&1) || die "ufw $spec failed: $out"
  ufw_record "$tag" "$spec"
}

# Refuses an SSH restriction that would lock out the SSH session running this installer.
check_ssh_lockout() {
  [[ -n $SSH_FROM ]] || return 0
  local peer outside
  local -a peers=()
  while IFS= read -r peer; do
    [[ -z $peer ]] && continue
    peer=${peer%:*}
    peer=${peer#\[}
    peer=${peer%\]}
    peer=${peer#::ffff:}
    [[ $peer == 127.* || $peer == ::1 ]] && continue
    peers+=("$peer")
  done < <(ss -Htn state established "( sport = :$SSH_PORT )" 2>/dev/null | awk '{ print $4 }' || true)
  ((${#peers[@]})) || return 0
  outside=$("$NODE_BIN" -e '
    const net = require("node:net");
    const [cidrs, ...ips] = process.argv.slice(1);
    const list = new net.BlockList();
    for (const c of cidrs.split(",")) {
      const [addr, prefix] = c.split("/");
      const type = net.isIPv6(addr) ? "ipv6" : "ipv4";
      try {
        if (prefix === undefined) list.addAddress(addr, type); else list.addSubnet(addr, Number(prefix), type);
      } catch { /* ufw reports invalid entries itself */ }
    }
    const out = ips.filter((ip) => net.isIP(ip) && !list.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4"));
    process.stdout.write([...new Set(out)].join(" "));
  ' "$SSH_FROM" "${peers[@]}" 2>/dev/null || true)
  [[ -n $outside ]] || return 0
  warn "You are connected over SSH from $outside, which is outside --ssh-from $SSH_FROM. New SSH connections from there would be blocked."
  if ((INTERACTIVE)) && ask_yes_no "Restrict SSH anyway?" n; then
    return 0
  fi
  die "SSH restriction not applied. Include your current address in --ssh-from (or work from the VM console) and re-run."
}

configure_firewall() {
  step "Configuring the firewall"
  if [[ $HTTPS_MODE == cloudflare-tunnel ]] && caddy_keeps_other_sites; then CADDY_OTHER_SITES=1; fi
  if ((NO_FIREWALL)); then
    FIREWALL_STATE=skipped
    if ((CADDY_OTHER_SITES)); then
      info "Skipped (--no-firewall). The tunnel needs no inbound ports; your own firewall has to allow SSH, and 80/tcp, 443/tcp, 443/udp for Caddy's other sites on this VM."
    elif [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
      info "Skipped (--no-firewall). The tunnel needs no inbound ports: your own firewall only has to allow SSH."
    else
      info "Skipped (--no-firewall). Make sure your own firewall allows 80/tcp, 443/tcp, 443/udp and SSH."
    fi
    return 0
  fi
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    FIREWALL_STATE=firewalld
    if ((CADDY_OTHER_SITES)); then
      info "firewalld is active, so ufw was not configured. The tunnel needs no inbound ports; firewalld has to allow SSH, and 80/tcp, 443/tcp, 443/udp for Caddy's other sites."
    elif [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
      info "firewalld is active, so ufw was not configured. The tunnel needs no inbound ports - allow only SSH in firewalld."
    else
      warn "firewalld is active, so ufw was not configured. Open 80/tcp, 443/tcp and 443/udp in firewalld yourself."
    fi
    return 0
  fi
  command -v ufw >/dev/null 2>&1 || die "ufw is not installed (it should have been installed in step 2)."
  FIREWALL_STATE=ufw

  local status active=0
  status=$(ufw status 2>/dev/null || true)
  [[ $status == *"Status: active"* ]] && active=1

  check_ssh_lockout

  if ((!active)); then
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
  fi

  # SSH rules someone else added ("open" = from any source address).
  local -a desired=() foreign=() cidrs=() ours=()
  local cidr line spec want keep ssh_re=" ($SSH_PORT(/tcp)?|ssh(/tcp)?|OpenSSH) "
  while IFS= read -r line; do
    [[ -z $line || $line == *"comment '$UFW_COMMENT'"* ]] && continue
    [[ " $line " =~ $ssh_re || " $line " == *" port $SSH_PORT "* ]] || continue
    foreign+=("$line")
  done < <(ufw_added_rules)
  mapfile -t ours < <(ufw_recorded ssh)

  if [[ -n $SSH_FROM ]]; then
    IFS=',' read -r -a cidrs <<<"$SSH_FROM"
    for cidr in "${cidrs[@]}"; do desired+=("allow proto tcp from $cidr to any port $SSH_PORT"); done
    SSH_RULE_DESC="$SSH_PORT/tcp  SSH - only from $SSH_FROM"
    for line in "${foreign[@]}"; do
      [[ $line == *" from "* ]] && continue
      warn "An existing firewall rule still allows SSH from anywhere: 'ufw $line'. If SSH should only be reachable from $SSH_FROM, remove it: sudo ufw delete ${line% comment *}"
    done
  elif ((${#foreign[@]} && ${#ours[@]} == 0)); then
    # The admin already manages SSH access in ufw - respect it rather than opening SSH wider.
    SSH_RULE_DESC="$SSH_PORT/tcp  SSH - per your existing rule(s): ${foreign[*]}"
  else
    desired+=("limit $SSH_PORT/tcp")
    SSH_RULE_DESC="$SSH_PORT/tcp  SSH - from anywhere, rate-limited (use --ssh-from to restrict)"
  fi

  # Add the new SSH rules before removing old ones, so remote access is never cut.
  for spec in "${desired[@]}"; do ufw_ensure ssh "$spec"; done
  local -a words
  for spec in "${ours[@]}"; do
    [[ -z $spec ]] && continue
    keep=0
    for want in "${desired[@]}"; do
      if [[ $want == "$spec" ]]; then keep=1; fi
    done
    ((keep)) && continue
    read -r -a words <<<"$spec"
    ufw delete "${words[@]}" >/dev/null 2>&1 || true
    ufw_forget ssh "$spec"
    info "Removed the previous SSH rule: ufw $spec"
  done

  local web_closed=0
  if ((CADDY_OTHER_SITES)); then
    if ((!active)) || [[ -n $(ufw_recorded web) ]]; then
      # The tunnel doesn't need them, but Caddy's other sites (and their certificates) do.
      for spec in "allow 80/tcp" "allow 443/tcp" "allow 443/udp"; do ufw_ensure web "$spec"; done
      WEB_PORTS_KEPT=1
      info "Ports 80/443 stay open: Caddy still serves other sites on this VM"
    else
      info "Ports 80/443: left as your ufw rules have them (Caddy serves other sites on this VM)"
    fi
  elif [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    web_closed=1
    # The web ports this installer opened for Caddy earlier are no longer needed.
    local -a web_rules=()
    mapfile -t web_rules < <(ufw_recorded web)
    for spec in "${web_rules[@]}"; do
      [[ -z $spec ]] && continue
      read -r -a words <<<"$spec"
      ufw delete "${words[@]}" >/dev/null 2>&1 || true
      ufw_forget web "$spec"
      info "Removed the rule for Caddy: ufw $spec"
    done
  else
    for spec in "allow 80/tcp" "allow 443/tcp" "allow 443/udp"; do ufw_ensure web "$spec"; done
  fi

  if ((!active)); then
    ufw --force enable >/dev/null
    ok "ufw enabled (incoming traffic denied unless allowed below)"
  else
    ok "ufw was already active; rules added"
  fi
  ok "Inbound allowed: $SSH_RULE_DESC"
  if ((web_closed)); then
    ok "No web ports opened by this installer: the Cloudflare Tunnel connects outbound; port $APP_PORT stays internal"
  elif [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    ok "The Cloudflare Tunnel needs no inbound port; port $APP_PORT stays internal"
  else
    ok "Inbound allowed: 80/tcp, 443/tcp, 443/udp from anywhere; port $APP_PORT stays internal"
  fi
  state_set SSH_FROM "$SSH_FROM"
  state_set SSH_PORT "$SSH_PORT"
}

# ---------------------------------------------------------------------------
# Step 10 - start the server
# ---------------------------------------------------------------------------
SERVER_VERSION=''
start_server() {
  step "Starting the server"
  # A failure here shows up as "not healthy" below, together with the service log.
  systemctl restart "$SERVICE" || true
  if ! wait_for_health; then
    printf '\n' >&2
    journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
    die "The server did not become healthy at $(health_url)/api/health (log above). Fix the problem and re-run the installer."
  fi
  SERVER_VERSION=$(json_get "$HEALTH_JSON" version)
  ok "Server ${SERVER_VERSION:+$SERVER_VERSION }is running and healthy at $(health_url) (loopback only)"
}

# ---------------------------------------------------------------------------
# Step 11 - Caddy (HTTPS)
# ---------------------------------------------------------------------------
CADDY_NOTE=''

caddyfile_is_stock() {
  [[ -f $CADDYFILE ]] || return 1
  local expected actual normalized
  expected=$(dpkg-query -W -f='${Conffiles}\n' caddy 2>/dev/null | awk '$1 == "/etc/caddy/Caddyfile" { print $2 }' || true)
  actual=$(md5sum <"$CADDYFILE" | awk '{ print $1 }')
  [[ -n $expected && $actual == "$expected" ]] && return 0
  # Fallback: the package's welcome-page site, comments and blank lines ignored.
  normalized=$(sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$CADDYFILE" | grep -v '^$' | tr '\n' '|' || true)
  [[ $normalized == ':80 {|root * /usr/share/caddy|file_server|}|' ]]
}

render_global_options() {
  printf '{\n'
  [[ -n $ACME_EMAIL ]] && printf '\temail %s\n' "$ACME_EMAIL"
  # Lets a reload finish quickly although Server-Sent Events connections stay open.
  printf '\tgrace_period 10s\n'
  printf '}\n'
}

render_site() {
  local upstream_host=$APP_HOST
  case $upstream_host in '' | 0.0.0.0 | :: | localhost) upstream_host=127.0.0.1 ;; *:*) upstream_host="[$upstream_host]" ;; esac
  cat <<EOF
$MARK_MANAGED - regenerated on every run.
# Put your own additions in another file in $CADDY_CONF_D/ instead of editing this one.
#
# MCHS Live Scores: automatic HTTPS (Let's Encrypt) and HTTP->HTTPS redirect in front of the
# Node server, which listens on $upstream_host:$APP_PORT only. Server-Sent Events
# (text/event-stream) are flushed immediately by reverse_proxy - no extra settings needed.
$DOMAIN {
	# Compress everything except the live event stream, which must not be buffered.
	@compressible not path /api/stream
	encode @compressible zstd gzip

	request_body {
		max_size 1MB
	}

	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}

	reverse_proxy $upstream_host:$APP_PORT

	# Access log to stderr = the systemd journal (journalctl -u caddy).
	log {
		output stderr
		format json
	}
}
EOF
}

# caddyfile_site_import FILE -> prints the first "import" line outside our marked block
# that already loads $CADDY_SITE_FILE ("import conf.d/*", "import /etc/caddy/conf.d/*",
# ...). Like Caddy: a relative pattern is relative to the importing file's directory,
# and "*" / "?" never match "/" (Go's filepath.Match).
caddyfile_site_import() {
  local dir line pattern in_block=0 site_slashes path_slashes
  dir=$(dirname -- "$1")
  site_slashes=${CADDY_SITE_FILE//[!\/]/}
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$MARK_IMPORT_BEGIN" ]]; then in_block=1; elif [[ $line == "$MARK_IMPORT_END" ]]; then in_block=0; fi
    ((in_block == 0)) || continue
    [[ $line =~ ^[[:space:]]*import[[:space:]]+([^[:space:]#]+) ]] || continue
    pattern=${BASH_REMATCH[1]}
    pattern=${pattern#[\"\`]}
    pattern=${pattern%[\"\`]}
    while [[ $pattern == ./* ]]; do pattern=${pattern#./}; done
    [[ $pattern == /* ]] || pattern=$dir/$pattern
    path_slashes=${pattern//[!\/]/}
    # shellcheck disable=SC2053  # the right-hand side is the glob pattern
    if [[ ${#path_slashes} -eq ${#site_slashes} && $CADDY_SITE_FILE == $pattern ]]; then
      printf '%s' "${line#"${line%%[![:space:]]*}"}"
      return 0
    fi
  done <"$1"
}

# Rewrites a user-maintained Caddyfile: our marked global block (only when the file
# has no global options block of its own) and our marked import line (only when no
# import of its own already loads the site - a second one would define it twice).
patch_custom_caddyfile() {
  local tmp=$TMP_DIR/Caddyfile.new stripped=$TMP_DIR/Caddyfile.stripped first add_global=0 add_import=0 note='' own_import
  own_import=$(caddyfile_site_import "$CADDYFILE")
  awk -v b1="$MARK_GLOBAL_BEGIN" -v e1="$MARK_GLOBAL_END" -v b2="$MARK_IMPORT_BEGIN" -v e2="$MARK_IMPORT_END" -v drop="${own_import:+1}" '
    $0 == b1 || (drop && $0 == b2) { skip = 1; next }
    $0 == e1 || (drop && $0 == e2) { skip = 0; next }
    !skip { print }
  ' "$CADDYFILE" >"$stripped"
  if [[ -n $own_import ]]; then
    info "$CADDYFILE already loads the portal's site with '$own_import'; no import line added"
  elif ! grep -Fxq -- "$MARK_IMPORT_BEGIN" "$stripped"; then
    add_import=1
  fi
  first=$(awk '{ sub(/#.*/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); if (length($0)) { print; exit } }' "$stripped")
  if [[ $first == "{" ]]; then
    grep -Eq '^[[:space:]]*grace_period[[:space:]]' "$stripped" || note+="add 'grace_period 10s' "
    if [[ -n $ACME_EMAIL ]] && ! grep -Eq '^[[:space:]]*email[[:space:]]' "$stripped"; then
      note+="add 'email $ACME_EMAIL' "
    fi
  else
    add_global=1
  fi

  {
    if ((add_global)); then
      printf '%s\n' "$MARK_GLOBAL_BEGIN"
      render_global_options
      printf '%s\n' "$MARK_GLOBAL_END"
    fi
    cat "$stripped"
    if ((add_import)); then
      printf '\n%s\n%s\n%s\n' "$MARK_IMPORT_BEGIN" "$CADDY_IMPORT_LINE" "$MARK_IMPORT_END"
    fi
  } >"$tmp"

  if ! cmp -s "$tmp" "$CADDYFILE"; then
    local backup
    backup=$(backup_file "$CADDYFILE")
    info "Backed up $CADDYFILE to $backup"
    write_file "$CADDYFILE" 0644 root:root <"$tmp"
  fi
  state_set CADDYFILE_MODE appended
  ((add_global)) && state_set CADDY_GLOBAL_ADDED 1
  ((add_import)) && state_set CADDY_IMPORT_ADDED 1
  if [[ -n $note ]]; then
    CADDY_NOTE="Your $CADDYFILE already has a global options block, so it was left as is. Please ${note% } inside that block, then run: sudo systemctl reload caddy"
    warn "$CADDY_NOTE"
  fi
}

validate_caddy() {
  HOME=$TMP_DIR XDG_DATA_HOME=$TMP_DIR/xdg-data XDG_CONFIG_HOME=$TMP_DIR/xdg-config \
    caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1
}

configure_caddy() {
  step "Configuring Caddy (HTTPS)"
  install -d -m 0755 -o root -g root "$CADDY_CONF_D"
  local saved_site=$TMP_DIR/site.saved saved_main=$TMP_DIR/main.saved
  [[ -f $CADDY_SITE_FILE ]] && cp -p "$CADDY_SITE_FILE" "$saved_site"
  [[ -f $CADDYFILE ]] && cp -p "$CADDYFILE" "$saved_main"

  write_file "$CADDY_SITE_FILE" 0644 root:root < <(render_site)
  ok "Site $DOMAIN -> $CADDY_SITE_FILE"

  if [[ ! -f $CADDYFILE ]] || grep -Fq "$MARK_MANAGED" "$CADDYFILE" || caddyfile_is_stock; then
    if [[ -f $CADDYFILE ]] && ! grep -Fq "$MARK_MANAGED" "$CADDYFILE"; then
      local backup
      backup=$(backup_file "$CADDYFILE")
      state_set CADDYFILE_BACKUP "$backup"
      info "Replaced the package's default Caddyfile (welcome page on :80); saved as $backup"
    fi
    write_file "$CADDYFILE" 0644 root:root < <(
      printf '%s - re-running the installer regenerates this file.\n' "$MARK_MANAGED"
      printf '# Add more sites as separate *.caddy files in %s/ (imported below).\n' "$CADDY_CONF_D"
      render_global_options
      printf '\n%s\n' "$CADDY_IMPORT_LINE"
    )
    state_set CADDYFILE_MODE managed
    ok "$CADDYFILE imports $CADDY_CONF_D/*.caddy"
  else
    patch_custom_caddyfile
    ok "Kept your existing $CADDYFILE and its sites; it imports $CADDY_CONF_D/*.caddy"
  fi

  local out
  if ! out=$(validate_caddy); then
    if [[ -f $saved_site ]]; then cp -p "$saved_site" "$CADDY_SITE_FILE"; else rm -f "$CADDY_SITE_FILE"; fi
    if [[ -f $saved_main ]]; then cp -p "$saved_main" "$CADDYFILE"; fi
    printf '%s\n' "$out" | tail -n 15 | sed 's/^/        /' >&2
    if [[ $out == *"ambiguous site definition"* ]]; then
      die "Caddy found the site $DOMAIN twice: $CADDYFILE (or a file it imports) already defines it or loads $CADDY_SITE_FILE another way. Remove that duplicate and re-run; the previous configuration was restored."
    fi
    die "Caddy rejected the new configuration (output above); the previous configuration was restored."
  fi

  systemctl enable --quiet caddy
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || systemctl restart caddy
  else
    systemctl restart caddy
  fi
  ok "Caddy reloaded; it obtains and renews the certificate for $DOMAIN automatically"
  # Switching back from the tunnel: it keeps serving until Caddy has taken over.
  retire_tunnel
}

# Switching from the Cloudflare Tunnel back to Caddy: the connector goes.
retire_tunnel() {
  [[ -e $SYSTEMD_DIR/$TUNNEL_SERVICE || -e $TUNNEL_TOKEN_FILE ]] || return 0
  systemctl disable --now --quiet "$TUNNEL_SERVICE" >/dev/null 2>&1 || true
  rm -f -- "$SYSTEMD_DIR/$TUNNEL_SERVICE" "$TUNNEL_TOKEN_FILE"
  rm -rf -- "${SYSTEMD_DIR:?}/$TUNNEL_SERVICE.d"
  systemctl daemon-reload
  systemctl reset-failed "$TUNNEL_SERVICE" >/dev/null 2>&1 || true
  ok "Removed the Cloudflare Tunnel connector ($TUNNEL_SERVICE) and its token"
  warn "Cloudflare still sends $DOMAIN to the tunnel. In the Cloudflare dashboard, DNS -> Records: delete the CNAME for $DOMAIN that points to the tunnel (<id>.cfargotunnel.com) and add an A record with this VM's public IP - DNS only (grey cloud) - so Caddy can get its certificate. Then delete the tunnel (Networking -> Tunnels)."
}

# ---------------------------------------------------------------------------
# Step 11 (Cloudflare Tunnel) - the connector service
# ---------------------------------------------------------------------------

# Switching from Caddy to the tunnel: the portal's Caddy site goes; Caddy keeps any other sites.
retire_caddy_site() {
  [[ -f $CADDY_SITE_FILE ]] || return 0
  rm -f -- "$CADDY_SITE_FILE"
  ok "Removed the portal's Caddy site ($CADDY_SITE_FILE)"
  command -v caddy >/dev/null 2>&1 || return 0
  local out
  if ! caddy_keeps_other_sites; then
    systemctl disable --now --quiet caddy >/dev/null 2>&1 || true
    ok "Caddy served only the portal, so it was stopped and disabled (the package stays installed)"
  elif systemctl is-active --quiet caddy; then
    if out=$(validate_caddy); then
      systemctl reload caddy || systemctl restart caddy
      ok "Caddy reloaded - it keeps serving your other sites"
    else
      warn "Caddy's remaining configuration does not validate, so Caddy was not reloaded: $(printf '%s' "$out" | tail -n 1)"
    fi
  fi
}

# Tunnel mode with Caddy keeping other sites: the installer keeps (or, when it turns ufw on,
# adds) 80/443 for them. On an already active ufw without such rules of ours, the admin's
# own rules stay exactly as they are - they may be narrower than "from anywhere".
tunnel_opens_web_ports() {
  caddy_keeps_other_sites || return 1
  [[ -n $(ufw_recorded web) ]] && return 0
  command -v ufw >/dev/null 2>&1 || return 0
  [[ $(ufw status 2>/dev/null || true) != *"Status: active"* ]]
}

# True when Caddy serves sites besides the portal: other files its import loads (symlinks
# included), or a Caddyfile of your own. Then Caddy and ports 80/443 stay.
caddy_keeps_other_sites() {
  command -v caddy >/dev/null 2>&1 || return 1
  local f
  for f in "$CADDY_CONF_D"/*.caddy; do
    [[ -f $f && $f != "$CADDY_SITE_FILE" ]] && return 0
  done
  [[ -f $CADDYFILE ]] && ! grep -Fq "$MARK_MANAGED" "$CADDYFILE" && ! caddyfile_is_stock
}

TUNNEL_READY=0
TUNNEL_CONNECTIONS=''
WEB_PORTS_KEPT=0
CADDY_OTHER_SITES=0
TUNNEL_CHECK=''   # why verify_tunnel_https failed: not-connected | dns | unreachable | route
wait_for_tunnel() {
  local i out
  for ((i = 0; i < 45; i++)); do
    if out=$(curl -fsS --max-time 2 "http://$TUNNEL_METRICS/ready" 2>/dev/null); then
      TUNNEL_READY=1
      TUNNEL_CONNECTIONS=$(json_get "$out" readyConnections)
      return 0
    fi
    [[ $(systemctl is-active "$TUNNEL_SERVICE" 2>/dev/null || true) == failed ]] && return 1
    sleep 2
  done
  return 1
}

configure_tunnel() {
  step "Connecting the Cloudflare Tunnel"
  retire_caddy_site

  local restart=0 line
  if [[ $(state_get TUNNEL_RESTART_PENDING) == 1 ]]; then restart=1; fi

  write_file "$SYSTEMD_DIR/$TUNNEL_SERVICE" 0644 root:root <<EOF
# Managed by mchs-live install.sh - re-running the installer overwrites this file.
# Local changes belong in a drop-in:  sudo systemctl edit ${TUNNEL_SERVICE%.service}
#
# Connects this VM to Cloudflare (outbound only). The tunnel's route - the public
# hostname $DOMAIN -> http://127.0.0.1:$APP_PORT - is set in the Cloudflare dashboard.
[Unit]
Description=MCHS Live Scores - Cloudflare Tunnel connector
After=network-online.target $SERVICE
Wants=network-online.target

[Service]
# Type=simple, not notify: without UDP 7844 cloudflared needs about a minute to fall back
# to TCP, and a start timeout would kill it before it gets there.
Type=simple
# The token never appears on a command line or in the environment: systemd copies the
# root-only file into the service's private credentials directory (%d).
LoadCredential=tunnel-token:$TUNNEL_TOKEN_FILE
# On stop, Cloudflare stops sending requests here at once and cloudflared waits the grace
# period before closing: keep that outage short (live streams never finish on their own).
ExecStart=$CLOUDFLARED_BIN --no-autoupdate tunnel --metrics $TUNNEL_METRICS --grace-period 5s run --token-file %d/tunnel-token
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
SyslogIdentifier=${TUNNEL_SERVICE%.service}

# Sandboxing. cloudflared needs no files and no privileges. Another tunnel's
# configuration in the usual places must not leak into this one.
DynamicUser=yes
InaccessiblePaths=-/etc/cloudflared -/usr/local/etc/cloudflared -/root/.cloudflared
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF
  ((FILE_CHANGED)) && restart=1
  systemctl daemon-reload
  systemctl enable --quiet "$TUNNEL_SERVICE"

  if ((restart || CLOUDFLARED_UPGRADED)) || ! systemctl is-active --quiet "$TUNNEL_SERVICE"; then
    if command -v ss >/dev/null 2>&1 && ! systemctl is-active --quiet "$TUNNEL_SERVICE"; then
      line=$(ss -Hltnp "( sport = :${TUNNEL_METRICS##*:} )" 2>/dev/null || true)
      [[ -z $line ]] || die "Port ${TUNNEL_METRICS##*:} (the tunnel connector's local status port) is already in use: $line"
    fi
    # A failure shows up below as "did not connect", together with the service log.
    systemctl restart "$TUNNEL_SERVICE" || true
    state_set TUNNEL_RESTART_PENDING 0
  fi
  if systemctl is-enabled --quiet cloudflared.service 2>/dev/null || systemctl is-active --quiet cloudflared.service 2>/dev/null; then
    warn "cloudflared.service (set up with 'cloudflared service install') also runs a tunnel connector on this VM. If it is for this tunnel it is not needed - $TUNNEL_SERVICE replaces it: sudo cloudflared service uninstall"
  fi

  info "Waiting for the tunnel to connect to Cloudflare (up to 90 seconds)..."
  if wait_for_tunnel; then
    ok "Tunnel $TUNNEL_ID is connected to Cloudflare (${TUNNEL_CONNECTIONS:-?} connections)"
  else
    printf '\n' >&2
    journalctl -u "$TUNNEL_SERVICE" -n 25 --no-pager >&2 || true
    warn "The tunnel did not connect (log above). Check the token, and that this VM may connect out to Cloudflare on port 7844 (TCP and UDP) - README \"Cloudflare Tunnel\". It keeps retrying on its own: journalctl -u ${TUNNEL_SERVICE%.service} -f"
  fi
}

# ---------------------------------------------------------------------------
# Step 12 - first admin
# ---------------------------------------------------------------------------
ADMIN_RESULT=''   # created | existing | failed
create_admin() {
  step "Creating the first admin account"
  local admins out
  admins=$(db_query "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0;" || true)
  if [[ $admins =~ ^[0-9]+$ ]] && ((admins > 0)); then
    ADMIN_RESULT=existing
    ok "$admins admin account(s) already exist - accounts left unchanged"
    return 0
  fi
  if [[ -z $ADMIN_PASSWORD ]]; then
    ADMIN_PASSWORD=$(generate_password)
    ADMIN_PASSWORD_GENERATED=1
  fi
  # "--opt=value" form: node:util parseArgs rejects a separate value that starts
  # with "-", so never pass these as two arguments. The password goes in on stdin
  # (printf is a builtin): in argv every local user could read it in ps / /proc.
  if out=$(printf '%s\n' "$ADMIN_PASSWORD" | "$CLI" create-user "--username=$ADMIN_USERNAME" \
    "--display-name=$ADMIN_DISPLAY_NAME" --role=admin --password-stdin 2>&1); then
    ADMIN_RESULT=created
    ok "Admin account '$ADMIN_USERNAME' created"
  else
    ADMIN_RESULT=failed
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    if [[ $admins == 0 ]]; then
      die "Could not create the admin account (output above). Create it by hand: sudo mchs-live-cli create-user --username admin --display-name Administrator --role admin"
    fi
    warn "Could not create the admin account (output above). If none exists: sudo mchs-live-cli create-user --username admin --display-name Administrator --role admin"
  fi
}

# ---------------------------------------------------------------------------
# Step 13 - APNs check
# ---------------------------------------------------------------------------
APNS_CONFIGURED=no
APNS_CHECK_RESULT=''   # passed | failed | skipped | not-configured
check_apns() {
  step "Checking Apple Push Notifications"
  APNS_CONFIGURED=$(json_get "$HEALTH_JSON" apns.configured)
  if [[ $APNS_CONFIGURED != true ]]; then
    APNS_CHECK_RESULT=not-configured
    info "APNs is not configured yet - the portal and scoreboard work, Live Activities wait for the key."
    return 0
  fi
  if ((SKIP_APNS_CHECK)); then
    APNS_CHECK_RESULT=skipped
    info "Skipped (--skip-apns-check). Run it later: sudo mchs-live-cli apns-check"
    return 0
  fi
  info "Creating and deleting a test broadcast channel in: $(json_get "$HEALTH_JSON" apns.environments)"
  local out status=0
  out=$(timeout 90 "$CLI" apns-check </dev/null 2>&1) || status=$?
  printf '%s\n' "$out" | sed 's/^/        /'
  if ((status == 0)); then
    APNS_CHECK_RESULT=passed
    ok "APNs check passed - key, team, bundle id and broadcast capability are working"
  else
    APNS_CHECK_RESULT=failed
    warn "The APNs check failed (output above). See README 'Troubleshooting' (FeatureNotEnabled = Broadcast Capability not enabled; InvalidProviderToken = wrong Key/Team ID or clock; BadEnvironmentKeyIdInToken = key not valid for that environment). Re-run: sudo mchs-live-cli apns-check"
  fi
}

# ---------------------------------------------------------------------------
# Step 14 - HTTPS end to end
# ---------------------------------------------------------------------------
HTTPS_OK=0
verify_https() {
  step "Verifying HTTPS"
  local i tries=24
  if ((DNS_RESOLVES)); then
    info "Waiting for the certificate for $DOMAIN (up to 2 minutes on the first run)..."
  else
    tries=1
    info "$DOMAIN does not resolve yet, so no certificate can be issued; checking once."
  fi
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -o /dev/null --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null; then
      HTTPS_OK=1
      ok "https://$DOMAIN/ is serving with a valid certificate"
      return 0
    fi
    if ((i + 1 < tries)); then sleep 5; fi
  done
  warn "HTTPS is not working yet. Usually DNS for $DOMAIN does not point to this VM yet, or ports 80/443 are blocked by a cloud firewall. Caddy keeps retrying on its own; watch: journalctl -u caddy -f"
}

# Step 14 (Cloudflare Tunnel): the public address must reach this server, and the
# live stream must arrive unbuffered.
verify_tunnel_https() {
  step "Verifying HTTPS through Cloudflare"
  if ((!TUNNEL_READY)); then
    TUNNEL_CHECK=not-connected
    warn "Not checked: the tunnel is not connected yet (see above)."
    return 0
  fi
  local i remote local_json remote_up local_up out rc=0
  info "Requesting https://$DOMAIN/api/health through Cloudflare (up to 1 minute)..."
  for ((i = 0; i < 12; i++)); do
    rc=0
    remote=$(curl -fsS --max-time 8 "https://$DOMAIN/api/health" 2>/dev/null) || rc=$?
    if ((rc == 0)) && local_json=$(curl -fsS --max-time 2 "$(health_url)/api/health" 2>/dev/null); then
      # Same server: same version and (within a minute) the same uptime.
      remote_up=$(json_get "$remote" uptimeSec)
      local_up=$(json_get "$local_json" uptimeSec)
      if [[ $(json_get "$remote" version) == "$(json_get "$local_json" version)" && $remote_up =~ ^[0-9]+$ && $local_up =~ ^[0-9]+$ ]] &&
        ((local_up - remote_up < 60 && remote_up - local_up < 60)); then
        HTTPS_OK=1
        break
      fi
    fi
    if ((i + 1 < 12)); then sleep 5; fi
  done
  if ((!HTTPS_OK)); then
    case $rc in
      6) TUNNEL_CHECK=dns ;;
      7 | 28 | 35 | 60) TUNNEL_CHECK=unreachable ;;
      *) TUNNEL_CHECK=route ;;
    esac
    case $rc in
      6)
        warn "$DOMAIN does not resolve from this VM. Check that the tunnel has the public hostname $DOMAIN (service type HTTP, URL 127.0.0.1:$APP_PORT - README \"Cloudflare Tunnel\", step 1.3) and that Cloudflare shows the domain as Active. If both are done, DNS is still catching up: open https://$DOMAIN/ from another device in a few minutes." ;;
      7 | 28 | 35 | 60)
        # Could not connect at all (DNS, firewall, TLS interception): says nothing about the route.
        warn "This VM could not connect to https://$DOMAIN/ (curl exit $rc), so the route was not checked. Outbound HTTPS to Cloudflare may be blocked or intercepted here - open https://$DOMAIN/api/health from another network instead. If it fails there too: README \"Cloudflare Tunnel\", step 1.3." ;;
      *)
        warn "The tunnel is connected, but https://$DOMAIN/ does not reach this server yet. In the Cloudflare dashboard, give the tunnel the public hostname $DOMAIN with service type HTTP and URL 127.0.0.1:$APP_PORT (README \"Cloudflare Tunnel\", step 1.3), then open https://$DOMAIN/" ;;
    esac
    return 0
  fi
  ok "https://$DOMAIN/ reaches this server through Cloudflare"
  # Live scores use Server-Sent Events: the first event must arrive at once, not when the stream ends.
  out=$(curl -sSN --max-time 6 -H 'Accept: text/event-stream' "https://$DOMAIN/api/stream" 2>/dev/null || true)
  if [[ $out == *'event: hello'* ]]; then
    ok "The live score stream arrives unbuffered"
  else
    warn "The live score stream did not arrive through Cloudflare within 6 seconds - scoreboards may not update live. See README \"Cloudflare Tunnel\" -> Troubleshooting (\"The live stream check failed\")."
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
  local line
  printf '\n%s%s%s\n' "$C_BOLD" '======================================================================' "$C_RESET"
  printf '%s MCHS Live Scores is installed%s\n' "$C_BOLD" "$C_RESET"
  printf '%s%s%s\n' "$C_BOLD" '======================================================================' "$C_RESET"
  local https_note='(HTTPS not verified yet - see warnings)'
  ((HTTPS_OK)) && https_note='(HTTPS verified)'
  [[ $HTTPS_MODE == cloudflare-tunnel ]] && ((HTTPS_OK)) && https_note='(verified through the Cloudflare Tunnel)'
  printf '  Portal          https://%s/   %s\n' "$DOMAIN" "$https_note"
  case $ADMIN_RESULT in
    created)
      printf '  Admin login     username: %s\n' "$ADMIN_USERNAME"
      if ((ADMIN_PASSWORD_GENERATED)); then
        printf '                  password: %s%s%s\n' "$C_BOLD" "$ADMIN_PASSWORD" "$C_RESET"
        printf '                  %s(generated - store it in your password manager now; it is not shown again)%s\n' "$C_WARN" "$C_RESET"
      else
        printf '                  password: the one you entered\n'
      fi
      ;;
    existing) printf '  Admin login     existing admin accounts (unchanged)\n' ;;
    *) printf '  Admin login     NOT created - see the warning above\n' ;;
  esac
  case $APNS_CHECK_RESULT in
    passed) printf '  Live Activities APNs working (%s)\n' "$APNS_ENVS" ;;
    failed) printf '  Live Activities APNs configured but the check FAILED - see warnings\n' ;;
    skipped) printf '  Live Activities APNs configured (check skipped)\n' ;;
    *) printf '  Live Activities not active yet - no APNs key configured\n' ;;
  esac

  printf '\n  Inbound ports\n'
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    case $FIREWALL_STATE in
      ufw) printf '    ufw allows    %s\n' "$SSH_RULE_DESC" ;;
      *)
        if ((CADDY_OTHER_SITES)); then
          printf "    Not managed by this installer. Allow SSH from your admin network, and 80/tcp, 443/tcp, 443/udp for Caddy's other sites.\n"
        else
          printf '    Not managed by this installer. Allow only SSH from your admin network.\n'
        fi
        ;;
    esac
    if ((WEB_PORTS_KEPT)); then
      printf "                  80/tcp, 443/tcp, 443/udp - from anywhere, for Caddy's other sites on this VM\n"
      printf '    The portal itself needs no web port: the Cloudflare Tunnel (service %s)\n' "${TUNNEL_SERVICE%.service}"
    elif ((CADDY_OTHER_SITES)); then
      if [[ $FIREWALL_STATE == ufw ]]; then
        printf "                  80/443 as your own rules have them, for Caddy's other sites on this VM\n"
      fi
      printf '    The portal itself needs no web port: the Cloudflare Tunnel (service %s)\n' "${TUNNEL_SERVICE%.service}"
    else
      printf '    No web ports: the Cloudflare Tunnel (service %s) connects out to Cloudflare\n' "${TUNNEL_SERVICE%.service}"
    fi
    printf '    connects out on port 7844 (UDP and TCP). Port %s (Node) is bound to loopback only.\n' "$APP_PORT"
    printf '\n  Cloudflare      tunnel %s; public hostname %s -> http://127.0.0.1:%s\n' "$TUNNEL_ID" "$DOMAIN" "$APP_PORT"
    printf '                  (set in the Cloudflare dashboard; it also manages the DNS record)\n'
  else
  case $FIREWALL_STATE in
    ufw)
      printf '    ufw allows    %s\n' "$SSH_RULE_DESC"
      printf "                  80/tcp   HTTP  (Let's Encrypt validation, redirect to HTTPS) - from anywhere\n"
      printf '                  443/tcp  HTTPS - from anywhere\n'
      printf '                  443/udp  HTTP/3 - from anywhere\n'
      ;;
    *)
      printf '    Not managed by this installer. Allow 80/tcp, 443/tcp, 443/udp from anywhere and SSH from your admin network.\n'
      ;;
  esac
  printf '    Port %s (Node) is bound to loopback only - never expose it.\n' "$APP_PORT"
  printf "    Open the same ports in your cloud provider's security group / network firewall, if any.\n"

  printf "\n  DNS             %s needs an A record (plus AAAA if you use IPv6) pointing at this VM's public IP.\n" "$DOMAIN"
  fi

  printf '\n  Files           config   %s\n' "$ENV_FILE"
  [[ -n $APNS_KEY_DEST && -n $APNS_KEY_ID ]] && printf '                  APNs key %s\n' "$APNS_KEY_DEST"
  printf '                  data     %s/live.db\n' "$DATA_DIR"
  printf '                  backups  %s (daily at about 04:15, kept %s days)\n' "$BACKUP_DIR" "$BACKUP_KEEP_DAYS"
  printf '                  code     %s\n' "$APP_DIR"
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    printf '                  tunnel   %s (token), %s\n' "$TUNNEL_TOKEN_FILE" "$SYSTEMD_DIR/$TUNNEL_SERVICE"
    printf '  Logs            journalctl -u mchs-live -f         (server)\n'
    printf '                  journalctl -u %s -f  (Cloudflare Tunnel)\n' "${TUNNEL_SERVICE%.service}"
  else
    printf '                  HTTPS    %s, %s\n' "$CADDYFILE" "$CADDY_SITE_FILE"
    printf '  Logs            journalctl -u mchs-live -f       (server)\n'
    printf '                  journalctl -u caddy -f           (HTTPS, certificates, access log)\n'
  fi
  printf '  Commands        sudo mchs-live-cli list-users | create-user | reset-password | apns-check\n'
  printf '                  sudo mchs-live-backup   sudo mchs-live-restore   sudo mchs-live-uninstall\n'

  printf '\n  Next steps\n'
  local n=1
  if [[ $APNS_CHECK_RESULT == not-configured ]]; then
    printf '    %d. Apple Developer: create an APNs auth key (.p8), enable Push Notifications and the\n' "$n"
    printf '       Broadcast Capability for %s, copy the key here and run:\n' "$BUNDLE_ID"
    printf '       sudo ./deploy/install.sh --apns-key-path ~/AuthKey_XXXXXXXXXX.p8\n'
    n=$((n + 1))
  elif [[ $APNS_CHECK_RESULT == failed ]]; then
    printf '    %d. Fix the APNs setup (README "Troubleshooting"), then: sudo mchs-live-cli apns-check\n' "$n"
    n=$((n + 1))
  fi
  printf '    %d. iOS app: set LiveScoresConfig.defaultServerURL in MCHS/LiveScoresConfig.swift to\n' "$n"
  printf '       URL(string: "https://%s")! and ship a new build.\n' "$DOMAIN"
  n=$((n + 1))
  printf '    %d. Sign in at https://%s/ and create scorekeeper accounts.\n' "$n" "$DOMAIN"
  n=$((n + 1))
  if ((!HTTPS_OK)) && [[ $HTTPS_MODE == cloudflare-tunnel ]]; then
    case $TUNNEL_CHECK in
      not-connected)
        printf '    %d. Get the tunnel connected (see the warning above), then check https://%s/\n' "$n" "$DOMAIN" ;;
      dns | unreachable)
        printf '    %d. Open https://%s/ from another device. If it fails there too, check the tunnel'"'"'s\n' "$n" "$DOMAIN"
        printf '       public hostname (-> HTTP 127.0.0.1:%s) and that the domain is Active in Cloudflare\n' "$APP_PORT" ;;
      *)
        printf '    %d. Cloudflare dashboard: give the tunnel the public hostname %s -> HTTP 127.0.0.1:%s,\n' "$n" "$DOMAIN" "$APP_PORT"
        printf '       then check https://%s/ (README "Cloudflare Tunnel")\n' "$DOMAIN" ;;
    esac
  elif ((!HTTPS_OK)); then
    printf '    %d. Make sure DNS points here and ports 80/443 are open, then check https://%s/\n' "$n" "$DOMAIN"
  fi

  if ((${#WARNINGS[@]})); then
    printf '\n  %sWarnings%s\n' "$C_WARN" "$C_RESET"
    for line in "${WARNINGS[@]}"; do printf '    - %s\n' "$line"; done
  fi
  printf '\n'
}

# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  if ((!ASSUME_YES)) && [[ -t 0 ]]; then INTERACTIVE=1; fi

  printf '%sMCHS Live Scores installer%s %s(%s)%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$SRC_DIR" "$C_RESET"
  ((INTERACTIVE)) || ((ASSUME_YES)) || info "stdin is not a terminal - running non-interactively (as with --yes)."

  preflight
  collect_config
  check_web_ports
  show_plan
  install_base_packages
  create_user_and_dirs
  save_https_choice
  install_node
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then install_cloudflared; else install_caddy; fi
  install_app_files
  write_config
  install_units
  configure_firewall
  start_server
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then configure_tunnel; else configure_caddy; fi
  create_admin
  check_apns
  if [[ $HTTPS_MODE == cloudflare-tunnel ]]; then verify_tunnel_https; else verify_https; fi
  print_summary
}

main "$@"
exit 0
