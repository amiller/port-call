#!/usr/bin/env python3
"""Port Call console — get the bot into a meeting, watch the room, pull its strings.  http://localhost:8090

The bot is a puppet in a live Google Meet; the person at this page is the brain. The page follows
the bot's lifecycle and shows only what that moment needs:

  not in a call   paste a link and join; readiness checks (stack, transcription model); the look
  getting in      request -> joining -> knocking (admit it in Meet) -> in, with the bot's own screen
  in the call     ONE timeline of the conversation — what the room said (transcript) interleaved
                  with what the bot did, confirmed from the bot's log — and a dock of controls

Acts go to the same redis command bus as demo.sh; nothing here is a second implementation of the
bot's behaviour. What the bot DID comes from its log, not from what was sent: "said" appears when
the bot logged it, "audible after 0.5 s" when the audio started, so the page cannot report a sound
that never played.

Deliberately has no auth: it is bound to localhost and it can make a bot join a meeting, so do NOT
expose it to the network.
"""
import json, pathlib, re, subprocess, time, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent


def dotenv():
    """The settings compose reads, so the console names the same container and port it does."""
    out = {}
    try:
        for line in (HERE / ".env").read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


ENV = dotenv()
CONTAINER = ENV.get("COMPOSE_PROJECT_NAME", "vexa-rig") + "-vexa-lite-1"
GATEWAY = f"http://localhost:{ENV.get('VEXA_GW_PORT', '8056')}"
# stt_local.py: transcription on this machine, and the one process that knows which Whisper model
# is loaded. The console only relays to it.
STT = "http://127.0.0.1:8177"
TOKENS = {"bot": "/tmp/vexa-bot-token.txt", "tx": "/tmp/vexa-tx-token.txt"}   # minted by ./pc up
BOT_NAME = "Port Call"
SFX = ["airhorn", "gavel", "ding", "objection", "order", "noted", "correct", "welcome", "timesup"]
# Meet's picker set VARIES by UI state — a dump taken while presenting showed 🎊 💗 💯 😆 🙁 😲,
# while the normal in-call picker shows these. The controller fails loudly (with the candidate
# list) when an emoji is absent rather than silently picking a neighbour.
EMOJI = ["👍", "🎉", "💖", "👏", "😂", "😮"]
# Fallback lists only: the page reads the HUD's own registries (avatars()/backgrounds()) and uses
# these if the HUD module cannot be loaded. An unknown name is REJECTED by the bot with the valid
# set named, so a drift here is a loud error, never a silently unchanged tile.
AVATARS = ["rooster", "hancock", "tina", "dmarz", "cat", "alien", "dolphin"]
BACKGROUNDS = ["transcript", "vitals", "swarm", "brainrot"]

