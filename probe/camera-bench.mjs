/**
 * CAMERA BENCH — prove the virtual camera without a meeting, a bot, or a human.
 *
 * The camera surface is just "getUserMedia returns a canvas stream we control". That is testable
 * on about:blank: install the same init script the bot installs, ask for a video track the way
 * Meet would, and check the track is live, correctly sized, and ADVANCING (a frozen first frame
 * would satisfy a naive check).
 *
 * Extended to assert the three speaking states render distinguishably:
 *   - idle (closed beak)
 *   - winding-up (throat-clearing chitter)
 *   - speaking (beak opens with amplitude)
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
  await new Promise(r => setTimeout(r, 1500));
  const f2 = g.__vexaCam?.frames() ?? -1;
  // getDisplayMedia is the screenshare path — same patch, same canvas, no Chrome picker.
  let display = null;
  try {
    const ds = await g.navigator.mediaDevices.getDisplayMedia({ video: true });
    const dt = ds.getVideoTracks()[0];
    display = { readyState: dt.readyState, ...dt.getSettings() };
  } catch (e) { display = { error: String(e.message ?? e) }; }
  return { hasCam: !!g.__vexaCam, trackLabel: t.label, readyState: t.readyState,
           width: st.width, height: st.height, frameDelta: f2 - f1, display };
});

// ── Speak-state test: MEASURE THE PIXELS, not the frame counter ─────────────────────────────────
// A frame counter advances whether or not the state machine exists, so "frames went up in each
// state" passes with the whole feature deleted — it did, before this was rewritten. `__vexaCam`
// exposes no derived state either, so the only honest witness is the rendered image.
//
// The rooster's OPEN beak is the one thing on the canvas painted #c9821a (201,130,26), and it is
// drawn ONLY when the computed beak opening exceeds 1px, with an area that grows with the opening.
// Counting those pixels therefore reads the state machine and the amplitude→beak map directly:
// idle must show none, and louder audio must show strictly more than quieter audio.
const BEAK = [201, 130, 26];
const stateTest = await page.evaluate(async ([r, gr, b]) => {
  const g = globalThis;
  const cam = g.__vexaCam;
  if (!cam) return { error: 'no camera' };

  const vid = g.document.createElement('video');
  vid.muted = true; vid.srcObject = cam.stream;
  await vid.play();
  const scratch = g.document.createElement('canvas');
  scratch.width = 1280; scratch.height = 720;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  const nextFrame = () => new Promise((res) => g.requestAnimationFrame(res));

  // The beak oscillates (bob/sway/chitter), so one sample is noise. Take the MAX open-beak area
  // over a ~350ms window: that is the peak opening the state actually reached. Skip the first few
  // frames — the <video> lags the canvas, and a MAX taken across the transition would otherwise
  // report the OUTGOING state's beak.
  const peakBeakPixels = async (ms) => {
    let peak = 0;
    for (let i = 0; i < 5; i++) await nextFrame();
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await nextFrame();
      sctx.drawImage(vid, 0, 0, 1280, 720);
      const d = sctx.getImageData(0, 0, 1280, 720).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) < 12 && Math.abs(d[i + 1] - gr) < 12 && Math.abs(d[i + 2] - b) < 12) n++;
      }
      if (n > peak) peak = n;
    }
    return peak;
  };

  // Pin the avatar: #c9821a is the ROOSTER's open beak. Pinning keeps this assertion meaningful
  // if the default avatar changes (older HUD builds have no avatar registry and ignore this).
  cam.hud({ avatar: 'rooster' });

  cam.hud({ speaking: false, windingUp: false, amplitude: 0 });
  const idle = await peakBeakPixels(350);

  cam.hud({ windingUp: true, speaking: false });
  const winding = await peakBeakPixels(350);

  cam.hud({ windingUp: false, speaking: true, amplitude: 0.15 });   // moderate RMS
  const quiet = await peakBeakPixels(350);

  cam.hud({ speaking: true, amplitude: 0.35 });                     // loud RMS → wider beak
  const loud = await peakBeakPixels(350);

  cam.hud({ speaking: false, windingUp: false });
  const afterSpeak = await peakBeakPixels(350);

  // SECOND utterance. The wind-up chitter is windowed on frames since the wind-up began, and the
  // stamp used to be set only when it was still zero — so it latched on the first speak of the
  // process and every wind-up after that rendered as idle. One speak cannot catch that; this is
  // the regression witness, and it must match the first wind-up rather than merely being non-zero.
  cam.hud({ windingUp: true, speaking: false });
  const winding2 = await peakBeakPixels(350);
  cam.hud({ windingUp: false, speaking: false });

  return { idle, winding, quiet, loud, afterSpeak, winding2, frames: cam.frames() };
}, BEAK);

await browser.close();

const ok = out.hasCam && out.readyState === 'live' && out.frameDelta > 10 && out.width > 0
         && out.display?.readyState === 'live';
console.log(JSON.stringify(out, null, 1));
console.log(JSON.stringify(stateTest, null, 1));

// idle draws no open beak; winding-up chitters; speaking opens it; LOUDER OPENS IT WIDER (this is
// the assertion that a timer-driven beak cannot satisfy); and speaking:false closes it again.
const states = !!stateTest && !stateTest.error
            && stateTest.idle === 0
            && stateTest.winding > 0
            && stateTest.quiet > 0
            && stateTest.loud > stateTest.quiet
            && stateTest.afterSpeak === 0
            && stateTest.winding2 > 0;   // the wind-up cue survives past the first utterance

console.log(ok ? 'PASS camera' : 'FAIL camera');
console.log(states ? 'PASS speak states (beak tracks amplitude)' : 'FAIL speak states (beak does not track amplitude)');
process.exit(ok && states ? 0 : 1);
