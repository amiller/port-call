#!/usr/bin/env bash
# USER-JOURNEY suite — the four things a real call exercised on 2026-08-12, three of which e2e.sh
# structurally cannot see. This complements e2e.sh (per-surface smoke test); it does not replace it.
#
#   ./journeys.sh <meet-code>               FULL: spawns its own bot, speaks aloud, kills it at the
#                                           end. DEDICATED OPEN ROOM ONLY — never a call with
#                                           people in it (it spawns and kills bots underneath them).
#   MODE=observe ./journeys.sh <meet-code>  OBSERVE: attaches to the bot already in that room. Never
#                                           spawns, never kills, never speaks. Safe mid-call. The
#                                           reaction journey is still VISIBLE to everyone in the
#                                           room — it is the one act observe mode cannot fake.
#
# Every journey reports PASS, FAIL, or SKIP. SKIP means "this room did not exercise the journey"
# (e.g. no Gemini consent prompt appeared, nobody spoke). A run with SKIPs is not a green run —
# the whole point of the consent journey is that it passes vacuously in a room without Gemini notes.
set -euo pipefail
MODE=${MODE:-full}
CODE=${1:?usage: [MODE=observe] ./journeys.sh <meet-code>}
. "$(dirname "$0")/rig-env.sh"   # RIG selects the rig; see rig-env.sh
rig_require_tokens
BOT=$(cat "$TOKBOT"); TX=$(cat "$TOKTX")
PASS=0; FAIL=0; SKIP=0
ok()   { echo "PASS $*"; PASS=$((PASS+1)); }
bad()  { echo "FAIL $*"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $*"; SKIP=$((SKIP+1)); }
act()  { docker exec "$C" redis-cli PUBLISH "bot_commands:meeting:$ID" "$1" >/dev/null; }
# Whole log, not tail -1: these journeys count occurrences and diff them across a window.
logs() { docker exec "$C" sh -c "grep -h -- '$1' /tmp/vexa-workloads/mtg-$ID-*.log 2>/dev/null | wc -l"; }
last() { docker exec "$C" sh -c "grep -h -- '$1' /tmp/vexa-workloads/mtg-$ID-*.log 2>/dev/null | tail -1"; }
# Resolve the bot from the ROOM, never from /tmp/vexa-demo-bot — that state file went stale on
# 2026-08-12 and made demo.sh report `gone` for a perfectly healthy bot.
api()  { curl -s $GW/bots/status -H "X-API-Key: $BOT" | python3 -c "
import sys,json
r=[x for x in json.load(sys.stdin)['running'] if x['native_meeting_id']=='$CODE']
print(r[0]['$1'] if r else '')"; }
segs() { curl -s "$GW/transcripts/google_meet/$CODE" -H "X-API-Key: $TX" | python3 -c "
import sys,json
print(len([s for s in (json.load(sys.stdin).get('segments') or []) if s.get('completed')]))"; }
hit()  { curl -s "$GW/transcripts/google_meet/$CODE" -H "X-API-Key: $TX" | python3 -c "
import sys,json
segs=[s for s in (json.load(sys.stdin).get('segments') or []) if s.get('completed')]
print(int(any('$1'.lower() in (s.get('text') or '').lower() for s in segs)))"; }

# ── J1 · join survives the Gemini consent gate ────────────────────────────────────────────────
# The 2026-08-12 failure: host admits the bot, Meet raises "This video call is being transcribed.
# Gemini is taking notes." (Leave / Join now), googleConsentPromptIndicators DETECTS it and
# correctly suppresses `admitted` — but nothing clicks Join now, so the bot loops the warning every
# 2s and dies at the 600s admission timeout. A human clicking it through is the bug, not the fix.
if [ "$MODE" = full ]; then
  curl -s -X DELETE "$GW/bots/google_meet/$CODE" -H "X-API-Key: $BOT" -o /dev/null
  sleep 8
  T0=$(date +%s)
  ID=$(curl -s -X POST $GW/bots -H "X-API-Key: $BOT" -H "Content-Type: application/json" \
    -d "{\"platform\":\"google_meet\",\"native_meeting_id\":\"$CODE\",\"bot_name\":\"Port Call Journeys\",\"voice_agent_enabled\":true}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
  [ -n "$ID" ] || { echo "FAIL spawn rejected — stale meeting row? ./demo.sh stop, wait 8s"; exit 1; }
  for _ in $(seq 1 24); do S=$(api status); [ "$S" = active ] && break; [ -z "$S" ] && break; sleep 5; done
  DT=$(( $(date +%s) - T0 ))
else
  ID=$(api id); S=$(api status)
  [ -n "$ID" ] || { echo "FAIL no bot in $CODE — observe mode attaches, it does not spawn"; exit 1; }
  DT=n/a
fi
echo "bot=$ID meeting=$CODE mode=$MODE"
GATE=$(logs 'consent prompt visible')
if [ "$GATE" -gt 0 ] && [ "$S" = active ]; then
  ok "join cleared the Gemini consent gate unaided (${GATE} suppressions, ${DT}s)"
elif [ "$GATE" -gt 0 ]; then
  bad "stuck behind the Gemini consent gate (${GATE} suppressions, status=$S) — nothing clicks Join now"
elif [ "$S" = active ]; then
  skip "consent gate NOT exercised — no prompt in this room; joined clean in ${DT}s"
else
  bad "join (status=${S:-gone})"
fi

# ── J2 · reactions repeat ─────────────────────────────────────────────────────────────────────
# e2e.sh sends exactly ONE reaction and asserts one `sent`, which is why it stayed green through
# the 2026-08-12 "first one worked, then nothing" report. Fire several and count the DELTA (observe
# mode attaches to a bot that has already reacted, so absolute counts are meaningless).
SENT0=$(logs '"sent"'); MISS0=$(logs '"missing"')
# Meet's ACTUAL picker set, read off a live dump: 💖 👍 🎉 👏 😂 😮 😢 🤔 👎. Note 💖, not ❤️ —
# a red heart is absent and throws `reaction picker has no entry`, which is a test bug, not a
# product bug (cost one confusing red run on 2026-08-12).
N=0; for E in 💖 👍 🎉 👏 😂; do act "{\"action\":\"reaction\",\"emoji\":\"$E\"}"; N=$((N+1)); sleep 6; done
sleep 4
SENT=$(( $(logs '"sent"') - SENT0 )); MISS=$(( $(logs '"missing"') - MISS0 ))
if [ "$SENT" -eq "$N" ]; then
  ok "reactions repeat ($SENT/$N sent)"
elif [ "$MISS" -gt 0 ]; then
  # bot-reactions.ts:53 dumps the picker's actual entries on a miss. If reaction 2+ misses while 1
  # sends, the picker is almost certainly still OPEN and the toolbar click TOGGLED IT SHUT.
  bad "reactions stop after $SENT/$N — $MISS picker miss(es); candidates: $(last '"missing"')"
else
  bad "reactions stop after $SENT/$N with no picker miss — the act is being dropped before the click"
fi

# ── J3 · camera HUD keeps animating ───────────────────────────────────────────────────────────
# bot-camera.ts:275 logs a CUMULATIVE canvasFrames counter, sampled once per camera_show. Two acts
# ~12s apart therefore measure whether the canvas is still drawing BETWEEN them — a static or
# wedged HUD reports cameraOn:true and a frame count that never moves.
act '{"action":"camera_show","text":"JOURNEYS","sub":"frame a"}'; sleep 8
F1=$(last '\[camera\]' | python3 -c "import sys,json;print(json.loads(sys.stdin.read().split('[camera] ')[1])['canvasFrames'])")
sleep 12
act '{"action":"camera_show","text":"JOURNEYS","sub":"frame b"}'; sleep 8
F2=$(last '\[camera\]' | python3 -c "import sys,json;print(json.loads(sys.stdin.read().split('[camera] ')[1])['canvasFrames'])")
act '{"action":"selfcheck"}'; sleep 9
ON=$(last '\[selfcheck\]')
if [ "$F2" -gt "$F1" ] && echo "$ON" | grep -q '"cameraOn":true'; then
  ok "camera HUD animating and live in Meet (+$((F2-F1)) frames in ~12s)"
elif [ "$F2" -gt "$F1" ]; then
  bad "canvas draws (+$((F2-F1)) frames) but cameraOn is false — Meet is showing the avatar, not the HUD"
else
  bad "camera HUD frozen (canvasFrames stuck at $F2) — recam needed"
fi

# ── J4 · transcript is reliable and prompt ────────────────────────────────────────────────────
# e2e.sh only asserts the endpoint returns >= 0 segments, which passes with ZERO transcription.
if [ "$MODE" = full ]; then
  # A natural phrase, not a random nonce: Whisper transcribes words, and a hex string would make
  # this flaky for reasons that have nothing to do with the pipeline. The bot's own TTS is audible
  # in the room, so this round-trips through the real audio path — mic, Whisper, and all.
  PHRASE="the purple elephant checks in at nine"
  act "{\"action\":\"speak\",\"text\":\"$PHRASE\"}"
  T0=$(date +%s); LAT=""
  for _ in $(seq 1 15); do
    sleep 3
    [ "$(hit "$PHRASE")" = 1 ] && { LAT=$(( $(date +%s) - T0 )); break; }
  done
  # Meet does NOT loop a participant's own mic back to it, so in an EMPTY room every capture
  # stream reads `silent emitted=0` and the bot cannot hear its own TTS — the round trip is
  # unprovable there, and reporting FAIL would be blaming the pipeline for an empty room. A
  # `PerSpeaker … AUDIO seen=` line is the proof that some audible stream actually existed; only
  # then is a missing phrase a real transcription failure.
  if [ -n "$LAT" ]; then
    ok "spoken phrase round-tripped to transcript in ${LAT}s"
  elif [ "$(logs 'AUDIO seen=')" -eq 0 ]; then
    skip "transcript round-trip NOT exercised — no audible stream in the room (a bot cannot hear itself)"
  else
    bad "spoken phrase never reached the transcript within 45s despite audible streams"
  fi
else
  # Nobody to speak on cue mid-call, so measure that transcription KEEPS UP with real speech:
  # [audio] lines prove someone talked, completed segments must then grow.
  A0=$(logs '\[audio\]'); S0=$(segs)
  sleep 30
  A=$(( $(logs '\[audio\]') - A0 )); D=$(( $(segs) - S0 ))
  if [ "$A" -eq 0 ]; then
    skip "transcript freshness NOT exercised — silent 30s window, nobody spoke"
  elif [ "$D" -gt 0 ]; then
    ok "transcript keeping up (+$D completed segments over 30s of speech)"
  else
    bad "$A audio frames in 30s but 0 new completed segments — transcription is stalled"
  fi
fi

[ "$MODE" = full ] && curl -s -X DELETE "$GW/bots/google_meet/$CODE" -H "X-API-Key: $BOT" -o /dev/null
echo "---- $PASS passed, $FAIL failed, $SKIP not exercised ----"
[ "$FAIL" -eq 0 ]