PAGE = r"""<!doctype html><meta charset=utf-8><title>Port Call</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:dark;--bg:#0b0b10;--panel:#14141c;--line:#23233a;--ink:#e8e8f0;--dim:#8a8aa0;--faint:#5a5a70;
       --good:#7ce38b;--warn:#f5c518;--bad:#ff7b72;--bot:#f5a524;--accent:#8ab4ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
 *{box-sizing:border-box}
 html,body{height:100%}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif;display:flex;flex-direction:column}
 button{font:600 15px system-ui;padding:10px 14px;border:0;border-radius:10px;background:#242433;color:var(--ink);cursor:pointer}
 button:hover{background:#33334a} button:active{transform:translateY(1px)} button:disabled{opacity:.45;cursor:default;transform:none}
 button.go{background:#2d7d46} button.go:hover{background:#379a55}
 button.stop{background:#8b2f2f} button.stop:hover{background:#a63a3a}
 button.sfx{background:#5b3ca8;padding:8px 12px;font-size:14px} button.sfx:hover{background:#6d49c9}
 button.emo{font-size:20px;padding:6px 10px;background:#1b1b26}
 button.ghost{background:transparent;border:1px solid var(--line);color:var(--dim)} button.ghost:hover{color:var(--ink);background:#1b1b26}
 input,select{font:15px system-ui;padding:10px 12px;border-radius:9px;border:1px solid #33334a;background:var(--panel);color:var(--ink)}
 input:focus{outline:2px solid var(--accent);outline-offset:-1px}
 .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center} .row>input{flex:1;min-width:160px}
 .lbl{font:12px system-ui;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:14px 0 6px}
 .mono{font:13px var(--mono);color:var(--dim)}
 .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--faint);vertical-align:middle}

 /* ── header: the bot's phase, always visible ─────────────────────────────────────────────── */
 header{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--line);background:#0e0e15;flex:none}
 header .brand{font-weight:700;letter-spacing:.02em;color:var(--dim)}
 header .phase{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
 header .phase b{font-size:17px;white-space:nowrap}
 header .phase span{color:var(--dim);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 #elapsed{font-family:var(--mono);flex:none}
 #ready{display:flex;gap:12px;font-size:13px;color:var(--dim)} #ready i{font-style:normal;white-space:nowrap}
 #ready .dot{margin-right:5px}
 .ok{background:var(--good)} .warnd{background:var(--warn)} .badd{background:var(--bad)} .pulse{animation:pulse 1.2s infinite}
 @keyframes pulse{50%{opacity:.25}}

 /* ── main: the room on the left, the bot on the right ────────────────────────────────────── */
 main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 340px;grid-template-rows:minmax(0,1fr)}
 #room{min-width:0;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--line);position:relative}
 #botpane{overflow:auto;padding:14px 16px}
 .card{max-width:560px;margin:28px auto;padding:22px 24px;background:var(--panel);border:1px solid var(--line);border-radius:16px}
 .card h2{margin:0 0 6px;font-size:19px} .card p{margin:6px 0 14px;color:var(--dim)}
 .check{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);flex-wrap:wrap}
 .check:first-of-type{border-top:0} .check .what{flex:1 1 200px;min-width:0} .check .what small{display:block;color:var(--dim)}
 .check select{flex:0 1 260px;min-width:0;max-width:100%}
 #banner{margin:0 0 14px;padding:10px 14px;border-radius:10px;background:#2b1a1c;color:#ffb3ad;display:none}
 .steps{display:flex;gap:6px;margin:10px 0 16px} .steps span{flex:1;height:6px;border-radius:3px;background:var(--line)}
 .steps span.done{background:var(--good)} .steps span.now{background:var(--warn);animation:pulse 1.2s infinite}
 .instr{font-size:17px;margin:8px 0}
 #joinshot,#shotimg{width:100%;border-radius:10px;border:1px solid var(--line);background:#000;display:none}

 /* the timeline */
 #timeline{flex:1;overflow:auto;padding:12px 16px 24px}
 .ev{display:grid;grid-template-columns:62px 1fr;gap:10px;padding:5px 0;align-items:baseline}
 .ev time{font:12px var(--mono);color:var(--faint);padding-top:2px}
 .ev .who{color:var(--good);font-weight:600;margin-right:6px}   /* the green is for a name without a colour yet */
 .ev.bot .body{color:#ffd9a3} .ev.bot .who{color:var(--bot)}
 .ev.bot .body small,.ev .sub{display:block;color:var(--dim);font-size:13px}
 .ev.note .body{color:var(--dim);font-size:13px} .ev.pending .body{color:var(--dim)} .ev.bad .body small{color:var(--bad)}
 .ev .quote{margin:4px 0 0 10px;padding-left:10px;border-left:2px solid var(--line);color:var(--dim);font-size:13px}
 #empty{color:var(--faint);padding:20px 0;text-align:center}
 #more{color:var(--faint);font-size:12px;text-align:center;padding:4px 0 10px;cursor:pointer}
 #jump{position:absolute;right:16px;bottom:14px;display:none;background:#1f3b63;border:1px solid #2d5a97}

 /* the bot's look */
 #stage{display:block;width:100%;aspect-ratio:236/280;border:1px solid var(--line);border-radius:14px;background:#07070c}
 .cards{display:flex;gap:6px;flex-wrap:wrap}
 .cardb{padding:0;width:70px;background:var(--panel);border:2px solid var(--line);border-radius:10px;overflow:hidden;font:600 12px system-ui;color:#c8c8d8}
 .cardb:hover{background:var(--panel);border-color:#5a5a8a} .cardb.sel{border-color:var(--good);color:#fff}
 .cardb:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
 .cardb img{display:block;width:66px;height:66px;background:#07070c} .cardb span{display:block;padding:3px 0 4px}
 #botpane .hint{font-size:12px;color:var(--faint);margin-top:6px}

 /* ── dock: the strings, only while in the call ───────────────────────────────────────────── */
 footer{flex:none;border-top:1px solid var(--line);background:#0e0e15;padding:10px 16px;display:none}
 footer .row+.row{margin-top:8px}
 #toast{font:13px var(--mono);color:var(--dim);margin-top:8px;min-height:16px;white-space:pre-wrap}
 footer .hint{font-size:12px;color:var(--faint);margin-top:8px} footer .hint b{color:var(--dim);font-weight:500}
 #sub[title]{cursor:help}
 details{padding:4px 16px 10px;color:var(--faint);font-size:12px} details pre{max-height:140px;overflow:auto;margin:6px 0 0;white-space:pre-wrap}

 main[data-mode=lobby] #timeline,main[data-mode=lobby] #joining,main[data-mode=joining] #timeline,
 main[data-mode=joining] #lobby,main[data-mode=call] #lobby,main[data-mode=call] #joining{display:none}
 body[data-mode=call] footer{display:block}

 @media (max-width:860px){
   main{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto}
   #room{border-right:0} #botpane{border-top:1px solid var(--line);max-height:38vh}
   body[data-mode=call] #botpane{display:none} body[data-mode=call].look #botpane{display:block}
   #ready i b{display:none} .card{margin:14px 12px}
   header{gap:8px;padding:8px 10px} header .brand{display:none} header button{padding:8px 10px}
   header .phase b{font-size:15px;overflow:hidden;text-overflow:ellipsis}
   body[data-mode=call] #ready,body[data-mode=call] #sub{display:none}
 }
</style>

<header>
  <span class=brand>PORT CALL</span>
  <div class=phase><span class=dot id=dot></span><b id=phase>…</b><span id=sub></span><span id=elapsed></span></div>
  <div id=ready></div>
  <button id=lookbtn class=ghost style=display:none onclick="document.body.classList.toggle('look')">Look</button>
  <button id=leave class=stop style=display:none onclick=leave()>Leave</button>
</header>

<main id=main data-mode=lobby>
  <section id=room>
    <div id=lobby class=card>
      <div id=banner></div>
      <h2>Send the bot into a meeting</h2>
      <p>Paste the Meet link. The bot knocks; admit it as the host and it is in.</p>
      <div class=row>
        <input id=roomin placeholder="meet.google.com/abc-defg-hij" onkeydown="if(event.key=='Enter')join()">
        <button class=go onclick=join()>Join</button>
      </div>
      <div id=lastroom class=mono style="margin-top:8px"></div>
      <div class=lbl>before you go</div>
      <div id=checks></div>
    </div>

    <div id=joining class=card>
      <h2 id=jtitle>Getting in…</h2>
      <div class=steps><span id=s1></span><span id=s2></span><span id=s3></span></div>
      <div class=instr id=jinstr></div>
      <p id=jnote class=mono></p>
      <img id=joinshot alt="what the bot sees">
      <div class=row style="margin-top:12px"><button class=ghost onclick=leave(true)>Cancel</button><span class=mono id=jelapsed></span></div>
    </div>

    <div id=timeline><div id=empty>Nothing yet — when people speak, it shows up here, and so does what the bot does.</div></div>
    <button id=jump onclick=jumpdown()>↓ latest</button>
  </section>

  <aside id=botpane>
    <div class=lbl style="margin-top:0">the bot's tile</div>
    <iframe id=stage title="live preview of the bot's camera tile"></iframe>
    <div class=mono id=stagecap style="margin-top:6px"></div>
    <div class=lbl>character</div><div class=cards id=avcards></div>
    <div class=lbl>background</div><div class=cards id=bgcards></div>
    <div class=hint>Hover a card to watch it listen and speak. Click to use it.</div>
    <div class=lbl>headline on the tile</div>
    <div class=row><input id=head placeholder="e.g. ON AIR"><button onclick=cam()>Apply</button></div>
    <div class=lbl>screen</div>
    <div class=row>
      <button id=present onclick=present()>Present the tile</button>
      <button class=ghost onclick=shot()>Bot's screen</button>
    </div>
    <div class=hint>Presenting shares this same tile as a screen; the bot cannot share a web page.</div>
    <img id=shotimg alt="the bot's own screen" style="margin-top:8px">
    <select id=avatar hidden></select><select id=bg hidden></select>
  </aside>
</main>

<footer>
  <div class=row>
    <input id=say placeholder="Say something out loud — Enter" onkeydown="if(event.key=='Enter')speak()">
    <button class=go onclick=speak()>Speak</button>
    <span class=row id=sfxrow></span>
  </div>
  <div class=row>
    <input id=chat placeholder="Post to the meeting chat" onkeydown="if(event.key=='Enter')chat()">
    <button onclick=chat()>Send</button>
    <button class=ghost onclick="act({action:'chat_read'})">Read chat</button>
    <span class=row id=emorow></span>
  </div>
  <div class=hint>Anyone in the call can type <b>opt-out</b> in the Meet chat to keep their words out of the transcript, <b>opt-out 2</b> to keep their name out too, <b>opt-in</b> to undo it.</div>
  <div id=toast></div>
</footer>
<details><summary>raw responses</summary><pre id=log></pre></details>

<script>
const CFG=CONFIG_JSON;
const BOT_NAME='Port Call';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hhmm=t=>new Date(t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const mmss=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
$('sfxrow').innerHTML=CFG.sfx.map(s=>`<button class=sfx onclick="act({action:'speak',text:'!${s}'})">${s}</button>`).join('');
$('emorow').innerHTML=CFG.emoji.map(e=>`<button class=emo onclick="act({action:'reaction',emoji:'${e}'})">${e}</button>`).join('');
$('avatar').innerHTML=CFG.avatars.map(a=>`<option>${a}</option>`).join('');
$('bg').innerHTML=CFG.backgrounds.map(b=>`<option>${b}</option>`).join('');

// ── talking to the server ─────────────────────────────────────────────────────────────────────
async function post(path,body){
  const r=await fetch(path,{method:'POST',body:JSON.stringify(body||{})});
  const t=await r.text();
  $('log').textContent=(t+'\n'+$('log').textContent).slice(0,4000);
  $('toast').textContent=t.length>160?t.slice(0,160)+'…':t;
  return t;
}
const act=a=>post('/act',{act:a}).then(()=>setTimeout(refresh,400));
function speak(){const v=$('say').value.trim(); if(v){act({action:'speak',text:v});$('say').value=''}}
function chat(){const v=$('chat').value.trim(); if(v){act({action:'chat_send',text:v});$('chat').value=''}}
function cam(){act({action:'camera_show',text:$('head').value||'VEXA',avatar:$('avatar').value,bg:$('bg').value})}
let PRESENTING=false;
function present(){act(PRESENTING?{action:'screen_share_stop'}:{action:'screen_share',text:$('head').value||'VEXA'})}
async function join(){
  const room=$('roomin').value.trim()||S.last_room||'';
  if(!room){$('roomin').focus();return}
  $('banner').style.display='none';
  const t=await post('/join',{room});
  if(/^joining/.test(t)) $('roomin').value=''; else {$('banner').textContent=t;$('banner').style.display='block'}
  refresh();
}
async function leave(cancel){
  if(!cancel&&!confirm('Leave the call?')) return;
  await post('/leave'); refresh();
}
async function shot(){
  await post('/shot'); const i=$('shotimg'); i.style.display='block'; i.src='/shot.png?'+Date.now();
}

// ── state → the page ──────────────────────────────────────────────────────────────────────────
let S={phase:'none'}, BOT=null, shotTimer=null;
const PHASES={
  offline:['badd','Stack is down','run ./pc up'],
  none:['','Not in a call',''],
  failed:['badd','Not in a call','the last join did not get in'],
  requested:['warnd pulse','Getting in','asking the gateway for a bot'],
  joining:['warnd pulse','Getting in','the bot is opening the meeting'],
  awaiting_admission:['warnd pulse','Knocking','admit Port Call in your Meet'],
  active:['ok','In the call',''],
  stopping:['warnd pulse','Leaving',''],
};
function mode(p){return p==='active'||p==='stopping'?'call':(p==='requested'||p==='joining'||p==='awaiting_admission')?'joining':'lobby'}
function render(s){
  S=s; BOT=s.bot;
  const [cls,title,sub]=PHASES[s.phase]||PHASES.none, m=mode(s.phase);
  $('dot').className='dot '+cls; $('phase').textContent=title;
  const oo=s.optouts||{}, named=oo.named||[], nout=named.length+(oo.unnamed||0);
  $('sub').textContent=s.phase==='active'?s.room+(s.presenting?' · presenting':'')+(s.camera===false?' · camera off':'')
    +(nout?` · ${nout} opted out`:''):(s.room&&m!=='lobby'?`${s.room} · ${sub}`:sub);
  if(nout) $('sub').title=[...named,...(oo.unnamed?[`${oo.unnamed} without a name`]:[])].join(', '); else $('sub').removeAttribute('title');
  $('elapsed').textContent=s.phase==='active'&&s.since?mmss(Date.now()/1000-s.since):'';
  const prev=document.body.dataset.mode;
  document.body.dataset.mode=$('main').dataset.mode=m;
  $('leave').style.display=m==='call'?'':'none'; $('lookbtn').style.display=m==='call'?'':'none';
  if(m==='call'&&prev!=='call'){ $('say').focus(); document.body.classList.remove('look'); }
  PRESENTING=!!s.presenting; $('present').textContent=PRESENTING?'Stop presenting':'Present the tile';
  newMeeting(s); settle(s);
  readiness(s.health); lobby(s); joiningView(s); timeline(s); caption();
}
function readiness(h){
  if(!h) return;
  const stt=h.stt||{}, model=stt.current, items=[
    ['gateway',h.gateway,'bot service'],
    ['tokens',h.tokens,'tokens'],
    ['tts',h.tts,'voice'],
    ['stt',stt.state==='ready',`transcription${model?' · '+model:''}`]];
  $('ready').innerHTML=items.map(([k,ok,label])=>`<i title="${label}"><span class="dot ${ok?'ok':'badd'}"></span><b>${label}</b></i>`).join('');
}
function lobby(s){
  const h=s.health||{}, stt=h.stt||{}, ms=stt.models||[], rec=ms.find(m=>m.name===stt.recommended), a=stt.activity;
  $('lastroom').innerHTML=s.last_room?`last time: <a href=# onclick="$('roomin').value='${s.last_room}';join();return false">${s.last_room}</a> — Join with the box empty uses it`:'';
  if(s.phase==='failed'&&s.failure){$('banner').textContent=s.failure;$('banner').style.display='block'}
  if(document.activeElement&&document.activeElement.id==='sttsel') return;   // not under an open dropdown
  const line=(ok,what,small,action)=>`<div class=check><span class="dot ${ok===null?'warnd pulse':ok?'ok':'badd'}"></span>
     <span class=what>${what}${small?`<small>${small}</small>`:''}</span>${action||''}</div>`;
  let sttWhat, sttSmall='', sttAct='';
  if(!stt.models){sttWhat='Transcription is not running';sttSmall='./pc up starts it'}
  else if(a){sttWhat=a.kind==='downloading'?`Downloading ${a.name} · ${Math.floor(a.done*100/a.total)}%`:`Loading ${a.name}…`}
  else if(!ms.some(m=>m.installed)&&rec){sttWhat='No transcription model on this Mac yet';
    sttSmall=`Install fetches ${rec.file} (${rec.size_mb} MB) from ${stt.source} and loads it`;
    sttAct=`<button class=go onclick="sttset('${rec.name}')">Install ${rec.name}</button>`}
  else {sttWhat=stt.current?`Transcribing on this Mac with ${stt.current}`:'No transcription model loaded';
    sttAct=`<select id=sttsel onchange="sttpick(this)">${ms.map(m=>`<option value="${m.name}"${m.name===stt.current?' selected':''}>${m.name} · ${m.note} · ${m.size_mb} MB${m.installed?'':' · download'}</option>`).join('')}</select>`}
  if(stt.error) sttSmall=(sttSmall?sttSmall+' — ':'')+stt.error;
  $('checks').innerHTML=line(h.gateway,'Bot service',h.gateway?'gateway answering on :8056':'not answering — ./pc up')
    +line(h.tokens,'API tokens',h.tokens?'':'missing (they die on reboot) — ./pc up')
    +line(h.tts,'Voice',h.tts?'local Piper ready':'speech service not answering')
    +line(a?null:stt.state==='ready',sttWhat,sttSmall,sttAct);
}
async function sttset(name){const t=await post('/stt',{name}); if(!/^transcription model/.test(t)) alert(t); refresh()}
function sttpick(sel){
  const ms=(S.health&&S.health.stt&&S.health.stt.models)||[], m=ms.find(x=>x.name===sel.value); sel.blur();
  if(m&&!m.installed&&!confirm(`Download ${m.file} (${m.size_mb} MB) from ${S.health.stt.source}?`)) return refresh();
  sttset(sel.value);
}
function joiningView(s){
  if(mode(s.phase)!=='joining'){ if(shotTimer){clearInterval(shotTimer);shotTimer=null} return; }
  const n={requested:1,joining:2,awaiting_admission:3}[s.phase]||1;
  [1,2,3].forEach(i=>{$('s'+i).className=i<n?'done':i===n?'now':''});
  $('jtitle').textContent=s.phase==='awaiting_admission'?'Knocking':'Getting in…';
  $('jinstr').textContent=s.phase==='awaiting_admission'?'Admit "Port Call" in your Meet — only the host sees the knock.'
    :s.phase==='joining'?'The bot is opening the meeting in its browser.':'Asking the gateway for a bot.';
  $('jnote').textContent='If it never goes further, the picture below is what the bot is looking at.';
  $('jelapsed').textContent=s.joined_at?mmss(Date.now()/1000-s.joined_at):'';
  if(!shotTimer){ joinShot(); shotTimer=setInterval(joinShot,6000); }
}
async function joinShot(){ await fetch('/shot',{method:'POST'}); const i=$('joinshot'); i.style.display='block'; i.src='/shot.png?'+Date.now(); }

// The conversation: the room's words and the bot's deeds in one thread, by time. The whole
// meeting, loaded backwards: /state sends everything from FLOOR on, and scrolling to the top pages
// in what came before TOP (the oldest item loaded) from /history into OLD. When the live part
// grows long its head moves into OLD and FLOOR advances, so each poll stays small.
let lastKey='', FLOOR=null, TOP=null, OLDER=0, OLD={transcript:[],events:[]}, OLDBOT=null, loading=false;
// The transcript lines the bot writes when someone opts out or back in (optout.ts MARKER).
const MARKER=/^\(opted (out of|back into) the transcript\)$/;
// A person's name is one colour here and on the bot's tile. The tile's own code decides it
// (camera.ts speakerColor, reached through the stage once the HUD module has loaded); this copy
// of the same function covers the first renders before then, and a page where it never loads.
const SPEAKER_HUES=[130,215,330,48,185,270,95,20,300,160,240,0];
function speakerColor(name){
  if(STAGE&&STAGE.__vexaCam&&STAGE.__vexaCam.speakerColor) return STAGE.__vexaCam.speakerColor(name);
  const x=String(name||'').trim().toLowerCase(); let h=0;
  for(let i=0;i<x.length;i++) h=(h*31+x.charCodeAt(i))|0;
  return `hsla(${SPEAKER_HUES[Math.abs(h)%SPEAKER_HUES.length]},65%,70%,1)`;
}
const who=n=>`<span class=who style="color:${speakerColor(n)}">${esc(n)}</span>`;
function newMeeting(s){
  if(s.bot===OLDBOT||!s.bot) return;
  OLDBOT=s.bot; FLOOR=TOP=null; OLDER=0; OLD={transcript:[],events:[]}; lastKey='';
}
function settle(s){
  if(s.floor==null) return;
  if(FLOOR==null){FLOOR=TOP=s.floor; OLDER=s.older}
  const live=[...(s.transcript||[]),...(s.events||[])].map(i=>i.t).sort((a,b)=>a-b);
  if(live.length>300){                                  // retire the head of the live part
    const f=live[live.length-100];
    OLD.transcript.push(...s.transcript.filter(l=>l.t<f)); OLD.events.push(...s.events.filter(e=>e.t<f));
    FLOOR=f;
    s.transcript=s.transcript.filter(l=>l.t>=f); s.events=s.events.filter(e=>e.t>=f);
  }
}
async function loadOlder(){
  if(loading||!OLDER||TOP==null) return;
  loading=true;
  try{
    const h=await (await fetch('/history?before='+TOP)).json(), tl=$('timeline'), was=tl.scrollHeight;
    OLD.transcript.unshift(...h.transcript); OLD.events.unshift(...h.events);
    OLDER=h.older; TOP=h.floor; lastKey='';
    timeline(S, true); tl.scrollTop+=tl.scrollHeight-was;   // keep the reader where they were
  }finally{loading=false}
}
function timeline(s, keep){
  const items=[];
  for(const l of [...OLD.transcript,...(s.transcript||[])]) items.push({t:l.t,html:who(l.speaker)+esc(l.text),cls:MARKER.test(l.text)?'note':''});
  for(const e of [...OLD.events,...(s.events||[])]) items.push(botItem(e));
  for(const p of s.pending||[]) items.push({t:p.t,cls:'bot pending',html:`<span class=who>${BOT_NAME}</span>${pendingText(p)}`});
  items.sort((a,b)=>a.t-b.t);
  const key=OLDER+'#'+items.map(i=>i.t+i.cls+i.html.length).join('|');
  if(key===lastKey) return; lastKey=key;
  const tl=$('timeline'), stick=!keep&&tl.scrollHeight-tl.scrollTop-tl.clientHeight<80;
  const more=OLDER?`<div id=more onclick=loadOlder()>${OLDER} earlier — scroll up or click to load</div>`:'';
  tl.innerHTML=items.length?more+items.map(i=>`<div class="ev ${i.cls}"><time>${hhmm(i.t)}</time><div class=body>${i.html}</div></div>`).join('')
    :'<div id=empty>Nothing yet — when people speak, it shows up here, and so does what the bot does.</div>';
  if(keep) return;
  if(stick) tl.scrollTop=tl.scrollHeight; else $('jump').style.display='block';
  if(OLDER&&tl.scrollHeight<=tl.clientHeight) loadOlder();  // nothing to scroll yet: fill the view
}
function pendingText(p){
  const a=p.act||{}, tail=p.stale?' <small>no reply from the bot yet</small>':'';
  return (a.action==='speak'?(a.text.startsWith('!')?`playing ${esc(a.text.slice(1))}…`:`saying “${esc(a.text)}”…`)
    :a.action==='chat_send'?`posting to chat…`:a.action==='reaction'?`reacting ${a.emoji}…`
    :a.action==='camera_show'?`changing the tile…`:a.action==='screen_share'?`starting to present…`:`${esc(a.action)}…`)+tail;
}
function botItem(e){
  let html=`<span class=who>${BOT_NAME}</span>`, cls='bot';
  if(e.kind==='speak'){
    const sfx=e.text.startsWith('!');
    html+=sfx?`played <b>${esc(e.text.slice(1))}</b>`:`said “${esc(e.text)}”`;
    if(e.state==='audible') html+=`<small>audible after ${(e.synth_ms/1000).toFixed(1)} s</small>`;
    else if(e.state==='failed'){cls+=' bad';html+=`<small>failed — ${esc(e.note)}</small>`}
    else html+=`<small>playing…</small>`;
  }else if(e.kind==='chat') html+=`posted to chat: “${esc(e.text)}”`;
  else if(e.kind==='chatread') html+=`read the chat`+(e.messages.length?e.messages.map(m=>`<div class=quote><b>${esc(m.sender)}</b> ${esc(m.text)}</div>`).join(''):'<small>no messages</small>');
  else if(e.kind==='reaction') html+=`reacted ${e.emoji}`;
  else if(e.kind==='camera') html+=e.off?`turned the camera off`:`tile → <b>${esc(e.avatar)}</b> on <b>${esc(e.bg)}</b>${e.text&&e.text!=='VEXA'?` · “${esc(e.text)}”`:''}`;
  else if(e.kind==='share') html+=e.presenting?`started presenting the tile`:`stopped presenting`;
  else {cls='note';html=`<span class=who>${BOT_NAME}</span>${esc(e.text)}`}
  return {t:e.t,cls,html};
}
function jumpdown(){const tl=$('timeline');tl.scrollTop=tl.scrollHeight;$('jump').style.display='none'}
$('timeline').addEventListener('scroll',()=>{const tl=$('timeline'); if(tl.scrollHeight-tl.scrollTop-tl.clientHeight<80)$('jump').style.display='none'; if(tl.scrollTop<200)loadOlder()});

// ── the bot's tile: previews drawn by the bot's own HUD code ─────────────────────────────────
// /hud.mjs is the compiled module the bot runs, so a card shows what the meeting tile will show,
// and a character added to the HUD appears here without touching this page. One live instance
// (the stage) plus still thumbnails. The hidden <select>s hold the value cam() reads, and are the
// whole control if the module cannot be loaded.
const HUDURL=location.origin+'/hud.mjs?'+Date.now();
const huddoc=(css,stepped)=>`<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden;background:#07070c}
canvas{position:absolute;${css}}</style><script type=module>
const make=document.createElement.bind(document);
document.createElement=t=>{const el=make(t); if(t==='canvas'&&!window.cvs) window.cvs=el; return el};
${stepped?'window.requestAnimationFrame=cb=>{window.step=cb;return 0};':''}
(await import('${HUDURL}')).installHud();
document.body.appendChild(window.cvs); window.ready=true;
<\/script>`;
function hudframe(el,css,stepped){
  el.srcdoc=huddoc(css,stepped);
  return new Promise((ok,no)=>{let n=0; const iv=setInterval(()=>{
    const w=el.contentWindow;
    if(w&&w.ready){clearInterval(iv);ok(w)} else if(++n>120){clearInterval(iv);no(new Error('the HUD module did not load'))}
  },50)});
}
const SAMPLE=['Sample text: roadmap review, camera picker ships Friday.','Transcription latency dropped under half a second.',
  'Budget, hiring, launch plan, customer feedback.'];
const ABOUT={rooster:'the original rooster',hancock:'a rooster drawn from life',tina:'a cube-faced robot',
  dmarz:'a one-eyed portrait',cat:'an orange tabby',alien:'a tall green alien',
  dolphin:'a dolphin up out of the water',none:'no character, background only',transcript:'live captions',
  vitals:'pipeline numbers',swarm:'transcript words in orbit',brainrot:'transcript words thrown around'};
async function thumb(avatar,bg,rect,lines){
  const f=document.createElement('iframe');
  f.style.cssText='position:absolute;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  try{
    const w=await hudframe(f,'',true), hud=w.__vexaCam;
    hud.hud({avatar,bg});
    if(lines) for(const line of SAMPLE){hud.hud({speaker:'Sample',line}); for(let i=0;i<30;i++) w.step()}
    while(hud.frames()%240!==40) w.step();  // frame 40 of the cycle is clear of every character's blink
    const c=document.createElement('canvas'), g=c.getContext('2d'); c.width=c.height=132;
    g.drawImage(w.cvs,...rect,0,0,132,132);
    if(avatar==='none'&&!lines){ g.strokeStyle='#5a5a70'; g.lineWidth=3; g.setLineDash([8,6]);
      g.beginPath(); g.arc(66,66,34,0,7); g.stroke(); g.setLineDash([]); g.beginPath(); g.moveTo(43,89); g.lineTo(89,43); g.stroke(); }
    return c.toDataURL();
  }finally{f.remove()}
}
let STAGE=null, demo=null;
function caption(text){
  if(STAGE) $('stagecap').textContent=text||`${$('avatar').value} · ${$('bg').value}`+(BOT?'':' · preview, no bot in a call');
}
function sync(){
  if(!STAGE) return;
  const now={avatar:$('avatar').value,bg:$('bg').value};
  document.querySelectorAll('.cardb').forEach(b=>b.classList.toggle('sel',b.dataset.name===now[b.dataset.kind]));
  STAGE.__vexaCam.hud(now); caption();
}
function stopdemo(){ if(demo){clearInterval(demo);demo=null} if(STAGE) STAGE.__vexaCam.hud({speaking:false,windingUp:false}); }
function preview(kind,name){
  if(!STAGE) return;
  stopdemo();
  const hud=STAGE.__vexaCam; hud.hud({[kind]:name});
  caption(`previewing ${name} · ${ABOUT[name]||kind}`);
  let k=0;
  const tick=()=>{
    const j=k%44;
    if(Math.floor(k/44)%2===0){
      if(j===0) hud.hud({speaking:false,windingUp:false});
      if(j===4||j===26) hud.hud({speaker:'Sample',line:SAMPLE[Math.floor(k/22)%SAMPLE.length]});
    }else if(j===0) hud.hud({windingUp:true});
    else if(j>6) hud.hud({speaking:true,windingUp:false,amplitude:0.04+0.3*Math.abs(Math.sin(j/2.3))*Math.abs(Math.sin(j/9))});
    k++;
  };
  tick(); demo=setInterval(tick,60);
}
function unpreview(){stopdemo();sync()}
// Switching is live on the bot: it is HUD state on a canvas Meet is already publishing.
function pick(kind,name){$(kind).value=name;stopdemo();sync();if(BOT)cam()}
function cards(host,kind,names,thumbs){
  host.innerHTML=names.map((n,i)=>`<button class=cardb data-kind=${kind} data-name="${n}" title="${ABOUT[n]||n}"><img alt="" src="${thumbs[i]}"><span>${n}</span></button>`).join('');
  host.querySelectorAll('.cardb').forEach(b=>{
    b.onclick=()=>pick(kind,b.dataset.name);
    b.onmouseenter=b.onfocus=()=>preview(kind,b.dataset.name);
    b.onmouseleave=b.onblur=unpreview;
  });
}
async function initpicker(){
  try{
    const stage=await hudframe($('stage'),'height:100%;left:50%;transform:translateX(-50%)',false);
    const hud=stage.__vexaCam, avs=hud.avatars(), bgs=hud.backgrounds();
    for(const [id,names] of [['avatar',avs],['bg',bgs]]){
      const cur=$(id).value; $(id).innerHTML=names.map(n=>`<option>${n}</option>`).join('');
      if(names.includes(cur)) $(id).value=cur;
    }
    const at=[], bt=[], bare=avs.includes('none')?'none':avs[0];
    for(const a of avs) at.push(await thumb(a,bgs[0],[420,232,440,440],false));
    for(const b of bgs) bt.push(await thumb(bare,b,[280,0,720,720],true));
    cards($('avcards'),'avatar',avs,at); cards($('bgcards'),'bg',bgs,bt);
    STAGE=stage; sync();
    lastKey=''; timeline(S);   // names take their colour from the tile's code from here on
  }catch(e){
    $('avatar').hidden=$('bg').hidden=false; $('stage').style.display='none';
    $('stagecap').textContent='preview unavailable ('+e.message+')';
  }
}

async function refresh(){
  try{ render(await (await fetch('/state'+(FLOOR!=null?'?floor='+FLOOR:''))).json()); }
  catch(e){ $('dot').className='dot badd'; $('phase').textContent='Console unreachable'; $('sub').textContent=''; }
}
refresh(); initpicker();
setInterval(refresh,2000);
setInterval(()=>{ if(S.phase==='active'&&S.since) $('elapsed').textContent=mmss(Date.now()/1000-S.since); },1000);
</script>"""


