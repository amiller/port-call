#!/usr/bin/env python3
"""The counting game — measure what the round trip to a live meeting actually costs.

    RIG=1 ./ping.py <meet-code> --lead            # you count back at it; the real number
    RIG=1 ./ping.py <meet-code> --lead --spawn "Port Call A"     # rig 1 leads
    RIG=4 ./ping.py <meet-code>        --spawn "Port Call B"     # rig 4 answers — no human

RUNS ON FRACTAL, next to the rig. Polling the gateway over ssh would add the very latency this
is trying to measure; every timestamp below comes from the same host clock.

One loop, two uses. `--lead` speaks first and takes the odd numbers; without it the instance
waits to hear the opening number and takes the evens. Two instances on two rigs in one room is
the unattended version (each bot hears the other and never itself — Meet does not loop a
participant's mic back, which is the same fact that makes journeys.sh J4 SKIP in an empty room).
One instance plus a human is the version whose number actually matters, because a human mouth
and a human ear are the target.

WHAT IT SAYS, AND WHY IT IS A SENTENCE. Two things were measured the hard way on the first run
of this script (2026-08-20, rigs 3+4 in the lab room), and both shape the utterance:

  * `minAudioDuration` is 2s and `submitInterval` is 2s (speaker-streams.ts), so a buffer holding
    less than 2s of audio is NEVER submitted on the timer. A turn also only closes early when the
    next audio arrives on that channel after a >1s gap (gmeet-pipeline.ts ONSET_GAP), and capture
    emits nothing during silence — so after a short utterance nothing arrives to close it and the
    15s idle timer is what finally submits. Measured: a 1.5s utterance sat for **16.7s** before it
    was submitted at all. The 2s threshold is a cliff, not a slope. `--terse` says the bare number
    (~0.5s) to measure that cliff on purpose; the default clears it with room to spare.
  * The obvious carrier — "one, one, one" — came back from Whisper as "1-1-1." and was killed by
    the HallucinationFilter, because a repeated single token is exactly what Whisper emits over
    silence. A count phrase has to be a sentence, not a repetition.

WHAT COMES OUT, per turn, all differences between stamps taken on this host:

  synth_ms      act published -> first PCM sample consumed  ([tts] begin/audible, #3)
  draft_ms      partner's audio ENDS -> we can first see those words at all
  final_ms      partner's audio ENDS -> that segment is `completed`
  rtt_ms        partner's audio ENDS -> our own reply is audible in the room

draft_ms is the headline. Everything downstream currently throws drafts away (board.py and
demo.sh both filter `completed`, goodpoint.py reads postgres, which db_writer.py holds for
IMMUTABILITY_THRESHOLD=30s before it is even written), so the gap between draft_ms and final_ms
is the latency that is being discarded by choice rather than paid for by physics.
"""
import argparse, json, os, re, statistics, subprocess, sys, time, urllib.request

RIG = os.environ.get("RIG", "1")
SFX = "" if RIG == "1" else RIG
C = f"vexa-rig{SFX}-vexa-lite-1"
GW = f"http://localhost:{8055 + int(RIG)}"
TOK = lambda k: open(f"/tmp/vexa{SFX}-{k}-token.txt").read().strip()

WORDS = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
         "fifteen sixteen seventeen eighteen nineteen twenty").split()
# Whisper's near-misses on isolated count words, collected rather than guessed at: these are the
# ones that turn a clean run red for a reason that has nothing to do with latency.
HOMOPHONES = {"won": 1, "to": 2, "too": 2, "tree": 3, "for": 4, "fore": 4, "sicks": 6, "ate": 8}


def gw(path, token):
    req = urllib.request.Request(f"{GW}{path}", headers={"X-API-Key": token})
    return json.load(urllib.request.urlopen(req, timeout=10))


def docker(cmd):
    return subprocess.run(["docker", "exec", C, "sh", "-c", cmd],
                          stdout=subprocess.PIPE, text=True, check=True).stdout


def numbers_in(text):
    """Every count word / digit in a segment, as ints. A segment may carry several."""
    out = set()
    for tok in re.findall(r"[a-z0-9]+", text.lower()):
        if tok.isdigit():
            out.add(int(tok))
        elif tok in WORDS:
            out.add(WORDS.index(tok))
        elif tok in HOMOPHONES:
            out.add(HOMOPHONES[tok])
    return out


