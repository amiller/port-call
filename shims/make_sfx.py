#!/usr/bin/env python3
"""Generate the built-in sound effects, at the exact format the bot's paplay wants
(s16le / 24000 Hz / mono), so the shim can serve them with no conversion.

Synthesized rather than downloaded — no rights questions, no external fetch.
    python3 make_sfx.py        # writes sfx/*.wav
"""
import math, random, struct, wave
from pathlib import Path

RATE = 24000
OUT = Path(__file__).parent / "sfx"


def write(name, samples):
    OUT.mkdir(exist_ok=True)
    peak = max(1e-9, max(abs(s) for s in samples))
    frames = b"".join(struct.pack("<h", int(max(-1, min(1, s / peak * 0.89)) * 32767)) for s in samples)
    with wave.open(str(OUT / f"{name}.wav"), "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(frames)
    print(f"  {name}.wav  {len(samples)/RATE:.2f}s")


def saw(t, f):
    return 2 * ((t * f) % 1.0) - 1.0


def airhorn(dur=1.5):
    """Two detuned saws a fifth apart + a rasp, with a fast attack and a hard cut."""
    out = []
    for i in range(int(RATE * dur)):
        t = i / RATE
        env = min(1.0, t / 0.05) * (1.0 if t < dur - 0.18 else max(0.0, (dur - t) / 0.18))
        rasp = 1 + 0.03 * math.sin(2 * math.pi * 47 * t)
        v = saw(t, 233 * rasp) + saw(t, 349 * rasp) * 0.8 + saw(t, 466 * rasp) * 0.45
        out.append(v * env * 0.5)
    return out


def gavel(knocks=3, gap=0.32):
    """Wood strike: noise transient over a decaying low thump. Three raps."""
    out = [0.0] * int(RATE * (gap * knocks + 0.1))
    for k in range(knocks):
        start = int(RATE * gap * k)
        for i in range(int(RATE * 0.22)):
            t = i / RATE
            body = math.sin(2 * math.pi * 180 * t) * math.exp(-t * 42)
            crack = (random.uniform(-1, 1)) * math.exp(-t * 150)
            ring = math.sin(2 * math.pi * 720 * t) * math.exp(-t * 70) * 0.3
            if start + i < len(out):
                out[start + i] += body + crack * 0.7 + ring
    return out


def ding(dur=1.1):
    out = []
    for i in range(int(RATE * dur)):
        t = i / RATE
        env = math.exp(-t * 4.5)
        out.append((math.sin(2 * math.pi * 880 * t) + 0.4 * math.sin(2 * math.pi * 1760 * t)) * env)
    return out


def objection(dur=0.9):
    """Rising two-tone alert — 'the court would like your attention'."""
    out = []
    for i in range(int(RATE * dur)):
        t = i / RATE
        f = 520 if t < dur / 2 else 780
        env = min(1.0, t / 0.02) * min(1.0, (dur - t) / 0.06)
        out.append(math.sin(2 * math.pi * f * t) * env * 0.8)
    return out


if __name__ == "__main__":
    random.seed(7)
    print("writing sfx/")
    write("airhorn", airhorn())
    write("gavel", gavel())
    write("ding", ding())
    write("objection", objection())
