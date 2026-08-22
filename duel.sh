#!/usr/bin/env bash
# THE TWO-BOT RUNG (#24) — two rigs, one room, each bot hears the other. No human, no SKIP.
#
#   ./duel.sh [meet-code]          RIG_A=4 RIG_B=3 by default
#
# What it proves that nothing else can. Meet does not loop a participant's own mic back, so a
# single bot in an empty room cannot hear itself: journeys.sh J4 SKIPs there, and every claim about
# audio actually reaching the meeting has therefore been either unproven or witnessed by a human in
# a call. Two bots on two rigs are two participants. Each one's TTS is the other's microphone
# input, so the whole loop — synth -> PulseAudio -> Chromium -> Meet -> WebRTC -> capture -> Whisper
# -> transcript — is closed and measured with nobody in the room.
#
# It is a LATENCY instrument first and a pass/fail rung second (ping.py holds both). A run prints
# say-to-audible, draft, completed and round-trip percentiles for both seats; the exit code only
# asks whether the bots heard each other at all, because the timings are what regress meaningfully
# and a hard threshold on them would go red on a slow near.ai afternoon rather than on a bug.
#
# NEVER rig 1. e2e.sh's rule applies twice over here: this spawns bots AND deletes every bot in the
# room on the way out, so pointing a seat at the rig Andrew takes meetings on can tear the bot out
# of a live call. Both seats refuse rig 1 unless someone insists out loud.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
CODE=${1:-tog-tccc-szk}
A=${RIG_A:-4}; B=${RIG_B:-3}
TURNS=${TURNS:-8}
REQUIRE=${REQUIRE:-5}

for R in "$A" "$B"; do
  [ "$R" = 1 ] && [ "${DUEL_ALLOW_RIG1:-0}" != 1 ] && {
    echo "duel: refusing rig 1 (the human's rig) — it spawns AND deletes bots in $CODE." >&2
    echo "      Use two of rigs 2/3/4, or set DUEL_ALLOW_RIG1=1 if you really mean it." >&2
    exit 1; }
done
[ "$A" = "$B" ] && { echo "duel: both seats are rig $A — one rig admits one bot per room" >&2; exit 1; }

sfx() { [ "$1" = 1 ] && echo "" || echo "$1"; }
gw()  { echo "http://localhost:$((8055 + $1))"; }
tok() { cat "/tmp/vexa$(sfx "$1")-$2-token.txt"; }
dir() { echo "$HOME/vexa-rig$(sfx "$1")"; }

for R in "$A" "$B"; do
  for S in bot tx; do
    [ -s "/tmp/vexa$(sfx "$R")-$S-token.txt" ] || {
      echo "duel: no $S token for rig $R — run ./relaunch.sh in $(dir "$R")" >&2; exit 1; }
  done
  [ -f "$(dir "$R")/ping.py" ] || { echo "duel: no ping.py in $(dir "$R") — rsync the tree first" >&2; exit 1; }
done

echo "═══ DUEL — rig $A leads, rig $B answers, room $CODE ═══"

spawn() {  # spawn <rig> <name>; returns 0 once the bot is ACTIVE
  local r=$1 name=$2 t resp; t=$(tok "$r" bot)
  # READ the response. A rejected spawn answers 200 with a {"detail": ...} body, so discarding it
  # turns "an active meeting already exists" into a silent 150-second wait for a bot that was never
  # created — the same class as demo.sh stop reporting success for a DELETE that failed.
  resp=$(curl -s -X POST "$(gw "$r")/bots" -H "X-API-Key: $t" -H "Content-Type: application/json" \
    -d "{\"platform\":\"google_meet\",\"native_meeting_id\":\"$CODE\",\"bot_name\":\"$name\",\"voice_agent_enabled\":true}")
  echo "$resp" | grep -q '"id"' || { echo "  rig $r spawn rejected: $resp" >&2; return 1; }
  for _ in $(seq 1 30); do
    sleep 5
    [ "$(curl -s "$(gw "$r")/bots/status" -H "X-API-Key: $t" \
        | python3 -c 'import sys,json;r=json.load(sys.stdin)["running"];print(r[0]["status"] if r else "gone")')" \
      = active ] && return 0
  done
  return 1
}

stop_all() {
  for R in "$A" "$B"; do
    curl -s -X DELETE "$(gw "$R")/bots/google_meet/$CODE" -H "X-API-Key: $(tok "$R" bot)" -o /dev/null
  done
}
# Bots left seated in a room are the #35 lifecycle problem; a rung must not create one on its way
# out, including when it is interrupted.
trap stop_all EXIT INT TERM

# Both seats first, THEN both loops. Spawning inside ping.py raced: whoever joined first started
# counting into a room where the other bot's capture was not up yet, and the opening number was
# lost to nobody.
# Clear the room first. A bot killed mid-stop (a reboot, a SIGKILL) leaves its meeting row in
# `stopping` forever, and the gateway then refuses every new spawn with "an active meeting already
# exists" — which is what a stale row looks like from the outside.
stop_all; sleep 8

spawn "$A" "Port Call A" || { echo "FAIL rig $A never joined $CODE — is the room OPEN?"; exit 1; }
spawn "$B" "Port Call B" || { echo "FAIL rig $B never joined $CODE"; exit 1; }
echo "both seats active"

LA=/tmp/duel-a-$$.log; LB=/tmp/duel-b-$$.log
( cd "$(dir "$B")" && RIG=$B python3 ping.py "$CODE" --turns "$TURNS" --require "$REQUIRE" ) >"$LB" 2>&1 &
PB=$!
sleep 3
( cd "$(dir "$A")" && RIG=$A python3 ping.py "$CODE" --lead --turns "$TURNS" --require "$REQUIRE" ) >"$LA" 2>&1 &
PA=$!
wait $PA; RA=$?
wait $PB; RB=$?

echo; echo "───── seat A (rig $A, leads) ─────"; cat "$LA"
echo; echo "───── seat B (rig $B, answers) ─────"; cat "$LB"
echo
[ "$RA" -eq 0 ] && [ "$RB" -eq 0 ] && { echo "DUEL GREEN — both bots heard each other in $CODE"; exit 0; }
echo "DUEL RED — seat A exit $RA, seat B exit $RB"; exit 1
