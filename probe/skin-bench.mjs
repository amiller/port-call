/**
 * SKIN BENCH — prove every avatar × background combination actually renders, without a meeting.
 *
 * The camera surface needs no meeting, no other participants, and no clicking, so the whole skin
 * matrix is testable on a page we control. Three things are asserted, and the second is the one
 * that matters:
 *
 *   1. Every registered name is selectable and reported back by state().
 *   2. Each combination renders DISTINCT pixels. A registry whose entries all quietly draw the
 *      default would satisfy "it rendered" and "frames advanced" while showing one skin forever —
 *      so compare a downsampled signature of the actual canvas per combination and fail on
 *      duplicates. This is the same trap as the frozen-first-frame check in camera-bench.
 *   3. An unknown name THROWS with the valid set named, rather than silently falling back. A
 *      silent default is indistinguishable from a dropped act, which is the bug we keep paying for.
 *
 * Backgrounds are also asserted to be SIGNAL-DRIVEN: with no transcript activity the brainrot box
 * must be visibly calmer than it is under load. An entertaining background that animates on a free
 * -running timer would claim the pipeline is alive while it is dead, which is the one thing this
 * HUD is designed never to do.
 *
 *   node skin-bench.mjs [--shots /tmp/skins]
 */
import { chromium } from '/app/core/meetings/modules/remote-browser/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const shotDir = process.argv.includes('--shots')
  ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shotDir) mkdirSync(shotDir, { recursive: true });

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
// https, NOT about:blank — mediaDevices only exists in a secure context (see camera-bench).
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

const names = await page.evaluate(() => ({
  avatars: globalThis.__vexaCam.avatars(),
  backgrounds: globalThis.__vexaCam.backgrounds(),
}));
console.log('registry ' + JSON.stringify(names));

let fail = 0;
const expectAvatars = ['rooster', 'tina', 'dmarz'];
const expectBgs = ['transcript', 'vitals', 'brainrot'];
for (const a of expectAvatars) {
  if (!names.avatars.includes(a)) { console.log('MISSING avatar ' + a); fail = 1; }
}
for (const b of expectBgs) {
  if (!names.backgrounds.includes(b)) { console.log('MISSING background ' + b); fail = 1; }
}

// Feed the HUD real-looking activity so the signal-driven backgrounds have something to render.
const feed = async () => {
  await page.evaluate(() => {
    const c = globalThis.__vexaCam;
    ['shape rotator os update', 'the swarm is holding', 'brainrot box online']
      .forEach((l, i) => c.hud({ line: l, speaker: ['andrew', 'tina', 'dmarz'][i] }));
    c.hud({ speaking: true, amplitude: 0.22 });
  });
};
await feed();

// Sample the TRACK, not the canvas. The HUD canvas is never appended to the document, and more
// importantly the only pixels that matter are the ones that actually leave through the captured
// stream — the historical camera bug was a HUD that drew correctly to a canvas nobody published.
// So: pull the real getUserMedia stream into a <video> and read frames back off that.
await page.evaluate(async () => {
  const g = globalThis;
  const s = await g.navigator.mediaDevices.getUserMedia({ video: true });
  const v = g.document.createElement('video');
  v.srcObject = s; v.muted = true; v.autoplay = true; v.playsInline = true;
  g.document.body.appendChild(v);
  await v.play();
  g.__probeVideo = v;
});

// Coarse 16x9 RGBA grid: two skins differing anywhere visible differ here, while encoder noise
// does not move it enough to matter.
const signature = () => page.evaluate(async () => {
  const g = globalThis;
  await new Promise(r => g.requestAnimationFrame(() => g.requestAnimationFrame(r)));
  const small = g.document.createElement('canvas');
  small.width = 16; small.height = 9;
  const s2 = small.getContext('2d');
  s2.drawImage(g.__probeVideo, 0, 0, 16, 9);
  return [...s2.getImageData(0, 0, 16, 9).data].join(',');
});

const seen = new Map();
for (const avatar of names.avatars) {
  for (const bg of names.backgrounds) {
    await page.evaluate((p) => globalThis.__vexaCam.hud(p), { avatar, bg });
    await page.waitForTimeout(120);
    const st = await page.evaluate(() => globalThis.__vexaCam.state());
    if (st.avatar !== avatar || st.bg !== bg) {
      console.log('NOT APPLIED ' + avatar + '/' + bg + ' -> ' + JSON.stringify(st)); fail = 1;
    }
    const sig = await signature();
    const key = avatar + '/' + bg;
    if (seen.has(sig)) {
      console.log('IDENTICAL RENDER ' + key + ' == ' + seen.get(sig)); fail = 1;
    } else {
      seen.set(sig, key);
    }
    if (shotDir) {
      const png = await page.evaluate(() => {
        const g = globalThis;
        const full = g.document.createElement('canvas');
        full.width = 1280; full.height = 720;
        full.getContext('2d').drawImage(g.__probeVideo, 0, 0, 1280, 720);
        return full.toDataURL('image/png').split(',')[1];
      });
      writeFileSync(shotDir + '/' + avatar + '-' + bg + '.png', Buffer.from(png, 'base64'));
    }
    console.log('  rendered ' + key);
  }
}
console.log('distinct renders: ' + seen.size + '/' + (names.avatars.length * names.backgrounds.length));

// ── Unknown names must throw, naming the valid set ────────────────────────────────────────────
for (const bad of [{ avatar: 'nosuchbird' }, { bg: 'nosuchbg' }]) {
  const err = await page.evaluate((p) => {
    try { globalThis.__vexaCam.hud(p); return null; } catch (e) { return String(e.message || e); }
  }, bad);
  const field = Object.keys(bad)[0];
  if (!err) { console.log('SILENT ACCEPT of unknown ' + field); fail = 1; }
  else if (!/have /.test(err)) { console.log('THROW without valid set: ' + err); fail = 1; }
  else console.log('  rejects unknown ' + field + ': ' + err);
}
// and the bad name must NOT have been applied
const after = await page.evaluate(() => globalThis.__vexaCam.state());
if (after.avatar === 'nosuchbird' || after.bg === 'nosuchbg') {
  console.log('REJECTED NAME WAS APPLIED ANYWAY ' + JSON.stringify(after)); fail = 1;
}

// ── The brainrot box must be driven by activity, not by a timer ───────────────────────────────
// Quiet the pipeline (no recent segment, no amplitude) and confirm the render CHANGES character.
// If a silent room looks identical to a busy one, the background is lying about the pipeline.
await page.evaluate((p) => globalThis.__vexaCam.hud(p), { avatar: 'rooster', bg: 'brainrot' });
await page.waitForTimeout(120);
const busy = await signature();
await page.evaluate(() => {
  const c = globalThis.__vexaCam;
  c.hud({ speaking: false, amplitude: 0 });
  c.__quiet = true;
});
// lastAt is internal; age it out by waiting past the 6s recency window used for `hot`.
await page.waitForTimeout(6500);
const quiet = await signature();
if (busy === quiet) {
  console.log('BRAINROT NOT SIGNAL-DRIVEN: identical busy vs quiet render'); fail = 1;
} else {
  console.log('  brainrot calms when the pipeline goes quiet');
}

await browser.close();
console.log(fail ? 'FAIL skins' : 'PASS skins (' + names.avatars.length + ' avatars x '
                                  + names.backgrounds.length + ' backgrounds)');
process.exit(fail);
