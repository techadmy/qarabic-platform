#!/usr/bin/env bash
# shellcheck disable=SC2016  # fake bodies expand in the fake, not here
# Tests for deploy/*.sh and deploy/anonymise/*.sh. Nothing here can reach a server: every
# system command the scripts use (hostname, id, sudo, nginx, systemctl, pm2, crontab, curl,
# mysqldump, apt-get, …) is a fake on PATH that only logs, and every path points into a temp
# folder. Run: bash deploy/tests/deploy.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REAL_NGINX="$(command -v nginx || true)"

FAILS=0
PASSES=0
ok() {
  PASSES=$((PASSES + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  FAILS=$((FAILS + 1))
  printf '  FAIL %s\n' "$1"
}
check() { # check <name> <command...>
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}
has() { grep -qE -- "$1" "$2"; }
hasnt() { ! grep -qE -- "$1" "$2"; }
lineno() { grep -nE -- "$1" "$2" | head -n1 | cut -d: -f1; }
before() { # before <regex-a> <regex-b> <file>: both occur, a first
  local a b
  a="$(lineno "$1" "$3")"
  b="$(lineno "$2" "$3")"
  [[ -n $a && -n $b && $a -lt $b ]]
}

# --- fakes ------------------------------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
fake() { # fake <name> [body]: logs "<name> <args>" then runs body
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$FAKE_LOG"\n%s\n' "$1" "${2:-exit 0}" >"$BIN/$1"
  chmod +x "$BIN/$1"
}
fake hostname 'echo "${FAKE_HOSTNAME:-ci-runner}"'
fake id 'if [[ ${1:-} == -u ]]; then echo "${FAKE_UID:-1000}"; fi; exit 0'
fake chown
fake nginx 'if [[ ${1:-} == -t && -n ${FAKE_NGINX_FAIL:-} ]]; then exit 1; fi; exit 0'
fake systemctl
fake pm2
fake apt-get
fake psql
fake git
fake curl 'printf "%s" "${FAKE_CURL_CODE:-200}"'
fake mysql 'exit 0'
fake mysqldump 'head -c "${FAKE_DUMP_BYTES:-200000}" /dev/urandom | base64; echo; [[ -n ${FAKE_DUMP_NO_TRAILER:-} ]] || echo "-- Dump completed on 2026-11-12"'
fake crontab '
f="$FAKE_CRONTAB"
case "${*: -1}" in
  -l) cat "$f" 2>/dev/null ;;
  -) cat >"$f" ;;
  *) cp "${*: -1}" "$f" ;;
esac'
# sudo: log only, but play Laravel maintenance mode so the scripts can see it.
fake sudo '
case "$*" in
  *"artisan down"*) mkdir -p "$FAKE_LARAVEL/storage/framework"; touch "$FAKE_LARAVEL/storage/framework/down" ;;
  *"artisan up"*) rm -f "$FAKE_LARAVEL/storage/framework/down" ;;
esac
exit 0'
# install(1): drop -o/-g (owners need root), then the real install into the temp tree.
cat >"$BIN/install" <<'FAKE'
#!/usr/bin/env bash
echo "install $*" >>"$FAKE_LOG"
args=()
skip=0
for a in "$@"; do
  if ((skip)); then skip=0; continue; fi
  case $a in -o | -g) skip=1 ;; *) args+=("$a") ;; esac
done
exec /usr/bin/install "${args[@]}"
FAKE
chmod +x "$BIN/install"

export PATH="$BIN:$PATH"
export FAKE_LOG="$TMP/fake.log" FAKE_CRONTAB="$TMP/crontab"

# --- a fake droplet layout ------------------------------------------------------------------------
ROOT="$TMP/root"
export QARABIC_ETC="$ROOT/etc/qarabic" QARABIC_SRV="$ROOT/srv" QARABIC_LOG_DIR="$ROOT/log" \
  QARABIC_BACKUP_DIR="$ROOT/backups" QARABIC_NODE_DIR="$ROOT/node24" \
  QARABIC_LARAVEL_DIR="$ROOT/forge/api.qarabic.com" QARABIC_APP_DIST="$ROOT/forge/qarabic-app/dist" \
  QARABIC_NGINX_SITE="$ROOT/nginx/sites-available/api.qarabic.com" \
  QARABIC_NGINX_INCLUDE_DIR="$ROOT/nginx/forge-conf/api.qarabic.com/server"
