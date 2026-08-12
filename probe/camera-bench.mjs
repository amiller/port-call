/**
 * CAMERA BENCH — prove the virtual camera without a meeting, a bot, or a human.
 *
 * The camera surface is just "getUserMedia returns a canvas stream we control". That is testable
 * on about:blank: install the same init script the bot installs, ask for a video track the way
 * Meet would, and check the track is live, correctly sized, and ADVANCING (a frozen first frame
 * would satisfy a naive check).
 *
 *   node camera-bench.mjs
 */
import { chromium } from '/app/core/meetings/modules/remote-browser/node_modules/playwright/index.mjs';

const { CAMERA_INIT_SCRIPT } = await import('/app/core/meetings/services/bot/dist/camera.js');

const browser = await chromium.launch({
  executablePath: '/ms-playwright/chromium-1194/chrome-linux/chrome',
  headless: false,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--in-process-gpu',
         '--use-fake-ui-for-media-stream', '--window-position=1200,0', '--window-size=600,400'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(CAMERA_INIT_SCRIPT);
const page = await ctx.newPage();
// https, NOT about:blank: navigator.mediaDevices only exists in a SECURE CONTEXT, so on
// about:blank the init script's getUserMedia patch silently skips and the bench tests nothing.
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const g = globalThis;
  g.__vexaCam?.set('E2E', 'camera bench');
  const s = await g.navigator.mediaDevices.getUserMedia({ video: true });
  const t = s.getVideoTracks()[0];
  const st = t.getSettings();
  const f1 = g.__vexaCam?.frames() ?? -1;
  await new Promise((r) => setTimeout(r, 1500));
  const f2 = g.__vexaCam?.frames() ?? -1;
  // getDisplayMedia is the screenshare path — same patch, same canvas, no Chrome picker.
  let display = null;
  try {
    const ds = await g.navigator.mediaDevices.getDisplayMedia({ video: true });
    const dt = ds.getVideoTracks()[0];
    display = { readyState: dt.readyState, ...dt.getSettings() };
  } catch (e) { display = { error: String(e.message || e) }; }
  return { hasCam: !!g.__vexaCam, trackLabel: t.label, readyState: t.readyState,
           width: st.width, height: st.height, frameDelta: f2 - f1, display };
});

await browser.close();

const ok = out.hasCam && out.readyState === 'live' && out.frameDelta > 10 && out.width > 0
         && out.display?.readyState === 'live';
console.log(JSON.stringify(out, null, 1));
console.log(ok ? 'PASS camera' : 'FAIL camera');
process.exit(ok ? 0 : 1);
