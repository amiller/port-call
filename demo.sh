#!/usr/bin/env bash
# DEMO / ITERATION MODE — one long-lived bot you keep talking to while you edit its code.
#
# e2e.sh is a clean-room test: it spawns a fresh bot and stops it, which is why you see a join and
# a leave every run. That is the harness, not a hot-swap limitation. This is the other mode:
#
#   ./demo.sh join                 # bot joins ONCE and stays
#   ./demo.sh say "hello"          # acts go to that same bot
#   ./demo.sh chat "hi everyone"
#   ./demo.sh camera "ON AIR"
#   ./demo.sh camera "ON AIR" tina brainrot   # avatar: rooster|tina|dmarz
#                                             # background: transcript|vitals|brainrot
#   ./demo.sh share "my slide"
#   ./demo.sh react 🎊
#   ./demo.sh check                # selfcheck dump
#   ./demo.sh shot                 # screenshot the bot's own screen
#   ... edit patches/bot-chat.ts ...
#   ./hotswap.sh                   # ~3s: recompile in place
#   ./demo.sh chat "now with new code"   # SAME bot runs it — no rejoin
#   ./demo.sh stop
#
# Surface controllers are re-imported per act (mtime-keyed), so a recompile lands on the next act.
# The one exception is the camera HUD's page-side canvas, installed at navigation: use `./demo.sh
# recam` to re-inject it without rejoining.
set -euo pipefail
. "$(dirname "$0")/rig-env.sh"   # RIG selects the rig; see rig-env.sh
ROOM=${ROOM:-tog-tccc-szk}
STATE=/tmp/vexa-demo-bot
BOT=$(cat "$TOKBOT")
pub() { docker exec "$C" redis-cli PUBLISH "bot_commands:meeting:$(cat $STATE)" "$1" >/dev/null && echo "-> $1"; }
need() { [ -f "$STATE" ] || { echo "no demo bot — run: ./demo.sh join"; exit 1; }; }

case "${1:-}" in
  join)
    curl -s -X DELETE "$GW/bots/google_meet/$ROOM" -H "X-API-Key: $BOT" -o /dev/null || true; sleep 6
    ID=$(curl -s -X POST $GW/bots -H "X-API-Key: $BOT" -H "Content-Type: application/json" \
      -d "{\"platform\":\"google_meet\",\"native_meeting_id\":\"$ROOM\",\"bot_name\":\"${BOT_NAME:-Port Call}\",\"voice_agent_enabled\":true}" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
    [ -n "$ID" ] || { echo "spawn rejected"; exit 1; }
    echo "$ID" > $STATE
    for i in $(seq 1 20); do
      S=$(curl -s $GW/bots/status -H "X-API-Key: $BOT" | python3 -c "import sys,json;r=[x for x in json.load(sys.stdin)['running'] if str(x['id'])=='$ID'];print(r[0]['status'] if r else 'gone')")
      [ "$S" = active ] && break; [ "$S" = gone ] && { echo "died during join"; exit 1; }; sleep 5
    done
    # A meeting that walls the bot behind Google sign-in (any personal-account calendared meeting)
    # leaves status non-active forever; without this check the script lied "active" on timeout.
    [ "${S:-}" = active ] || { echo "never went active (last: ${S:-unknown}) — ./demo.sh shot to see why"; exit 1; }
    echo "bot $ID active in $ROOM — it stays until ./demo.sh stop" ;;
  say)     need; pub "$(python3 -c 'import json,sys;print(json.dumps({"action":"speak","text":sys.argv[1]}))' "$2")" ;;
  chat)    need; pub "$(python3 -c 'import json,sys;print(json.dumps({"action":"chat_send","text":sys.argv[1]}))' "$2")" ;;
  read)    need; pub '{"action":"chat_read"}' ;;
  # camera "HEADLINE" [avatar] [background]  — avatar and background are independent; omitting
  # either leaves it as-is, so `./demo.sh camera "TEXT"` behaves exactly as it always has.
  camera)  need; pub "$(python3 -c 'import json,sys
a = {"action": "camera_show", "text": sys.argv[1]}
if len(sys.argv) > 2 and sys.argv[2]: a["avatar"] = sys.argv[2]
if len(sys.argv) > 3 and sys.argv[3]: a["bg"] = sys.argv[3]
print(json.dumps(a))' "${2:-VEXA}" "${3:-}" "${4:-}")" ;;
  share)   need; pub "$(python3 -c 'import json,sys;print(json.dumps({"action":"screen_share","text":sys.argv[1]}))' "${2:-VEXA}")" ;;
  unshare) need; pub '{"action":"screen_share_stop"}' ;;
  react)   need; pub "$(python3 -c 'import json,sys;print(json.dumps({"action":"reaction","emoji":sys.argv[1]}))' "${2:-🎊}")" ;;
  check)   need; pub '{"action":"selfcheck"}'; sleep 8
           docker exec "$C" sh -c "grep -h '\[selfcheck\]' /tmp/vexa-workloads/mtg-$(cat $STATE)-*.log | tail -1" ;;
  log)     need; docker exec "$C" sh -c "tail -${2:-20} /tmp/vexa-workloads/mtg-$(cat $STATE)-*.log" ;;
  # Completed segments only: vexa resubmits each utterance as a GROWING window, so provisional
  # ones make a polling agent see the same sentence half-a-dozen times and act on it repeatedly.
  transcript) curl -s "$GW/transcripts/google_meet/$ROOM" -H "X-API-Key: $(cat "$TOKTX")" \
      | python3 -c "
import sys,json
segs=json.load(sys.stdin).get('segments') or []
for s in segs[-int('${2:-15}'):]:
    if s.get('completed'): print(f\"{s.get('speaker','?')}: {s.get('text','').strip()}\")" ;;
  shot)    docker exec "$C" sh -c "DISPLAY=:99 ffmpeg -y -loglevel error -f x11grab -video_size 1600x900 -i :99 -frames:v 1 /tmp/demo.png"
           docker cp "$C:/tmp/demo.png" "${2:-/tmp/demo.png}" && echo "-> ${2:-/tmp/demo.png}" ;;
  recam)   need; pub '{"action":"camera_off"}'; sleep 2; pub '{"action":"camera_show","text":"reloaded"}' ;;
  status)  need; curl -s $GW/bots/status -H "X-API-Key: $BOT" | python3 -c "
import sys,json; r=[x for x in json.load(sys.stdin)['running'] if str(x['id'])=='$(cat $STATE)']
print(r[0]['status'] if r else 'gone')" ;;
  stop)    need; curl -s -X DELETE "$GW/bots/google_meet/$ROOM" -H "X-API-Key: $BOT" -o /dev/null; rm -f $STATE; echo stopped ;;
  *) sed -n '2,25p' "$0" ;;
esac