export FAKE_LARAVEL="$QARABIC_LARAVEL_DIR" HEALTH_SLEEP=0 HEALTH_RETRIES=2
SECRET_A="s3cr3t-session-value-0123456789abcdef"
SECRET_B="AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEF="
SECRET_C="laravel-db-password-zz9"
reset_droplet() {
  rm -rf "$ROOT" "$FAKE_CRONTAB"
  mkdir -p "$QARABIC_ETC" "$QARABIC_LARAVEL_DIR/config" "$QARABIC_APP_DIST" \
    "$(dirname "$QARABIC_NGINX_SITE")" "$QARABIC_NGINX_INCLUDE_DIR" "$QARABIC_SRV"
  touch "$QARABIC_LARAVEL_DIR/artisan" "$QARABIC_NGINX_SITE" "$QARABIC_APP_DIST/index.html"
  printf 'APP_TIMEZONE=UTC\nDB_DATABASE=qarabic_live\nDB_USERNAME=forge\nDB_PASSWORD=%s\n' \
    "$SECRET_C" >"$QARABIC_LARAVEL_DIR/.env"
  cp "$DEPLOY/nginx/qarabic-app.laravel.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
  {
    grep -vE '^\s*#|^\s*$' "$DEPLOY/api.env.example" |
      sed -E "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://qarabic:pw@127.0.0.1:5432/qarabic|" |
      sed -E "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET_A|" |
      sed -E "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$SECRET_B|" |
      sed -E "s|<set on server>|filled-on-server-1234567890|"
  } >"$QARABIC_ETC/api.env"
  printf "PORT=4200\nDATABASE_URL=postgresql://q:pw@127.0.0.1:5432/qarabic_rehearsal\nWEB_ORIGIN=http://localhost:4001\nAPP_URL=http://localhost:4001/app\nSESSION_SECRET=%s\nSCHEDULER_ENABLED=false\n" "$SECRET_A" >"$QARABIC_ETC/api-rehearsal.env"
  printf '* * * * * cd %s && php artisan schedule:run >> /dev/null 2>&1\n' "$QARABIC_LARAVEL_DIR" >"$FAKE_CRONTAB"
}
on_droplet() { export FAKE_HOSTNAME=qarabic FAKE_UID=0; }
off_droplet() { export FAKE_HOSTNAME=ci-runner FAKE_UID=1000; }

run() { # run <output-file> <cmd...>: output + exit code in $RC
  local out=$1
  shift
  : >"$FAKE_LOG"
  "$@" >"$out" 2>&1 </dev/null
  RC=$?
}
no_secrets() { ! grep -qE -- "$SECRET_A|$SECRET_B|$SECRET_C" "$@"; }
MUTATING='^(nginx|systemctl|pm2|apt-get|crontab [^-]|crontab -$|mysqldump|psql|git|sudo)'

# --- 1. Dry runs work anywhere and change nothing --------------------------------------------------
echo "dry runs (not the droplet)"
reset_droplet
off_droplet
for s in "prepare-server.sh" "backup.sh" "release.sh v2026.11.20 --rehearsal" "switch.sh freeze" \
  "switch.sh nginx" "switch.sh jobs-on" "rollback.sh" "server-facts.sh"; do
  read -r -a cmd <<<"$s"
  run "$TMP/dry.out" "$DEPLOY/${cmd[0]}" --dry-run "${cmd[@]:1}"
  check "$s --dry-run exits 0" test "$RC" -eq 0
  check "$s --dry-run runs nothing" hasnt "$MUTATING" "$FAKE_LOG"
  check "$s --dry-run prints no secret" no_secrets "$TMP/dry.out"
done
check "laravel include untouched by dry runs" cmp -s "$DEPLOY/nginx/qarabic-app.laravel.conf" \
  "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
check "crontab untouched by dry runs" hasnt '^# n8-disabled' "$FAKE_CRONTAB"

