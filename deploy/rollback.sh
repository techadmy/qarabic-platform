#!/usr/bin/env bash
# Rollback of the N8 switch (docs/36 §7): staff back on Laravel at the same URL in about a minute.
# Safe at any point of the night and safe to run twice.
#
#   sudo deploy/rollback.sh --dry-run
#   sudo deploy/rollback.sh
#
# 1. nginx: the saved Laravel include back (/etc/qarabic/state, else the repo copy), nginx -t,
#    reload. 2. qarabic-api: SCHEDULER_ENABLED=false + restart (the new processes keep running,
#    unrouted, for the post-mortem). 3. Laravel: artisan up. 4. Laravel cron line back.
# MySQL was never written by the new system: nothing to restore there. Anything entered in the
# new system after the switch is listed from Postgres audit_logs (time printed at the end).
SCRIPT_NAME=rollback
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${PUBLIC_HOST:=api.qarabic.com}"

STATE="$QARABIC_ETC/state"
INCLUDE="$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
SAVED_LARAVEL_CONF="$STATE/qarabic-app.conf.laravel"
REPO_LARAVEL_CONF="$DEPLOY_DIR/nginx/qarabic-app.laravel.conf"
SAVED_CRON="$STATE/forge-crontab.orig"
CRON_MARK='# n8-disabled '

parse_common_flags "$@"
require_droplet
confirm "Roll back: staff back on Laravel at https://$PUBLIC_HOST/app/?"

FAILED=0
step_failed() {
  FAILED=1
  log "STEP FAILED: $* (continuing with the other steps)"
}

# --- 1. nginx -----------------------------------------------------------------------------------
src="$SAVED_LARAVEL_CONF"
[[ -f $src ]] || src="$REPO_LARAVEL_CONF"
if [[ -f $INCLUDE ]] && cmp -s "$INCLUDE" "$src"; then
  log "nginx already serves Laravel"
else
  log "restoring the Laravel include from $src"
  run cp "$INCLUDE" "$INCLUDE.n8-rolled-back" 2>/dev/null || true
  run install -m 644 "$src" "$INCLUDE"
  if run nginx -t; then
    run systemctl reload nginx || step_failed "nginx reload"
  else
    step_failed "nginx -t (the include in place is the Laravel one; check the other files)"
  fi
fi

# --- 2. New-stack jobs off --------------------------------------------------------------------
if [[ -f $QARABIC_ETC/api.env ]] || ((DRY_RUN)); then
  if [[ $(env_get "$QARABIC_ETC/api.env" SCHEDULER_ENABLED) != false ]]; then
    env_set "$QARABIC_ETC/api.env" SCHEDULER_ENABLED false || step_failed "SCHEDULER_ENABLED=false"
    pm2_app restart qarabic-api --update-env || step_failed "pm2 restart qarabic-api"
  else
    log "qarabic-api scheduler already off"
  fi
fi

# --- 3. Laravel up ------------------------------------------------------------------------------
if [[ -f $QARABIC_LARAVEL_DIR/storage/framework/down ]] || ((DRY_RUN)); then
  run sudo -u "$QARABIC_LARAVEL_USER" php "$QARABIC_LARAVEL_DIR/artisan" up || step_failed "artisan up"
else
  log "Laravel already up"
fi

# --- 4. Laravel cron ----------------------------------------------------------------------------
if ((DRY_RUN)); then
  printf "  + crontab -u %s: remove the '%s' prefix (saved copy: %s)\n" \
    "$QARABIC_LARAVEL_USER" "$CRON_MARK" "$SAVED_CRON" >&2
else
  cur="$(crontab -u "$QARABIC_LARAVEL_USER" -l 2>/dev/null || true)"
  if grep -q "^${CRON_MARK}" <<<"$cur"; then
    sed -E "s|^${CRON_MARK}||" <<<"$cur" | crontab -u "$QARABIC_LARAVEL_USER" - ||
      step_failed "crontab restore"
    log "Laravel cron line back"
  elif [[ -z $cur && -f $SAVED_CRON ]]; then
    crontab -u "$QARABIC_LARAVEL_USER" "$SAVED_CRON" || step_failed "crontab restore"
  else
    log "Laravel cron already active"
  fi
fi

# --- 5. Check + what to re-enter ----------------------------------------------------------------
if ((!DRY_RUN)); then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$PUBLIC_HOST:443:127.0.0.1" \
    "https://$PUBLIC_HOST/app/" || true)"
  log "https://$PUBLIC_HOST/app/ → HTTP $code (Laravel React app expected: 200)"
fi
if [[ -f $STATE/switched-at ]]; then
  log "entries made in the new system since $(cat "$STATE/switched-at") are NOT in MySQL:"
  log "  list them from Postgres audit_logs (created_at >= that time) and re-enter by hand"
  ((DRY_RUN)) || run mv "$STATE/switched-at" "$STATE/switched-at.rolled-back-$(utc_stamp)"
fi
if ((FAILED)); then die "rollback finished with failed steps (see above)"; fi
log "rollback done"
