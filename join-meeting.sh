#!/usr/bin/env bash
# Spawn a bot into a Meet: ./join-meeting.sh <meet-code> [bot-name]
set -euo pipefail
CODE=${1:?usage: join-meeting.sh <meet-code> [bot-name]}
NAME=${2:-Vexa Notetaker}
. "$(dirname "$0")/rig-env.sh"   # RIG selects the rig; see rig-env.sh
curl -s -X POST "$GW/bots" \
  -H "X-API-Key: $(cat "$TOKBOT")" -H "Content-Type: application/json" \
  -d "{\"platform\":\"google_meet\",\"native_meeting_id\":\"$CODE\",\"bot_name\":\"$NAME\",\"voice_agent_enabled\":true}"