def spawn(room, name, token):
    body = json.dumps({"platform": "google_meet", "native_meeting_id": room,
                       "bot_name": name, "voice_agent_enabled": True}).encode()
    req = urllib.request.Request(f"{GW}/bots", data=body, method="POST",
                                 headers={"X-API-Key": token, "Content-Type": "application/json"})
    mid = json.load(urllib.request.urlopen(req, timeout=30))["id"]
    for _ in range(24):
        time.sleep(5)
        if bot_in(room, token)[1] == "active":
            return mid
    sys.exit(f"bot {mid} never went active in {room} — is the room OPEN?")


def bot_in(room, token):
    running = gw("/bots/status", token)["running"]
    here = [b for b in running if b["native_meeting_id"] == room]
    return (here[0]["id"], here[0]["status"]) if here else (None, None)


def phrase(word, terse, again=False):
    """~3s of speech (piper runs ~13 chars/s), one sentence, the number said once. Long enough to
    clear minAudioDuration, shaped unlike anything in the hallucination corpus.

    `again` must not be a synonym for the same string: the anti-repetition guard suppresses a
    repeated speak within its window, so a retry that says the identical sentence is silently
    dropped and the run stalls waiting for audio that was never emitted (observed 2026-08-20)."""
    if terse:
        return word
    return (f"say again, the count is number {word}, over" if again
            else f"okay, the count is now number {word}, over")


def say(mid, text):
    """Publish the speak act and return the host-clock ms at which we published it."""
    act = json.dumps({"action": "speak", "text": text})
    t = int(time.time() * 1000)
    docker(f"redis-cli PUBLISH bot_commands:meeting:{mid} {json.dumps(act)}")
    return t


