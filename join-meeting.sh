#!/usr/bin/env bash
# Spawn a bot into a Meet: ./join-meeting.sh <meet-code> [bot-name]
set -euo pipefail
CODE=${1:?usage: join-meeting.sh <meet-code> [bot-name]}
NAME=${2:-Vexa Notetaker}
curl -s -X POST http://localhost:8056/bots \
  -H "X-API-Key: $(cat /tmp/vexa-bot-token.txt)" -H "Content-Type: application/json" \
  -d "{\"platform\":\"google_meet\",\"native_meeting_id\":\"$CODE\",\"bot_name\":\"$NAME\",\"voice_agent_enabled\":true}"
