#!/usr/bin/env bash
# Anonymise a production MySQL dump of the Laravel app for the second N8 rehearsal
# (docs/37 §6 F6, docs/36 §5). Runs on a dev machine (never on the droplet) against a LOCAL
# throwaway MySQL database whose name ends in `_anon`.
#
#   deploy/anonymise/anonymise-mysql-dump.sh --dry-run in.sql.gz out.sql.gz
#   deploy/anonymise/anonymise-mysql-dump.sh in.sql.gz out.sql.gz
#
# Env: ANON_MYSQL_HOST (127.0.0.1), ANON_MYSQL_PORT (3307), ANON_MYSQL_USER (root; password,
# if any, from ~/.my.cnf — never on the command line), ANON_DB (qarabic_anon).
#
# 1. load the dump into ANON_DB (dropped and re-created)        2. fingerprint: row count of every
# table, sum of every money/number column, min/max of every date/time column    3. anonymise.sql
# 4. JSON blobs: values of name/email/phone/address-like keys replaced    5. any e-mail address
# left in any text/JSON column replaced    6. fingerprint again: must be identical
# 7. leak check: no e-mail outside the anon domain, no user phone outside the fake range
# 8. dump ANON_DB to the output file. Login on the anonymised data: every user's password is
# the rehearsal password below; LEGACY_APP_KEY for the import = ANON_APP_KEY below.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${ANON_MYSQL_HOST:=127.0.0.1}"
: "${ANON_MYSQL_PORT:=3307}"
: "${ANON_MYSQL_USER:=root}"
: "${ANON_DB:=qarabic_anon}"
# Test-only values for anonymised data (they protect nothing real).
: "${ANON_PASSWORD:=Rehearsal-Only-2026}"
: "${ANON_APP_KEY:=base64:cWFyYWJpYy1hbm9ueW1pc2VkLXJlaGVhcnNhbC1rZXk=}"
ANON_DOMAIN=anon.qarabic.test

log() { printf '%s [anonymise] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
refuse() {
  log "REFUSED: $*"
  exit 2
}

DRY_RUN=0
ARGS=()
for a in "$@"; do
  case $a in
    --dry-run | -n) DRY_RUN=1 ;;
    -*) die "unknown option $a" ;;
    *) ARGS+=("$a") ;;
  esac
