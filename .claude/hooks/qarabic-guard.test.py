import json, subprocess, sys
import os
H = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "qarabic-guard.py")
cases = [
    ("git push origin main", 2), ("git push origin HEAD:main", 2), ("git push -u origin feat/x", 0),
    ("git push --force origin x", 2), ("git push origin --delete x", 2), ("git push origin :x", 2),
    ('git commit -m "mentions prisma migrate reset and git push origin main"', 0),
    ('gh pr create --body "ssh root@api.qarabic.com"', 0),
    ("psql postgresql://u@h:5433/qarabic -c x", 2), ('psql "postgresql://u@h:5433/qarabic" -c x', 2),
    ("psql postgresql://u@h:5433/qarabic_test", 0), ("DATABASE_URL=postgres://u:p@h/q_dev?schema=public pnpm test", 0),
    ("ssh root@api.qarabic.com", 2), ("curl -s https://api.qarabic.com/health", 0),
    ("pnpm prisma migrate reset", 2), ("pnpm prisma migrate deploy", 0),
    ("cat <<EOF\ngit push origin main\nEOF", 0), ("cat <<'EOF' > f\nprisma migrate reset\nEOF\ngit push origin main", 2),
    ("ls", 0),
]
bad = 0
for c, want in cases:
    r = subprocess.run(["python3", H], input=json.dumps({"tool_name": "Bash", "tool_input": {"command": c}}), text=True, capture_output=True)
    ok = r.returncode == want
    bad += not ok
    print("ok " if ok else "BAD", r.returncode, repr(c)[:70])
print("failures:", bad)
sys.exit(1 if bad else 0)
