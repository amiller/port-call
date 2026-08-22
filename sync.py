#!/usr/bin/env python3
"""The sync game — measure the ACOUSTIC round trip by counting together.

    RIG=4 ./sync.py <meet-code> [--rounds 3]

Run it, then count along out loud with the bot, matching what you HEAR. It plays 1..10 on a
1.000s metronome (make-metronome.py renders the file; the onsets are fixed at render time, not
at speak time). You join in whenever you catch the rhythm — starting late is fine and is in fact
useful, because the transcript says which number you started on.

WHAT IS BEING MEASURED, and why it is not the same number ping.py reports. ping.py measures the
TRANSCRIPT loop: how long until the bot knows what you said. This measures the AUDIO loop:

    bot's speaker -> Meet -> your ear     (you count in sync with what you hear)
    your mouth    -> Meet -> bot's mic    (your voice arrives at the bot's capture)

If you count in sync with what you hear, your count k leaves your mouth at
`onset(k) + downstream`, and lands in the bot's capture at `onset(k) + downstream + upstream`.
So the offset between the transmitted onset and the received audio IS the full acoustic round
trip, plus your own sync error — which is small and roughly zero-mean across ten beats. None of
this passes through Whisper's timing, so it is a property of the audio path alone.

TIMEBASE. Transmit: `[tts] audible ts=` stamps the moment paplay begins consuming, and onset k is
exactly k seconds after that. Receive: a transcript segment's `start` is `windowStartMs`, the wall
clock at which that audio was fed to the buffer by capture — i.e. when your voice actually reached
the bot, NOT when Whisper got round to it. Both stamps are taken on the same host, so they
subtract cleanly.

HOW THE TWO TIMEBASES ARE COMBINED. A 1.000s metronome is periodic, so cross-correlating against
it is ambiguous at whole-second multiples — a 0.3s lag and a 1.3s lag correlate equally well. So
each source answers the half it can:

  * the TRANSCRIPT says which beat you started on (`numbers_in`), an unambiguous coarse anchor;
  * the AUDIO gives the sub-beat offset, by cross-correlating the received envelope against
    impulses at the known transmit onsets.

Coarse from words, fine from samples. Neither alone is enough.

TAP GEOMETRY, and the one systematic worth stating. Frames are 4096 samples (256ms at 16kHz) and
`ts` is stamped Node-side as the frame crosses the Playwright boundary (capture-bridge.ts:210), so
it marks the END of the block, not the start. Sample i of a frame therefore occurred at
`ts - (pcm_len - i)/16000`. Residual error is the page->Node serialization delay, which is small
but nonzero and biases every measurement the SAME way — so differences and jitter are trustworthy,
and the absolute floor is an upper bound rather than an exact figure.
"""
import argparse, base64, json, math, os, re, statistics, struct, subprocess, sys, time, urllib.request

RIG = os.environ.get("RIG", "4")
SFX = "" if RIG == "1" else RIG
C = f"vexa-rig{SFX}-vexa-lite-1"
GW = f"http://localhost:{8055 + int(RIG)}"
TOK = lambda k: open(f"/tmp/vexa{SFX}-{k}-token.txt").read().strip()
WORDS = "zero one two three four five six seven eight nine ten".split()
HOMOPHONES = {"won": 1, "to": 2, "too": 2, "tree": 3, "for": 4, "fore": 4, "sicks": 6, "ate": 8}
SPACING = 1.0


def gw(path, token):
    return json.load(urllib.request.urlopen(
        urllib.request.Request(f"{GW}{path}", headers={"X-API-Key": token}), timeout=10))


def docker(cmd):
    return subprocess.run(["docker", "exec", C, "sh", "-c", cmd],
                          stdout=subprocess.PIPE, text=True, check=True).stdout


def numbers_in(text):
    """Ordered, de-duplicated run of count words / digits — order matters here, unlike ping.py."""
    out = []
    for tok in re.findall(r"[a-z0-9]+", text.lower()):
        n = (int(tok) if tok.isdigit() else
             WORDS.index(tok) if tok in WORDS else HOMOPHONES.get(tok))
        if n is not None and 1 <= n <= 10 and (not out or out[-1] != n):
            out.append(n)
    return out


def alone(mid):
    """True when the bot is the only one there. Three rounds were once played into an empty room
    because nothing checked — the metronome sounded perfect and the transcript was simply silent,
    which is indistinguishable from 'the human said nothing' unless you ask."""
    docker(f"redis-cli PUBLISH bot_commands:meeting:{mid} " + json.dumps(json.dumps({"action": "selfcheck"})))
    for _ in range(40):
        time.sleep(0.4)
        out = docker(f"grep -ha '\\[selfcheck\\]' /tmp/vexa-workloads/mtg-{mid}-*.log 2>/dev/null | tail -1")
        m = re.search(r'"participantTiles":\s*(\d+)', out)
        if m:
            return int(m.group(1)) <= 1
    return False           # selfcheck never answered — do not block the run on a missing probe


def play(mid):
    act = json.dumps({"action": "speak", "text": "!count"})
    t = int(time.time() * 1000)
    docker(f"redis-cli PUBLISH bot_commands:meeting:{mid} {json.dumps(act)}")
    for _ in range(120):                       # -a: the bot log carries binary bytes
        out = docker(f"grep -ha '\\[tts\\] audible' /tmp/vexa-workloads/mtg-{mid}-*.log 2>/dev/null | tail -4")
        for line in reversed(out.strip().splitlines()):
            m = re.search(r"ts=(\d+)", line)
            if m and int(m.group(1)) >= t:
                return int(m.group(1))
        time.sleep(0.25)
    sys.exit(f"the bot never played !count — is {os.path.expanduser('~')}/vexa-rig{SFX}/shims/sfx/count.wav there? "
             f"(render it with ./make-metronome.py)")