def audible_after(mid, t_act, timeout=25):
    """The [tts] audible stamp for the act published at t_act. WHEN we read the log is irrelevant
    — the timestamps are written into it by the bot, so polling here costs the measurement nothing."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        # -a is load-bearing: the bot log carries occasional binary bytes, and plain grep answers
        # "binary file matches" instead of the lines, which read here as "the bot never spoke".
        out = docker(f"grep -ha '\\[tts\\] audible' /tmp/vexa-workloads/mtg-{mid}-*.log 2>/dev/null | tail -5")
        for line in reversed(out.strip().splitlines()):
            m = re.search(r"ts=(\d+) synth_ms=(\d+)", line)
            if m and int(m.group(1)) >= t_act:
                return int(m.group(1)), int(m.group(2))
        time.sleep(0.2)
    # Report what was actually seen rather than guessing at a cause: an empty tail and a tail full
    # of older stamps are different failures (nothing spoke vs we are reading a stale meeting log).
    tail = docker(f"grep -haE '\\[tts\\]|\\[bot\\] speak' /tmp/vexa-workloads/mtg-{mid}-*.log 2>/dev/null | tail -4")
    sys.exit(f"no [tts] audible stamp >= {t_act} for meeting {mid} within {timeout}s.\n"
             f"last [tts]/speak lines in that log:\n{tail or '  (none)'}")


LISTEN_S = 45


def listen_for(room, token, n, floor_s, timeout=LISTEN_S):
    """Poll the LIVE transcript for the partner saying n. Returns when the number is both seen and
    finalized, or on timeout with whatever was reached. `floor_s` discards transcript history."""
    seen = {"end": None, "draft_at": None, "final_at": None, "text": None}
    deadline = time.time() + timeout
    while time.time() < deadline:
        now = time.time()
        for s in gw(f"/transcripts/google_meet/{room}", token).get("segments") or []:
            if (s.get("end") or 0) < floor_s or n not in numbers_in(s.get("text") or ""):
                continue
            if seen["draft_at"] is None:
                seen.update(end=s["end"], draft_at=now, text=(s.get("text") or "").strip())
            if s.get("completed") and seen["final_at"] is None:
                # The completed segment can carry a different end than the draft did (the window
                # advances as it is confirmed); the finalized one is the honest end of the audio.
                seen.update(end=s["end"], final_at=now, text=(s.get("text") or "").strip())
                return seen
        time.sleep(0.25)
    return seen


def summarize(turns, key, label):
    vals = sorted(t[key] for t in turns if t.get(key) is not None)
    if not vals:
        print(f"  {label:<10} no samples")
        return
    p = lambda q: vals[min(len(vals) - 1, int(len(vals) * q))]
    print(f"  {label:<10} n={len(vals):<3} min={vals[0]/1000:5.2f}s  p50={statistics.median(vals)/1000:5.2f}s"
          f"  p90={p(0.9)/1000:5.2f}s  max={vals[-1]/1000:5.2f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("room")
    ap.add_argument("--lead", action="store_true", help="speak first and take the odd numbers")
    ap.add_argument("--turns", type=int, default=8)
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--spawn", metavar="NAME", help="spawn a bot of this name instead of attaching")
    ap.add_argument("--terse", action="store_true", help="say each number ONCE (~0.5s) — measures "
                                                        "the short-utterance hole on purpose")
    ap.add_argument("--out", default=None)
    ap.add_argument("--require", type=int, default=0,
                    help="exit non-zero unless at least this many turns round-tripped (duel.sh)")
    a = ap.parse_args()

    sys.stdout.reconfigure(line_buffering=True)   # nohup'd to a file: watchable while it runs
    bt, tx = TOK("bot"), TOK("tx")
    mid = spawn(a.room, a.spawn, bt) if a.spawn else bot_in(a.room, bt)[0]  # /bots/status is bot-scoped
    if not mid:
        sys.exit(f"no bot in {a.room} on rig {RIG} — join one first, or pass --spawn NAME")
    out = a.out or f"/tmp/ping-rig{RIG}-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    print(f"rig {RIG}  bot {mid}  room {a.room}  {'leading' if a.lead else 'answering'}  -> {out}")
    if not a.lead:
        print(f"waiting to hear {a.start}…")

    say_n = a.start if a.lead else a.start + 1
    expect = None if a.lead else a.start
    floor = time.time()
    turns, missed, said = [], False, None

    for i in range(a.turns):
        heard = None
        if expect is not None:
            heard = listen_for(a.room, tx, expect, floor)
            if heard["draft_at"] is None:
                # A missed turn is usually the partner never hearing US, so repeat rather than
                # end the run — the same thing a person does. Once; twice means it is broken.
                if missed:
                    print(f"  turn {i}: never heard {expect} twice — stopping"); break
                missed = True
                if said is None:                      # the answerer has not spoken yet: nothing
                    print(f"  still waiting for {expect}…")   # to repeat, just keep listening
                else:
                    print(f"  turn {i}: no {expect} in {LISTEN_S}s — repeating {said}")
                    t_act = say(mid, phrase(WORDS[said], a.terse, again=True)); audible_after(mid, t_act)
                continue
            missed = False
            floor = heard["end"] + 0.01

        word = WORDS[say_n] if say_n < len(WORDS) else str(say_n)
        t_act = say(mid, phrase(word, a.terse))
        t_aud, synth = audible_after(mid, t_act)

        turn = {"i": i, "said": say_n, "synth_ms": synth}
        if heard:
            end_ms = heard["end"] * 1000
            turn.update(heard=expect, text=heard["text"],
                        draft_ms=round(heard["draft_at"] * 1000 - end_ms),
                        final_ms=None if heard["final_at"] is None
                                 else round(heard["final_at"] * 1000 - end_ms),
                        rtt_ms=round(t_aud - end_ms))
            fin = "  n/a" if turn["final_ms"] is None else f"{turn['final_ms']/1000:5.2f}s"
            print(f"  {expect:>3} -> {say_n:<3} draft={turn['draft_ms']/1000:5.2f}s final={fin}"
                  f" rtt={turn['rtt_ms']/1000:5.2f}s synth={synth/1000:4.2f}s  {heard['text'][:40]!r}")
        else:
            print(f"      -> {say_n:<3} synth={synth/1000:4.2f}s (opening)")
        turns.append(turn)
        with open(out, "a") as f:
            f.write(json.dumps(turn) + "\n")
        said, expect, say_n = say_n, say_n + 1, say_n + 2

    print(f"\n── rig {RIG}, {len(turns)} turns, {'terse' if a.terse else 'sentence'} ──")
    summarize(turns, "synth_ms", "synth")
    summarize(turns, "draft_ms", "draft")
    summarize(turns, "final_ms", "final")
    summarize(turns, "rtt_ms", "rtt")
    print(f"  {out}")
    done = sum(1 for t in turns if t.get("rtt_ms") is not None)
    if done < a.require:
        sys.exit(f"FAIL only {done}/{a.require} turns round-tripped — the room was not heard")


if __name__ == "__main__":
    main()
