#!/usr/bin/env python3
"""Vexa console — join a meeting, watch the transcript, drive the bot.  http://<host>:8090

The one URL for daily use: paste a Meet link, hit Join, and everything else (live transcript, the
tricks, what the bot can see) is on the same page. Acts go to the same redis command bus as
demo.sh; nothing here is a second implementation of the bot's behaviour.

Deliberately has no auth: it is bound to a machine on a private network and it can make a bot join
a meeting, so do NOT expose it to the internet.
"""
import json, mimetypes, os, pathlib, re, subprocess, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

CONTAINER = "vexa-rig-vexa-lite-1"
GATEWAY = "http://localhost:8056"
BOT_TOKEN = open("/tmp/vexa-bot-token.txt").read().strip()
TX_TOKEN = open("/tmp/vexa-tx-token.txt").read().strip()
# The daily rung writes its evidence here (daily.sh). Served read-only at /daily so a run is
# something you can look at rather than something you have to ssh for.
DAILY = "/media/amiller/fractal-nvme2/vexa-archive/daily"
SFX = ["airhorn", "gavel", "ding", "objection", "order", "noted", "correct", "welcome", "timesup"]
# Meet's picker set VARIES by UI state — a dump taken while presenting showed 🎊 💗 💯 😆 🙁 😲,
# while the normal in-call picker shows these. The controller fails loudly (with the candidate
# list) when an emoji is absent rather than silently picking a neighbour.
EMOJI = ["👍", "🎉", "💖", "👏", "😂", "😮"]
# The camera is a character over a background, chosen independently. These must match the registries
# in patches/bot-camera.ts; an unknown name is REJECTED by the bot with the valid set named, so a
# drift here shows up as a loud error in the log rather than as a silently unchanged tile.
AVATARS = ["rooster", "hancock", "tina", "dmarz"]   # the bot exposes avatars() live; this list is a drift risk (see #37)
BACKGROUNDS = ["transcript", "vitals", "swarm", "brainrot"]
# One-tap looks for driving a live meeting: (label, avatar, background).
PRESETS = [("heartbeat", "rooster", "transcript"),
           ("vitals", "rooster", "vitals"),
           ("brainrot", "tina", "brainrot")]

