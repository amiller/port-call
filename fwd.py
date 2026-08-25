"""Push a live meeting's transcript to the shareable page on the pod.

Lives in the repo, not /tmp: the previous copy died in the 2026-08-18 reboot along with the
API tokens. Polls postgres rather than the gateway so it needs no token of its own, and
re-sends everything if the pod's in-memory room expires or the app restarts.
"""
import json, subprocess, sys, time, urllib.request

# MID accepts a COMMA-SEPARATED list. A host reboot kills the bot and the next join gets a NEW
# meeting row, so a single id would make the shared page drop everything said before the restart —
# the first post is `replace: True`. Passing "157,160" keeps one continuous transcript across it.
CODE, MID = sys.argv[1], sys.argv[2]
MIDS = ",".join(str(int(m)) for m in MID.split(","))
BASE = "https://pod.dstack.soc1024.com/meeting-brainrot"
SQL = (f"select coalesce(speaker,'?'), replace(text, chr(10), ' ') "
       f"from transcriptions where meeting_id in ({MIDS}) order by start_time, id")

def fetch():
    out = subprocess.run(["docker", "exec", "vexa-rig-postgres-1", "psql", "-U", "postgres",
                          "vexa", "-tAF", "\x1f", "-c", SQL], capture_output=True, text=True).stdout
    rows = []
    for row in out.splitlines():
        if "\x1f" not in row: continue
        sp, tx = row.split("\x1f", 1)
        if tx.strip(): rows.append({"speaker": sp, "text": tx.strip()})
    return rows

def post(body):
    req = urllib.request.Request(BASE + "/signal", json.dumps(body).encode(),
                                 {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))

sent = 0
while True:
    rows = fetch()
    have = json.load(urllib.request.urlopen(f"{BASE}/state?code={CODE}", timeout=30))
    n = len(have.get("lines") or []) if have.get("known") else 0
    if n > len(rows) or (n == 0 and sent): sent = 0        # room expired or app restarted
    if sent == 0:              r = post({"code": CODE, "replace": True, "lines": rows})
    elif len(rows) > sent:     r = post({"code": CODE, "lines": rows[sent:]})
    else:                      r = {"lines": n}
    sent = r["lines"]
    print(time.strftime("%H:%M:%S"), f"db={len(rows)} pod={sent}", flush=True)
    time.sleep(8)
