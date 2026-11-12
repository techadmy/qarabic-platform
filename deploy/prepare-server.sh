#!/usr/bin/env bash
# One-time server preparation for the new stack (docs/36 §3). No user impact: nothing here
# touches Laravel, MySQL data, nginx or the live app. Safe to run again (idempotent).
#
#   sudo deploy/prepare-server.sh --dry-run      # print the plan
#   sudo deploy/prepare-server.sh                # do it (asks for 'yes')
#
# Steps: Postgres 17 (PGDG apt repo, 127.0.0.1 only, timezone UTC) · role + databases
# `qarabic` and `qarabic_rehearsal` · Node 24 tarball in /opt/node24 (SHA-256 checked) + pnpm
# (corepack) · system user `qarabic` · folders · /etc/qarabic/api.env and api-rehearsal.env
# from the templates, with generated secrets (never printed) · pm2 boot service for `qarabic`.
SCRIPT_NAME=prepare-server
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

: "${NODE_VERSION:=v24.22.3}"
: "${PG_MAJOR:=17}"
: "${PG_DB:=qarabic}"
: "${PG_REHEARSAL_DB:=qarabic_rehearsal}"
: "${PG_ROLE:=qarabic}"

parse_common_flags "$@"
require_droplet
confirm "Install Postgres $PG_MAJOR and Node $NODE_VERSION on $(hostname)?"

# --- 1. Postgres 17 from PGDG ---------------------------------------------------------------
install_postgres() {
  if command -v "/usr/lib/postgresql/$PG_MAJOR/bin/postgres" >/dev/null 2>&1; then
    log "Postgres $PG_MAJOR already installed"
  else
    run apt-get update -q
    run apt-get install -y -q postgresql-common ca-certificates
    # Official PGDG helper: adds apt.postgresql.org with its signed key, no prompts.
    run /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
    run apt-get install -y -q "postgresql-$PG_MAJOR"
  fi
  local conf="/etc/postgresql/$PG_MAJOR/main/conf.d/qarabic.conf"
  # Local connections only; UTC sessions (docs/37 F1; the API also forces it, PR #13).
  write_file "$conf" 644 postgres:postgres <<'EOF'
listen_addresses = '127.0.0.1'
timezone = 'UTC'
log_timezone = 'UTC'
EOF
  run systemctl enable --now "postgresql@$PG_MAJOR-main"
  run systemctl restart "postgresql@$PG_MAJOR-main"
}

psql_q() { run sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA -c "$1"; }

# Role password: generated here, written only to the env files (mode 640), never printed.
create_role_and_dbs() {
  local exists pw
  if ((DRY_RUN)); then
    printf '  + create role %s (generated password) and databases %s, %s if missing\n' \
      "$PG_ROLE" "$PG_DB" "$PG_REHEARSAL_DB" >&2
    return 0
  fi
  exists="$(sudo -u postgres psql -qtA -c "SELECT 1 FROM pg_roles WHERE rolname='$PG_ROLE'")"
  if [[ $exists == 1 && -n $(env_get "$QARABIC_ETC/api.env" DATABASE_URL) ]]; then
    log "role $PG_ROLE exists and api.env has its URL (password unchanged)"
  else
    # New role, or a role whose URL was never written (an earlier run stopped): (re)set it.
    local verb=CREATE
    [[ $exists == 1 ]] && verb=ALTER
    pw="$(openssl rand -hex 24)"
    # Password sent on stdin, so it is not in the process list.
    printf "%s ROLE %s LOGIN PASSWORD '%s';\n" "$verb" "$PG_ROLE" "$pw" |
      sudo -u postgres psql -v ON_ERROR_STOP=1 -q >/dev/null
    PG_URL_PROD="postgresql://$PG_ROLE:$pw@127.0.0.1:5432/$PG_DB"
    PG_URL_REH="postgresql://$PG_ROLE:$pw@127.0.0.1:5432/$PG_REHEARSAL_DB"
    unset pw
    log "$verb ROLE $PG_ROLE done (password not shown)"
  fi
  local db
  for db in "$PG_DB" "$PG_REHEARSAL_DB"; do
    if [[ $(sudo -u postgres psql -qtA -c "SELECT 1 FROM pg_database WHERE datname='$db'") != 1 ]]; then
      psql_q "CREATE DATABASE $db OWNER $PG_ROLE ENCODING 'UTF8' TEMPLATE template0"
    fi
    psql_q "ALTER DATABASE $db SET timezone TO 'UTC'"
  done
}

