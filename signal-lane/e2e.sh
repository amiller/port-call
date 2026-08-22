#!/usr/bin/env bash
# Signal lane end-to-end: two linked seats, no human in the room.
#
#   ./e2e.sh
#
# Seat A speaks and shows a camera; seat B listens and watches. Because both seats are ours, every
# assertion is machine-checkable — a real transcript of a phrase we chose, and a video frame we
# rendered. That is the difference between this and the Meet e2e, which still needs an open room.
#
# WHAT THIS CANNOT PROVE: speaker attribution. Both seats are linked devices of ONE account, so the
# call sees one identity twice. Attribution needs a second account and is deliberately not asserted.
set -euo pipefail
cd "$(dirname "$0")"

A=${A_PORT:-9334}          # CDP for seat A, via ssh tunnel to fractal
B=${B_PORT:-9335}          # CDP for seat B
CA=port-call-signal-a
CB=port-call-signal-b
RIG=${RIG:-4}              # which rig's shims to borrow for TTS + transcription
TTS=vexa-rig$RIG-tts-shim-1
STT=vexa-rig$RIG-near-shim-1
SECS=${SECS:-22}           # capture window on seat B
OUT=${OUT:-/tmp/signal-e2e-$(date +%H%M%S)}
mkdir -p "$OUT"

