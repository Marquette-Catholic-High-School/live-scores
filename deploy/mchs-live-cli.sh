#!/usr/bin/env bash
#
# MCHS Live Scores - admin command line (installed as /usr/local/sbin/mchs-live-cli).
#
# Runs server/cli.js as the service user with the production configuration, so it
# uses the same database and APNs settings as the running server:
#
#     sudo mchs-live-cli list-users
#     sudo mchs-live-cli create-user --username coach --display-name "Coach Smith" --role scorekeeper
#     sudo mchs-live-cli reset-password --username admin
#     sudo mchs-live-cli delete-user --username coach
#     sudo mchs-live-cli apns-check
#
# create-user and reset-password ask for the password on a terminal, or generate and
# print one when input is not a terminal. Scripts pipe it in with --password-stdin
# (first line of stdin) - never --password=..., which every local user can see in ps:
#
#     printf '%s\n' "$pw" | sudo mchs-live-cli reset-password --username=admin --password-stdin

set -Eeuo pipefail

readonly APP_DIR=/opt/mchs-live
readonly ENV_FILE=/etc/mchs-live/mchs-live.env
readonly SERVICE_USER=mchslive
readonly HOME_DIR=/var/lib/mchs-live
readonly NODE_BIN=/usr/bin/node

die() {
  printf 'mchs-live-cli: %s\n' "$*" >&2
  exit 1
}

((EUID == 0)) || die "run it with sudo: sudo mchs-live-cli $*"
[[ -f $APP_DIR/server/cli.js ]] || die "$APP_DIR/server/cli.js not found - is MCHS Live Scores installed?"
[[ -r $ENV_FILE ]] || die "$ENV_FILE not found - re-run the installer."
[[ -x $NODE_BIN ]] || die "$NODE_BIN not found - re-run the installer."
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "user $SERVICE_USER does not exist - re-run the installer."

# A clean environment: the configuration comes only from the env file, exactly as
# for the service (variables already set in the environment would take precedence).
env_vars=(PATH=/usr/bin:/bin HOME="$HOME_DIR" LANG=C.UTF-8)
[[ -n ${TERM:-} ]] && env_vars+=("TERM=$TERM")

cd "$APP_DIR"
exec runuser -u "$SERVICE_USER" -- env -i "${env_vars[@]}" \
  "$NODE_BIN" --disable-warning=ExperimentalWarning --env-file="$ENV_FILE" server/cli.js "$@"
