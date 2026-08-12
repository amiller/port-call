/**
 * SURFACE BENCH — run the REAL controllers against a Meet-shaped DOM. No meeting, no human.
 *
 * This imports the same compiled controllers the bot runs (dist/{chat,camera,reactions,
 * screen-share}.js) and drives them against probe/mock-meet.html, whose selectors come from a live
 * aria-label dump of Google Meet. It therefore exercises the actual selector strings, the toolbar
 * wake logic, and the getUserMedia/getDisplayMedia patch — everything except Meet's own DOM drift.
 *
 * It also reproduces the two behaviours that broke real automation, so a regression is caught here
 * rather than in a meeting: the toolbar auto-hides after 3s, and chat content lives in data-*
 * attributes with hover UI polluting textContent.
 *
 *   node surface-bench.mjs
 */
import { chromium } from '/app/core/meetings/modules/remote-browser/node_modules/playwright/index.mjs';

const D = '/app/core/meetings/services/bot/dist';
const { CAMERA_INIT_SCRIPT, createCameraController } = await import(`${D}/camera.js`);
const { createChatController } = await import(`${D}/chat.js`);
const { createReactionController } = await import(`${D}/reactions.js`);
const { createScreenShareController } = await import(`${D}/screen-share.js`);

const MOCK = 'https://mock.invalid/mock-meet.html';   // routed to the local file below
let pass = 0, fail = 0;
const ok = (n, extra = '') => { console.log(`PASS ${n}${extra ? ' — ' + extra : ''}`); pass++; };
const bad = (n, e) => { console.log(`FAIL ${n} — ${e}`); fail++; };

const browser = await chromium.launch({
  executablePath: '/ms-playwright/chromium-1194/chrome-linux/chrome',
  headless: false,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--in-process-gpu',
         '--use-fake-ui-for-media-stream', '--window-position=0,0', '--window-size=1600,900'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(CAMERA_INIT_SCRIPT);
// Serve the mock over https so navigator.mediaDevices exists (secure-context requirement — the
// same trap that made an about:blank bench silently prove nothing). charset=utf-8 is REQUIRED:
// without it the emoji in the reaction picker decode as Latin-1 mojibake ("Send ðŸŽ‰") and an
// emoji match fails for a reason that looks like a controller bug.
const html = await (await import('node:fs/promises')).readFile('/tmp/mock-meet.html', 'utf8');
await ctx.route('**/mock-meet.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
const page = await ctx.newPage();
// Capture what the controllers print — their [chat]/[share] lines are the real oracle, the same
// lines e2e.sh greps out of the bot log in production.
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
await page.goto(MOCK, { waitUntil: 'domcontentloaded' });

const idle = () => page.waitForTimeout(4000);   // let the toolbar auto-hide: the real failure mode

// ── chat ────────────────────────────────────────────────────────────────────────────────────
const chat = createChatController(page);
try {
  await idle();
  await chat.send('surface bench probe');
  // Read the way real Meet requires: container text minus nested controls (no data-message-text).
  const msgs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('div[data-message-id]'))
      .filter((n) => !n.closest('button'))
      .map((n) => { const c = n.cloneNode(true);
                    c.querySelectorAll('button,[role="button"],[aria-label]').forEach((b) => b.remove());
                    return (c.textContent || '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean));
  msgs.includes('surface bench probe')
    ? ok('chat_send', `${msgs.length} message(s)`)
    : bad('chat_send', `not found: ${JSON.stringify(msgs)}`);
} catch (e) { bad('chat_send', e.message); }

try {
  await chat.read();   // must not throw, and must not return hover-UI pollution
  // The oracle that matters: the controller's OWN output must not carry Meet's hover UI.
  const line = logs.filter((l) => l.startsWith('[chat] ') && l.includes('messages')).pop() || '';
  const clean = line.includes('surface bench probe') && !line.includes('Pin message');
  clean ? ok('chat_read', 'controller output clean of hover UI') : bad('chat_read', line.slice(0, 120));
} catch (e) { bad('chat_read', e.message); }

// ── camera ──────────────────────────────────────────────────────────────────────────────────
try {
  await idle();
  await createCameraController(page).show('E2E', 'camera');
  const st = await page.evaluate(async () => {
    const t = window.__mock.camTrack;
    return t ? { live: t.readyState === 'live', ...t.getSettings() } : null;
  });
  st?.live && st.width > 0 ? ok('camera', `${st.width}x${st.height} live`) : bad('camera', JSON.stringify(st));
} catch (e) { bad('camera', e.message); }

// ── screenshare ─────────────────────────────────────────────────────────────────────────────
try {
  await idle();
  await createScreenShareController(page, 'google_meet').share('E2E share');
  const st = await page.evaluate(() => {
    const t = window.__mock.shareTrack;
    return { presenting: window.__mock.presenting, live: t ? t.readyState === 'live' : false,
             w: t ? t.getSettings().width : 0 };
  });
  st.presenting && st.live ? ok('screen_share', `${st.w}px live, presenting`) : bad('screen_share', JSON.stringify(st));
} catch (e) { bad('screen_share', e.message); }

// ── reactions ───────────────────────────────────────────────────────────────────────────────
try {
  await idle();
  await createReactionController(page).send('🎊');
  const r = await page.evaluate(() => window.__mock.reactions);
  r.includes('🎊') ? ok('reaction', JSON.stringify(r)) : bad('reaction', `picker got ${JSON.stringify(r)}`);
} catch (e) { bad('reaction', e.message); }

// ── stop share ──────────────────────────────────────────────────────────────────────────────
try {
  await createScreenShareController(page, 'google_meet').stop();
  const p = await page.evaluate(() => window.__mock.presenting);
  p === false ? ok('screen_share_stop') : bad('screen_share_stop', 'still presenting');
} catch (e) { bad('screen_share_stop', e.message); }

await browser.close();
console.log(`---- ${pass} passed, ${fail} failed ----`);
process.exit(fail === 0 ? 0 : 1);
