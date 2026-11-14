# deploy/ — N8 cut-over on the droplet

Everything the cut-over runbook (`docs/36-n8-cutover-runbook.md`, outside this repo) runs on the
DigitalOcean droplet that serves `api.qarabic.com` today (Laravel + MySQL, managed by Forge).

| File                                           | What                                                                                                                                                                                                                                         | Runbook          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `prepare-server.sh`                            | Postgres 17 (PGDG, `127.0.0.1`, UTC), role + `qarabic` / `qarabic_rehearsal`, Node 24 in `/opt/node24` (SHA-256 checked) + pnpm, user `qarabic`, folders, `/etc/qarabic/api.env` + `api-rehearsal.env` with generated secrets, pm2 boot unit | §3               |
| `backup.sh`                                    | MySQL dump (`--single-transaction`, gzip / size / trailer checked), Laravel tar, React `dist` tar, nginx tar, optional `pg_dump`, `SHA256SUMS`                                                                                               | §4               |
| `release.sh <tag>`                             | tag → `/srv/qarabic/releases/<tag>`, `pnpm install --frozen-lockfile`, build with `NEXT_PUBLIC_BASE_PATH=/app`, `prisma migrate deploy`, `current` symlink, pm2 start/reload, health, keep 5                                                 | §3.3–3.6, §5.3   |
| `switch.sh status\|freeze\|nginx\|jobs-on`     | Laravel down + cron off · nginx include swap (`nginx -t` first) · scheduler on for `qarabic-api` only                                                                                                                                        | §6.2, §6.6, §6.8 |
| `rollback.sh`                                  | Laravel include back, jobs off, `artisan up`, cron back; idempotent                                                                                                                                                                          | §7               |
| `check-headers.sh <base-url>`                  | read-only check of the security headers (HSTS, nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, CSP `frame-ancestors 'none'`, no duplicates); `switch.sh nginx` runs it                                                   | §6.6–6.7         |
| `server-facts.sh`                              | read-only facts (versions, disk, zones, nginx layout, ports, jobs)                                                                                                                                                                           | §1               |
| `ecosystem.config.cjs`                         | pm2: `qarabic-api` :4100, `qarabic-web` :4000, rehearsal pair :4200 / :4001, Node 24                                                                                                                                                         | §3.5, §5.3       |
| `nginx/qarabic-n8.conf`                        | `/app/` → Next, `/api/` → Nest, `/up` → health (body untouched); security headers on all three (docs/39 P0-2)                                                                                                                                | §8               |
| `nginx/qarabic-app.laravel.conf`               | the live Laravel-era include (copy of 2026-11-12), rollback fallback                                                                                                                                                                         | §7               |
| `api.env.example`, `api-rehearsal.env.example` | every API variable, no values                                                                                                                                                                                                                | §3.4             |
| `anonymise/`                                   | anonymise a production MySQL dump for a local rehearsal (docs/37 F6)                                                                                                                                                                         | §5               |
| `tests/deploy.test.sh`                         | harness: fakes on PATH, temp droplet layout; runs in CI with shellcheck and a real `nginx -t`                                                                                                                                                | —                |

## Rules every script follows

- `set -euo pipefail`; `--dry-run` prints every command and changes nothing (works anywhere);
  `--yes` skips the confirmation prompt.
- A real run refuses (exit 2) unless the hostname is `qarabic`, the Laravel app and its nginx site
  exist, and it runs as root.
- No secret is ever printed or put on a command line: the apps read `/etc/qarabic/*.env` through
  Node's `--env-file`; MySQL is read through root's socket (or a temporary `600` defaults file);
  generated secrets are written straight to the env files.
- nginx: Forge owns the site file, so it is never edited. Only the include
  `forge-conf/api.qarabic.com/server/qarabic-app.conf` is swapped (the live one is saved to
  `/etc/qarabic/state/` first) and every change is `nginx -t`-checked before `reload`.

## The order (details and owners in docs/36)

```bash
# once, any day (no user impact)
sudo deploy/prepare-server.sh --dry-run && sudo deploy/prepare-server.sh
# copy WEB_LEADS_WEBHOOK_SECRET, LEGACY_DATABASE_URL, LEGACY_APP_KEY into /etc/qarabic/api.env by hand
sudo deploy/release.sh v2026.MM.DD --rehearsal

# server rehearsal (§5)
sudo deploy/backup.sh
# legacy:import + legacy:verify into qarabic_rehearsal (docs/37 §1 commands)

# the night (§6)
sudo deploy/switch.sh freeze
sudo deploy/backup.sh
# legacy:import + legacy:verify into qarabic
sudo deploy/switch.sh nginx
# smoke (§6.7)
sudo deploy/switch.sh jobs-on

# any time it goes wrong (§7)
sudo deploy/rollback.sh
```

Tests: `bash deploy/tests/deploy.test.sh` (needs bash, node; `nginx` optional).
Shellcheck: `cd deploy && shellcheck -x -P SCRIPTDIR *.sh tests/*.sh anonymise/*.sh`.

## Anonymised rehearsal data (docs/37 §6 F6)

On a dev machine, with a local MySQL (e.g. the docs/37 §7 one on `127.0.0.1:3307`):

```bash
deploy/anonymise/anonymise-mysql-dump.sh ~/qarabic-backups/mysql-<db>.sql.gz ~/qarabic-backups/anon.sql.gz
```

It loads the dump into `qarabic_anon`, replaces names, e-mails, phones, addresses, free text,
meeting links (re-encrypted with a fake key), IPs, tokens and passwords (one known rehearsal
password), scrubs name/e-mail/phone keys inside JSON, and checks that every row count, number sum
and date range is identical before and after and that no e-mail outside `anon.qarabic.test` is
left. It refuses the droplet, a non-local MySQL, a database not named `*_anon` and an output path
inside a git repository. Import it with `LEGACY_DATABASE_URL=mysql://root@127.0.0.1:3307/qarabic_anon`
and `LEGACY_APP_KEY` = the script's `ANON_APP_KEY`.
