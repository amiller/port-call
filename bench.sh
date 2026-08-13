#!/usr/bin/env bash
# Every check that needs NO meeting, NO bot and NO human. Run this before touching a real room —
# most bugs this project hit were reachable here, and the ones that weren't (Meet DOM drift) are
# the only reason e2e.sh exists.
#
#   ./bench.sh
set -uo pipefail
C=${C:-vexa-rig-vexa-lite-1}
FAIL=0

echo "== audio: click train (paplay rate/channels) =="
docker exec "$C" bash -c '
python3 -c "
import struct
sr=24000; n=sr*3; d=[0]*n
for k in range(3):
    for i in range(200): d[k*sr+i]=20000 if i%2==0 else -20000
open(\"/tmp/clicks.pcm\",\"wb\").write(b\"\".join(struct.pack(\"<h\",x) for x in d))
"
pactl set-sink-mute tts_sink 0 >/dev/null; pactl set-source-mute virtual_mic 0 >/dev/null
parecord --device=virtual_mic --file-format=wav /tmp/c.wav & REC=$!
sleep 1; paplay --raw --format=s16le --rate=24000 --channels=1 --device=tts_sink /tmp/clicks.pcm
sleep 1; kill $REC 2>/dev/null; sleep 1
python3 -c "
import wave,struct,sys
w=wave.open(\"/tmp/c.wav\"); n=w.getnframes(); ch=w.getnchannels(); sr=w.getframerate()
d=struct.unpack(f\"<{n*ch}h\", w.readframes(n)); pk=max(abs(x) for x in d)
hits=[]; last=-9999
for i,x in enumerate(d):
    if abs(x)>pk*0.5 and i-last>sr*ch*0.3: hits.append(i/ch/sr); last=i
gaps=[hits[i+1]-hits[i] for i in range(len(hits)-1)]
r=sum(gaps)/len(gaps) if gaps else 0
print(f\"PASS audio ratio={r:.3f}\" if 0.95<r<1.05 else f\"FAIL audio ratio={r:.3f} (want 1.000)\")
sys.exit(0 if 0.95<r<1.05 else 1)
"' || FAIL=1

echo "== camera + getDisplayMedia patch =="
docker cp "$(dirname "$0")/probe/camera-bench.mjs" "$C:/tmp/camera-bench.mjs" >/dev/null
docker exec "$C" sh -c "DISPLAY=:99 node /tmp/camera-bench.mjs | tail -2" || FAIL=1

echo "== surfaces: chat / camera / share / reaction vs Meet-shaped DOM =="
docker cp "$(dirname "$0")/probe/mock-meet.html" "$C:/tmp/mock-meet.html" >/dev/null
docker cp "$(dirname "$0")/probe/surface-bench.mjs" "$C:/tmp/surface-bench.mjs" >/dev/null
docker exec "$C" sh -c "DISPLAY=:99 node /tmp/surface-bench.mjs" || FAIL=1

echo "== DOM fixture tests: selector ambiguity detection =="
docker cp "$(dirname "$0")/probe/fixture-tests.mjs" "$C:/tmp/fixture-tests.mjs" >/dev/null
docker cp "$(dirname "$0")/probe/fixtures/populated-call.html" "$C:/tmp/fixtures/" >/dev/null
docker cp "$(dirname "$0")/probe/fixtures/no-bot-mic.html" "$C:/tmp/fixtures/" >/dev/null
docker cp "$(dirname "$0")/probe/fixtures/picker-closed.html" "$C:/tmp/fixtures/" >/dev/null
docker cp "$(dirname "$0")/probe/fixtures/pre-join-only.html" "$C:/tmp/fixtures/" >/dev/null
docker exec "$C" sh -c "cd /tmp/fixtures && node /tmp/fixture-tests.mjs" || FAIL=1

echo
[ "$FAIL" -eq 0 ] && echo "BENCH GREEN" || echo "BENCH RED"
exit $FAIL