# --- 2. Node 24 in its own folder (system Node 18 untouched) ---------------------------------
install_node() {
  local have=""
  [[ -x $QARABIC_NODE_DIR/bin/node ]] && have="$("$QARABIC_NODE_DIR/bin/node" -v)"
  if [[ $have == "$NODE_VERSION" ]]; then
    log "Node $NODE_VERSION already in $QARABIC_NODE_DIR"
  else
    local tar="node-$NODE_VERSION-linux-x64.tar.xz" tmp
    tmp="$(mktemp -d)"
    run curl -fsSL -o "$tmp/$tar" "https://nodejs.org/dist/$NODE_VERSION/$tar"
    run curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
    if ((DRY_RUN)); then
      printf '  + sha256sum -c (only %s)\n' "$tar" >&2
    else
      (cd "$tmp" && grep " $tar\$" SHASUMS256.txt | sha256sum -c -) || die "Node checksum mismatch"
      # Optional extra pin, e.g. NODE_SHA256=<from nodejs.org> deploy/prepare-server.sh
      if [[ -n ${NODE_SHA256:-} ]]; then
        [[ $(sha256sum "$tmp/$tar" | cut -d' ' -f1) == "$NODE_SHA256" ]] || die "NODE_SHA256 mismatch"
      fi
    fi
    run rm -rf "$QARABIC_NODE_DIR.new"
    run mkdir -p "$QARABIC_NODE_DIR.new"
    run tar -xJf "$tmp/$tar" -C "$QARABIC_NODE_DIR.new" --strip-components=1
    run rm -rf "$QARABIC_NODE_DIR"
    run mv "$QARABIC_NODE_DIR.new" "$QARABIC_NODE_DIR"
    run rm -rf "$tmp"
  fi
  # pnpm at the version in package.json#packageManager, through corepack of Node 24.
  run env "PATH=$QARABIC_NODE_DIR/bin:/usr/bin:/bin" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "$QARABIC_NODE_DIR/bin/corepack" enable --install-directory "$QARABIC_NODE_DIR/bin" pnpm
}

# --- 3. User, folders ------------------------------------------------------------------------
create_user_and_dirs() {
  if id "$QARABIC_USER" >/dev/null 2>&1; then
    log "user $QARABIC_USER exists"
  else
    run useradd --system --create-home --home-dir "/home/$QARABIC_USER" --shell /bin/bash "$QARABIC_USER"
  fi
  run install -d -m 755 -o "$QARABIC_USER" -g "$QARABIC_USER" "$QARABIC_SRV" "$QARABIC_SRV/releases"
  run install -d -m 750 -o "$QARABIC_USER" -g "$QARABIC_USER" "$QARABIC_SRV/storage" \
    "$QARABIC_SRV/storage/private" "$QARABIC_SRV/storage/rehearsal"
  run install -d -m 750 -o "$QARABIC_USER" -g "$QARABIC_USER" "$QARABIC_LOG_DIR"
  run install -d -m 750 -o root -g "$QARABIC_USER" "$QARABIC_ETC"
  run install -d -m 700 -o root -g root "$QARABIC_BACKUP_DIR"
}

# --- 4. Env files (only missing keys are filled; existing values are never touched) ----------
fill_env() { # fill_env <file> <template> <db-url-or-empty>
  local file=$1 template=$2 url=$3
  if ((DRY_RUN)); then
    printf '  + create %s from %s if missing; fill empty DATABASE_URL/SESSION_SECRET (+ APP_ENCRYPTION_KEY in api.env)\n' \
      "$file" "$(basename "$template")" >&2
    return 0
  fi
  if [[ ! -f $file ]]; then
    grep -vE '^\s*#|^\s*$' "$template" | write_file "$file" 640 "root:$QARABIC_USER"
  fi
  # A URL is generated only with a new password: then it replaces the old one.
  [[ -n $url ]] && env_set_secret "$file" DATABASE_URL "$url"
  [[ -z $(env_get "$file" SESSION_SECRET) ]] && env_set_secret "$file" SESSION_SECRET "$(openssl rand -hex 32)"
  if [[ $file == "$QARABIC_ETC/api.env" && -z $(env_get "$file" APP_ENCRYPTION_KEY) ]]; then
    env_set_secret "$file" APP_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  fi
  return 0
}

# Like env_set, but logs only the key name.
env_set_secret() {
  local file=$1 key=$2 value=$3 tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  grep -vE "^${key}=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  chmod 640 "$tmp"
  chown "root:$QARABIC_USER" "$tmp"
  mv -f "$tmp" "$file"
  log "generated $key in $file (not shown)"
}

write_env_files() {
  PG_URL_PROD="${PG_URL_PROD:-}"
  PG_URL_REH="${PG_URL_REH:-}"
  fill_env "$QARABIC_ETC/api.env" "$DEPLOY_DIR/api.env.example" "$PG_URL_PROD"
  # The rehearsal file holds only overrides: Node reads api.env first, then this one
  # (`--env-file` twice, the last wins). Its own session secret; the same encryption key.
  fill_env "$QARABIC_ETC/api-rehearsal.env" "$DEPLOY_DIR/api-rehearsal.env.example" "$PG_URL_REH"
  log "next: copy WEB_LEADS_WEBHOOK_SECRET, LEGACY_DATABASE_URL, LEGACY_APP_KEY by hand (docs/36 §3.4)"
  log "next: back up APP_ENCRYPTION_KEY offline (docs/36 §3.4)"
}

# --- 5. pm2 boot service for the app user ----------------------------------------------------
pm2_boot() {
  if [[ -f /etc/systemd/system/pm2-$QARABIC_USER.service ]]; then
    log "pm2-$QARABIC_USER.service exists"
  else
    run env "PATH=$QARABIC_NODE_DIR/bin:/usr/bin:/bin" pm2 startup systemd -u "$QARABIC_USER" \
      --hp "/home/$QARABIC_USER" --service-name "pm2-$QARABIC_USER"
  fi
}

install_postgres
create_role_and_dbs
install_node
create_user_and_dirs
write_env_files
pm2_boot
log "done. Health of the toolchain:"
run "$QARABIC_NODE_DIR/bin/node" -v
run sudo -u postgres psql -qtA -c "SHOW timezone"