def heard_after(room, token, t0_ms, wait=25):
    """The human's counting run: the first segment starting after t0 that holds >=2 counts."""
    deadline = time.time() + wait
    best = None
    while time.time() < deadline:
        for s in gw(f"/transcripts/google_meet/{room}", token).get("segments") or []:
            if (s.get("start") or 0) * 1000 < t0_ms:
                continue
            ns = numbers_in(s.get("text") or "")
            if len(ns) >= 2 and (best is None or s["start"] * 1000 < best["start"] * 1000):
                best = dict(s, _ns=ns)
        if best and best.get("completed"):
            return best
        time.sleep(0.4)
    return best


SR = 16000            # capture sample rate
HOP_MS = 5            # envelope resolution — far finer than the 256ms frame cadence, because the
                      # PCM inside each frame is intact and only the ANCHOR is per-frame


def tap_envelope(mid, t0_ms, span_ms):
    """Read the capture tap and return (hop_ms, base_ms, [rms...]) over [t0, t0+span].

    The tap only records frames the capture actually emitted — silence is suppressed upstream — so
    gaps in the timeline are genuine silence and are left as zeros rather than interpolated."""
    path = f"/tmp/vexa-capture-tap/capture-mtg{mid}.jsonl"
    raw = docker(f"cat {path} 2>/dev/null || true")
    if not raw.strip():
        return None
    n = span_ms // HOP_MS
    env = [0.0] * n
    for line in raw.splitlines():
        try:
            f = json.loads(line)
        except ValueError:
            continue                       # a torn last line while the bot is still writing
        pcm = base64.b64decode(f["pcm"])
        cnt = len(pcm) // 4
        if not cnt:
            continue
        vals = struct.unpack(f"<{cnt}f", pcm[:cnt * 4])
        end = f["ts"]                      # ts is the END of the block (see TAP GEOMETRY above)
        start = end - cnt / SR * 1000.0
        step = max(1, int(SR * HOP_MS / 1000))
        for i in range(0, cnt, step):
            at = start + i / SR * 1000.0
            k = int((at - t0_ms) // HOP_MS)
            if 0 <= k < n:
                chunk = vals[i:i + step]
                env[k] = max(env[k], math.sqrt(sum(v * v for v in chunk) / len(chunk)))
    return env


def best_lag(env, first_beat, n_beats, max_lag_ms=900):
    """Sub-beat offset: slide impulses at the KNOWN transmit onsets over the received envelope.

    Search is capped at max_lag_ms (< one beat) on purpose — beyond that the 1.000s period makes
    the answer ambiguous, and the transcript has already fixed which beat we are on."""
    if not env or not any(env):
        return None
    beats = [(first_beat - 1 + i) * 1000.0 for i in range(n_beats)]
    width = int(250 / HOP_MS)              # a spoken count word is ~250-400ms of energy
    best, best_score = None, -1.0
    for lag in range(-100, max_lag_ms, HOP_MS):
        score = 0.0
        for b in beats:
            k0 = int((b + lag) // HOP_MS)
            score += sum(env[k] for k in range(k0, k0 + width) if 0 <= k < len(env))
        if score > best_score:
            best_score, best = score, lag
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("room")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--gap", type=float, default=6.0, help="seconds of quiet between rounds")
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    bt, tx = TOK("bot"), TOK("tx")
    running = gw("/bots/status", bt)["running"]
    here = [b for b in running if b["native_meeting_id"] == a.room]
    if not here:
        sys.exit(f"no bot in {a.room} on rig {RIG}")
    mid = here[0]["id"]
    print(f"rig {RIG}  bot {mid}  room {a.room}  — count along out loud, match what you hear\n")

    if alone(mid):
        sys.exit(f"the bot is ALONE in {a.room} — nobody to count with. Join, then re-run.")

    offsets = []
    for r in range(a.rounds):
        t0 = play(mid)
        print(f"round {r + 1}: playing 1..10 …")
        time.sleep(10 * SPACING + 1)
        seg = heard_after(a.room, tx, t0, wait=25)
        if not seg:
            print("  heard no counting — say the numbers out loud along with it\n")
            time.sleep(a.gap)
            continue
        ns = seg["_ns"]
        first = ns[0]
        print(f"  you counted {ns}  (started on beat {first})")

        # COARSE, from the transcript: which beat, unambiguously.
        onset_ms = t0 + (first - 1) * SPACING * 1000
        coarse = seg["start"] * 1000 - onset_ms
        print(f"  coarse (transcript onset)  {coarse/1000:+.2f}s")

        # FINE, from the audio: sub-beat offset by cross-correlation against the transmit onsets.
        env = tap_envelope(mid, t0, 16000)
        lag = best_lag(env, first, len(ns)) if env else None
        if lag is None:
            print("  fine (audio) UNAVAILABLE — no capture tap data."
                  "  Enable it: docker exec <bot-container> mkdir -p /tmp/vexa-capture-tap,"
                  " then respawn the bot.\n")
            offsets.append(coarse)
        else:
            print(f"  ROUND TRIP {lag/1000:+.2f}s   (audio cross-correlation, {HOP_MS}ms resolution)")
            offsets.append(lag)
        print()
        time.sleep(a.gap)

    if offsets:
        print(f"── acoustic round trip over {len(offsets)} round(s) ──")
        print(f"  min {min(offsets)/1000:+.2f}s   median {statistics.median(offsets)/1000:+.2f}s"
              f"   max {max(offsets)/1000:+.2f}s")
        print("  (includes your own sync error; a negative value means you anticipated the beat)")


if __name__ == "__main__":
    main()