run "$TMP/dry.out" "$DEPLOY/release.sh" --dry-run v2026.11.20 --rehearsal
check "release plans a frozen-lockfile install" has 'pnpm install --frozen-lockfile' "$TMP/dry.out"
check "release builds with basePath /app" has 'NEXT_PUBLIC_BASE_PATH=/app' "$TMP/dry.out"
check "release builds with mocks off" has 'NEXT_PUBLIC_ENABLE_MOCKS=false' "$TMP/dry.out"
check "release builds the rehearsal web into .next-rehearsal" has 'NEXT_DIST_DIR=.next-rehearsal' "$TMP/dry.out"
check "release migrates (deploy, never seed)" has 'migrate deploy' "$TMP/dry.out"
check "release never seeds" hasnt 'db:seed|prisma db seed' "$TMP/dry.out"
check "release builds before migrating" before 'pnpm build' 'migrate deploy' "$TMP/dry.out"
check "release migrates before starting" before 'migrate deploy' 'startOrReload' "$TMP/dry.out"
check "release env read by node, not the shell" has 'node --env-file=' "$DEPLOY/release.sh"

run "$TMP/dry.out" "$DEPLOY/prepare-server.sh" --dry-run
check "prepare installs postgresql-17" has 'postgresql-17' "$TMP/dry.out"
check "prepare checks the Node checksum" has 'sha256sum' "$TMP/dry.out"
check "prepare: Postgres on 127.0.0.1, UTC" has "listen_addresses = '127.0.0.1'" "$DEPLOY/prepare-server.sh"
check "prepare: database timezone UTC" has "timezone TO 'UTC'" "$DEPLOY/prepare-server.sh"

# --- 2. Real runs refuse anywhere but the droplet --------------------------------------------------
echo "real runs off the droplet are refused"
for s in "prepare-server.sh --yes" "backup.sh" "release.sh v2026.11.20" "switch.sh freeze --yes" \
  "switch.sh nginx --yes" "switch.sh jobs-on --yes" "rollback.sh --yes" "server-facts.sh"; do
  read -r -a cmd <<<"$s"
  run "$TMP/ref.out" "$DEPLOY/${cmd[0]}" "${cmd[@]:1}"
  check "$s → exit 2" test "$RC" -eq 2
  check "$s → says why" has 'REFUSED: this is not the Qarabic droplet' "$TMP/ref.out"
  check "$s → ran nothing" hasnt "$MUTATING" "$FAKE_LOG"
done
reset_droplet
on_droplet
export FAKE_HOSTNAME=qarabic-copy
run "$TMP/ref.out" "$DEPLOY/switch.sh" freeze --yes
check "another hostname is refused even as root" test "$RC" -eq 2

# --- 3. The night on a fake droplet ------------------------------------------------------------------
echo "switch / rollback on a fake droplet"
reset_droplet
on_droplet
run "$TMP/s.out" "$DEPLOY/switch.sh" nginx --yes
check "nginx before freeze is refused" test "$RC" -eq 2
check "… and nginx untouched" cmp -s "$DEPLOY/nginx/qarabic-app.laravel.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"

run "$TMP/s.out" "$DEPLOY/switch.sh" jobs-on --yes
check "jobs-on before the switch is refused" test "$RC" -eq 2

run "$TMP/s.out" "$DEPLOY/switch.sh" freeze --yes
check "freeze exits 0" test "$RC" -eq 0
check "freeze puts Laravel down" test -f "$QARABIC_LARAVEL_DIR/storage/framework/down"
check "freeze disables the Laravel cron line" has '^# n8-disabled .*schedule:run' "$FAKE_CRONTAB"
check "freeze saves the crontab" test -f "$QARABIC_ETC/state/forge-crontab.orig"
run "$TMP/s2.out" "$DEPLOY/switch.sh" freeze --yes
check "freeze twice is harmless" has '^# n8-disabled .*schedule:run' "$FAKE_CRONTAB"
check "… and does not double-prefix" hasnt '^# n8-disabled # n8-disabled' "$FAKE_CRONTAB"

FAKE_CURL_CODE=502 run "$TMP/s.out" "$DEPLOY/switch.sh" nginx --yes
check "nginx refused while the new API is unhealthy" test "$RC" -eq 2
check "… nginx untouched" cmp -s "$DEPLOY/nginx/qarabic-app.laravel.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"

