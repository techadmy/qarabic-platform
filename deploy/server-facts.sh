#!/usr/bin/env bash
# Read-only facts for docs/36 §1 (versions, disk, time zones, nginx layout, ports, jobs).
# Changes nothing. Prints no secret: only named non-secret keys of Laravel's .env, only the
# structural lines of nginx files (no certificates paths, no auth files).
#
#   sudo deploy/server-facts.sh
SCRIPT_NAME=server-facts
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

parse_common_flags "$@"
require_droplet
if ((DRY_RUN)); then
  log "would print: OS, CPU/RAM/disk, runtimes, time zones, Laravel non-secret keys, nginx layout, ports, ufw, cron"
  exit 0
fi

section() { printf '\n== %s\n' "$1"; }
v() { command -v "$1" >/dev/null 2>&1 && "$@" 2>&1 | head -n1 || echo "$1: missing"; }

section host
hostname
lsb_release -ds 2>/dev/null || true
printf 'cpus %s\n' "$(nproc)"
free -h | sed -n 2p
df -h / | tail -n1
timedatectl show -p Timezone 2>/dev/null || true

section runtimes
v node -v
[[ -x $QARABIC_NODE_DIR/bin/node ]] && echo "node24: $("$QARABIC_NODE_DIR/bin/node" -v)" || echo "node24: missing"
v pm2 -v
v php -v
v mysql --version
v nginx -v
v psql --version
v redis-server --version

section "time zones"
grep -E '^APP_TIMEZONE=' "$QARABIC_LARAVEL_DIR/.env" || echo "APP_TIMEZONE not set (config default)"
grep -n "'timezone'" "$QARABIC_LARAVEL_DIR/config/app.php" || true
mysql -N -e 'SELECT @@global.time_zone, @@system_time_zone' 2>/dev/null || echo "mysql: no socket access"
sudo -u postgres psql -qtA -c 'SHOW timezone' 2>/dev/null || echo "postgres: not installed"

section "laravel (non-secret keys)"
grep -E '^(APP_ENV|APP_URL|DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE|QUEUE_CONNECTION|MAIL_MAILER|FILESYSTEM_DISK|BROADCAST_CONNECTION)=' \
  "$QARABIC_LARAVEL_DIR/.env" || true
[[ -f $QARABIC_LARAVEL_DIR/storage/framework/down ]] && echo "maintenance: DOWN" || echo "maintenance: up"
mysql -N -e "SELECT table_schema, ROUND(SUM(data_length+index_length)/1048576,1) AS mb
  FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema')
  GROUP BY table_schema" 2>/dev/null || true

section "nginx api.qarabic.com (structure only)"
grep -nE 'server_name|listen|root |location|include|proxy_pass|fastcgi_pass|alias|try_files|client_max_body_size' \
  "$QARABIC_NGINX_SITE" | grep -vE 'ssl_certificate|auth_basic_user_file' || true
for f in "$(dirname "$QARABIC_NGINX_INCLUDE_DIR")"/*/*; do
  [[ -f $f ]] || continue
  echo "-- ${f#/etc/nginx/}"
  grep -nE 'server_name|location|proxy_pass|alias|try_files|return|client_max_body_size' "$f" || true
done
grep -rn 'client_max_body_size' /etc/nginx/nginx.conf /etc/nginx/conf.d 2>/dev/null || echo "client_max_body_size: nginx default (1m)"

section "listening ports"
ss -ltn | awk 'NR > 1 { print $4 }' | sort -u
section firewall
ufw status 2>/dev/null | head -n 15 || true

section "jobs"
crontab -u "$QARABIC_LARAVEL_USER" -l 2>/dev/null | grep -vE '^\s*#|^\s*$' | sed -E 's#https?://[^ ]*#<url>#g' || true
ls /etc/supervisor/conf.d 2>/dev/null || echo "no supervisor programs"
sudo -u "$QARABIC_USER" -H pm2 ls 2>/dev/null || echo "pm2 ($QARABIC_USER): not set up"