# ── what the console knows ────────────────────────────────────────────────────────────────────
# The bot now in (or last in) a meeting, and what it did. EVENTS is read off the bot's own log, so
# every entry is something the bot reported, not something this page sent. PENDING is what this
# page sent and has not yet seen reported; the two meet when the log line arrives.
LAST = {"id": None, "code": None, "status": None, "active_at": None, "joined_at": None, "ended": None}
EVENTS, PENDING = [], []
CURSOR = {}            # bot id -> log lines already parsed
SELFCHECK = {}         # last [selfcheck] per bot id
OPTOUT = {}            # last [optout] roster per bot id: names at level 1, a count at level 2
CACHE = {"tts_t": 0, "tts": None, "last_room": None}
EVENT_RE = {
    "speak": re.compile(r'^\[bot\] speak: "(.*)"$'),
    "audible": re.compile(r"^\[bot\] \[tts\] audible ts=(\d+) synth_ms=(\d+)"),
    "service": re.compile(r"^\[bot\] \[tts\] service (\d+): (.*)$"),
    "guard": re.compile(r'^\[guard\] suppressed repeat speak: "(.*?)"'),
    "left": re.compile(r"^\[bot\] orchestrator: emitting completed \(reason=(\w+)"),
}


def token(kind):
    try:
        return open(TOKENS[kind]).read().strip()
    except OSError:
        return ""