done
((${#ARGS[@]} == 2)) || die "usage: anonymise-mysql-dump.sh [--dry-run] <in.sql[.gz]> <out.sql.gz>"
IN=${ARGS[0]}
OUT=${ARGS[1]}

# --- Guards: local machine, local MySQL, throwaway database -------------------------------------
[[ $(hostname 2>/dev/null) != qarabic && ! -e /home/forge/api.qarabic.com ]] ||
  refuse "this looks like the production droplet; copy the dump to a dev machine first"
[[ $ANON_MYSQL_HOST == 127.0.0.1 || $ANON_MYSQL_HOST == localhost ]] ||
  refuse "ANON_MYSQL_HOST must be local (got $ANON_MYSQL_HOST)"
[[ $ANON_DB =~ ^[a-z0-9_]+_anon$ ]] || refuse "ANON_DB must end in _anon (got $ANON_DB)"
[[ -f $IN ]] || die "no input file $IN"
[[ $OUT != "$IN" ]] || die "output must differ from input"
# Never write a data dump inside a git checkout (walk up looking for .git).
d="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd -P)" || die "output folder does not exist"
while [[ -n $d && $d != / ]]; do
  [[ -e $d/.git ]] && refuse "output $OUT is inside a git repository ($d): keep data dumps out of repos"
  d="$(dirname "$d")"
done

MYSQL=(mysql -h "$ANON_MYSQL_HOST" -P "$ANON_MYSQL_PORT" -u "$ANON_MYSQL_USER" --default-character-set=utf8mb4)
q() { "${MYSQL[@]}" -N -B "$ANON_DB" -e "$1"; }

if ((DRY_RUN)); then
  log "DRY RUN: would load $IN into $ANON_MYSQL_HOST:$ANON_MYSQL_PORT/$ANON_DB, anonymise, verify, write $OUT"
  grep -cE '^-- @table ' "$HERE/anonymise.sql" | xargs -I{} printf '  + %s table blocks in anonymise.sql\n' {} >&2
  exit 0
fi
command -v htpasswd >/dev/null || die "htpasswd is needed for the bcrypt hash (macOS: built in; Ubuntu: apache2-utils)"

# --- 1. Load ------------------------------------------------------------------------------------
log "loading $IN into $ANON_DB"
"${MYSQL[@]}" -e "DROP DATABASE IF EXISTS \`$ANON_DB\`; CREATE DATABASE \`$ANON_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
if [[ $IN == *.gz ]]; then gunzip -c "$IN"; else cat "$IN"; fi | "${MYSQL[@]}" "$ANON_DB"

# --- 2. Fingerprint (what must not change) --------------------------------------------------------
fingerprint() {
  local sql
  sql="$(q "SELECT GROUP_CONCAT(stmt SEPARATOR ' UNION ALL ') FROM (
      SELECT CONCAT('SELECT ''', t.table_name, ' rows'', COUNT(*) FROM \`', t.table_name, '\`') AS stmt
        FROM information_schema.tables t WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
      UNION ALL
      SELECT CONCAT('SELECT ''', c.table_name, '.', c.column_name, ' sum'', COALESCE(SUM(\`', c.column_name, '\`), 0) FROM \`', c.table_name, '\`')
        FROM information_schema.columns c
       WHERE c.table_schema = DATABASE() AND c.data_type IN ('int','bigint','smallint','tinyint','mediumint','decimal','double','float')
      UNION ALL
      SELECT CONCAT('SELECT ''', c.table_name, '.', c.column_name, ' range'', CONCAT_WS(''..'', MIN(\`', c.column_name, '\`), MAX(\`', c.column_name, '\`), COUNT(\`', c.column_name, '\`)) FROM \`', c.table_name, '\`')
        FROM information_schema.columns c
       WHERE c.table_schema = DATABASE() AND c.data_type IN ('date','datetime','timestamp','time')
    ) s")"
  "${MYSQL[@]}" -N -B "$ANON_DB" -e "$sql" | sort
}
# GROUP_CONCAT of the statements needs a large limit for big schemas.
q "SET GLOBAL group_concat_max_len = 67108864" 2>/dev/null || true
MYSQL+=(--init-command="SET SESSION group_concat_max_len = 67108864")
BEFORE="$(mktemp)"
AFTER="$(mktemp)"
trap 'rm -f "$BEFORE" "$AFTER"' EXIT
fingerprint >"$BEFORE"
log "fingerprint: $(wc -l <"$BEFORE" | tr -d ' ') values (counts, sums, time ranges)"

# --- 3. Table rules -------------------------------------------------------------------------------
# Laravel `encrypted` payload (AES-256-CBC + HMAC-SHA256 over iv.value) of a fake value.
key_hex="$(printf '%s' "${ANON_APP_KEY#base64:}" | base64 -d | xxd -p -c 64)"
[[ ${#key_hex} -eq 64 ]] || die "ANON_APP_KEY must be base64 of 32 bytes"
laravel_encrypt() {
  local iv_hex iv_b64 value mac
  iv_hex="$(openssl rand -hex 16)"
  iv_b64="$(printf '%s' "$iv_hex" | xxd -r -p | base64)"
  value="$(printf '%s' "$1" | openssl enc -aes-256-cbc -K "$key_hex" -iv "$iv_hex" | base64 | tr -d '\n')"
  mac="$(printf '%s%s' "$iv_b64" "$value" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key_hex" | awk '{print $NF}')"
  printf '{"iv":"%s","value":"%s","mac":"%s","tag":""}' "$iv_b64" "$value" "$mac" | base64 | tr -d '\n'
}
ENC_URL="$(laravel_encrypt 'https://meet.example.test/anon')"
ENC_PHONE="$(laravel_encrypt '+15550000000')"
PW_HASH="$(htpasswd -bnBC 12 '' "$ANON_PASSWORD" | tr -d ':\n')"

tables=" $(q "SELECT GROUP_CONCAT(table_name SEPARATOR ' ') FROM information_schema.tables WHERE table_schema = DATABASE()") _setup _teardown "
script="$(awk -v present="$tables" '
  /^-- @table / { t = $3; keep = index(present, " " t " ") > 0; if (!keep) print "-- skipped (no table): " t > "/dev/stderr"; next }
  keep { print }' "$HERE/anonymise.sql")"
log "applying anonymise.sql"
{
  printf "SET @enc_url = '%s', @enc_phone = '%s', @pw = '%s';\n" "$ENC_URL" "$ENC_PHONE" "$PW_HASH"
  printf '%s\n' "$script"
} | "${MYSQL[@]}" "$ANON_DB"

# --- 4 + 5. Every JSON / text column: personal keys in JSON, then any e-mail address -------------
KEY_RX='"([A-Za-z_]*([Nn]ame|[Ee]mail|[Pp]hone|[Mm]obile|[Aa]ddress|[Ww]hats[Aa]pp)[A-Za-z_]*|ip|ip_address|user_agent)" ?: ?"[^"]*"'
EMAIL_RX="[A-Za-z0-9._%+-]+@(?!${ANON_DOMAIN//./\\\\.})[A-Za-z0-9-]+(\\\\.[A-Za-z0-9-]+)*\\\\.[A-Za-z]{2,}"
log "scrubbing JSON keys and stray e-mail addresses in every text/JSON column"
q "SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('json','text','mediumtext','longtext','tinytext','varchar','char')
      AND c.table_name NOT IN ('migrations','quran_surahs','permissions','roles','country','time_zones','cities','states')
      AND c.column_name NOT IN ('password') AND c.extra NOT LIKE '%GENERATED%'" |
  while IFS=$'\t' read -r t c type; do
    stmts=""
    if [[ $type == json ]]; then
      stmts+="UPDATE \`$t\` SET \`$c\` = CAST(REGEXP_REPLACE(CAST(\`$c\` AS CHAR), '$KEY_RX', '\"\$1\": \"anon\"') AS JSON) WHERE \`$c\` IS NOT NULL AND REGEXP_LIKE(CAST(\`$c\` AS CHAR), '$KEY_RX');"
      stmts+="UPDATE \`$t\` SET \`$c\` = CAST(REGEXP_REPLACE(CAST(\`$c\` AS CHAR), '$EMAIL_RX', 'redacted@$ANON_DOMAIN') AS JSON) WHERE \`$c\` IS NOT NULL AND REGEXP_LIKE(CAST(\`$c\` AS CHAR), '$EMAIL_RX');"
    else
      stmts+="UPDATE \`$t\` SET \`$c\` = REGEXP_REPLACE(\`$c\`, '$EMAIL_RX', 'redacted@$ANON_DOMAIN') WHERE \`$c\` IS NOT NULL AND REGEXP_LIKE(\`$c\`, '$EMAIL_RX');"
    fi
    "${MYSQL[@]}" "$ANON_DB" -e "$stmts"
  done

# --- 6. Same ids, times, money --------------------------------------------------------------------
fingerprint >"$AFTER"
if ! diff -q "$BEFORE" "$AFTER" >/dev/null; then
  diff "$BEFORE" "$AFTER" | head -n 20 >&2
  die "fingerprint changed: ids, times or money were altered"
fi
log "fingerprint identical after anonymising"

# --- 7. Leak check --------------------------------------------------------------------------------
leaks=0
while IFS=$'\t' read -r t c; do
  n="$(q "SELECT COUNT(*) FROM \`$t\` WHERE REGEXP_LIKE(CAST(\`$c\` AS CHAR), '$EMAIL_RX')")"
  if ((n > 0)); then
    log "LEAK: $t.$c has $n e-mail address(es) outside $ANON_DOMAIN"
    leaks=$((leaks + n))
  fi
done < <(q "SELECT c.table_name, c.column_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('json','text','mediumtext','longtext','tinytext','varchar','char')")
if q "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'" | grep -q 1; then
  n="$(q "SELECT COUNT(*) FROM users WHERE phone NOT LIKE '+1555%' OR email NOT LIKE '%@$ANON_DOMAIN' OR password <> '$PW_HASH'")"
  ((n == 0)) || {
    log "LEAK: $n users keep a real phone, e-mail or password hash"
    leaks=$((leaks + n))
  }
fi
((leaks == 0)) || die "leak check failed ($leaks); nothing written"
log "leak check: clean"

# --- 8. Write -----------------------------------------------------------------------------------
umask 077
mysqldump -h "$ANON_MYSQL_HOST" -P "$ANON_MYSQL_PORT" -u "$ANON_MYSQL_USER" --single-transaction \
  --routines --triggers --hex-blob --default-character-set=utf8mb4 --no-tablespaces "$ANON_DB" |
  gzip -6 >"$OUT"
gunzip -t "$OUT"
log "wrote $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
log "rehearsal: import with LEGACY_DATABASE_URL=mysql://…/$ANON_DB and LEGACY_APP_KEY=<ANON_APP_KEY>;"
log "every user logs in with the rehearsal password (ANON_PASSWORD)"