PAGE = """<!doctype html><meta charset=utf-8><title>Vexa console</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:dark}
 body{background:#0b0b10;color:#e8e8f0;font:16px system-ui,sans-serif;margin:0;padding:20px;
      max-width:900px;margin-inline:auto}
 h1{font-size:19px;margin:0 0 4px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;
      color:#8a8aa0;margin:26px 0 8px}
 .row{display:flex;gap:8px;flex-wrap:wrap} .row>input{flex:1;min-width:220px}
 button{font:600 16px system-ui;padding:13px 18px;border:0;border-radius:10px;background:#242433;
      color:#e8e8f0;cursor:pointer} button:hover{background:#33334a} button:active{transform:translateY(1px)}
 .go{background:#2d7d46} .go:hover{background:#379a55}
 .stop{background:#8b2f2f} .stop:hover{background:#a63a3a}
 .sfx{background:#5b3ca8} .sfx:hover{background:#6d49c9}
 .emo{font-size:22px;padding:10px 14px}
 input,select{font:16px system-ui;padding:12px;border-radius:9px;border:1px solid #33334a;
      background:#14141c;color:#e8e8f0;box-sizing:border-box}
 .skin{background:#1f5f7a} .skin:hover{background:#2a7b9c}
 #sharenote{font:13px system-ui;color:#8a8aa0;margin-top:8px;max-width:60ch}
 #status{font:13px ui-monospace,monospace;color:#8a8aa0;margin-top:6px}
 #tx{background:#14141c;border:1px solid #23233a;border-radius:10px;padding:12px;height:260px;
      overflow:auto;font:14px/1.5 system-ui}
 #tx div{margin:3px 0} #tx b{color:#7ce38b;font-weight:600}
 #log{font:12px ui-monospace,monospace;color:#5a5a70;white-space:pre-wrap;margin-top:14px;max-height:90px;overflow:auto}
 img{width:100%;border-radius:10px;border:1px solid #23233a;margin-top:8px}
 .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
</style>

<h1>Vexa console <a href=/daily style="font-size:13px;font-weight:400;color:#8ab4ff">daily rung ›</a></h1>
<div id=status>…</div>

<h2>meeting</h2>
<div class=row>
  <input id=room placeholder="meet.google.com/abc-defg-hij  (or blank for the lab room)">
  <button class=go onclick=join()>Join</button>
  <button class=stop onclick=act({action:'leave'},true)>Leave</button>
</div>

<h2>your next meetings</h2>
<div id=upcoming>…</div>

<h2>say</h2>
<div class=row>
  <input id=say placeholder="something to say out loud" onkeydown="if(event.key=='Enter')speak()">
  <button onclick=speak()>Speak</button>
</div>
<div class=row id=sfxrow></div>

<h2>chat</h2>
<div class=row>
  <input id=chat placeholder="post to meeting chat" onkeydown="if(event.key=='Enter')chat()">
  <button onclick=chat()>Send</button>
  <button onclick="act({action:'chat_read'})">Read</button>
</div>

<h2>react</h2>
<div class=row id=emorow></div>

<h2>camera</h2>
<div class=row>
  <input id=head placeholder="headline on the bot's camera / shared screen">
  <select id=avatar title="who the bot looks like"></select>
  <select id=bg title="what it stands in front of"></select>
  <button onclick=cam()>Camera</button>
</div>
<div class=row id=presetrow></div>

<h2>screen</h2>
<div class=row>
  <button onclick="act({action:'screen_share',text:head.value||'VEXA'})">Present</button>
  <button onclick="act({action:'screen_share_stop'})">Stop</button>
</div>
<div id=sharenote>Present shares the bot's own camera canvas, not a website — Chrome's desktop
capture is patched out of the path entirely. Presenting a real page is issue #7.</div>

<h2>live transcript</h2>
<div id=tx></div>

<h2>what the bot sees</h2>
<div class=row><button onclick=shot()>Refresh screenshot</button></div>
<img id=shotimg style=display:none>

<div id=log></div>

<script>
const $=id=>document.getElementById(id);
$('sfxrow').innerHTML=SFX_.map(s=>`<button class=sfx onclick="act({action:'speak',text:'!${s}'})">${s}</button>`).join('');
$('emorow').innerHTML=EMOJI_.map(e=>`<button class="emo" onclick="act({action:'reaction',emoji:'${e}'})">${e}</button>`).join('');
$('avatar').innerHTML=AVATARS_.map(a=>`<option>${a}</option>`).join('');
$('bg').innerHTML=BACKGROUNDS_.map(b=>`<option>${b}</option>`).join('');
$('presetrow').innerHTML=PRESETS_.map(([label,a,b])=>
  `<button class=skin onclick="skin('${a}','${b}')">${label}</button>`).join('');
// Switching a skin is live: it is HUD state on a canvas Meet is already publishing, so it lands on
// the next frame with no respawn. Only a CODE change to the HUD needs re-injection.
function skin(a,b){$('avatar').value=a;$('bg').value=b;cam()}
function cam(){act({action:'camera_show',text:$('head').value||'VEXA',
                    avatar:$('avatar').value,bg:$('bg').value})}

async function post(path,body){
  const r=await fetch(path,{method:'POST',body:JSON.stringify(body||{})});
  const t=await r.text(); $('log').textContent=t+'\\n'+$('log').textContent; return t;
}
const act=(a,quiet)=>post('/act',{act:a}).then(t=>{if(!quiet)refresh()});
const speak=()=>{if($('say').value){act({action:'speak',text:$('say').value});$('say').value=''}};
const chat=()=>{if($('chat').value){act({action:'chat_send',text:$('chat').value});$('chat').value=''}};
const join=()=>post('/join',{room:$('room').value}).then(refresh);
async function shot(){ await post('/shot'); const i=$('shotimg'); i.style.display='block';
  i.src='/shot.png?'+Date.now(); }

async function upcoming(){
  const evs=await (await fetch('/upcoming')).json();
  $('upcoming').innerHTML = evs.length ? evs.map(e=>
     `<div class=row style="align-items:center;margin-bottom:6px">
        <span style="flex:1;min-width:220px">
          <b style="color:${e.soon?'#7ce38b':'#8a8aa0'}">${e.when}</b> ${e.summary}
          <span style="color:#5a5a70">${e.code}</span></span>
        <button class=go onclick="joinCode('${e.code}')">Join</button></div>`).join('')
   : '<div style=color:#5a5a70>nothing with a Meet link in the next 12h</div>';
}
const joinCode=c=>post('/join',{room:c}).then(refresh);

async function refresh(){
  const s=await (await fetch('/state')).json();
  const live=s.status==='active';
  $('status').innerHTML=`<span class=dot style="background:${live?'#7ce38b':'#ff7b72'}"></span>`
    +(s.bot?`bot ${s.bot} · ${s.room} · ${s.status}`:'no bot in a meeting')
    +(s.camera?' · camera on':'')+(s.presenting?' · presenting':'');
  $('tx').innerHTML=(s.transcript||[]).map(l=>`<div><b>${l.speaker}</b> ${l.text}</div>`).join('')
    ||'<div style=color:#5a5a70>nothing yet</div>';
  $('tx').scrollTop=$('tx').scrollHeight;
}
refresh(); upcoming(); setInterval(refresh,5000); setInterval(upcoming,120000);
</script>"""