def gw(path, kind="bot", method="GET", body=None, timeout=8):
    req = urllib.request.Request(f"{GATEWAY}{path}", method=method,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"X-API-Key": token(kind), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def running():
    r = gw("/bots/status").get("running") or []
    return r[0] if r else None


def transcript(code):
    """Completed segments only: vexa resubmits each utterance as a growing window, so provisional
    ones would rewrite the same sentence half a dozen times. `start` is epoch seconds. The whole
    meeting: the page asks for a window of it (window())."""
    try:
        segs = gw(f"/transcripts/google_meet/{code}", "tx").get("segments") or []
    except Exception:
        return []
    return [{"t": s.get("start") or 0, "speaker": s.get("speaker") or "?", "text": (s.get("text") or "").strip()}
            for s in segs if s.get("completed") and (s.get("text") or "").strip()]


def docker(*args, timeout=10):
    return subprocess.run(["docker", "exec", CONTAINER, *args], capture_output=True, text=True, timeout=timeout).stdout


def bot_log(mid):
    """Read the bot's log once per poll and turn the lines added since last time into events."""
    out = docker("sh", "-c", f"cat /tmp/vexa-workloads/mtg-{mid}-*.log 2>/dev/null")
    lines = out.splitlines()
    new, CURSOR[mid] = lines[CURSOR.get(mid, 0):], len(lines)
    now = time.time()
    for line in new:
        if line.startswith("[selfcheck] "):
            try:
                SELFCHECK[mid] = json.loads(line[12:])
            except ValueError:
                pass
            continue
        if line.startswith("[optout] {"):
            # The bot writes the whole roster each time, so the latest line is the state; a note
            # rides along only for what the transcript itself cannot show (a level-2 opt-out).
            try:
                OPTOUT[mid] = j = json.loads(line[9:])
            except ValueError:
                continue
            if j.get("note"):
                EVENTS.append({"kind": "note", "text": j["note"], "t": now})
            continue
        ev = fact(line, now)
        if ev:
            EVENTS.append(ev)


def last_event(kind):
    for e in reversed(EVENTS):
        if e["kind"] == kind:
            return e
    return None


def resolve(kind, ev):
    """A reported act answers the oldest unanswered act of that kind sent from here; the page's
    copy carries the full text where the bot's log line truncates it, and the time it was sent."""
    for i, p in enumerate(PENDING):
        a = p["act"]
        if a.get("action") == kind:
            if kind == "speak" and len(a.get("text", "")) > len(ev.get("text", "")):
                ev["text"] = a["text"]
            ev["t"] = min(ev["t"], p["t"] + 0.001)
            del PENDING[i]
            return


def fact(line, now):
    """One bot log line -> one event, or None. Transcript chatter and plumbing are skipped."""
    m = EVENT_RE["speak"].match(line)
    if m:
        ev = {"kind": "speak", "text": m.group(1), "state": "playing", "t": now}
        resolve("speak", ev)
        return ev
    m = EVENT_RE["audible"].match(line)
    if m:
        e = last_event("speak")
        if e and e["state"] == "playing":
            e["state"], e["synth_ms"] = "audible", int(m.group(2))
        return None
    m = EVENT_RE["service"].match(line)
    if m:
        e = last_event("speak")
        if e and e["state"] == "playing":
            e["state"] = "failed"
            e["note"] = "no such sound effect" if m.group(1) == "404" else f"voice service answered {m.group(1)}"
        return None
    m = EVENT_RE["guard"].match(line)
    if m:
        ev = {"kind": "note", "text": f"did not repeat “{m.group(1)}” (said recently)", "t": now}
        resolve("speak", ev)
        return ev
    if line.startswith("[bot] noise cancellation:"):
        return {"kind": "note", "text": "Meet noise cancellation " + line.split(":", 1)[1].strip(), "t": now}
    if line.startswith("[bot] mic: unmuted"):
        return {"kind": "note", "text": "unmuted its mic", "t": now}
    m = EVENT_RE["left"].match(line)
    if m:
        return {"kind": "note", "text": f"left the call ({m.group(1)})", "t": now}
    for prefix, kind in (("[chat] ", "chat"), ("[reaction] ", "reaction"), ("[camera] ", "camera"), ("[share] ", "share")):
        if line.startswith(prefix):
            try:
                j = json.loads(line[len(prefix):])
            except ValueError:
                return None
            if kind == "chat" and "messages" in j:
                ev = {"kind": "chatread", "messages": j["messages"], "t": now}
                resolve("chat_read", ev)
            elif kind == "chat":
                ev = {"kind": "chat", "text": j.get("sent", ""), "t": now}
                resolve("chat_send", ev)
            elif kind == "reaction":
                ev = {"kind": "reaction", "emoji": j.get("sent", ""), "t": now}
                resolve("reaction", ev)
            elif kind == "camera":
                ev = {"kind": "camera", "off": bool(j.get("off")), "avatar": j.get("avatar"), "bg": j.get("bg"),
                      "text": j.get("text"), "t": now}
                resolve("camera_off" if j.get("off") else "camera_show", ev)
            else:
                ev = {"kind": "share", "presenting": bool(j.get("presenting")), "t": now}
                resolve("screen_share" if j.get("presenting") else "screen_share_stop", ev)
            return ev
    return None


def tts_ok():
    if time.time() - CACHE["tts_t"] > 20:
        CACHE["tts_t"] = time.time()
        try:
            CACHE["tts"] = '"healthy"' in docker("curl", "-s", "-m", "4", "http://tts-shim:8002/health", timeout=8)
        except Exception:
            CACHE["tts"] = False
    return CACHE["tts"]


def stt(path, body=None):
    """Ask the local transcription service. Its JSON error bodies are answers, not failures."""
    req = urllib.request.Request(f"{STT}{path}", method="POST" if body else "GET",
                                 data=json.dumps(body).encode() if body else None)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)
    except OSError:
        return {"state": "off"}


