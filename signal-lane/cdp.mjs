#!/usr/bin/env node
// CDP driver for a Signal Desktop seat.
//   node cdp.mjs <port> eval <file>|-e '<expr>' | shot <out.png> | init <file> | perms
//
// Signal Desktop is Electron, so its ENTIRE React UI is reachable over --remote-debugging-port:
// clicks on real buttons, device <select>s, call state, the lot. The one thing CDP cannot touch is
// call audio — RingRTC is a native module that opens PulseAudio directly and never exposes PCM to
// JS — which is why the audio half of this lane is virtual devices, not script.
const [port, cmd, arg, arg2] = process.argv.slice(2);
if (!port || !cmd) { console.error('usage: cdp.mjs <port> eval <file>|-e <expr> | shot <out.png> | init <file> | perms'); process.exit(2); }

const TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS || 60000);
const fs = await import('node:fs/promises');
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

// Open a session against one target and give back a `send` bound to it. Every call is bounded:
// a hung renderer used to hang the whole e2e silently with no message.
function session(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace(/:\d+\//, `:${port}/`));
  let id = 0;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', (e) => rej(new Error('CDP socket error: ' + (e.message || 'unknown'))));
  });
  const send = (method, params) => new Promise((res, rej) => {
    const myId = ++id;
    const timer = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error(`CDP ${method} timed out after ${TIMEOUT_MS}ms`)); }, TIMEOUT_MS);
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { clearTimeout(timer); ws.removeEventListener('message', h); res(m); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  return { ws, ready, send };
}

// `perms` clears the first-join microphone/camera prompt, which lives in its own target.
// Signal asks twice (mic, then camera) and each answer opens the next, so this loops. It reports
// what it actually CLICKED, not how many popups it saw: a wording or locale change would otherwise
// leave the prompt standing while this returned a confident count.
if (cmd === 'perms') {
  let clicked = 0, seen = 0;
  for (let round = 0; round < 4; round++) {
    const fresh = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pop = fresh.find(t => t.url.includes('permissions_popup'));
    if (!pop) break;
    seen++;
    const s = session(pop);
    await s.ready;
    const r = await s.send('Runtime.evaluate', { expression:
      `(() => { const b = [...document.querySelectorAll('button')].find(x => /Allow Access/i.test(x.innerText||'')); if (!b) return false; b.click(); return true; })()`,
      returnByValue: true });
    if (r.result?.result?.value === true) clicked++;
    else console.error(`[perms] popup ${seen} had no "Allow Access" button — prompt left standing`);
    await new Promise(r2 => setTimeout(r2, 1500));
    s.ws.close();
  }
  console.log(JSON.stringify({ seen, clicked }));
  if (seen !== clicked) process.exit(6);
  process.exit(0);
}

// A first-join permission prompt opens as its OWN target, not a node in the main page. Anything
// driving Signal has to know that or it hangs forever waiting on a modal it cannot see.
const page = list.find(t => t.type === 'page' && t.url.includes('background.html'));
if (!page) { console.error('no background.html target; targets: ' + list.map(t => t.url).join(', ')); process.exit(3); }
const { ws, ready, send } = session(page);
await ready;

if (cmd === 'init') {
  // The bot's model: install the camera patch BEFORE any app code runs, then reload. Signal
  // enumerates video inputs once at startup and caches the result in Redux, so a HUD injected into
  // a live page patches enumerateDevices too late — Signal already believes there is no camera and
  // never calls getUserMedia, leaving the tile showing an avatar. CDP's addInitScript equivalent.
  const src = await fs.readFile(arg, 'utf8');
  await send('Page.enable', {});
  await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  await send('Page.reload', {});
  console.log(JSON.stringify({ initScript: arg, reloaded: true }));
} else if (cmd === 'shot') {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot.result?.data) { console.error('screenshot failed: ' + JSON.stringify(shot).slice(0, 300)); process.exit(4); }
  await fs.writeFile(arg, Buffer.from(shot.result.data, 'base64'));
  console.log(arg);
} else {
  const expr = arg === '-e' ? arg2 : await fs.readFile(arg, 'utf8');
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) { console.error('EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500)); process.exit(5); }
  console.log(JSON.stringify(r.result?.result?.value ?? null));
}
ws.close();
process.exit(0);
