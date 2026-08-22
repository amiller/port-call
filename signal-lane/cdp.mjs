#!/usr/bin/env node
// CDP driver for a Signal Desktop seat.  node cdp.mjs <port> eval <file>|-e '<expr>' | shot <out.png>
//
// Signal Desktop is Electron, so its ENTIRE React UI is reachable over --remote-debugging-port:
// clicks on real buttons, device <select>s, call state, the lot. The one thing CDP cannot touch is
// call audio — RingRTC is a native module that opens PulseAudio directly and never exposes PCM to
// JS — which is why the audio half of this lane is virtual devices, not script.
const [port, cmd, arg, arg2] = process.argv.slice(2);
if (!port || !cmd) { console.error('usage: cdp.mjs <port> eval <file>|-e <expr> | shot <out.png> | perms'); process.exit(2); }

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

// `perms` clears the first-join microphone/camera prompt, which lives in its own target.
// Signal asks twice (mic, then camera) and each answer opens the next, so this loops.
if (cmd === 'perms') {
  let cleared = 0;
  for (let round = 0; round < 4; round++) {
    const fresh = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pop = fresh.find(t => t.url.includes('permissions_popup'));
    if (!pop) break;
    const pws = new WebSocket(pop.webSocketDebuggerUrl.replace(/:\d+\//, `:${port}/`));
    await new Promise(r => pws.addEventListener('open', r));
    pws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `[...document.querySelectorAll('button')].find(b => /Allow Access/i.test(b.innerText||''))?.click()` } }));
    await new Promise(r => setTimeout(r, 1500));
    pws.close(); cleared++;
  }
  console.log(JSON.stringify({ cleared }));
  process.exit(0);
}
// A first-join permission prompt opens as its OWN target, not a node in the main page. Anything
// driving Signal has to know that or it hangs forever waiting on a modal it cannot see.
const page = list.find(t => t.type === 'page' && t.url.includes('background.html'));
if (!page) { console.error('no background.html target; targets: ' + list.map(t => t.url).join(', ')); process.exit(3); }

const ws = new WebSocket(page.webSocketDebuggerUrl.replace(/:\d+\//, `:${port}/`));
let id = 0;
const send = (method, params) => new Promise(res => {
  const myId = ++id;
  const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { ws.removeEventListener('message', h); res(m); } };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: myId, method, params }));
});

ws.addEventListener('open', async () => {
  if (cmd === 'init') {
    // The bot's model: install the camera patch BEFORE any app code runs, then reload. Signal
    // enumerates video inputs once at startup and caches the result in Redux, so a HUD injected
    // into a live page patches enumerateDevices too late — Signal already believes there is no
    // camera and never calls getUserMedia, leaving the tile showing an avatar. This is the
    // CDP equivalent of Playwright's addInitScript.
    const src = await (await import('node:fs/promises')).readFile(arg, 'utf8');
    await send('Page.enable', {});
    await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    await send('Page.reload', {});
    console.log(JSON.stringify({ initScript: arg, reloaded: true }));
    ws.close(); process.exit(0);
  }
  if (cmd === 'shot') {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) { console.error('screenshot failed: ' + JSON.stringify(shot).slice(0, 300)); process.exit(4); }
    await (await import('node:fs/promises')).writeFile(arg, Buffer.from(shot.result.data, 'base64'));
    console.log(arg);
  } else {
    const expr = arg === '-e' ? arg2 : await (await import('node:fs/promises')).readFile(arg, 'utf8');
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) { console.error('EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500)); process.exit(5); }
    console.log(JSON.stringify(r.result?.result?.value ?? null));
  }
  ws.close(); process.exit(0);
});
