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
C=vexa-rig-vexa-lite-1
ADMIN=${ADMIN_TOKEN:-devadmintoken123}
set -a; . ~/projects/ic3camp-teexai/teexai-transcribe/.env; set +a   # NEAR_API_KEY

docker compose up -d
until docker exec "$C" curl -sf -o /dev/null http://127.0.0.1:8056/health; do sleep 3; done
adminapi() { docker exec "$C" curl -s "$@"; }
until adminapi -f -o /dev/null http://127.0.0.1:8001/health; do sleep 2; done

UID_=$(adminapi -X POST http://127.0.0.1:8001/admin/users -H "X-Admin-API-Key: $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"email":"andrew@teleport.computer","name":"Andrew","max_concurrent_bots":2}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
for scope in bot tx; do
  adminapi -X POST "http://127.0.0.1:8001/admin/users/$UID_/tokens?scope=$scope" -H "X-Admin-API-Key: $ADMIN" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" > /tmp/vexa-$scope-token.txt
done
echo "tokens -> /tmp/vexa-bot-token.txt /tmp/vexa-tx-token.txt"

pgrep -f board.py >/dev/null || { nohup python3 board.py >/tmp/vexa-board.log 2>&1 & echo "console -> :8090"; }