PASS=0; FAIL=0
ok()  { echo "PASS $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL $*"; FAIL=$((FAIL+1)); }
# Every seat action = lib.js (helpers) + the action script, evaluated in the renderer.
seat() { local port=$1 script=$2; cat js/lib.js "js/$script" > "$OUT/.run.js"; node cdp.mjs "$port" eval "$OUT/.run.js"; }
raw()  { node cdp.mjs "$1" eval -e "$2"; }
jqf()  { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$1'))"; }

# A phrase Whisper transcribes reliably — no digits (they come back as words or numerals at random)
# and no proper nouns. Three distinct content words; two hits is a pass, so one dropped word does
# not fail an otherwise working pipeline.
WORDS=(harbor cricket velvet)
PHRASE="the ${WORDS[0]} and the ${WORDS[1]} share a ${WORDS[2]} morning"

echo "== preconditions =="
for pair in "$A A" "$B B"; do
  set -- $pair
  linked=$(seat "$1" link-state.js | jqf linked)
  [ "$linked" = "True" ] && ok "seat $2 is linked" || { bad "seat $2 is NOT linked — scan its QR first"; exit 1; }
done

echo "== configure seat A (speaker) =="
# The HUD must be an INIT script, not an injection into a live page: Signal enumerates video
# inputs once at startup and caches the result, so a late patch of enumerateDevices leaves Signal
# believing there is no camera — it then never calls getUserMedia and the tile shows an avatar.
node cdp.mjs "$A" init js/hud.js > /dev/null
sleep 8
seat "$A" set-devices.js
raw "$A" "globalThis.__vexaCam.set('PORT CALL E2E', '$(date +%H:%M:%S)'); globalThis.__pcCam = true; 'ok'" > /dev/null
ok "seat A: virtual_mic + call_out selected, HUD injected"

echo "== configure seat B (listener) =="
seat "$B" set-devices.js
ok "seat B: virtual_mic + call_out selected"

echo "== call link =="
# Both seats open the SAME link URL. Matching by list row does not work: call links do not reliably
# sync between two devices of one account, and Signal's "Active" marker depends on a periodic SFU
# peek that a second device may never see. The URL needs neither — Signal fetches the link.
LINK=$(seat "$A" create-link.js | jqf url)
case "$LINK" in https://signal.link/call/#key=*) ok "call link: $LINK";; *) bad "no call link URL (got '$LINK')"; exit 1;; esac
KEY=${LINK#*#key=}

echo "== reset =="
# A seat left in a call by a previous run blocks the next join behind a modal, which reads exactly
# like a broken join. reset.js loops and VERIFIES rather than clicking once and assuming.
seat "$A" reset.js > /dev/null; seat "$B" reset.js > /dev/null
ok "both seats out of any prior call"

echo "== join =="
for pair in "$CA a" "$CB b"; do
  set -- $pair
  ssh fractal "docker exec $1 sh -c 'DISPLAY=:99 signal-desktop --user-data-dir=/data --no-sandbox \"sgnl://signal.link/call/#key=$KEY\" >/dev/null 2>&1 &'"
done
sleep 10
node cdp.mjs "$A" perms > /dev/null; node cdp.mjs "$B" perms > /dev/null
raw "$A" "globalThis.__pcCam = true; 'ok'" > /dev/null
raw "$B" "globalThis.__pcCam = false; 'ok'" > /dev/null
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

echo "== speak: TTS on A -> capture on B =="
ssh fractal "docker exec $CB sh -c 'parec -d call_out.monitor --file-format=wav --format=s16le --rate=16000 --channels=1 /tmp/cap.wav' " &
CAPSSH=$!
sleep 2
# TTS is the rig's own shim (piper, local — no meeting text leaves the machine), piped straight
# into seat A's tts_sink, whose monitor is remapped as the mic Signal is transmitting.
# The shim returns HEADERLESS raw PCM (s16le/24000/mono) because Vexa pipes it into `paplay --raw`;
# a WAV header would be played as noise. And unmute first: a muted sink's monitor records pure
# silence, which is indistinguishable from a dead audio chain (tts-shim.py's own hard-won note).
ssh fractal "docker exec $TTS python3 -c \"
import urllib.request, json
b=json.dumps({'model':'tts-1','input':'''$PHRASE''','voice':'auto'}).encode()
r=urllib.request.Request('http://localhost:8002/v1/audio/speech',data=b,headers={'Content-Type':'application/json'})
open('/tmp/say.pcm','wb').write(urllib.request.urlopen(r,timeout=90).read())
print('tts ok')\" && docker cp $TTS:/tmp/say.pcm /tmp/say.pcm && docker cp /tmp/say.pcm $CA:/tmp/say.pcm \
  && docker exec $CA pactl set-sink-mute tts_sink 0 \
  && docker exec $CA paplay --raw --format=s16le --rate=24000 --channels=1 --device=tts_sink /tmp/say.pcm && echo played"
ok "TTS played into seat A's virtual mic"

sleep "$SECS"
kill $CAPSSH 2>/dev/null || true
ssh fractal "docker exec $CB pkill -f 'parec -d call_out' || true"
sleep 1

echo "== camera loopback: A's HUD seen from B =="
node cdp.mjs "$B" shot "$OUT/seat-b.png" > /dev/null
FRAME=$(seat "$B" remote-frame.js)
echo "  $FRAME"
SPREAD=$(echo "$FRAME" | python3 -c "import json,sys; print(json.load(sys.stdin).get('spread') or 0)")
[ "$SPREAD" -gt 20 ] && ok "seat B is rendering a non-blank remote video (spread $SPREAD)" \
                     || bad "seat B's remote video looks blank (spread $SPREAD)"

echo "== transcript =="
ssh fractal "docker cp $CB:/tmp/cap.wav /tmp/cap.wav && docker cp /tmp/cap.wav $STT:/tmp/cap.wav"
TXT=$(ssh fractal "docker exec $STT python3 -c \"
import urllib.request, json, uuid
b=open('/tmp/cap.wav','rb').read(); bd=uuid.uuid4().hex
p=[('--'+bd+'\r\nContent-Disposition: form-data; name=\\\"response_format\\\"\r\n\r\nverbose_json\r\n').encode(),
   ('--'+bd+'\r\nContent-Disposition: form-data; name=\\\"file\\\"; filename=\\\"a.wav\\\"\r\nContent-Type: audio/wav\r\n\r\n').encode()+b+b'\r\n',
   ('--'+bd+'--\r\n').encode()]
r=urllib.request.Request('http://localhost:8001/v1/audio/transcriptions',data=b''.join(p),headers={'Content-Type':'multipart/form-data; boundary='+bd})
print(json.load(urllib.request.urlopen(r,timeout=240)).get('text',''))\"")
echo "  heard: $TXT"
HITS=0
for w in "${WORDS[@]}"; do echo "$TXT" | grep -qi "$w" && HITS=$((HITS+1)); done
[ "$HITS" -ge 2 ] && ok "transcript carries the spoken phrase ($HITS/3 keywords)" \
                  || bad "transcript missed the phrase ($HITS/3 keywords)"

echo "== teardown =="
seat "$A" leave.js > /dev/null; seat "$B" leave.js > /dev/null
ok "both seats left the call"

echo
echo "artifacts: $OUT"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
