#!/usr/bin/env bash
# shellcheck disable=SC2016  # bash -c bodies expand $1/$2 in the child shell, on purpose
# Build and start a release of the new stack (docs/36 §3.3, §3.5, §3.6, §5.3).
# Does not touch nginx, Laravel or MySQL: the public URL keeps serving Laravel until switch.sh.
#
#   sudo deploy/release.sh --dry-run v2026.11.20
#   sudo deploy/release.sh v2026.11.20                    # build + migrate + start prod pair
#   sudo deploy/release.sh v2026.11.20 --rehearsal        # also the rehearsal pair (4200/4001)
#   sudo deploy/release.sh v2026.11.20 --start=none       # build + migrate only
#
# Steps: fetch the tag into /srv/qarabic/repo (deploy key of the `qarabic` user, read-only) ·
# export it to /srv/qarabic/releases/<tag> · pnpm install --frozen-lockfile · pnpm build with
# NEXT_PUBLIC_BASE_PATH=/app · prisma migrate deploy (migrations only, never a seed) · point
# /srv/qarabic/current at it · pm2 startOrReload by name · health checks · keep 5 releases.
# Re-running with a release already built reuses it (that is also the app-level rollback:
# `release.sh <previous tag>`).
SCRIPT_NAME=release
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${PUBLIC_URL:=https://api.qarabic.com}"
: "${BASE_PATH:=/app}"
: "${REHEARSAL_API_URL:=http://localhost:4200}"
: "${KEEP_RELEASES:=5}"
: "${HEALTH_RETRIES:=20}"
: "${HEALTH_SLEEP:=3}"

TAG=""
START=prod
REHEARSAL=0
REBUILD=0
parse_common_flags "$@"
for a in "${REST[@]+"${REST[@]}"}"; do
  case $a in
    --rehearsal) REHEARSAL=1 ;;
    --rebuild) REBUILD=1 ;;
    --start=prod | --start=none | --start=rehearsal) START="${a#--start=}" ;;
    -*) die "unknown option $a" ;;
    *) TAG=$a ;;
  esac
done
[[ $TAG =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$ ]] ||
  refuse "give a release tag like v2026.11.20 (got '${TAG}')"
((REHEARSAL)) && [[ $START == prod ]] && START=both
require_droplet

REPO="$QARABIC_SRV/repo"
REL="$QARABIC_SRV/releases/$TAG"
ENV_PROD="$QARABIC_ETC/api.env"
ENV_REH="$QARABIC_ETC/api-rehearsal.env"