FAKE_NGINX_FAIL=1 run "$TMP/s.out" "$DEPLOY/switch.sh" nginx --yes
check "nginx -t failure aborts" test "$RC" -eq 1
check "… puts the Laravel include back" cmp -s "$DEPLOY/nginx/qarabic-app.laravel.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
check "… and never reloads" hasnt 'systemctl reload' "$FAKE_LOG"

run "$TMP/s.out" "$DEPLOY/switch.sh" nginx --yes
check "nginx switch exits 0" test "$RC" -eq 0
check "nginx include is the N8 file" cmp -s "$DEPLOY/nginx/qarabic-n8.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
check "Laravel include saved for rollback" cmp -s "$DEPLOY/nginx/qarabic-app.laravel.conf" "$QARABIC_ETC/state/qarabic-app.conf.laravel"
check "nginx -t before reload" before '^nginx -t' '^systemctl reload nginx' "$FAKE_LOG"
check "the Forge site file is never edited" test ! -s "$QARABIC_NGINX_SITE"
check "switch time recorded" test -f "$QARABIC_ETC/state/switched-at"

run "$TMP/s.out" "$DEPLOY/switch.sh" jobs-on --yes
check "jobs-on exits 0" test "$RC" -eq 0
check "jobs-on sets SCHEDULER_ENABLED=true" has '^SCHEDULER_ENABLED=true$' "$QARABIC_ETC/api.env"
check "jobs-on restarts qarabic-api only" has 'pm2 restart qarabic-api --update-env' "$FAKE_LOG"
check "rehearsal scheduler stays off" has '^SCHEDULER_ENABLED=false$' "$QARABIC_ETC/api-rehearsal.env"
check "jobs-on keeps the secrets in api.env" has "^SESSION_SECRET=$SECRET_A\$" "$QARABIC_ETC/api.env"
check "jobs-on prints no secret" no_secrets "$TMP/s.out"

run "$TMP/st.out" "$DEPLOY/switch.sh" status
check "status shows the new stack" has 'new stack' "$TMP/st.out"
check "status prints no secret" no_secrets "$TMP/st.out"

run "$TMP/r.out" "$DEPLOY/rollback.sh" --yes
check "rollback exits 0" test "$RC" -eq 0
check "rollback restores the Laravel include" cmp -s "$DEPLOY/nginx/qarabic-app.laravel.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
check "rollback checks nginx before reload" before '^nginx -t' '^systemctl reload nginx' "$FAKE_LOG"
check "rollback turns the new jobs off" has '^SCHEDULER_ENABLED=false$' "$QARABIC_ETC/api.env"
check "rollback brings Laravel up" test ! -f "$QARABIC_LARAVEL_DIR/storage/framework/down"
check "rollback restores the Laravel cron" hasnt '^# n8-disabled' "$FAKE_CRONTAB"
check "… the cron line is active" has '^\* \* \* \* \* cd .*schedule:run' "$FAKE_CRONTAB"
check "rollback names the re-entry window" has 'NOT in MySQL' "$TMP/r.out"
check "rollback prints no secret" no_secrets "$TMP/r.out"
run "$TMP/r2.out" "$DEPLOY/rollback.sh" --yes
check "rollback twice is harmless" test "$RC" -eq 0

reset_droplet
on_droplet
rm -f "$QARABIC_ETC/state/qarabic-app.conf.laravel"
cp "$DEPLOY/nginx/qarabic-n8.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"
run "$TMP/r.out" "$DEPLOY/rollback.sh" --yes
check "rollback without a saved copy uses the repo's Laravel include" \
  cmp -s "$DEPLOY/nginx/qarabic-app.laravel.conf" "$QARABIC_NGINX_INCLUDE_DIR/qarabic-app.conf"

