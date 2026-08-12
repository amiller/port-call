#!/usr/bin/env python3
"""Soundboard / control panel for the Vexa bot.  python3 board.py  -> http://<host>:8090

Publishes acts.v1 to the meeting's redis command bus, the same path speak.sh and share.sh use.
Targets are read live from the gateway, so the list is whatever is actually in a meeting.
"""
import json, subprocess, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

CONTAINER = "vexa-rig-vexa-lite-1"
GATEWAY = "http://localhost:8056"
TOKEN = open("/tmp/vexa-bot-token.txt").read().strip()
SFX = ["airhorn", "gavel", "ding", "objection"]

PAGE = """<!doctype html><title>Vexa board</title><meta name=viewport content="width=device-width,initial-scale=1">
<style>
 body{background:#0d0d12;color:#e8e8f0;font:16px system-ui,sans-serif;margin:0;padding:24px;max-width:760px}
 h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#8a8aa0;margin:28px 0 10px}
 button{font:600 17px system-ui;padding:16px 22px;margin:0 8px 8px 0;border:0;border-radius:10px;
   background:#242433;color:#e8e8f0;cursor:pointer}
 button:hover{background:#33334a} button:active{transform:translateY(1px)}
 .sfx{background:#7c3aed} .sfx:hover{background:#8b4ff5}
 input,select{font:16px system-ui;padding:12px;border-radius:8px;border:1px solid #33334a;
   background:#16161f;color:#e8e8f0;width:100%;box-sizing:border-box;margin-bottom:8px}
 #log{margin-top:24px;font:13px ui-monospace,monospace;color:#6a6a80;white-space:pre-wrap}
 .row{display:flex;gap:8px}.row input{flex:1}
</style>
<h2>target</h2><select id=t></select>
<h2>soundboard</h2><div id=sfx></div>
<h2>speak</h2><div class=row><input id=say placeholder="something to say"><button onclick=speak()>Say</button></div>
<h2>share a tab</h2><div class=row><input id=url placeholder="https://..."><button onclick=share()>Share</button><button onclick=act({action:'screen_share_stop'})>Stop</button></div>
<div id=log></div>
<script>
const SFX=__SFX__;
sfx.innerHTML=SFX.map(s=>`<button class=sfx onclick="act({action:'speak',text:'!${s}'})">${s}</button>`).join('');
async function refresh(){
  const r=await (await fetch('/targets')).json();
  t.innerHTML=r.map(b=>`<option value="${b.id}">${b.id} - ${b.native_meeting_id} (${b.status})</option>`).join('')
    ||'<option value="">no bot in a meeting</option>';
}
async function act(a){
  const r=await fetch('/act',{method:'POST',body:JSON.stringify({id:t.value,act:a})});
  log.textContent=(await r.text())+'\\n'+log.textContent;
}
const speak=()=>{act({action:'speak',text:say.value});say.value='';};
const share=()=>act({action:'screen_share',url:url.value});
refresh();setInterval(refresh,5000);
</script>""".replace("__SFX__", json.dumps(SFX))


def targets():
    req = urllib.request.Request(GATEWAY + "/bots/status", headers={"X-API-Key": TOKEN})
    running = json.load(urllib.request.urlopen(req, timeout=5))["running"]
    return [{k: b[k] for k in ("id", "native_meeting_id", "status")} for b in running]


class H(BaseHTTPRequestHandler):
    def _send(self, body, ctype="text/html; charset=utf-8"):
        b = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/targets":
            self._send(json.dumps(targets()), "application/json")
        else:
            self._send(PAGE)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        payload = json.dumps(body["act"])
        chan = "bot_commands:meeting:" + str(body["id"])
        out = subprocess.run(["docker", "exec", CONTAINER, "redis-cli", "PUBLISH", chan, payload],
                             capture_output=True, text=True)
        # subscriber count 0 = nothing received it (bot not listening / wrong meeting id)
        self._send(payload + " -> subscribers=" + (out.stdout.strip() or out.stderr.strip()), "text/plain")

    def log_message(self, *a):
        pass


HTTPServer(("0.0.0.0", 8090), H).serve_forever()
