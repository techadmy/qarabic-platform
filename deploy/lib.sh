#!/usr/bin/env bash
# shellcheck shell=bash
#
# Shared helpers for the N8 deploy scripts (docs/36). Sourced, never run directly.
#
# The scripts run ON the droplet, as root, from a checkout of this repo. Every one:
#   - stops on the first error (set -euo pipefail);
#   - has --dry-run: prints each command instead of running it (works anywhere);
#   - refuses a real run on any host that is not the Qarabic droplet;
#   - never prints a secret: env files are read into the environment of one command only.
#
# Paths can be moved with QARABIC_* variables. That exists for the test harness
# (deploy/tests/deploy.test.sh), which points them into a temp folder and puts fake
# binaries (hostname, nginx, pm2, …) first on PATH.

set -euo pipefail

: "${QARABIC_EXPECTED_HOSTNAME:=qarabic}"
: "${QARABIC_ETC:=/etc/qarabic}"
: "${QARABIC_SRV:=/srv/qarabic}"
: "${QARABIC_LOG_DIR:=/var/log/qarabic}"
: "${QARABIC_BACKUP_DIR:=/root/backups}"
: "${QARABIC_NODE_DIR:=/opt/node24}"
: "${QARABIC_USER:=qarabic}"
: "${QARABIC_LARAVEL_DIR:=/home/forge/api.qarabic.com}"
: "${QARABIC_LARAVEL_USER:=forge}"
: "${QARABIC_APP_DIST:=/home/forge/qarabic-app/dist}"
: "${QARABIC_NGINX_SITE:=/etc/nginx/sites-available/api.qarabic.com}"
: "${QARABIC_NGINX_INCLUDE_DIR:=/etc/nginx/forge-conf/api.qarabic.com/server}"
: "${QARABIC_REPO_URL:=git@github.com:techadmy/qarabic-platform.git}"

# shellcheck disable=SC2034  # used by the scripts that source this file
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
ASSUME_YES=0
SCRIPT_NAME="${SCRIPT_NAME:-$(basename "$0" .sh)}"

log() { printf '%s [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$SCRIPT_NAME" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
# Exit 2 = refused (wrong host, missing gate); exit 1 = a step failed.
refuse() {
  log "REFUSED: $*"
  exit 2
}

# Common flags. Usage: parse_common_flags "$@"; set -- "${REST[@]}"
REST=()
parse_common_flags() {
  REST=()
  local a
  for a in "$@"; do
    case $a in
      --dry-run | -n) DRY_RUN=1 ;;
      --yes | -y) ASSUME_YES=1 ;;
      *) REST+=("$a") ;;
    esac
  done
  if ((DRY_RUN)); then log "DRY RUN: nothing will be changed"; fi
  return 0
}

# run <cmd...>: run it, or print it in dry-run. Never pass a secret as an argument.
run() {
  if ((DRY_RUN)); then
    printf '  + %s\n' "$*" >&2
    return 0
  fi
  log "+ $*"
  "$@"
}

# write_file <path> <mode> <owner:group>: content from stdin, written atomically.
write_file() {
  local path=$1 mode=$2 owner=$3 tmp
  if ((DRY_RUN)); then
    printf '  + write %s (mode %s, %s)\n' "$path" "$mode" "$owner" >&2
    cat >/dev/null
    return 0
  fi
  tmp="$(mktemp "${path}.XXXXXX")"
  cat >"$tmp"
  chmod "$mode" "$tmp"
  if [[ $(id -u) -eq 0 ]]; then chown "$owner" "$tmp"; fi
  mv -f "$tmp" "$path"
  log "wrote $path"
}

# Real runs only on the droplet, as root. Dry runs only warn.
require_droplet() {
  local host problems=()
  host="$(hostname 2>/dev/null || true)"
  [[ $host == "$QARABIC_EXPECTED_HOSTNAME" ]] ||
    problems+=("hostname is '$host', expected '$QARABIC_EXPECTED_HOSTNAME'")
  [[ -f $QARABIC_LARAVEL_DIR/artisan ]] || problems+=("no Laravel app at $QARABIC_LARAVEL_DIR")
  [[ -f $QARABIC_NGINX_SITE ]] || problems+=("no nginx site $QARABIC_NGINX_SITE")
  [[ $(id -u) -eq 0 ]] || problems+=("not root")
  if ((${#problems[@]})); then
    if ((DRY_RUN)); then
      log "note: not the droplet (${problems[*]}); dry run only prints the plan"
      return 0
    fi
    refuse "this is not the Qarabic droplet: ${problems[*]}"
  fi
}

confirm() {
  local what=$1 answer
  ((DRY_RUN || ASSUME_YES)) && return 0
  [[ -t 0 ]] || die "not a terminal: pass --yes to confirm non-interactively"
  read -r -p "$what  Type 'yes' to continue: " answer
  [[ $answer == yes ]] || die "aborted"
}

# env_get <file> <KEY>: one value from a dotenv file, without logging it.
# Plain KEY=value lines only (what our env files and Laravel's .env use).
env_get() {
  local file=$1 key=$2 line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

# env_set <file> <KEY> <value>: replace or append one line (atomic, keeps mode/owner).
# Only for non-secret flags (SCHEDULER_ENABLED); never logs the value of other keys.
env_set() {
  local file=$1 key=$2 value=$3 tmp
  if ((DRY_RUN)); then
    printf '  + set %s=%s in %s\n' "$key" "$value" "$file" >&2
    return 0
  fi
  [[ -f $file ]] || die "missing $file"
  tmp="$(mktemp "${file}.XXXXXX")"
  if grep -qE "^${key}=" "$file"; then
    sed -E "s|^${key}=.*|${key}=${value}|" "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 640 "$tmp"
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
  log "set $key=$value in $file"
}

# Secrets reach the apps through Node's own `--env-file=<file>` (read by the process,
# never by this shell), so no script ever holds or prints them.

# Commands run as the app user with the Node 24 toolchain first on PATH.
as_app() {
  run sudo -u "$QARABIC_USER" -H env "PATH=$QARABIC_NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# pm2 for the app user (its own PM2_HOME; the global pm2 binary is fine on any Node).
pm2_app() {
  run sudo -u "$QARABIC_USER" -H env "PATH=$QARABIC_NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" pm2 "$@"
}
