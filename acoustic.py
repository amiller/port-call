#!/usr/bin/env python3
"""ACOUSTIC SELF-TEST — measure the speaking round trip in the lab room with nobody in it.

    ./acoustic.py [meet-code]           RIG_A=4 RIG_B=3 by default

Runs on fractal. Three legs, and the point is the DECOMPOSITION — a single round-trip number
cannot tell you whether the latency is ours or Google's, and the answer decides what is worth
optimising:

  1. LOOPBACK   paplay -> tts_sink -> virtual_mic, recorded with parecord.
                No meeting, no bot, no browser. This is the rig's own transmit plumbing.
  2. A -> B     rig A plays the metronome, rig B's capture tap records it.
                Adds Chromium's encode, Meet's servers, Chromium's decode, WebAudio capture,
                the 256ms capture block, and the Playwright boundary.
  3. B -> A     the same in reverse, because the two directions need not be symmetric.

    round trip  = (A->B) + (B->A)
    Meet's share = one-way - loopback

WHY THIS EXISTS AT ALL. Every latency figure this rig could previously produce was measured at
the TRANSCRIPT, downstream of buffering, Whisper and LocalAgreement-2 confirmation — so it said
nothing about the audio path. Worse, a human counting into a live call produced NO transcript
segments at all (2026-08-20: 61 captured frames, zero segments), so the transcript cannot even
reliably tell you a sound happened. This measures the audio directly, and needs no human, which
means it can run unattended like every other rung.

The metronome is `shims/sfx/count.wav`, rendered by make-metronome.py with onsets fixed at exactly
1.000s and each number head-trimmed, played through the TTS shim's `!name` sfx path (~85ms to
audible, versus 1300-1900ms for real synthesis). `[tts] audible ts=` stamps playback start; onset
k is exactly k seconds later.

AMBIGUITY, handled: a 1.000s metronome is periodic, so correlation peaks repeat every second and
the search is capped below one beat. A true one-way latency above ~900ms would alias and be
reported as itself minus a second. The loopback leg bounds how plausible that is.
"""
import base64, json, math, os, re, statistics, struct, subprocess, sys, time, urllib.request

ROOM = "tog-tccc-szk"
A = os.environ.get("RIG_A", "4")
B = os.environ.get("RIG_B", "3")
SR = 16000          # capture tap sample rate
HOP_MS = 5
SPACING = 1.0
BEATS = 10


def sfx(rig):
    return "" if rig == "1" else rig


def cont(rig):
    return f"vexa-rig{sfx(rig)}-vexa-lite-1"


def gwurl(rig):
    return f"http://localhost:{8055 + int(rig)}"


def tok(rig, kind):
    return open(f"/tmp/vexa{sfx(rig)}-{kind}-token.txt").read().strip()


def sh(cmd):
    return subprocess.run(["sh", "-c", cmd], stdout=subprocess.PIPE, text=True).stdout


def dk(rig, cmd):
    return subprocess.run(["docker", "exec", cont(rig), "sh", "-c", cmd],
                          stdout=subprocess.PIPE, text=True).stdout


def gw(rig, path, kind="bot"):
    return json.load(urllib.request.urlopen(
        urllib.request.Request(f"{gwurl(rig)}{path}", headers={"X-API-Key": tok(rig, kind)}), timeout=10))


def envelope_of(samples, sr, hop_ms=HOP_MS):
    hop = max(1, int(sr * hop_ms / 1000))
    return [max(abs(v) for v in samples[i:i + hop]) for i in range(0, len(samples) - hop, hop)]


def onsets_of(env, frac=0.20, min_gap_ms=500):
    """First bin of each burst above `frac` of peak — an attack detector, not a peak finder.
    The loudest moment of a spoken word is mid-word and drifts by word; the attack does not."""
    pk = max(env) if env else 0
    if pk <= 0:
        return []
    out, i, skip = [], 0, int(min_gap_ms / HOP_MS)
    while i < len(env):
        if env[i] > pk * frac:
            out.append(i * HOP_MS / 1000.0)
            i += skip
        else:
            i += 1
    return out


