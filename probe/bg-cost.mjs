/**
 * BACKGROUND COST — does each camera background have headroom against the frame budget?
 *
 * The budget is one vsync interval, 16.6ms (see probe/gl-budget.mjs, which measured the WebGL
 * composite path and found a full-resolution blit alone eats ~7.4ms of it). These are the 2D
 * backgrounds, so the expectation is that they are nearly free — but "nearly free" is a claim,
 * and this is the measurement behind it.
 *
 * Method: select a background, then count frames the HUD actually rendered over a wall-clock
 * window. This deliberately does NOT report a milliseconds-per-frame figure: rAF is vsync-locked
 * at 60Hz, so anything inside the budget reports exactly 60fps and 1000/fps would be the vsync
 * interval rather than the work done. What this can prove is HEADROOM — the track publishes at
 * 30fps, so a background rendering at 60 has at least 2x spare and is not the thing to optimise.
 * To attribute actual milliseconds to a specific draw, use gl-budget.mjs, which loads the frame
 * heavily enough that draw cost becomes the binding constraint and is therefore measurable.
 *
 *   node bg-cost.mjs
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
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

// Load the HUD up with realistic transcript content: brainrot's cost scales with how many words
// it has to lay out, so measuring it on an empty pipeline would flatter it.
await page.evaluate(() => {
  const c = globalThis.__vexaCam;
  ['shape rotator os update meeting', 'the swarm is holding steady today',
   'brainrot box online and rendering'].forEach((l, i) =>
    c.hud({ line: l, speaker: ['andrew', 'tina', 'dmarz'][i] }));
  c.hud({ speaking: true, amplitude: 0.3 });
});

const measure = async (bg) => {
  await page.evaluate((b) => globalThis.__vexaCam.hud({ bg: b }), bg);
  await page.waitForTimeout(400);                       // let it settle on the new background
  return page.evaluate(async () => {
    const cam = globalThis.__vexaCam;
    // Frames the HUD actually rendered over a wall-clock window: this is the number that decides
    // whether the published track keeps up, and it cannot be gamed by a cheap-looking draw call.
    const t0 = performance.now(), f0 = cam.frames();
    await new Promise((r) => setTimeout(r, 3000));
    const t1 = performance.now(), f1 = cam.frames();
    return { fps: (f1 - f0) / ((t1 - t0) / 1000), frames: f1 - f0 };
  });
};

const REPS = 3;
const results = {};
for (const bg of await page.evaluate(() => globalThis.__vexaCam.backgrounds())) {
  const runs = [];
  for (let i = 0; i < REPS; i++) runs.push((await measure(bg)).fps);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const sd = Math.sqrt(runs.reduce((a, b) => a + (b - mean) ** 2, 0) / runs.length);
  // Report HEADROOM, not ms/frame. rAF is vsync-locked at 60Hz, so a background comfortably inside
  // the budget reports exactly 60fps and 1000/fps is just the vsync interval — quoting that as a
  // draw cost would be reporting the clock rather than the work, the same tautology-as-measurement
  // trap that let a timer-driven beak pass for a week.
  results[bg] = { renderFps: +mean.toFixed(1), sd: +sd.toFixed(2),
                  vsyncCapped: mean > 58, headroomVsTrack: +(mean / 30).toFixed(2) + 'x' };
  console.log(bg.padEnd(12) + JSON.stringify(results[bg]));
}

await browser.close();

// The camera publishes at 30fps. Anything rendering at 60 has the whole budget spare; the failure
// we care about is a background that cannot even feed 30.
const floor = 30;
const bad = Object.entries(results).filter(([, r]) => r.renderFps < floor);
bad.forEach(([bg, r]) => console.log('FAIL ' + bg + ' renders at ' + r.renderFps
  + 'fps, under the ' + floor + 'fps the track publishes at'));
console.log(bad.length ? 'FAIL background cost' : 'PASS background cost (all >= ' + floor + 'fps render)');
process.exit(bad.length ? 1 : 0);
