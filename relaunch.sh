#!/usr/bin/env bash
# Recover the compose rig (e.g. after a reboot): services up, /tmp API tokens re-minted, console up.
# Tokens live in /tmp and die with every reboot — this script is the only thing that recreates them.
#
# v0.13: rewritten for the compose era. The old docker-run path (vexa-lite / vexa-postgres names)
# died 2026-08-13 when a reboot proved nobody had run it since the compose migration.
#  - Admin routes live on admin-api, bound 127.0.0.1:8001 INSIDE the container — docker exec only.
#  - POST /admin/users is idempotent: it returns the existing user for a known email.
#  - Reading transcripts needs a `tx`-scoped token; a bot token gets "insufficient scope".
set -euo pipefail
cd "$(dirname "$0")"
. "$(dirname "$0")/rig-env.sh"   # RIG selects the rig; see rig-env.sh
ADMIN=${ADMIN_TOKEN:-devadmintoken123}
# NEAR_API_KEY comes from ./.env, which docker compose reads natively. The old line sourced it
# from ~/projects/ic3camp-teexai/... which exists on ONE machine and not this one — with set -e
# that aborted recovery at line 14, so every reboot left the rig tokenless and the console down.

docker compose up -d
until docker exec "$C" curl -sf -o /dev/null http://127.0.0.1:8056/health; do sleep 3; done
adminapi() { docker exec "$C" curl -s "$@"; }
until adminapi -f -o /dev/null http://127.0.0.1:8001/health; do sleep 2; done

# admin-api reports healthy before postgres will accept writes, so the create can come back as a
# non-JSON error page and the whole recovery dies on the parse. At boot that race is likelier, not
# rarer — it is what broke this on 2026-08-18. Retry until it parses, then fail loudly.
for _ in $(seq 1 30); do
  UID_=$(adminapi -X POST http://127.0.0.1:8001/admin/users -H "X-Admin-API-Key: $ADMIN" \
    -H "Content-Type: application/json" \
    -d '{"email":"andrew@teleport.computer","name":"Andrew","max_concurrent_bots":2}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null) && break
  sleep 4
done
[ -n "${UID_:-}" ] || { echo "admin-api never returned a user id after 2 minutes" >&2; exit 1; }
for scope in bot tx; do
  adminapi -X POST "http://127.0.0.1:8001/admin/users/$UID_/tokens?scope=$scope" -H "X-Admin-API-Key: $ADMIN" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" > /tmp/vexa$RIGSFX-$scope-token.txt
done
echo "tokens -> $TOKBOT $TOKTX"

pgrep -f board.py >/dev/null || { nohup python3 board.py >/tmp/vexa-board.log 2>&1 & echo "console -> :8090"; }
