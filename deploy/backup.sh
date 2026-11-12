#!/usr/bin/env bash
# Backups before touching data (docs/36 §4). Read-only for the live system.
#
#   sudo deploy/backup.sh --dry-run
#   sudo deploy/backup.sh [--with-postgres]
#
# Writes to /root/backups/n8-<UTC stamp>/ (mode 700):
#   mysql-<db>.sql.gz   mysqldump --single-transaction (no lock on InnoDB), gunzip -t checked,
#                       size checked, "Dump completed" trailer checked
#   laravel-app.tar.gz  /home/forge/api.qarabic.com (code + .env; no vendor/node_modules/logs)
#   app-dist.tar.gz     the current React build served at /app/
#   nginx.tar.gz        the api.qarabic.com site file + its forge-conf includes
#   postgres-<db>.dump  pg_dump -Fc of the new database (--with-postgres)
#   SHA256SUMS
# MySQL is read as root through the local socket (auth_socket); if that is refused, the
# credentials of Laravel's .env go into a temporary 600 defaults file, never on a command line.
SCRIPT_NAME=backup
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${MIN_DUMP_BYTES:=100000}"
WITH_PG=0
parse_common_flags "$@"
for a in "${REST[@]+"${REST[@]}"}"; do
  case $a in
    --with-postgres) WITH_PG=1 ;;
    *) die "unknown option $a" ;;
  esac
done
require_droplet

STAMP="$(utc_stamp)"
OUT="$QARABIC_BACKUP_DIR/n8-$STAMP"
DB="$(env_get "$QARABIC_LARAVEL_DIR/.env" DB_DATABASE)"
if [[ -z $DB ]]; then
  ((DRY_RUN)) || die "DB_DATABASE not found in Laravel .env"
  DB='<DB_DATABASE from Laravel .env>'
fi

run install -d -m 700 "$OUT"

# --- MySQL ------------------------------------------------------------------------------------
MYSQL_OPTS=()
DEFAULTS=""
cleanup() { [[ -n $DEFAULTS ]] && rm -f "$DEFAULTS"; return 0; }
trap cleanup EXIT
if ((!DRY_RUN)) && ! mysql -N -e 'SELECT 1' >/dev/null 2>&1; then
  DEFAULTS="$(mktemp)"
  chmod 600 "$DEFAULTS"
  {
    printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' \
      "$(env_get "$QARABIC_LARAVEL_DIR/.env" DB_USERNAME)" \
      "$(env_get "$QARABIC_LARAVEL_DIR/.env" DB_PASSWORD)" \
      "$(env_get "$QARABIC_LARAVEL_DIR/.env" DB_HOST)" \
      "$(env_get "$QARABIC_LARAVEL_DIR/.env" DB_PORT)"
  } >"$DEFAULTS"
  MYSQL_OPTS=(--defaults-extra-file="$DEFAULTS")
  log "MySQL: using Laravel's credentials from a temporary file (not shown)"
fi

DUMP="$OUT/mysql-$DB.sql.gz"
log "STEP: mysqldump $DB"
if ((DRY_RUN)); then
  printf '  + mysqldump --single-transaction --quick --routines --triggers --events --hex-blob %s | gzip > %s\n' "$DB" "$DUMP" >&2
else
  mysqldump "${MYSQL_OPTS[@]+"${MYSQL_OPTS[@]}"}" --single-transaction --quick --routines --triggers \
    --events --hex-blob --default-character-set=utf8mb4 --no-tablespaces "$DB" | gzip -6 >"$DUMP"
  gunzip -t "$DUMP" || die "dump is not a valid gzip"
  size="$(stat -c %s "$DUMP" 2>/dev/null || stat -f %z "$DUMP")"
  ((size >= MIN_DUMP_BYTES)) || die "dump is only $size bytes (min $MIN_DUMP_BYTES)"
  gunzip -c "$DUMP" | tail -n 1 | grep -q 'Dump completed' || die "dump has no 'Dump completed' trailer"
  tables="$(gunzip -c "$DUMP" | grep -c '^CREATE TABLE' || true)"
  log "dump ok: $size bytes, $tables tables"
fi

# --- Files ------------------------------------------------------------------------------------
run tar -C "$(dirname "$QARABIC_LARAVEL_DIR")" -czf "$OUT/laravel-app.tar.gz" \
  --exclude=vendor --exclude=node_modules --exclude='storage/logs/*' \
  "$(basename "$QARABIC_LARAVEL_DIR")"
if [[ -d $QARABIC_APP_DIST ]] || ((DRY_RUN)); then
  run tar -C "$(dirname "$QARABIC_APP_DIST")" -czf "$OUT/app-dist.tar.gz" "$(basename "$QARABIC_APP_DIST")"
fi
run tar -czf "$OUT/nginx.tar.gz" "$QARABIC_NGINX_SITE" "$(dirname "$QARABIC_NGINX_INCLUDE_DIR")"

# --- Postgres (new system), when it holds data --------------------------------------------------
if ((WITH_PG)); then
  PG_DB="$(basename "$(env_get "$QARABIC_ETC/api.env" DATABASE_URL)" | cut -d'?' -f1)"
  [[ -n $PG_DB ]] || PG_DB=qarabic
  run sudo -u postgres pg_dump -Fc -f "/tmp/postgres-$PG_DB-$STAMP.dump" "$PG_DB"
  run mv "/tmp/postgres-$PG_DB-$STAMP.dump" "$OUT/postgres-$PG_DB.dump"
fi

if ((!DRY_RUN)); then
  if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
  (cd "$OUT" && "${sum[@]}" -- * >SHA256SUMS)
  chmod 600 "$OUT"/*
fi
log "backup in $OUT"
log "copy it off the server (from the Mac, outside any git repo):"
log "  scp -i ~/.ssh/qarabic_do_ed25519 -r root@<droplet>:$OUT ~/qarabic-backups/"
printf '%s\n' "$OUT"
