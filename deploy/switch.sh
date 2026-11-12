#!/usr/bin/env bash
# The night's switch steps (docs/36 §6). One sub-command per runbook step, run in this order
# with the import in between:
#
#   sudo deploy/switch.sh status            # read-only: where each piece stands
#   sudo deploy/switch.sh freeze            # §6.2  Laravel down (503) + Laravel cron line off
#   (backup.sh, legacy:import, legacy:verify — §6.3–6.5)
#   sudo deploy/switch.sh nginx             # §6.6  /app/, /api/, /up → the new stack
#   (smoke — §6.7)
#   sudo deploy/switch.sh jobs-on           # §6.8  SCHEDULER_ENABLED=true on qarabic-api only
#
# Every sub-command takes --dry-run and --yes. deploy/rollback.sh undoes all of them.
# The Laravel site file is Forge's and is never edited: only its include
# forge-conf/api.qarabic.com/server/qarabic-app.conf is swapped (Laravel copy saved first).
SCRIPT_NAME=switch
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${PUBLIC_HOST:=api.qarabic.com}"
: "${HEALTH_RETRIES:=10}"
: "${HEALTH_SLEEP:=2}"

STATE="$QARABIC_ETC/state"
INCLUDE="$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
N8_CONF="$DEPLOY_DIR/nginx/qarabic-n8.conf"
SAVED_LARAVEL_CONF="$STATE/qarabic-app.conf.laravel"
SAVED_CRON="$STATE/forge-crontab.orig"
CRON_MARK='# n8-disabled '

parse_common_flags "$@"
CMD="${REST[0]:-}"
[[ -n $CMD ]] || die "usage: switch.sh [--dry-run] [--yes] status|freeze|nginx|jobs-on"
require_droplet

artisan() { run sudo -u "$QARABIC_LARAVEL_USER" php "$QARABIC_LARAVEL_DIR/artisan" "$@"; }

is_n8_include() { [[ -f $INCLUDE ]] && cmp -s "$INCLUDE" "$N8_CONF"; }
laravel_down() { [[ -f $QARABIC_LARAVEL_DIR/storage/framework/down ]]; }

wait_http() { # wait_http <name> <curl args...>: 200 within the retries
  local name=$1 i code=""
  shift
  if ((DRY_RUN)); then
    printf '  + check %s answers 200\n' "$name" >&2
    return 0
  fi
  for ((i = 1; i <= HEALTH_RETRIES; i++)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true)"
    [[ $code == 200 ]] && {
      log "$name: 200"
      return 0
    }
    sleep "$HEALTH_SLEEP"
  done
  log "$name: HTTP $code"
  return 1
}

status() {
  local s
  is_n8_include && s="new stack" || s="Laravel"
  log "nginx /app/ + /api/: $s"
  laravel_down && s="down (maintenance)" || s="up"
  log "Laravel: $s"
  if crontab -u "$QARABIC_LARAVEL_USER" -l 2>/dev/null | grep -q "^${CRON_MARK}.*schedule:run"; then
    s="disabled by n8"
  else
    s="active"
  fi
  log "Laravel cron: $s"
  log "qarabic-api SCHEDULER_ENABLED=$(env_get "$QARABIC_ETC/api.env" SCHEDULER_ENABLED)"
  log "rehearsal SCHEDULER_ENABLED=$(env_get "$QARABIC_ETC/api-rehearsal.env" SCHEDULER_ENABLED)"
  [[ -f $STATE/switched-at ]] && log "switched at: $(cat "$STATE/switched-at")"
  return 0
}

freeze() {
  confirm "Put Laravel in maintenance (staff see 503) and stop its cron?"
  run install -d -m 700 "$STATE"
  if laravel_down; then
    log "Laravel already down"
  else
    # No --secret: nobody needs to bypass. WPForms gets 503 and retries.
    artisan down --retry=60
  fi
  if ((DRY_RUN)); then
    printf "  + crontab -u %s: save to %s, prefix the schedule:run line with '%s'\n" \
      "$QARABIC_LARAVEL_USER" "$SAVED_CRON" "$CRON_MARK" >&2
    return 0
  fi
  local cur
  cur="$(crontab -u "$QARABIC_LARAVEL_USER" -l 2>/dev/null || true)"
  if grep -q "^${CRON_MARK}" <<<"$cur"; then
    log "Laravel cron already disabled"
  else
    [[ -f $SAVED_CRON ]] || printf '%s\n' "$cur" | write_file "$SAVED_CRON" 600 root:root
    sed -E "s|^([^#].*artisan schedule:run.*)$|${CRON_MARK}\1|" <<<"$cur" |
      crontab -u "$QARABIC_LARAVEL_USER" -
    log "Laravel cron line disabled (Forge's Scheduler page may show it as changed)"
  fi
}

switch_nginx() {
  # The new processes must answer before any traffic goes to them.
  wait_http "qarabic-api" "http://127.0.0.1:4100/api/v1/health" || refuse "qarabic-api is not healthy"
  wait_http "qarabic-web" "http://127.0.0.1:4000/app/login" || refuse "qarabic-web is not healthy"
  laravel_down || ((DRY_RUN)) || refuse "Laravel is not frozen: run 'switch.sh freeze' first"
  if is_n8_include; then
    log "nginx already on the new stack"
    return 0
  fi
  confirm "Route https://$PUBLIC_HOST/app/ and /api/ to the new stack?"
  run install -d -m 700 "$STATE"
  # Save the live Laravel include once (the exact bytes the rollback puts back).
  if [[ ! -f $SAVED_LARAVEL_CONF ]]; then run cp -p "$INCLUDE" "$SAVED_LARAVEL_CONF"; fi
  run install -m 644 "$N8_CONF" "$INCLUDE"
  if ! run nginx -t; then
    log "nginx -t failed: putting the Laravel include back"
    run cp -p "$SAVED_LARAVEL_CONF" "$INCLUDE"
    run nginx -t
    die "switch aborted, nginx unchanged"
  fi
  run systemctl reload nginx
  if ((!DRY_RUN)); then date -u +%Y-%m-%dT%H:%M:%SZ | write_file "$STATE/switched-at" 600 root:root; fi
  wait_http "https://$PUBLIC_HOST/up" --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST/up" ||
    die "https://$PUBLIC_HOST/up is not 200 after the switch: consider rollback.sh"
  wait_http "https://$PUBLIC_HOST/app/login" --resolve "$PUBLIC_HOST:443:127.0.0.1" \
    "https://$PUBLIC_HOST/app/login" || die "/app/login is not 200 after the switch: consider rollback.sh"
  log "nginx switched. Next: smoke (docs/36 §6.7), then 'switch.sh jobs-on'"
}

jobs_on() {
  is_n8_include || ((DRY_RUN)) || refuse "nginx is not switched yet: jobs stay off"
  if [[ $(env_get "$QARABIC_ETC/api.env" SCHEDULER_ENABLED) == true ]]; then
    log "qarabic-api scheduler already on"
    return 0
  fi
  confirm "Turn the class generator and the other jobs on (qarabic-api only)?"
  env_set "$QARABIC_ETC/api.env" SCHEDULER_ENABLED true
  # The env file is read at process start (node --env-file): restart, not reload.
  pm2_app restart qarabic-api --update-env
  wait_http "qarabic-api" "http://127.0.0.1:4100/api/v1/health" || die "qarabic-api not healthy after restart"
}

case $CMD in
  status) status ;;
  freeze) freeze ;;
  nginx) switch_nginx ;;
  jobs-on) jobs_on ;;
  *) die "unknown command '$CMD' (status|freeze|nginx|jobs-on)" ;;
esac