def upcoming_events(hours=12):
    """Andrew's next meetings that have a Meet link, so the console can offer a Join button each.

    Prefers upcoming.json, pushed from the laptop by push-upcoming.py: the calendar tokens live
    there and MUST NOT be copied here — only the derived list (title, time, code) crosses. Falls
    back to reading the calendar directly if tokens ever do exist locally."""
    local = pathlib.Path(os.path.expanduser("~/vexa-rig/upcoming.json"))
    if local.exists():
        try:
            return json.loads(local.read_text())
        except Exception:
            pass
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    out, seen = [], set()
    for name in ("calendar_token.json", "calendar_token_personal.json"):
        tok = pathlib.Path(os.path.expanduser("~/projects/teleport/planning/scripts")) / name
        if not tok.exists():
            continue
        try:
            c = Credentials.from_authorized_user_file(str(tok))
            if c.expired and c.refresh_token:
                c.refresh(Request())
            svc = build("calendar", "v3", credentials=c, cache_discovery=False)
            items = svc.events().list(calendarId="primary", timeMin=now.isoformat(),
                                      timeMax=(now + timedelta(hours=hours)).isoformat(),
                                      singleEvents=True, orderBy="startTime").execute().get("items", [])
        except Exception:
            continue
        for e in items:
            m = CODE_RE.search(e.get("hangoutLink") or "")
            st = e["start"].get("dateTime")
            if not m or not st or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            start = datetime.fromisoformat(st.replace("Z", "+00:00"))
            mins = (start - now).total_seconds() / 60
            out.append({"code": m.group(1), "summary": (e.get("summary") or "")[:60],
                        "when": start.astimezone().strftime("%H:%M"),
                        "soon": mins <= 10})
    return sorted(out, key=lambda x: x["when"])[:8]


def gw(path, token, method="GET", body=None):
    req = urllib.request.Request(f"{GATEWAY}{path}", method=method,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"X-API-Key": token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)


def running():
    r = gw("/bots/status", BOT_TOKEN).get("running") or []
    return r[0] if r else None


def transcript(code, n=25):
    try:
        segs = gw(f"/transcripts/google_meet/{code}", TX_TOKEN).get("segments") or []
    except Exception:
        return []
    # completed only: vexa resubmits each utterance as a growing window, so provisional segments
    # would make the panel rewrite the same sentence half a dozen times.
    return [{"speaker": s.get("speaker") or "?", "text": (s.get("text") or "").strip()}
            for s in segs if s.get("completed")][-n:]


def selfcheck_state(mid):
    """Last [selfcheck] line from the bot log — camera/presenting as MEET sees it, not as we hope."""
    out = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c",
                          f"grep -h '\\[selfcheck\\]' /tmp/vexa-workloads/mtg-{mid}-*.log 2>/dev/null | tail -1"],
                         capture_output=True, text=True).stdout
    if "[selfcheck] " not in out:
        return {}
    try:
        return json.loads(out.split("[selfcheck] ", 1)[1])
    except Exception:
        return {}