# --- 0. Env files complete? (key names only in messages) --------------------------------------
check_env() { # check_env <file> <required keys...>
  local file=$1 key missing=()
  shift
  if ((DRY_RUN)) && [[ ! -r $file ]]; then
    printf '  + check %s: required keys set, no <set on server> left\n' "$file" >&2
    return 0
  fi
  [[ -r $file ]] || refuse "$file missing: run prepare-server.sh first"
  for key in "$@"; do
    [[ -n $(env_get "$file" "$key") ]] || missing+=("$key")
  done
  grep -qE '<set on server>' "$file" &&
    missing+=("$(grep -E '<set on server>' "$file" | cut -d= -f1 | tr '\n' ' ')")
  if [[ $file == "$ENV_PROD" && $(env_get "$file" BILLING_ALLOW_LIVE) != false ]]; then
    missing+=("BILLING_ALLOW_LIVE must be false")
  fi
  if ((${#missing[@]})); then
    if ((DRY_RUN)); then
      log "would refuse: $file: set ${missing[*]}"
      return 0
    fi
    refuse "$file: set ${missing[*]}"
  fi
  log "$file: complete"
}
check_env "$ENV_PROD" NODE_ENV PORT DATABASE_URL WEB_ORIGIN APP_URL SESSION_SECRET APP_ENCRYPTION_KEY \
  WEB_LEADS_WEBHOOK_SECRET
if [[ $START == both || $START == rehearsal ]] || ((REHEARSAL)); then
  check_env "$ENV_REH" PORT DATABASE_URL WEB_ORIGIN APP_URL SESSION_SECRET SCHEDULER_ENABLED
fi
if [[ $(env_get "$ENV_REH" SCHEDULER_ENABLED) == true ]]; then refuse "$ENV_REH: SCHEDULER_ENABLED must stay false"; fi

# --- 1. Code ------------------------------------------------------------------------------------
if [[ -d $REL && $REBUILD -eq 0 && -f $REL/.release-ok ]]; then
  log "release $TAG already built: reusing $REL"
else
  if [[ -d $REPO/.git ]] || { ((DRY_RUN)) && [[ -d $REPO ]]; }; then
    as_app git -C "$REPO" fetch --quiet --tags --prune origin
  else
    as_app git clone --quiet "$QARABIC_REPO_URL" "$REPO"
  fi
  as_app git -C "$REPO" rev-parse --verify --quiet "refs/tags/$TAG"
  run rm -rf "$REL"
  as_app mkdir -p "$REL"
  # Export the tag (no .git in the release); the tag's commit is recorded for the log.
  if ((DRY_RUN)); then
    printf '  + git -C %s archive %s | tar -x -C %s\n' "$REPO" "$TAG" "$REL" >&2
  else
    sudo -u "$QARABIC_USER" -H bash -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "$REPO" "$TAG" "$REL"
    sudo -u "$QARABIC_USER" -H git -C "$REPO" rev-list -n1 "$TAG" | sudo -u "$QARABIC_USER" tee "$REL/.commit" >/dev/null
  fi

  # --- 2. Install + build ---------------------------------------------------------------------
  as_app bash -c 'cd "$1" && CI=1 pnpm install --frozen-lockfile' _ "$REL"
  as_app env NEXT_PUBLIC_BASE_PATH="$BASE_PATH" NEXT_PUBLIC_API_URL="$PUBLIC_URL" \
    NEXT_PUBLIC_ENABLE_MOCKS=false NEXT_PUBLIC_APP_VERSION="$TAG" NEXT_TELEMETRY_DISABLED=1 \
    bash -c 'cd "$1" && pnpm build' _ "$REL"
  if ((REHEARSAL)); then
    # Same code, built for http://localhost:4001/app/ talking to the rehearsal API.
    as_app env NEXT_PUBLIC_BASE_PATH="$BASE_PATH" NEXT_PUBLIC_API_URL="$REHEARSAL_API_URL" \
      NEXT_PUBLIC_ENABLE_MOCKS=false NEXT_PUBLIC_APP_VERSION="$TAG-rehearsal" \
      NEXT_DIST_DIR=.next-rehearsal NEXT_TELEMETRY_DISABLED=1 \
      bash -c 'cd "$1/apps/web" && pnpm exec next build' _ "$REL"
  fi
  as_app touch "$REL/.release-ok"
fi

# --- 3. Migrations (Node reads the env file itself; this shell never sees DATABASE_URL) -------
migrate() { # migrate <extra env-file or ""> : api.env, then the overrides
  as_app bash -c 'cd "$1/apps/api" && node --env-file="$2" ${3:+--env-file="$3"} node_modules/prisma/build/index.js migrate deploy' \
    _ "$REL" "$ENV_PROD" "$1"
}
migrate ""
if [[ $START == both || $START == rehearsal ]] || ((REHEARSAL)); then migrate "$ENV_REH"; fi

# --- 4. Activate + start ------------------------------------------------------------------------
PREV=""
[[ -L $QARABIC_SRV/current ]] && PREV="$(readlink "$QARABIC_SRV/current")"
run ln -sfn "$REL" "$QARABIC_SRV/current.new"
run mv -Tf "$QARABIC_SRV/current.new" "$QARABIC_SRV/current"
[[ -n $PREV && $PREV != "$REL" ]] && log "previous release: $PREV (app rollback: release.sh $(basename "$PREV"))"

ECO="$QARABIC_SRV/current/deploy/ecosystem.config.cjs"
health() { # health <url> <name>
  local url=$1 name=$2 i code
  if ((DRY_RUN)); then
    printf '  + wait for %s (%s)\n' "$url" "$name" >&2
    return 0
  fi
  for ((i = 1; i <= HEALTH_RETRIES; i++)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
    if [[ $code == 200 || $code == 307 || $code == 308 ]]; then
      log "$name healthy ($code)"
      return 0
    fi
    sleep "$HEALTH_SLEEP"
  done
  die "$name not healthy at $url (last HTTP $code): pm2 logs $name --lines 100"
}
start_pair() { # start_pair <api> <web> <api-port> <web-port>
  pm2_app startOrReload "$ECO" --only "$1,$2" --update-env
  health "http://127.0.0.1:$3/api/v1/health" "$1"
  health "http://127.0.0.1:$4$BASE_PATH/login" "$2"
}
case $START in
  prod) start_pair qarabic-api qarabic-web 4100 4000 ;;
  rehearsal) start_pair qarabic-api-rehearsal qarabic-web-rehearsal 4200 4001 ;;
  both)
    start_pair qarabic-api qarabic-web 4100 4000
    start_pair qarabic-api-rehearsal qarabic-web-rehearsal 4200 4001
    ;;
  none) log "not starting processes (--start=none)" ;;
esac
[[ $START != none ]] && pm2_app save

# --- 5. Keep the last releases --------------------------------------------------------------------
if ((!DRY_RUN)); then
  current_target="$(readlink "$QARABIC_SRV/current")"
  find "$QARABIC_SRV/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn |
    awk -v keep="$KEEP_RELEASES" 'NR > keep { print $2 }' | while read -r old; do
    [[ $old == "$current_target" || $old == "$PREV" ]] && continue
    log "removing old release $old"
    rm -rf -- "$old"
  done
fi
log "release $TAG active (nginx unchanged: switch.sh routes the public URL)"
