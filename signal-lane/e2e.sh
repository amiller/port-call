#!/usr/bin/env bash
# Signal lane end-to-end: two linked seats, no human in the room.
#
#   ./e2e.sh
#
# Seat A speaks and shows a camera; seat B listens and watches. Because both seats are ours, every
# assertion is machine-checkable — a transcript of a phrase chosen THIS RUN, and screenshots of
# both seats saved as evidence.
#
# EVIDENCE, not adjectives: every run writes screenshots of both seats plus the captured wav and
# the transcript into $OUT and prints the path. A green line with no artifact behind it is how this
# harness lied before.
#
# WHAT THIS CANNOT PROVE: speaker attribution. Both seats are linked devices of ONE account, so the
# call sees one identity twice. Attribution needs a second account and is deliberately not asserted.
set -euo pipefail
cd "$(dirname "$0")"

# CDP reaches the containers on fractal through ssh tunnels; these are the LOCAL tunnel ports.
# The containers publish 9333 (seat A) and 9335 (seat B) on fractal's loopback, so the usual
# tunnel is  -L 9334:127.0.0.1:9333  -L 9335:127.0.0.1:9335 . A_PORT is 9334 for that reason.
A=${A_PORT:-9334}
B=${B_PORT:-9335}
CA=port-call-signal-a
CB=port-call-signal-b
HOST=${SIGNAL_HOST:-fractal}
RIG=${RIG:-4}                # which rig's shims to borrow for TTS + transcription
TTS=vexa-rig$RIG-tts-shim-1
STT=vexa-rig$RIG-near-shim-1
SECS=${SECS:-22}             # capture window on seat B
OUT=${OUT:-/tmp/signal-e2e-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"

# Two concurrent runs would drive the same two seats and the same fixed /tmp paths on three
# machines, corrupting each other's capture and call state. The Meet lane locks rig+room for the
# same reason. Serialize rather than interleave.
exec 9>/tmp/signal-e2e.lock
flock -w 1800 9 || { echo "FAIL another signal e2e is holding the lock" >&2; exit 1; }

PASS=0; FAIL=0
ok()  { echo "PASS $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL $*"; FAIL=$((FAIL+1)); }
seat() { local port=$1 script=$2; cat js/lib.js "js/$script" > "$OUT/.run-$port.js"; node cdp.mjs "$port" eval "$OUT/.run-$port.js"; }
raw()  { node cdp.mjs "$1" eval -e "$2"; }
jqf()  { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }   # KeyError is loud on purpose
shot() { node cdp.mjs "$1" shot "$OUT/$2.png" > /dev/null && echo "  shot: $OUT/$2.png"; }

# Leave no seat in a call and no capture running, whatever happens. Without this, a failure between
# join and teardown strands both seats — and the next run's only defence was an unchecked reset.
cleanup() {
  local rc=$?
  ssh "$HOST" "docker exec $CB pkill -f 'parec -d call_out' || true" 2>/dev/null || true
  seat "$A" reset.js > /dev/null 2>&1 || true
  seat "$B" reset.js > /dev/null 2>&1 || true
  return $rc
}
trap cleanup EXIT

# A phrase chosen PER RUN. Whisper transcribes these reliably — no digits (spelled inconsistently)
# and no proper nouns. Randomising is not cosmetic: with a fixed phrase, a stale capture from an
# earlier run contains exactly the keywords this run greps for, so a dead audio chain still greens.
POOL=(harbor cricket velvet lantern meadow copper thistle marble orchard ribbon)
W1=${POOL[$((RANDOM % 10))]}; W2=${POOL[$((RANDOM % 10))]}; W3=${POOL[$((RANDOM % 10))]}
while [ "$W2" = "$W1" ]; do W2=${POOL[$((RANDOM % 10))]}; done
while [ "$W3" = "$W1" ] || [ "$W3" = "$W2" ]; do W3=${POOL[$((RANDOM % 10))]}; done
PHRASE="the $W1 and the $W2 share a $W3 morning"
echo "run phrase: $PHRASE"
echo "evidence:   $OUT"

echo "== preconditions =="
for pair in "$A A" "$B B"; do
  set -- $pair
  linked=$(seat "$1" link-state.js | jqf linked)
  [ "$linked" = "True" ] && ok "seat $2 is linked" || { bad "seat $2 is NOT linked — scan its QR first"; exit 1; }
done

echo "== configure seat A (speaker) =="
# The HUD must be an INIT script, not an injection into a live page: Signal enumerates video inputs
# once at startup and caches the result, so a late patch of enumerateDevices leaves Signal believing
# there is no camera — it then never calls getUserMedia and the tile shows an avatar.
node cdp.mjs "$A" init js/hud.js > /dev/null
sleep 8
seat "$A" set-devices.js
raw "$A" "globalThis.__vexaCam.set('PORT CALL E2E', '$W1-$W2-$W3'); globalThis.__pcCam = true; 'ok'" > /dev/null
ok "seat A: virtual_mic + call_out selected, HUD injected"

echo "== configure seat B (listener) =="
seat "$B" set-devices.js
raw "$B" "globalThis.__pcCam = false; 'ok'" > /dev/null
ok "seat B: virtual_mic + call_out selected"

echo "== call link =="
# Both seats open the SAME link URL. Matching by list row does not work: call links do not reliably
# sync between two devices of one account, and Signal's "Active" marker depends on a periodic SFU
# peek that a second device may never see. The URL needs neither — Signal fetches the link.
LINK=$(seat "$A" create-link.js | jqf url)
case "$LINK" in https://signal.link/call/#key=*) ok "call link: $LINK";; *) bad "no call link URL (got '$LINK')"; exit 1;; esac
KEY=${LINK#*#key=}

echo "== reset =="
# CHECKED, not assumed. reset.js loops and verifies; printing ok regardless was a false green.
for pair in "$A A" "$B B"; do
  set -- $pair
  clean=$(seat "$1" reset.js | jqf clean)
  [ "$clean" = "True" ] && ok "seat $2 out of any prior call" || { bad "seat $2 would not leave its prior call"; exit 1; }
done

echo "== join =="
# Each push spawns a launcher process that forwards the URL to the running instance and should
# exit. They accumulated to 22 once and one of them stole the CDP port, so reap them here.
for pair in "$CA a" "$CB b"; do
  set -- $pair
  ssh "$HOST" "docker exec $1 sh -c 'DISPLAY=:99 signal-desktop --user-data-dir=/data --no-sandbox \"sgnl://signal.link/call/#key=$KEY\" >/dev/null 2>&1 &'"
done
sleep 10
for c in "$CA" "$CB"; do
  ssh "$HOST" "docker exec $c sh -c 'pkill -f \"user-data-dir=/data --no-sandbox sgnl://\" || true'" 2>/dev/null || true
done
node cdp.mjs "$A" perms > /dev/null; node cdp.mjs "$B" perms > /dev/null
# The lobby Join, scoped to the calling container: a document-order match picks the call-link
# DETAILS panel's Join instead, which merely re-opens the lobby and reports a success that is not one.
seat "$A" lobby-join.js > /dev/null; seat "$B" lobby-join.js > /dev/null
sleep 3
seat "$A" cancel-modal.js > /dev/null; seat "$B" cancel-modal.js > /dev/null

for pair in "$A A" "$B B"; do
  set -- $pair
  n=$(seat "$1" call-state.js | jqf inCall)
  [ "$n" = "2" ] && ok "seat $2 sees 2 in call" || bad "seat $2 sees '$n' in call, expected 2"
done
shot "$A" joined-seat-a
shot "$B" joined-seat-b

echo "== speak: TTS on A -> capture on B =="
# Delete the previous run's capture EVERYWHERE first. The containers persist between runs, so a
# capture that never starts would otherwise be papered over by docker cp shipping the old wav.
ssh "$HOST" "docker exec $CB rm -f /tmp/cap.wav; rm -f /tmp/cap.wav; docker exec $STT rm -f /tmp/cap.wav" 2>/dev/null || true
ssh "$HOST" "docker exec $CB sh -c 'parec -d call_out.monitor --file-format=wav --format=s16le --rate=16000 --channels=1 /tmp/cap.wav >/dev/null 2>&1 &'"
sleep 2
# TTS is the rig's own shim (piper, local — no meeting text leaves the machine), piped straight
# into seat A's tts_sink, whose monitor is remapped as the mic Signal is transmitting.
# The shim returns HEADERLESS raw PCM (s16le/24000/mono) because Vexa pipes it into `paplay --raw`;
# a WAV header would be played as noise. And unmute first: a muted sink's monitor records pure
# silence, which is indistinguishable from a dead audio chain (tts-shim.py's own hard-won note).
ssh "$HOST" "docker exec $TTS python3 -c \"
import urllib.request, json
b=json.dumps({'model':'tts-1','input':'''$PHRASE''','voice':'auto'}).encode()
r=urllib.request.Request('http://localhost:8002/v1/audio/speech',data=b,headers={'Content-Type':'application/json'})
open('/tmp/say.pcm','wb').write(urllib.request.urlopen(r,timeout=90).read())\" \
 && docker cp $TTS:/tmp/say.pcm /tmp/say.pcm >/dev/null \
 && docker cp /tmp/say.pcm $CA:/tmp/say.pcm >/dev/null \
 && docker exec $CA pactl set-sink-mute tts_sink 0 \
 && docker exec $CA paplay --raw --format=s16le --rate=24000 --channels=1 --device=tts_sink /tmp/say.pcm"
ok "TTS played into seat A's virtual mic"

sleep "$SECS"
ssh "$HOST" "docker exec $CB pkill -f 'parec -d call_out' || true"
sleep 1

echo "== capture is real =="
# Prove the capture happened THIS run before believing anything downstream of it.
ssh "$HOST" "docker cp $CB:/tmp/cap.wav /tmp/cap.wav" >/dev/null
scp -q "$HOST:/tmp/cap.wav" "$OUT/capture.wav"
LEVEL=$(python3 -c "
import wave, audioop, sys
w = wave.open('$OUT/capture.wav'); d = w.readframes(w.getnframes())
print(round(w.getnframes()/w.getframerate(), 1), audioop.max(d, 2), audioop.rms(d, 2))")
set -- $LEVEL; CSECS=$1; CPEAK=$2; CRMS=$3
echo "  captured ${CSECS}s peak=$CPEAK rms=$CRMS -> $OUT/capture.wav"
awk "BEGIN{exit !($CSECS > 3)}"   && ok "capture is $CSECS s long"        || bad "capture too short ($CSECS s) — parec never ran"
[ "$CPEAK" -gt 2000 ]             && ok "capture is not silence (peak $CPEAK)" || bad "capture is effectively silent (peak $CPEAK)"

echo "== camera loopback: A's HUD seen from B =="
shot "$B" camera-seat-b
FRAME=$(seat "$B" remote-frame.js); echo "  $FRAME"
STATE=$(echo "$FRAME" | jqf state)
[ "$STATE" = "drawing" ] && ok "seat B is rendering a non-blank remote video" \
                         || bad "seat B remote video state=$STATE (see $OUT/camera-seat-b.png)"

echo "== transcript =="
ssh "$HOST" "docker cp /tmp/cap.wav $STT:/tmp/cap.wav" >/dev/null
ssh "$HOST" "docker exec $STT python3 -c \"
import urllib.request, json, uuid
b=open('/tmp/cap.wav','rb').read(); bd=uuid.uuid4().hex
p=[('--'+bd+'\r\nContent-Disposition: form-data; name=\\\"response_format\\\"\r\n\r\nverbose_json\r\n').encode(),
   ('--'+bd+'\r\nContent-Disposition: form-data; name=\\\"file\\\"; filename=\\\"a.wav\\\"\r\nContent-Type: audio/wav\r\n\r\n').encode()+b+b'\r\n',
   ('--'+bd+'--\r\n').encode()]
r=urllib.request.Request('http://localhost:8001/v1/audio/transcriptions',data=b''.join(p),headers={'Content-Type':'multipart/form-data; boundary='+bd})
print(json.load(urllib.request.urlopen(r,timeout=240))['text'])\"" > "$OUT/transcript.txt"
TXT=$(cat "$OUT/transcript.txt")
echo "  heard: $TXT"
HITS=0
for w in "$W1" "$W2" "$W3"; do echo "$TXT" | grep -qi "${w%r}" && HITS=$((HITS+1)); done
[ "$HITS" -ge 2 ] && ok "transcript carries this run's phrase ($HITS/3 keywords)" \
                  || bad "transcript missed this run's phrase ($HITS/3) — see $OUT/transcript.txt"

echo "== teardown =="
for pair in "$A A" "$B B"; do
  set -- $pair
  left=$(seat "$1" leave.js | jqf left)
  [ "$left" = "True" ] && ok "seat $2 left the call" || bad "seat $2 did not leave the call"
done

echo
echo "evidence: $OUT"
ls -1 "$OUT" | grep -v '^\.run-' | sed 's/^/  /'
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