# --- 4. Release gates --------------------------------------------------------------------------------
echo "release gates"
reset_droplet
on_droplet
run "$TMP/rel.out" "$DEPLOY/release.sh" main
check "release refuses a branch name" test "$RC" -eq 2
sed -i.bak -E 's|^WEB_LEADS_WEBHOOK_SECRET=.*|WEB_LEADS_WEBHOOK_SECRET=<set on server>|; s|^SESSION_SECRET=.*|SESSION_SECRET=|' "$QARABIC_ETC/api.env"
run "$TMP/rel.out" "$DEPLOY/release.sh" v2026.11.20
check "release refuses an incomplete api.env" test "$RC" -eq 2
check "… naming the missing keys" has 'SESSION_SECRET' "$TMP/rel.out"
check "… and the placeholders" has 'WEB_LEADS_WEBHOOK_SECRET' "$TMP/rel.out"
check "… without printing values" no_secrets "$TMP/rel.out"
check "… before any build" hasnt '^(sudo|git|pm2)' "$FAKE_LOG"
reset_droplet
sed -i.bak -E 's|^BILLING_ALLOW_LIVE=.*|BILLING_ALLOW_LIVE=true|' "$QARABIC_ETC/api.env"
run "$TMP/rel.out" "$DEPLOY/release.sh" v2026.11.20
check "release refuses BILLING_ALLOW_LIVE=true" test "$RC" -eq 2
reset_droplet
sed -i.bak -E 's/^SCHEDULER_ENABLED=.*/SCHEDULER_ENABLED=true/' "$QARABIC_ETC/api-rehearsal.env"
run "$TMP/rel.out" "$DEPLOY/release.sh" v2026.11.20
check "release refuses a rehearsal env with jobs on" test "$RC" -eq 2

# --- 5. Backup ---------------------------------------------------------------------------------------
echo "backup on a fake droplet"
reset_droplet
on_droplet
export MIN_DUMP_BYTES=100000
run "$TMP/b.out" "$DEPLOY/backup.sh"; [[ -n ${DEBUG:-} ]] && cat "$TMP/b.out"
check "backup exits 0" test "$RC" -eq 0
OUTDIR="$(tail -n1 "$TMP/b.out")"
check "backup writes the MySQL dump" test -s "$OUTDIR/mysql-qarabic_live.sql.gz"
check "backup dump is valid gzip" gunzip -t "$OUTDIR/mysql-qarabic_live.sql.gz"
check "backup tars Laravel" test -s "$OUTDIR/laravel-app.tar.gz"
check "backup tars the React dist" test -s "$OUTDIR/app-dist.tar.gz"
check "backup tars nginx" test -s "$OUTDIR/nginx.tar.gz"
check "backup writes SHA256SUMS" test -s "$OUTDIR/SHA256SUMS"
check "backup uses a consistent snapshot" has 'mysqldump .*--single-transaction' "$FAKE_LOG"
check "backup prints no secret" no_secrets "$TMP/b.out"
check "backup never puts the DB password on a command line" no_secrets "$FAKE_LOG"
FAKE_DUMP_NO_TRAILER=1 run "$TMP/b.out" "$DEPLOY/backup.sh"
check "backup fails on a truncated dump" test "$RC" -ne 0
FAKE_DUMP_BYTES=10 run "$TMP/b.out" "$DEPLOY/backup.sh"
check "backup fails on a tiny dump" test "$RC" -ne 0

# --- 6. Static config checks -------------------------------------------------------------------------
echo "nginx + pm2 config"
N8="$DEPLOY/nginx/qarabic-n8.conf"
check "/app/ goes to Next on 4000 keeping the prefix" has 'proxy_pass http://127.0.0.1:4000;' "$N8"
check "/app/ wins over the PHP regex (^~)" has 'location \^~ /app/' "$N8"
check "/api/ goes to Nest on 4100" has 'proxy_pass http://127.0.0.1:4100;' "$N8"
check "/api/ wins over the PHP regex (^~)" has 'location \^~ /api/' "$N8"
check "/up goes to the health endpoint" has 'location = /up' "$N8"
check "no body rewriting directives" hasnt 'sub_filter|proxy_set_body|gunzip on' "$N8"
check "Laravel include serves the React dist" has 'alias /home/forge/qarabic-app/dist/' "$DEPLOY/nginx/qarabic-app.laravel.conf"
if command -v node >/dev/null; then
  check "pm2 ecosystem: four apps, Node 24, right ports" node -e '
    const c = require(process.argv[1]);
    const by = Object.fromEntries(c.apps.map((a) => [a.name, a]));
    const ok = c.apps.length === 4
      && c.apps.every((a) => a.interpreter.endsWith("/node24/bin/node"))
      && by["qarabic-web"].args === "start -p 4000 -H 127.0.0.1"
      && by["qarabic-web-rehearsal"].args === "start -p 4001 -H 127.0.0.1"
      && by["qarabic-web-rehearsal"].env.NEXT_DIST_DIR === ".next-rehearsal"
      && by["qarabic-api"].node_args[0].endsWith("/api.env")
      && by["qarabic-api-rehearsal"].node_args[1].endsWith("/api-rehearsal.env") && by["qarabic-api-rehearsal"].node_args[0].endsWith("/api.env")
      && !JSON.stringify(c).match(/SECRET|PASSWORD|DATABASE_URL=/);
    process.exit(ok ? 0 : 1);' "$DEPLOY/ecosystem.config.cjs"