class H(BaseHTTPRequestHandler):
    def _send(self, body, ctype="text/html; charset=utf-8", raw=False):
        b = body if raw else body.encode()
        self.send_response(200); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path == "/state":
            b = running()
            st = {"bot": None, "room": None, "status": "none", "transcript": []}
            if b:
                sc = selfcheck_state(b["id"])
                st = {"bot": b["id"], "room": b["native_meeting_id"], "status": b["status"],
                      "camera": sc.get("cameraOn"), "presenting": sc.get("presenting"),
                      "transcript": transcript(b["native_meeting_id"])}
            return self._send(json.dumps(st), "application/json")
        if self.path == "/upcoming":
            try:
                return self._send(json.dumps(upcoming_events()), "application/json")
            except Exception as e:
                return self._send(json.dumps([{"code": "", "summary": f"calendar unavailable: {e}",
                                               "when": "--:--", "soon": False}]), "application/json")
        if self.path.startswith("/daily"):
            # Path is joined then checked, so a ../ in the URL cannot climb out of DAILY.
            f = os.path.normpath(os.path.join(DAILY, self.path[6:].lstrip("/") or "index.html"))
            if not f.startswith(DAILY): return self._send(b"nope", "text/plain", raw=True)
            return self._send(open(f, "rb").read(),
                              mimetypes.guess_type(f)[0] or "text/plain", raw=True)
        if self.path.startswith("/shot.png"):
            try:
                return self._send(open("/tmp/board-shot.png", "rb").read(), "image/png", raw=True)
            except OSError:
                return self._send(b"", "image/png", raw=True)
        page = (PAGE.replace("SFX_", json.dumps(SFX)).replace("EMOJI_", json.dumps(EMOJI))
                    .replace("AVATARS_", json.dumps(AVATARS))
                    .replace("BACKGROUNDS_", json.dumps(BACKGROUNDS))
                    .replace("PRESETS_", json.dumps(PRESETS)))
        self._send(page)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or "{}")

        if self.path == "/join":
            # Accept a full URL or a bare code — pasting the link out of an invite is the fast path.
            room = (body.get("room") or "").strip()
            m = re.search(r"([a-z]{3}-[a-z]{4}-[a-z]{3})", room)
            code = m.group(1) if m else (room or open("/tmp/vexa-lab-room").read().strip())
            try:
                gw(f"/bots/google_meet/{code}", BOT_TOKEN, "DELETE")
            except Exception:
                pass
            try:
                r = gw("/bots", BOT_TOKEN, "POST", {"platform": "google_meet", "native_meeting_id": code,
                                                    "bot_name": "Port Call", "voice_agent_enabled": True})
                return self._send(f"joining {code} as bot {r.get('id')}", "text/plain")
            except Exception as e:
                return self._send(f"join failed: {e}", "text/plain")

        if self.path == "/shot":
            subprocess.run(["docker", "exec", CONTAINER, "sh", "-c",
                            "DISPLAY=:99 ffmpeg -y -loglevel error -f x11grab -video_size 1600x900 "
                            "-i :99 -frames:v 1 /tmp/board.png"], capture_output=True)
            subprocess.run(["docker", "cp", f"{CONTAINER}:/tmp/board.png", "/tmp/board-shot.png"],
                           capture_output=True)
            return self._send("screenshot taken", "text/plain")

        b = running()
        if not b:
            return self._send("no bot in a meeting", "text/plain")
        payload = json.dumps(body["act"])
        out = subprocess.run(["docker", "exec", CONTAINER, "redis-cli", "PUBLISH",
                              f"bot_commands:meeting:{b['id']}", payload], capture_output=True, text=True)
        # subscriber count 0 = nothing received it (bot still in the lobby, or wrong meeting)
        self._send(f"{payload} -> subscribers={out.stdout.strip() or out.stderr.strip()}", "text/plain")

    def log_message(self, *a):
        pass


HTTPServer(("0.0.0.0", 8090), H).serve_forever()
