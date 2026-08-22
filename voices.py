#!/usr/bin/env python3
"""Time-to-first-audio for a TTS candidate, measured through the path the bot actually uses.

    ./voices.py --url http://localhost:8002/v1/audio/speech
    ./voices.py --url https://<hosted>/v1/audio/speech --key-env HOSTED_TTS_KEY --vram

WHAT IS MEASURED, and why TTFA is the only number that matters here. The bot does
`res.pipe(paplay.stdin)` (bot-tts-playback.ts:154) — it streams. So the moment audio bytes leave
the engine, they are audible. What it costs to claim the floor is therefore TIME TO FIRST BYTE,
not total synthesis time. Today those are the same number, because the shim answers with a
Content-Length body and so cannot reply until synthesis has finished; a candidate that streams is
worth nothing until that changes. This harness reports both, so the gap between them IS the
speedup a streaming shim would unlock, per candidate.

RTF is reported too but is the wrong metric for barge-in: it is an amortized throughput figure and
says nothing about the first 100ms. Measured against `!count` at 82-91ms — the pre-rendered sfx
path is the floor any candidate is competing with.

Audio duration assumes the s16le/24k/mono the bot tells paplay to expect, so a candidate that
answers in another format will report a wrong duration and a wrong RTF — which is the correct
outcome, since that stream would also be played as noise.
"""
import argparse, json, os, subprocess, threading, time, urllib.request

RATE, WIDTH = 24000, 2
SHORT = "Hold on, one second."
LONG = ("Hold on — I want to jump in here, because that last point about latency "
        "is the whole thing, and I think we just talked past it.")


def peak_vram(stop, out):
    base = None
    while not stop.is_set():
        used = int(subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                  stdout=subprocess.PIPE, text=True, check=True).stdout.split("\n")[0])
        base = used if base is None else base
        out["peak"] = max(out.get("peak", 0), used)
        out["base"] = min(out.get("base", base), used)
        time.sleep(0.05)


def probe(url, key, model, voice, text, vram):
    body = json.dumps({"model": model, "input": text, "voice": voice}).encode()
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    v, stop = {}, threading.Event()
    if vram:
        threading.Thread(target=peak_vram, args=(stop, v), daemon=True).start()
    t0 = time.time()
    res = urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=180)
    first = res.read(1)
    ttfa = (time.time() - t0) * 1000
    n = len(first) + len(res.read())
    total = (time.time() - t0) * 1000
    stop.set()
    time.sleep(0.12)
    audio_s = n / (RATE * WIDTH)
    return dict(ttfa_ms=round(ttfa), total_ms=round(total), bytes=n, audio_s=round(audio_s, 2),
                rtf=round(total / 1000 / audio_s, 2) if audio_s else None,
                streamed=ttfa < total * 0.5,
                vram_mb=(v["peak"] - v["base"]) if vram and "peak" in v else None,
                chunked=res.headers.get("Transfer-Encoding") == "chunked")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--key-env", help="env var holding the bearer token; hosted candidates need one")
    ap.add_argument("--model", default="tts-1")
    ap.add_argument("--voice", default="alloy")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--vram", action="store_true", help="sample nvidia-smi — only meaningful on the GPU host")
    a = ap.parse_args()
    key = os.environ[a.key_env] if a.key_env else None

    for label, text in (("short", SHORT), ("long", LONG)):
        rows = [probe(a.url, key, a.model, a.voice, text, a.vram) for _ in range(a.runs)]
        ttfa = sorted(r["ttfa_ms"] for r in rows)
        r = rows[-1]
        vram = f"  vram +{r['vram_mb']}MB" if r["vram_mb"] else ""
        print(f"{label:<6} ttfa {ttfa[0]:>5}-{ttfa[-1]:<5}ms  total {r['total_ms']:>5}ms  "
              f"audio {r['audio_s']:>5.2f}s  rtf {r['rtf']}  "
              f"{'STREAMED' if r['streamed'] else 'buffered'}"
              f"{'  chunked' if r['chunked'] else ''}{vram}")


if __name__ == "__main__":
    main()