fi
check "api.env.example has no values for secrets" \
  grep -qE '^SESSION_SECRET=$' "$DEPLOY/api.env.example"
check "api.env.example keeps jobs off and money test-only" \
  bash -c "grep -q '^SCHEDULER_ENABLED=false$' '$DEPLOY/api.env.example' && grep -q '^BILLING_ALLOW_LIVE=false$' '$DEPLOY/api.env.example'"
if [[ -n $REAL_NGINX ]]; then
  mkdir -p "$TMP/ngx/logs"
  for f in qarabic-n8.conf qarabic-app.laravel.conf; do
    cat >"$TMP/ngx/$f.nginx.conf" <<EOF
pid $TMP/ngx/nginx.pid;
error_log $TMP/ngx/logs/error.log;
events {}
http {
  access_log off;
  client_body_temp_path $TMP/ngx/body; proxy_temp_path $TMP/ngx/proxy;
  fastcgi_temp_path $TMP/ngx/fcgi; uwsgi_temp_path $TMP/ngx/uwsgi; scgi_temp_path $TMP/ngx/scgi;
  server {
    listen 127.0.0.1:18080;
    server_name api.qarabic.com;
    root $TMP/ngx;
    include $DEPLOY/nginx/$f;
    location / { try_files \$uri /index.php?\$query_string; }
    location ~ \.php\$ { return 404; }
  }
}
EOF
    check "real nginx -t accepts $f" "$REAL_NGINX" -t -q -e "$TMP/ngx/logs/err.log" -p "$TMP/ngx" -c "$TMP/ngx/$f.nginx.conf"
  done
else
  echo "  (skip) nginx not installed: syntax check runs in CI"
fi

# --- 7. Anonymiser guards ----------------------------------------------------------------------------
echo "anonymiser guards"
ANON="$DEPLOY/anonymise/anonymise-mysql-dump.sh"
echo "-- empty" | gzip >"$TMP/in.sql.gz"
mkdir -p "$TMP/outside"
off_droplet
run "$TMP/a.out" "$ANON" --dry-run "$TMP/in.sql.gz" "$TMP/outside/out.sql.gz"
check "anonymiser dry run exits 0" test "$RC" -eq 0
check "anonymiser dry run touches no MySQL" hasnt '^(mysql|mysqldump)' "$FAKE_LOG"
ANON_DB=qarabic run "$TMP/a.out" "$ANON" "$TMP/in.sql.gz" "$TMP/outside/out.sql.gz"
check "anonymiser refuses a database not named *_anon" test "$RC" -eq 2
ANON_MYSQL_HOST=10.0.0.5 run "$TMP/a.out" "$ANON" "$TMP/in.sql.gz" "$TMP/outside/out.sql.gz"
check "anonymiser refuses a remote MySQL" test "$RC" -eq 2
FAKE_HOSTNAME=qarabic run "$TMP/a.out" "$ANON" "$TMP/in.sql.gz" "$TMP/outside/out.sql.gz"
check "anonymiser refuses to run on the droplet" test "$RC" -eq 2
run "$TMP/a.out" "$ANON" "$TMP/in.sql.gz" "$DEPLOY/out.sql.gz"
check "anonymiser refuses to write inside a git repo" test "$RC" -eq 2
check "… and wrote nothing there" test ! -e "$DEPLOY/out.sql.gz"
check "anonymise.sql keeps money and ids (no UPDATE of *_minor or id)" \
  bash -c "! grep -qiE '(_minor|amount|\\bid)\\s*=' '$DEPLOY/anonymise/anonymise.sql'"

echo
echo "passed: $PASSES  failed: $FAILS"
((FAILS == 0))
