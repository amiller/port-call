#!/usr/bin/env bash
# Full end-to-end check of the unofficial Meet API surface. No human in the loop, PROVIDED the lab
# meeting is OPEN (accessType=OPEN — mint one with lab-room.py; an ad-hoc "Quick access" room dies
# with the call and the code stops resolving).
#
#   ./e2e.sh <meet-code>
#
# Bench tests that need NO meeting live in probe/ (camera-bench.mjs, the audio click train) — run
# those first when iterating; most bugs never need a room.
set -euo pipefail
# The permanent lab room (Meet API space, accessType=OPEN, minted by lab-room.py). Unlike an
# ad-hoc Quick-access room it does NOT die when the call ends, so this runs unattended forever.
CODE=${1:-tog-tccc-szk}
C=${C:-vexa-rig-vexa-lite-1}
GW=http://localhost:8056
BOT=$(cat /tmp/vexa-bot-token.txt); TX=$(cat /tmp/vexa-tx-token.txt)
PASS=0; FAIL=0
# RECORD=1 captures the bot's own X display: a screenshot after every surface act plus an mp4 of
# the whole run, then an HTML report. The bot has a real desktop (Xvfb :99), so this is what the
# meeting actually looked like from its seat — not a reconstruction.
REC=${RECORD:-0}
STAMP=$(date +%Y%m%d-%H%M%S)
ART=~/vexa-rig/artifacts/$STAMP
STEPS=""
shot() {
  [ "$REC" = 1 ] || return 0
  docker exec "$C" sh -c "DISPLAY=:99 ffmpeg -y -loglevel error -f x11grab -video_size 1600x900 -i :99 -frames:v 1 /tmp/shot-$1.png" 2>/dev/null || true
  STEPS="$STEPS $1"
}
ok()   { echo "PASS $*"; PASS=$((PASS+1)); }
bad()  { echo "FAIL $*"; FAIL=$((FAIL+1)); }
act()  { docker exec "$C" redis-cli PUBLISH "bot_commands:meeting:$ID" "$1" >/dev/null; }
log()  { docker exec "$C" sh -c "grep -h '$1' /tmp/vexa-workloads/mtg-$ID-*.log 2>/dev/null | tail -1"; }

curl -s -X DELETE "$GW/bots/google_meet/$CODE" -H "X-API-Key: $BOT" -o /dev/null || true
sleep 8
ID=$(curl -s -X POST $GW/bots -H "X-API-Key: $BOT" -H "Content-Type: application/json" \
  -d "{\"platform\":\"google_meet\",\"native_meeting_id\":\"$CODE\",\"bot_name\":\"Vexa E2E\",\"voice_agent_enabled\":true}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
[ -n "$ID" ] || { echo "FAIL spawn rejected"; exit 1; }
echo "bot=$ID meeting=$CODE"
if [ "$REC" = 1 ]; then
  mkdir -p "$ART"
  # -nostdin so the detached grab does not fight for the terminal; SIGINT later flushes the file.
  docker exec -d "$C" sh -c "DISPLAY=:99 ffmpeg -y -nostdin -loglevel error -f x11grab -video_size 1600x900 -framerate 8 -i :99 -pix_fmt yuv420p -t 300 /tmp/e2e.mp4"
  echo "recording -> $ART"
fi

for i in $(seq 1 24); do
  S=$(curl -s $GW/bots/status -H "X-API-Key: $BOT" \
      | python3 -c "import sys,json;r=[x for x in json.load(sys.stdin)['running'] if x['id']==$ID];print(r[0]['status'] if r else 'gone')")
  [ "$S" = active ] && break; [ "$S" = gone ] && break; sleep 5
done
[ "$S" = active ] && ok join || { bad "join (status=$S) — is the room OPEN?"; exit 1; }
shot join
sleep 5

act '{"action":"chat_send","text":"e2e chat probe"}';           sleep 10
log '\[chat\].*sent'      | grep -q sent      && ok chat_send   || bad chat_send
act '{"action":"chat_read"}';                                   sleep 8
log '\[chat\].*messages'  | grep -q "e2e chat probe" && ok chat_read || bad "chat_read (own message not read back)"
shot chat

act '{"action":"camera_show","text":"E2E","sub":"camera"}';     sleep 10
log '\[camera\]'          | grep -q canvasFrames && ok "camera canvas drawing" || bad "camera canvas"
act '{"action":"selfcheck"}'; sleep 9
log '\[selfcheck\]' | grep -q '"cameraOn":true' && ok "camera ON in Meet" || bad "camera not on in Meet (avatar shown)"
shot camera

act '{"action":"screen_share","text":"E2E share"}';             sleep 12
log '\[share\]'           | grep -q '"presenting":true' && ok screen_share || bad screen_share
shot share

# 🎊 not 🎉 — Meet's picker offers 🎊 💗 💯 😆 🙁 😲 (dumped live); 🎉 is simply not in it.
act '{"action":"reaction","emoji":"🎊"}';                        sleep 8
log '\[reaction\]'        | grep -q sent && ok reaction         || bad reaction
shot reaction

act '{"action":"selfcheck"}';                                   sleep 10
SC=$(log '\[selfcheck\]')
echo "$SC" | grep -q '"presenting":true' && ok "presenting confirmed in DOM" || bad "presenting not visible in DOM"

N=$(curl -s "$GW/transcripts/google_meet/$CODE" -H "X-API-Key: $TX" \
    | python3 -c "import sys,json;s=json.load(sys.stdin).get('segments');print(len(s) if s is not None else -1)")
[ "$N" -ge 0 ] && ok "transcript endpoint (segments=$N)" || bad "transcript endpoint"

S=$(curl -s $GW/bots/status -H "X-API-Key: $BOT" \
    | python3 -c "import sys,json;r=[x for x in json.load(sys.stdin)['running'] if x['id']==$ID];print(r[0]['status'] if r else 'gone')")
[ "$S" = active ] && ok "survived the run" || bad "bot left during run (status=$S)"

if [ "$REC" = 1 ]; then
  docker exec "$C" sh -c "pkill -INT -f 'x11grab.*e2e.mp4'" 2>/dev/null || true
  sleep 3
  docker cp "$C:/tmp/e2e.mp4" "$ART/run.mp4" 2>/dev/null || true
  for st in $STEPS; do docker cp "$C:/tmp/shot-$st.png" "$ART/$st.png" 2>/dev/null || true; done
  {
    echo "<!doctype html><meta charset=utf-8><title>Vexa e2e $STAMP</title>"
    echo "<style>body{background:#0d0d12;color:#e8e8f0;font:15px system-ui;margin:0;padding:32px;max-width:1100px}"
    echo "h1{font-size:22px}img{width:100%;border-radius:8px;border:1px solid #33334a;margin:8px 0 24px}"
    echo "video{width:100%;border-radius:8px}.ok{color:#7ce38b}.no{color:#ff7b72}code{color:#8a8aa0}</style>"
    echo "<h1>Vexa e2e — $STAMP</h1><p><code>meeting $CODE · bot $ID · $PASS passed, $FAIL failed</code></p>"
    [ -f "$ART/run.mp4" ] && echo "<video controls src=run.mp4></video>"
    for st in $STEPS; do [ -f "$ART/$st.png" ] && echo "<h2>$st</h2><img src=$st.png>"; done
  } > "$ART/report.html"
  echo "report -> $ART/report.html"
fi
curl -s -X DELETE "$GW/bots/google_meet/$CODE" -H "X-API-Key: $BOT" -o /dev/null
echo "---- $PASS passed, $FAIL failed ----"
[ "$FAIL" -eq 0 ]
