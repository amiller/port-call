#!/usr/bin/env python3
"""Render a counting metronome with EXACT onsets, for the acoustic round-trip measurement.

    RIG=4 ./make-metronome.py            # -> <rigdir>/shims/sfx/count.wav, played by `speak !count`

Why a pre-rendered file instead of ten speak acts. A speak act costs 1.28-1.95s of synthesis
before any sound (measured 2026-08-20), and that varies per act — so ten of them are not a
metronome, they are ten unknown offsets. One file played by the shim's `!name` sfx path has its
onsets fixed at render time: count k starts at exactly k seconds after playback begins, and the
only unknown left is the single playback start, which `[tts] audible ts=` already stamps.

Each number is silence-trimmed at the head before placement. Piper emits 100-200ms of lead-in,
and leaving it in would put the audible attack that much after the nominal onset — an error the
size of the thing being measured.

The point of the exercise: the bot plays this, a human counts along in sync with what they HEAR,
and the offset between transmitted onset k and the received audio of the human's count k is the
full acoustic round trip (bot -> Meet -> ear, mouth -> Meet -> bot) plus the human's sync error,
which is roughly zero-mean over ten beats. This is independent of Whisper — it is a property of
the audio path, not of transcription.
"""
import json, os, struct, subprocess, sys, urllib.request

RIG = os.environ.get("RIG", "4")
SFX = "" if RIG == "1" else RIG
SHIM = f"vexa-rig{SFX}-tts-shim-1"
RIGDIR = os.path.expanduser(f"~/vexa-rig{SFX}")
RATE = 24000                      # the shim's output format: s16le, 24k, mono
SPACING = 1.0                     # seconds between onsets
WORDS = "one two three four five six seven eight nine ten".split()
THRESH = 600                      # |sample| that counts as the attack (s16 full scale 32768)


def render_in_shim():
    """Synthesize each word inside the shim container and return {word: trimmed pcm bytes}."""
    script = f'''
import json, urllib.request, base64, struct
out = {{}}
for w in {WORDS!r}:
    b = json.dumps({{"model": "tts-1", "input": w, "voice": "alloy"}}).encode()
    r = urllib.request.Request("http://localhost:8002/v1/audio/speech", data=b,
                               headers={{"Content-Type": "application/json"}})
    pcm = urllib.request.urlopen(r, timeout=60).read()
    n = len(pcm) // 2
    s = struct.unpack("<%dh" % n, pcm[:n * 2])
    first = next((i for i, v in enumerate(s) if abs(v) > {THRESH}), 0)
    last = len(s) - next((i for i, v in enumerate(reversed(s)) if abs(v) > {THRESH}), 0)
    out[w] = base64.b64encode(pcm[first * 2:last * 2]).decode()
print(json.dumps(out))
'''
    raw = subprocess.run(["docker", "exec", "-i", SHIM, "python3", "-c", script],
                         stdout=subprocess.PIPE, text=True, check=True).stdout
    import base64
    return {k: base64.b64decode(v) for k, v in json.loads(raw).items()}


def main():
    parts = render_in_shim()
    total = int(RATE * (SPACING * (len(WORDS) - 1))) + len(parts[WORDS[-1]]) // 2 + RATE // 2
    buf = bytearray(total * 2)
    for k, w in enumerate(WORDS):
        at = int(k * SPACING * RATE) * 2
        pcm = parts[w]
        if at + len(pcm) > len(buf):
            sys.exit(f"'{w}' ({len(pcm)//2/RATE:.2f}s) overruns the {SPACING}s slot — shorten SPACING")
        buf[at:at + len(pcm)] = pcm
        print(f"  {w:<6} onset {k * SPACING:5.3f}s  len {len(pcm)//2/RATE:.2f}s")

    wav = (b"RIFF" + struct.pack("<I", 36 + len(buf)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, RATE, RATE * 2, 2, 16)
           + b"data" + struct.pack("<I", len(buf)) + bytes(buf))
    dest = f"{RIGDIR}/shims/sfx/count.wav"
    open(dest, "wb").write(wav)
    print(f"\n{dest}  ({len(wav)} bytes, {total/RATE:.2f}s, onsets every {SPACING}s)")
    print(f'play it:  {{"action":"speak","text":"!count"}}')


if __name__ == "__main__":
    main()