# The page shows the whole meeting but does not re-send it every poll: /state carries everything
# from a floor time the page pins (the last TAIL items when it has none yet), and /history pages
# backwards from there as the page is scrolled up.
TAIL = 100


def window(transcript, events, floor=None, before=None, n=TAIL):
    """Items with floor <= t (< before); with no floor, the last n of them. Returns the slices,
    the floor used, and how many items are older than it."""
    ts = sorted([l["t"] for l in transcript] + [e["t"] for e in events])
    if before is not None:
        ts = [t for t in ts if t < before]
    if floor is None:
        floor = ts[-n] if len(ts) >= n else (ts[0] if ts else 0)
    keep = lambda t: t >= floor and (before is None or t < before)
    return ([l for l in transcript if keep(l["t"])], [e for e in events if keep(e["t"])],
            floor, sum(t < floor for t in ts))


def history(code, before):
    """The page of the timeline just before `before` (the page's oldest item)."""
    tr, ev, floor, older = window(transcript(code) if code else [], EVENTS, before=before)
    return {"transcript": tr, "events": ev, "floor": floor, "older": older}


def state(floor=None):
    st = {"phase": "none", "bot": None, "room": None, "since": None, "joined_at": None, "camera": None,
          "presenting": None, "failure": None, "last_room": CACHE["last_room"], "transcript": [],
          "events": [], "pending": []}
    health = {"gateway": False, "tokens": bool(token("bot") and token("tx")), "tts": tts_ok(), "stt": stt("/models")}
    try:
        b = running()
        health["gateway"] = True
    except Exception:
        st["phase"] = "offline"
        st["health"] = health
        return st
    now = time.time()
    if b:
        if b["id"] != LAST["id"]:                      # a bot this page did not send: adopt it
            LAST.update(id=b["id"], code=b["native_meeting_id"], status=None, active_at=None, joined_at=now, ended=None)
            EVENTS.clear(); PENDING.clear()
        LAST["status"] = b["status"]
        if b["status"] == "active" and not LAST["active_at"]:
            LAST["active_at"] = now
        bot_log(b["id"])
        sc = SELFCHECK.get(b["id"], {})
        st.update(phase=b["status"], bot=b["id"], room=b["native_meeting_id"], since=LAST["active_at"],
                  joined_at=LAST["joined_at"], camera=sc.get("cameraOn"), presenting=sc.get("presenting"),
                  transcript=transcript(b["native_meeting_id"]), optouts=OPTOUT.get(b["id"], {}))
    elif LAST["id"] and not LAST["ended"]:
        LAST["ended"] = now
        bot_log(LAST["id"])                            # the leave reason lands after the bot is gone
    if not b and LAST["id"] and not LAST["active_at"] and LAST["ended"] and now - LAST["ended"] < 600:
        st["phase"], st["failure"] = "failed", (
            f"The bot never got into {LAST['code']} (last seen: {LAST['status'] or 'requested'}). "
            "Calendared personal-account meetings wall out guest bots behind a Google sign-in.")
    st["room"] = st["room"] or LAST["code"]
    # Acts sent from here that the bot has not reported yet; stale ones are shown as unconfirmed.
    for p in PENDING:
        p["stale"] = now - p["t"] > 20
    st["pending"] = PENDING[-10:]
    st["transcript"], st["events"], st["floor"], st["older"] = window(st["transcript"], EVENTS, floor)
    st["health"] = health
    return st


