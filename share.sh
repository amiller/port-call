#!/usr/bin/env bash
# Put a page in front of the meeting:  ./share.sh <meeting_id> <url>
#                                      ./share.sh <meeting_id> stop
#
# Same redis path as speak.sh (acts.v1). The bot opens the URL in a stage tab titled VEXA-STAGE
# and presents that tab; Chrome auto-answers its tab picker from the launch flag. Desktop/window
# capture is NOT used — it does not work in this image (see patches/browser-args.ts).
set -euo pipefail
ID=${1:?usage: share.sh <meeting_id> <url|stop>}
URL=${2:?usage: share.sh <meeting_id> <url|stop>}
C=${C:-vexa-lite}
if [ "$URL" = stop ]; then
  PAYLOAD='{"action":"screen_share_stop"}'
else
  PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"action":"screen_share","url":sys.argv[1]}))' "$URL")
fi
docker exec "$C" redis-cli PUBLISH "bot_commands:meeting:$ID" "$PAYLOAD"
