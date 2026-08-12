#!/usr/bin/env bash
# Make the bot say something:  ./speak.sh <meeting_id> "text"
#
# meeting_id is the DB id returned by POST /bots (not the xxx-xxxx-xxx code). The bot subscribes
# to acts.v1 on redis; meeting-api's POST /bots/{platform}/{id}/speak route does not exist in
# v0.12 (the gateway proxies to a 404), so redis is the only path that actually reaches the bot.
set -euo pipefail
ID=${1:?usage: speak.sh <meeting_id> "text"}
TEXT=${2:?usage: speak.sh <meeting_id> "text"}
PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"action":"speak","text":sys.argv[1]}))' "$TEXT")
docker exec vexa-lite redis-cli PUBLISH "bot_commands:meeting:$ID" "$PAYLOAD"