def sfx_names():
    """Buttons only for effects that exist: SFX also names some with no file in shims/sfx."""
    have = sorted(p.stem for p in (HERE / "shims" / "sfx").glob("*.wav"))
    return ([s for s in SFX if s in have] + [s for s in have if s not in SFX]) if have else SFX


class H(BaseHTTPRequestHandler):
    def _send(self, body, ctype="text/html; charset=utf-8", raw=False, code=200):
        b = body if raw else body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = {k: float(v[0]) for k, v in urllib.parse.parse_qs(url.query).items() if k in ("floor", "before")}
        if url.path == "/state":
            return self._send(json.dumps(state(q.get("floor"))), "application/json")
        if url.path == "/history":
            return self._send(json.dumps(history(LAST["code"], q.get("before", time.time()))), "application/json")
        if self.path.startswith("/hud.mjs"):
            # The compiled module the bot itself runs (hotswap.sh rewrites it), so the console's
            # camera previews are drawn by the same code as the meeting tile.
            try:
                js = (HERE / "live" / "services-bot-dist" / "camera.js").read_bytes()
            except OSError:
                js = b"throw new Error('live/services-bot-dist/camera.js is missing: run ./populate-live.sh')"
            return self._send(js, "text/javascript", raw=True)
        if self.path.startswith("/shot.png"):
            try:
                return self._send(open("/tmp/board-shot.png", "rb").read(), "image/png", raw=True)
            except OSError:
                return self._send(b"", "image/png", raw=True)
        if self.path != "/":
            return self._send("not found", "text/plain", code=404)
        cfg = {"sfx": sfx_names(), "emoji": EMOJI, "avatars": AVATARS, "backgrounds": BACKGROUNDS}
        self._send(PAGE.replace("CONFIG_JSON", json.dumps(cfg)))

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or "{}")

        if self.path == "/stt":
            r = stt("/model", {"name": body.get("name")})
            return self._send(r.get("error") or f"transcription model -> {body.get('name')} ({r.get('state')})", "text/plain")

        if self.path == "/join":
            # Accept a full URL or a bare code — pasting the link out of an invite is the fast path.
            m = re.search(r"([a-z]{3}-[a-z]{4}-[a-z]{3})", (body.get("room") or "").strip())
            if not m:
                return self._send("that is not a Meet link or code (abc-defg-hij)", "text/plain")
            code = m.group(1)
            try:
                gw(f"/bots/google_meet/{code}", method="DELETE")
            except Exception:
                pass
            try:
                r = gw("/bots", method="POST", body={"platform": "google_meet", "native_meeting_id": code,
                                                     "bot_name": BOT_NAME, "voice_agent_enabled": True})
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:300]
                return self._send(f"join refused ({e.code}): {detail}", "text/plain")
            except Exception as e:
                return self._send(f"join failed: {e}", "text/plain")
            LAST.update(id=r.get("id"), code=code, status="requested", active_at=None, joined_at=time.time(), ended=None)
            EVENTS.clear(); PENDING.clear()
            CACHE["last_room"] = code
            return self._send(f"joining {code} as bot {r.get('id')}", "text/plain")

        if self.path == "/leave":
            code = LAST["code"]
            if not code:
                return self._send("no bot to stop", "text/plain")
            # Read the answer instead of assuming: a DELETE that failed once left a bot sitting in
            # a live call while the page said it had left.
            try:
                r = gw(f"/bots/google_meet/{code}", method="DELETE")
            except urllib.error.HTTPError as e:
                return self._send(f"leave FAILED ({e.code}): {e.read().decode(errors='replace')[:200]}", "text/plain")
            except Exception as e:
                return self._send(f"leave FAILED: {e}", "text/plain")
            return self._send(f"leaving {code}: {r.get('status') or r}", "text/plain")

        if self.path == "/shot":
            docker("sh", "-c", "DISPLAY=:99 ffmpeg -y -loglevel error -f x11grab -video_size 1600x900 -i :99 -frames:v 1 /tmp/board.png", timeout=20)
            subprocess.run(["docker", "cp", f"{CONTAINER}:/tmp/board.png", "/tmp/board-shot.png"], capture_output=True)
            return self._send("screenshot taken", "text/plain")

        if self.path == "/act":
            try:
                b = running()
            except Exception as e:
                return self._send(f"gateway not answering: {e}", "text/plain")
            if not b:
                return self._send("no bot in a meeting", "text/plain")
            a = body.get("act") or {}
            payload = json.dumps(a)
            out = subprocess.run(["docker", "exec", CONTAINER, "redis-cli", "PUBLISH",
                                  f"bot_commands:meeting:{b['id']}", payload], capture_output=True, text=True)
            subs = (out.stdout or out.stderr).strip()
            if subs == "1":
                PENDING.append({"t": time.time(), "act": a})
                del PENDING[:-20]
                return self._send(f"sent {a.get('action')}", "text/plain")
            # subscriber count 0 = nothing received it (bot still in the lobby, or wrong meeting)
            return self._send(f"{a.get('action')}: nobody listening (subscribers={subs}) — the bot is not in the call yet", "text/plain")

        self._send("not found", "text/plain", code=404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8090), H).serve_forever()
