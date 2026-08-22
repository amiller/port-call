#!/usr/bin/env python3
"""Raise a GOOD POINT banner on the bot's camera tile when the room says something worth keeping.

    ./goodpoint.py <meeting-id> [--window 12] [--every 20] [--min-score 7]

This is the judge lane from the original brainrot box (`webhost-apps-feedling/brainrot-box`),
reduced to the part that was actually fun: watch the transcript, decide whether the last stretch
contained a genuinely reusable point, and if so put it on the tile for everyone to see.

Three deliberate choices, all inherited from that box rather than invented here:

  * the prompt, the strict-JSON shape and the score>=7 threshold are its `JUDGE_SYSTEM` verbatim —
    it was tuned against real meetings and flags concise insight over vague agreement;
  * the model is DeepSeek-V4-Flash, which is what it used, and which NEAR serves;
  * a banner is a claim about the conversation, so it fires on a MODEL VERDICT and never on a
    timer. A quiet room raises nothing.

It needs no bot change: `camera_show` already carries `sub`, so the verdict rides an ordinary act
onto the tile. The camera reads an optional "<score>|" prefix to pick the treatment.

The NEAR call is issued from INSIDE the near-shim container, which already holds NEAR_API_KEY —
the key never moves to whatever machine runs this.
"""
import argparse, json, shlex, subprocess, sys, time

HOST = "fractal"
PG = "docker exec vexa-rig-postgres-1 psql -U postgres vexa -tAc"
GW = "http://localhost:8056"
SHIM = "vexa-rig-near-shim-1"
BOT = "vexa-rig-vexa-lite-1"
MODEL = "deepseek-ai/DeepSeek-V4-Flash"

JUDGE_SYSTEM = (
    'You judge a live meeting transcript for genuinely useful "good points".\n'
    "Return STRICT JSON only:\n"
    '{"good_point":bool,"quote":"<=140 chars near-verbatim","why":"<=12 words","score":0-10}\n'
    "Flag only concise, reusable insights, decisions, or unusually clear framing. "
    "Ignore filler, logistics, and vague agreement."
)


def ssh(cmd, **kw):
    return subprocess.run(["ssh", HOST, cmd], stdout=subprocess.PIPE, text=True,
                          check=True, **kw).stdout


def room_of(mid):
    """meeting id -> room code. The gateway is keyed by ROOM and serves that room's LATEST meeting,
    so pointing this at an old meeting id reads whatever ran in that room most recently. Harmless
    for the only real use — a sidecar attached to the call happening now — and wrong for replay."""
    q = f"select platform_specific_id from meetings where id={mid}"
    code = ssh(f"{PG} {shlex.quote(q)}").strip()
    if not code:
        sys.exit(f"no meeting row {mid}")
    return code


def segments(code, limit):
    """The LIVE transcript, read from the gateway — NOT from postgres.

    `transcriptions` is a durability layer, not a live view: db_writer.py holds a segment for
    IMMUTABILITY_THRESHOLD (30s) after its last update and flushes on a 10s tick, so reading that
    table put every verdict ~40s behind the room (measured 2026-08-20: p50 39.9s, p90 50.6s over
    six real meetings). The gateway merges the in-flight redis hash and is the only fresh source.
    Still `completed` only — drafts rewrite themselves as the window grows, and a banner is a
    claim about something someone actually finished saying."""
    out = ssh(f"curl -s {GW}/transcripts/google_meet/{code} "
              f'-H "X-API-Key: $(cat /tmp/vexa-tx-token.txt)"')
    segs = json.loads(out).get("segments") or []
    return [f"{s.get('speaker') or '?'}: {(s.get('text') or '').strip()}"
            for s in segs if s.get("completed") and (s.get("text") or "").strip()][-limit:]


def judge(text):
    """Ask NEAR for a verdict. Any non-JSON answer is a no, not a crash — but it is reported."""
    script = (
        "import os,sys,json,urllib.request\n"
        "p=sys.stdin.read()\n"
        "b=json.dumps({'model':%r,'messages':["
        "{'role':'system','content':%r},{'role':'user','content':p}],"
        "'max_tokens':180,'temperature':0}).encode()\n"
        "r=urllib.request.Request('https://cloud-api.near.ai/v1/chat/completions',data=b,"
        "headers={'Authorization':'Bearer '+os.environ['NEAR_API_KEY'],"
        "'Content-Type':'application/json'})\n"
        "print(json.load(urllib.request.urlopen(r,timeout=60))"
        "['choices'][0]['message']['content'])\n" % (MODEL, JUDGE_SYSTEM))
    out = subprocess.run(
        ["ssh", HOST, f"docker exec -i {SHIM} python3 -c {shlex.quote(script)}"],
        input=f"Transcript:\n{text}\n\nJSON:", stdout=subprocess.PIPE, text=True,
        check=True, timeout=120).stdout.strip()
    start, end = out.find("{"), out.rfind("}")
    if start < 0 or end < 0:
        print(f"  judge returned no JSON: {out[:90]}", file=sys.stderr)
        return None
    return json.loads(out[start:end + 1])


def raise_banner(mid, score, quote, avatar, bg):
    # Carry the skin on every banner. A camera_show that omits avatar/bg is not neutral: if the
    # HUD version changed, show() re-injects a FRESH page object whose state starts at the
    # defaults (rooster/transcript), so an omitted skin silently reverts the tile mid-meeting.
    act = json.dumps({"action": "camera_show", "text": "PORT CALL",
                      "sub": f"{score}|{quote}", "avatar": avatar, "bg": bg})
    ssh(f"docker exec {BOT} redis-cli PUBLISH bot_commands:meeting:{mid} {shlex.quote(act)}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("meeting_id", type=int)
    p.add_argument("--window", type=int, default=12, help="segments per verdict")
    p.add_argument("--every", type=int, default=20, help="seconds between verdicts")
    p.add_argument("--min-score", type=int, default=7)
    p.add_argument("--once", action="store_true")
    p.add_argument("--avatar", default="hancock")
    p.add_argument("--bg", default="swarm")
    a = p.parse_args()

    code = room_of(a.meeting_id)
    seen = set()
    while True:
        segs = segments(code, a.window)
        if segs:
            key = segs[-1]
            if key not in seen:          # only judge when the room has actually moved on
                seen.add(key)
                v = judge("\n".join(segs))
                if v and v.get("good_point") and v.get("score", 0) >= a.min_score and v.get("quote"):
                    print(f"{time.strftime('%H:%M:%S')}  {v['score']}/10  {v['quote'][:80]}"
                          f"   ({v.get('why','')})", flush=True)
                    raise_banner(a.meeting_id, int(v["score"]), v["quote"][:140], a.avatar, a.bg)
                else:
                    print(f"{time.strftime('%H:%M:%S')}  —"
                          f" {(v or {}).get('score', '?')}", flush=True)
        if a.once:
            return
        time.sleep(a.every)


if __name__ == "__main__":
    main()
