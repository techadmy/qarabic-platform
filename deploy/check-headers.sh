#!/usr/bin/env bash
# Read-only check of the security headers nginx sends (docs/39 P0-2, docs/36 §6.7).
# Sends HEAD/GET requests only; changes nothing, so it runs from anywhere (a Mac, CI, the droplet).
#
#   deploy/check-headers.sh https://api.qarabic.com
#   deploy/check-headers.sh https://api.qarabic.com --resolve api.qarabic.com:443:127.0.0.1
#   deploy/check-headers.sh http://127.0.0.1:18080          # CI: nginx + stub upstreams
#
# For /app/login, /api/v1/health and /up it checks: HSTS (max-age ≥ 1 year), nosniff,
# X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, a CSP with frame-ancestors 'none'
# — and that none of these single-value headers appears twice. Exit 0 = all good, 1 = a miss.
set -euo pipefail

BASE="${1:-}"
[[ $BASE =~ ^https?:// ]] || {
  echo "usage: check-headers.sh <base-url> [curl options, e.g. --resolve host:443:ip]" >&2
  exit 2
}
shift
BASE="${BASE%/}"
: "${CHECK_PATHS:=/app/login /api/v1/health /up}"

FAILS=0
miss() {
  FAILS=$((FAILS + 1))
  printf '  FAIL %s: %s\n' "$1" "$2"
}

for path in $CHECK_PATHS; do
  # GET, headers only (some apps answer HEAD differently); body discarded.
  headers="$(curl -s -o /dev/null -D - --max-time 10 "$@" "$BASE$path" | tr -d '\r')"
  status="$(head -n1 <<<"$headers" | awk '{print $2}')"
  printf '%s %s\n' "${status:-???}" "$path"
  [[ -n $status ]] || {
    miss "$path" "no response"
    continue
  }
  get() { grep -i "^$1:" <<<"$headers" || true; }
  count() { grep -ci "^$1:" <<<"$headers" || true; }

  hsts="$(get Strict-Transport-Security)"
  age="$(sed -nE 's/.*max-age=([0-9]+).*/\1/p' <<<"$hsts")"
  [[ -n $age && $age -ge 31536000 ]] || miss "$path" "Strict-Transport-Security max-age ≥ 31536000 (got '${hsts#*: }')"
  grep -qi '^X-Content-Type-Options: *nosniff$' <<<"$headers" || miss "$path" "X-Content-Type-Options: nosniff"
  grep -qi '^X-Frame-Options: *DENY$' <<<"$headers" || miss "$path" "X-Frame-Options: DENY"
  grep -qiE '^Referrer-Policy: *(strict-origin-when-cross-origin|no-referrer|same-origin|strict-origin)$' <<<"$headers" ||
    miss "$path" "Referrer-Policy"
  [[ -n $(get Permissions-Policy) ]] || miss "$path" "Permissions-Policy"
  grep -qi "^Content-Security-Policy:.*frame-ancestors 'none'" <<<"$headers" ||
    miss "$path" "Content-Security-Policy with frame-ancestors 'none'"
  for h in Strict-Transport-Security X-Content-Type-Options X-Frame-Options Referrer-Policy Permissions-Policy; do
    n="$(count "$h")"
    ((n <= 1)) || miss "$path" "$h sent $n times"
  done
done

if ((FAILS)); then
  echo "security headers: $FAILS problem(s)" >&2
  exit 1
fi
echo "security headers: ok"