# ── leg 1: loopback, no meeting ────────────────────────────────────────────────────────────────
def loopback(rig, lead=0.6):
    """Play the metronome into tts_sink and record virtual_mic. Returns ms of local transmit path."""
    c = cont(rig)
    subprocess.run(["docker", "cp", f"{os.path.expanduser('~')}/vexa-rig{sfx(rig)}/shims/sfx/count.wav",
                    f"{c}:/tmp/count.wav"], stdout=subprocess.DEVNULL, check=True)
    dk(rig, f"""
      pactl set-sink-mute tts_sink 0; pactl set-source-mute virtual_mic 0
      rm -f /tmp/loop.wav
      parecord --device=virtual_mic --format=s16le --rate=24000 --channels=1 --file-format=wav /tmp/loop.wav &
      RP=$!
      sleep {lead}
      paplay --device=tts_sink /tmp/count.wav
      sleep 0.5
      kill -INT $RP 2>/dev/null; sleep 1
    """)
    raw = dk(rig, "python3 -c \"import wave,struct,sys,base64;"
                  "w=wave.open('/tmp/loop.wav');n=w.getnframes();"
                  "print(w.getframerate());print(base64.b64encode(w.readframes(n)).decode())\"")
    lines = raw.strip().splitlines()
    if len(lines) < 2:
        return None
    sr = int(lines[0])
    pcm = base64.b64decode(lines[1])
    s = struct.unpack(f"<{len(pcm)//2}h", pcm[:len(pcm) // 2 * 2])
    ons = onsets_of(envelope_of(s, sr))
    if not ons:
        return None
    gaps = [round(ons[i + 1] - ons[i], 3) for i in range(len(ons) - 1)]
    print(f"  loopback: {len(ons)} onsets, gaps {gaps[:6]}{'…' if len(gaps) > 6 else ''}")
    return (ons[0] - lead) * 1000.0


# ── legs 2 and 3: one bot plays, the other's tap listens ───────────────────────────────────────
def tap_envelope(rig, mid, t0_ms, span_ms=16000):
    raw = dk(rig, f"cat /tmp/vexa-capture-tap/capture-mtg{mid}.jsonl 2>/dev/null || true")
    if not raw.strip():
        return None
    n = span_ms // HOP_MS
    env = [0.0] * n
    for line in raw.splitlines():
        try:
            f = json.loads(line)
        except ValueError:
            continue
        pcm = base64.b64decode(f["pcm"])
        cnt = len(pcm) // 4
        if not cnt:
            continue
        vals = struct.unpack(f"<{cnt}f", pcm[:cnt * 4])
        start = f["ts"] - cnt / SR * 1000.0        # ts is the END of the block
        step = max(1, int(SR * HOP_MS / 1000))
        for i in range(0, cnt, step):
            k = int((start + i / SR * 1000.0 - t0_ms) // HOP_MS)
            if 0 <= k < n:
                ch = vals[i:i + step]
                env[k] = max(env[k], math.sqrt(sum(v * v for v in ch) / len(ch)))
    return env


def best_lag(env, beats=BEATS, max_lag_ms=900):
    if not env or not any(env):
        return None
    width = int(250 / HOP_MS)
    best, score_best = None, -1.0
    for lag in range(-50, max_lag_ms, HOP_MS):
        score = 0.0
        for i in range(beats):
            k0 = int((i * SPACING * 1000 + lag) // HOP_MS)
            score += sum(env[k] for k in range(k0, k0 + width) if 0 <= k < len(env))
        if score > score_best:
            score_best, best = score, lag
    return best


# ── the duet: B hears A's beat, locks to it, and counts along ──────────────────────────────────
def live_onsets(rig, mid, since_ms, thresh=0.05):
    """Onsets (wall-clock ms) visible in the tap RIGHT NOW, after `since_ms`.

    This is the same energy read the fast responder in #41 would need: no ASR, no LLM, just
    'did something loud start, and when'. The tap is append-only, so re-reading is cheap and safe
    while the bot is still writing (a torn final line is skipped, not fatal)."""
    raw = dk(rig, f"cat /tmp/vexa-capture-tap/capture-mtg{mid}.jsonl 2>/dev/null || true")
    hits = []
    for line in raw.splitlines():
        try:
            f = json.loads(line)
        except ValueError:
            continue
        if f["ts"] < since_ms:
            continue
        pcm = base64.b64decode(f["pcm"])
        cnt = len(pcm) // 4
        if not cnt:
            continue
        vals = struct.unpack(f"<{cnt}f", pcm[:cnt * 4])
        start = f["ts"] - cnt / SR * 1000.0
        step = max(1, int(SR * HOP_MS / 1000))
        prev_loud = False
        for i in range(0, cnt, step):
            ch = vals[i:i + step]
            loud = math.sqrt(sum(v * v for v in ch) / len(ch)) > thresh
            if loud and not prev_loud:
                hits.append(start + i / SR * 1000.0)
            prev_loud = loud
    # collapse anything inside half a beat — one word is several loud hops
    out = []
    for h in sorted(hits):
        if not out or h - out[-1] > SPACING * 500:
            out.append(h)
    return out


def duet(a_rig, b_rig, mid_a, mid_b, b_offset_ms):
    """A plays the metronome; B listens, locks phase, and counts along on the beat it HEARS.

    B's counts therefore carry one full downstream leg already (it heard A late), and arrive back
    at A a full upstream leg later — so A's measurement of B against A's OWN transmit onsets is
    the round trip, which is exactly the number the human version produces with a person in B's
    seat. b_offset_ms is how early B must publish its act for its audio to be audible ON the beat.
    """
    t0 = play(a_rig, mid_a)                       # A's transmit clock: onset k = t0 + k*1000
    print(f"  A playing (t0={t0}); B listening for the beat …")

    heard, deadline = [], time.time() + 6
    while time.time() < deadline and len(heard) < 2:
        time.sleep(0.35)
        heard = live_onsets(b_rig, mid_b, t0 - 500)
    if len(heard) < 2:
        print(f"  B never heard a beat to lock onto ({len(heard)} onset(s)) — no duet")
        return None

    # Phase from the onsets B actually heard, not from t0: B is only allowed to know what it hears.
    period = SPACING * 1000
    phase = statistics.median((h - heard[0]) % period for h in heard)
    base = heard[0] + phase - phase                # heard[0] IS the reference; keep it explicit
    nxt = base
    while nxt < time.time() * 1000 + b_offset_ms + 400:
        nxt += period
    beat_index = round((nxt - base) / period)
    wait = (nxt - b_offset_ms) / 1000.0 - time.time()
    print(f"  B locked on {len(heard)} onsets, first at {heard[0]:.0f}; "
          f"counting in on its beat {beat_index} (waiting {wait:.2f}s)")
    if wait > 0:
        time.sleep(wait)
    t0_b = play(b_rig, mid_b)

    time.sleep(BEATS * SPACING + 3)
    env = tap_envelope(a_rig, mid_a, t0)
    if env is None:
        print(f"  no tap data on rig {a_rig}")
        return None
    # B started on ITS beat `beat_index`, which is A's onset `beat_index` too (same beat, heard
    # late). Correlate B's arrivals against A's transmit onsets from that beat on.
    width = int(250 / HOP_MS)
    best, score_best = None, -1.0
    # Inside ONE period. 1800 spanned nearly two beats and duly aliased: a real 465ms
    # round trip was reported as 1465ms on 2026-08-20. The beat index is already known
    # from what B locked onto, so there is nothing to gain from a wider window.
    for lag in range(-50, 950, HOP_MS):
        score = 0.0
        for i in range(beat_index, BEATS):
            k0 = int((i * period + lag) // HOP_MS)
            score += sum(env[k] for k in range(k0, k0 + width) if 0 <= k < len(env))
        if score > score_best:
            score_best, best = score, lag
    print(f"  B's counting came back to A at lag {best} ms")
    return best


def bot_in(rig):
    r = [b for b in gw(rig, "/bots/status")["running"] if b["native_meeting_id"] == ROOM]
    return (r[0]["id"], r[0]["status"]) if r else (None, None)


def spawn(rig, name):
    body = json.dumps({"platform": "google_meet", "native_meeting_id": ROOM,
                       "bot_name": name, "voice_agent_enabled": True}).encode()
    resp = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{gwurl(rig)}/bots", data=body, method="POST",
        headers={"X-API-Key": tok(rig, "bot"), "Content-Type": "application/json"}), timeout=30))
    if "id" not in resp:
        sys.exit(f"rig {rig} spawn rejected: {resp}")
    for _ in range(30):
        time.sleep(5)
        mid, st = bot_in(rig)
        if st == "active":
            return mid
    sys.exit(f"rig {rig} never went active in {ROOM}")


def stop(rig):
    req = urllib.request.Request(f"{gwurl(rig)}/bots/google_meet/{ROOM}", method="DELETE",
                                 headers={"X-API-Key": tok(rig, "bot")})
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception:
        pass


def play(rig, mid):
    act = json.dumps({"action": "speak", "text": "!count"})
    t = int(time.time() * 1000)
    dk(rig, f"redis-cli PUBLISH bot_commands:meeting:{mid} {json.dumps(act)}")
    for _ in range(80):
        out = dk(rig, f"grep -ha '\\[tts\\] audible' /tmp/vexa-workloads/mtg-{mid}-*.log 2>/dev/null | tail -4")
        for line in reversed(out.strip().splitlines()):
            m = re.search(r"ts=(\d+)", line)
            if m and int(m.group(1)) >= t:
                return int(m.group(1))
        time.sleep(0.25)
    sys.exit(f"rig {rig} never played !count — is shims/sfx/count.wav rendered? (./make-metronome.py)")


def one_way(src, dst, src_mid, dst_mid, label):
    t0 = play(src, src_mid)
    time.sleep(BEATS * SPACING + 2)
    env = tap_envelope(dst, dst_mid, t0)
    if env is None:
        print(f"  {label}: NO TAP DATA on rig {dst} — is /tmp/vexa-capture-tap there? "
              f"(docker exec {cont(dst)} mkdir -p /tmp/vexa-capture-tap, then respawn)")
        return None
    lag = best_lag(env)
    ons = onsets_of(env)
    # Two estimators, deliberately both shown. best_lag fits a 250ms box at each onset, so it
    # centres on the energy MASS of a spoken word and reads LATE; the attack detector catches the
    # leading edge. The attack figure is the better latency estimate; the gap between them is the
    # word's own rise time, not jitter, and hiding either would make the number look more certain
    # than it is.
    # MODULO THE PERIOD, and this is the whole trick. Meet's transmission ramp swallows the first
    # ~1s of audio after silence, so the earliest attack we detect is often beat 1 or 2, not beat 0
    # — taking it at face value reported a 220ms path as 1220ms. The beats are 1.000s apart, so the
    # sub-beat remainder is the latency regardless of how many leading beats were lost. Bounded, as
    # always, by the assumption that the true one-way is under a full beat.
    attack = (ons[0] * 1000) % (SPACING * 1000) if ons else None
    if attack is not None:
        lost = int(ons[0] * 1000 // (SPACING * 1000))
        print(f"  {label}: {attack:.0f} ms   ({len(ons)} bursts, peak rms {max(env):.3f}, "
              f"{lost} leading beat(s) swallowed, box-fit would say {lag})")
    else:
        print(f"  {label}: box-fit {lag} ms, no clean attack")
    return attack if attack is not None else lag


def main():
    global ROOM
    if len(sys.argv) > 1:
        ROOM = sys.argv[1]
    if A == B:
        sys.exit("RIG_A and RIG_B must differ — one rig admits one bot per room")
    for r in (A, B):
        if r == "1" and os.environ.get("ACOUSTIC_ALLOW_RIG1") != "1":
            sys.exit(f"refusing rig 1 (the human's rig) — this spawns and deletes bots in {ROOM}")
    sys.stdout.reconfigure(line_buffering=True)

    print(f"═══ ACOUSTIC SELF-TEST — rig {A} <-> rig {B}, room {ROOM} ═══\n")

    print("leg 1 — loopback (no meeting, no bot, no browser)")
    local = loopback(A)
    if local is None:
        sys.exit("  loopback produced no onsets — check shims/sfx/count.wav and tts_sink")
    # The ABSOLUTE figure here is not trustworthy: parecord's capture does not begin when the
    # shell backgrounds it, so the file's origin is unknown by an unmeasured startup race (it read
    # +40ms once and -260ms the next run). What IS trustworthy is the GAP structure — that the
    # metronome survives our own plumbing at 1.000s spacing. Treat the number as a smoke test.
    print(f"  onset spacing preserved through the local chain (raw offset {local:+.0f} ms, "
          f"absolute value unreliable — see comment)\n")
    local_offset = 125.0     # act -> audible for the sfx path (~85ms) + local chain (~40ms)

    for r in (A, B):
        dk(r, "mkdir -p /tmp/vexa-capture-tap")          # the tap's switch IS the directory
    stop(A); stop(B); time.sleep(8)
    mid_a = spawn(A, "Acoustic A")
    mid_b = spawn(B, "Acoustic B")
    print(f"both seats active (A={mid_a} on rig {A}, B={mid_b} on rig {B})\n")

    try:
        print("leg 2 + 3 — one way through Meet, each direction measured separately")
        ab = one_way(A, B, mid_a, mid_b, f"rig {A} -> rig {B}")
        time.sleep(4)
        ba = one_way(B, A, mid_b, mid_a, f"rig {B} -> rig {A}")

        print("\nleg 4 — THE DUET: B hears A's beat, locks to it, and counts along")
        rt = duet(A, B, mid_a, mid_b, b_offset_ms=local_offset)
    finally:
        stop(A); stop(B)

    print()
    print("── decomposition ──")
    if ab is not None:
        print(f"  rig {A} -> rig {B} one way          {ab:6.0f} ms")
    if ba is not None:
        print(f"  rig {B} -> rig {A} one way          {ba:6.0f} ms")
    if ab is not None and ba is not None:
        print(f"  sum of the two one ways      {ab + ba:6.0f} ms")
    if rt is not None:
        print(f"  DUET ROUND TRIP              {rt:6.0f} ms   <- B synced to what it HEARD")
        print("\n  The duet is the closed loop: B is in the seat a human occupies, so this is the")
        print("  same quantity sync.py measures with a person, minus the human's sync error.")
    if rt is None and (ab is None or ba is None):
        sys.exit("ACOUSTIC RED — no measurement")


if __name__ == "__main__":
    main()
