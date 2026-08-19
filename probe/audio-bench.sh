#!/usr/bin/env bash
# Click train through the bot's audio path: play 3 clicks 1s apart into tts_sink, record them back
# off virtual_mic, assert the gaps survive at 1.000s. This is what catches a sample-rate or channel
# mismatch between the TTS sink and the mic the meeting actually hears.
#
# Runs INSIDE the bot container (bench.sh docker cp's it in). It was inline in bench.sh until
# 2026-08-19, where a fixed `sleep 1` before playback made it flaky: pulse leaves both devices
# SUSPENDED, and on a loaded box parecord had not begun capturing when the first click played, so
# the run reported ratio=0.000 — a red that looks exactly like a real regression. Wait for the
# capture to actually start instead of guessing at it.
set -uo pipefail
pactl set-sink-mute tts_sink 0 >/dev/null
pactl set-source-mute virtual_mic 0 >/dev/null

python3 -c '
import struct
sr = 24000
d = [0] * (sr * 3)
for k in range(3):
    for i in range(200):
        d[k * sr + i] = 20000 if i % 2 == 0 else -20000
open("/tmp/clicks.pcm", "wb").write(b"".join(struct.pack("<h", x) for x in d))
'

rm -f /tmp/c.wav
parecord --device=virtual_mic --file-format=wav /tmp/c.wav & REC=$!
# A wav header is 44 bytes; anything beyond it means frames are landing. Give it 10s to wake.
for _ in $(seq 1 100); do
  [ -s /tmp/c.wav ] && [ "$(stat -c %s /tmp/c.wav)" -gt 4096 ] && break
  sleep 0.1
done
[ "$(stat -c %s /tmp/c.wav 2>/dev/null || echo 0)" -gt 4096 ] || {
  kill $REC 2>/dev/null; echo "FAIL audio — virtual_mic never started capturing"; exit 1; }

paplay --raw --format=s16le --rate=24000 --channels=1 --device=tts_sink /tmp/clicks.pcm
sleep 1; kill $REC 2>/dev/null; sleep 1

python3 -c '
import wave, struct, sys
w = wave.open("/tmp/c.wav"); n = w.getnframes(); ch = w.getnchannels(); sr = w.getframerate()
d = struct.unpack(f"<{n*ch}h", w.readframes(n))
pk = max(abs(x) for x in d) if d else 0
if pk == 0:
    print("FAIL audio — captured pure silence"); sys.exit(1)
hits, last = [], -9999
for i, x in enumerate(d):
    if abs(x) > pk * 0.5 and i - last > sr * ch * 0.3:
        hits.append(i / ch / sr); last = i
gaps = [hits[i+1] - hits[i] for i in range(len(hits) - 1)]
r = sum(gaps) / len(gaps) if gaps else 0
ok = 0.95 < r < 1.05
print(f"{'"'"'PASS'"'"' if ok else '"'"'FAIL'"'"'} audio ratio={r:.3f}" + ("" if ok else " (want 1.000)"))
sys.exit(0 if ok else 1)
'
