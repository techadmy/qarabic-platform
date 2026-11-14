#!/usr/bin/env python3
"""Qarabic guard-rail hook (audit 39, P0-6, D142).

PreToolUse on Bash. Blocks, whatever the model was told:
  - pushes to main/master, force pushes, and remote branch deletion
  - database URLs in a command unless the database name ends in _test or _dev
  - shell access to production hosts (qarabic.com, api.qarabic.com)
  - destructive Prisma commands (migrate reset, db push --accept-data-loss / --force-reset)
Exit code 2 = block; the reason on stderr is shown to Claude.
"""
import json
import re
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if data.get("tool_name") != "Bash":
    sys.exit(0)

cmd = (data.get("tool_input") or {}).get("command") or ""
# Quoted text (commit messages, PR bodies, echo) is not a command: ignore it for the
# push/SSH/Prisma checks. Database URLs are checked on the full command, quotes included.
bare = re.sub(r"<<-?\s*['\"]?(\w+)['\"]?\n.*?^\s*\1\s*$", "", cmd, flags=re.S | re.M)
bare = re.sub(r"\"(?:\\.|[^\"\\])*\"|'[^']*'", "''", bare, flags=re.S)


def block(reason: str) -> None:
    print(f"Blocked by the Qarabic guard hook (.claude/hooks/qarabic-guard.py): {reason}", file=sys.stderr)
    sys.exit(2)


# 1. git push rules (look at each push in a chained command)
for push in re.findall(r"\bgit\s+push\b[^;&|\n]*", bare):
    args = push.split()[2:]
    if any(a in ("-f", "--force", "--force-with-lease") or a.startswith("--force") for a in args):
        block("force push is not allowed; push a merge commit instead.")
    if "--delete" in args or "-d" in args or any(a.startswith(":") for a in args):
        block("deleting remote branches needs Ahmed's explicit OK.")
    refs = [a for a in args if not a.startswith("-")]
    for ref in refs[1:]:  # refs[0] is the remote
        dest = ref.split(":")[-1]
        if dest in ("main", "master", "refs/heads/main", "refs/heads/master"):
            block("never push to main directly; open a PR (CLAUDE.md working rules).")

# 2. database URLs: only *_test or *_dev databases
for m in re.finditer(r"postgres(?:ql)?://[^\s'\"]+", cmd):
    url = m.group(0)
    dbname = re.split(r"[?#]", url.rsplit("/", 1)[-1])[0] if url.count("/") >= 3 else ""
    if not re.search(r"_(test|dev)$", dbname):
        block(f"database '{dbname or '?'}' is not a *_test or *_dev database; never use production data.")
for m in re.finditer(r"mysql://[^\s'\"]+", cmd):
    block("MySQL URLs are the old live system; use the read-only migration path only with Ahmed's OK.")

# 3. production hosts over a shell
if re.search(r"\b(ssh|scp|sftp|rsync)\b[^;&|\n]*\b(qarabic\.com|api\.qarabic\.com)\b", bare):
    block("shell access to production hosts needs Ahmed's explicit go (N8).")

# 4. destructive Prisma commands
if re.search(r"\bprisma\s+migrate\s+reset\b", bare) or re.search(
    r"\bprisma\s+db\s+push\b[^;&|\n]*--(accept-data-loss|force-reset)", bare
):
    block("destructive Prisma command; create a fresh *_test database instead.")

sys.exit(0)
