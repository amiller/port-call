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
 * With --shots it also emits THE ARTIFACT A HUMAN CAN LOOK AT (#57): every combination at every
 * speak state, written as individual frames plus one contact sheet per state. Each cell shows the
 * full 1280x720 canvas AND, boxed beside it, the ~560px band Meet actually crops to — because a
 * sheet of full canvases flatters every avatar and hides exactly the bug #52 fixed.
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
const expectAvatars = ['rooster', 'tina', 'dmarz', 'none'];
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
    console.log('  rendered ' + key);
  }
}
console.log('distinct renders: ' + seen.size + '/' + (names.avatars.length * names.backgrounds.length));

// A contact sheet is a STILL: a canvas frozen after the first paint would produce a perfectly
// good-looking sheet while the published track showed one frame forever. Assert the render loop
// is running before trusting anything below it.
const f0 = await page.evaluate(() => globalThis.__vexaCam.frames());
await page.waitForTimeout(300);
const f1 = await page.evaluate(() => globalThis.__vexaCam.frames());
if (f1 <= f0) { console.log('FROZEN canvas: frames ' + f0 + ' -> ' + f1); fail = 1; }
else console.log('  frames advancing: ' + f0 + ' -> ' + f1);

// ── The artifact (#57) ────────────────────────────────────────────────────────────────────────
// Deliberately AFTER the assertions and gated on --shots: bench.sh runs this file as a pass/fail
// check on every loop, and the sweep is 3x the work. The assertions above are unchanged by it.
const STATES = [
  { name: 'listening',  patch: { speaking: false, windingUp: false, amplitude: 0 } },
  { name: 'winding-up', patch: { speaking: false, windingUp: true, amplitude: 0 } },
  { name: 'speaking',   patch: { speaking: true, windingUp: false, amplitude: 0.34 } },
];
const CROP_X = 360, CROP_W = 560;   // SAFE_W band, mirroring patches/bot-camera.ts

// Every background here is SIGNAL-DRIVEN and decays: swarm fades a word over ~30s, brainrot
// calms when nothing lands, vitals counts up SINCE LAST. A sweep that feeds once and then walks 20
// combinations captures a pipeline going cold — the first sheet showed swarm empty and vitals at
// 13s idle, and read as "these backgrounds are broken" when they were merely stale. Re-feed before
// every capture so each cell shows the same LIVE room, which is the only way cells compare.
const CORPUS = [
  'the swarm is holding shape rotator os update',
  'brainrot box online and the transcript is flowing',
  'shape rotator grants cohort wants a facilitator agent',
  'the swarm keeps the transcript honest about latency',
  'facilitator agent for the rotator cohort meeting',
];
const feedRich = () => page.evaluate((corpus) => {
  const c = globalThis.__vexaCam;
  corpus.forEach((l, i) => c.hud({ line: l, speaker: ['andrew', 'tina', 'dmarz'][i % 3] }));
}, CORPUS);

const grab = (sx, sw, w, h) => page.evaluate(([sx, sw, w, h]) => {
  const g = globalThis;
  const c = g.document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(g.__probeVideo, sx, 0, sw, 720, 0, 0, w, h);
  return c.toDataURL('image/png').split(',')[1];
}, [sx, sw, w, h]);

if (shotDir) {
  for (const st of STATES) {
    await page.evaluate((p) => globalThis.__vexaCam.hud(p), st.patch);
    await page.evaluate(([cols, rows, title]) => {
      const g = globalThis;
      const CW = 240, CH = 135, BW = 105, GAP = 12, LBL = 20, TOP = 34;
      const cw = CW + 6 + BW + GAP, ch = CH + LBL + GAP;
      const c = g.document.createElement('canvas');
      c.width = cols * cw + GAP; c.height = TOP + rows * ch + GAP;
      const x = c.getContext('2d');
      x.fillStyle = '#15151c'; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#e6e6ee'; x.font = 'bold 17px system-ui, sans-serif'; x.textAlign = 'left';
      x.fillText(title, GAP, 23);
      g.__sheet = { c, x, CW, CH, BW, GAP, LBL, TOP, cw, ch };
    }, [names.backgrounds.length, names.avatars.length,
        'skins / ' + st.name + '  —  left: full 1280x720 canvas   right (boxed): the ~560px band Meet crops to']);

    for (const [ai, avatar] of names.avatars.entries()) {
      for (const [bi, bg] of names.backgrounds.entries()) {
        await page.evaluate((p) => globalThis.__vexaCam.hud(p), { avatar, bg });
        await feedRich();
        // Re-stamp the state AFTER feeding: winding-up renders as a ~30-frame chitter measured
        // from windUpStart, so without this it has expired by the time the frame is captured.
        await page.evaluate((p) => globalThis.__vexaCam.hud(p), st.patch);
        await page.waitForTimeout(120);
        const pose = (await page.evaluate(() => globalThis.__vexaCam.state())).pose;
        const stem = shotDir + '/' + st.name + '-' + avatar + '-' + bg;
        writeFileSync(stem + '.png', Buffer.from(await grab(0, 1280, 1280, 720), 'base64'));
        writeFileSync(stem + '-safe.png', Buffer.from(await grab(CROP_X, CROP_W, CROP_W, 720), 'base64'));
        await page.evaluate(([r, col, label]) => {
          const g = globalThis, S = g.__sheet, x = S.x;
          const px = S.GAP + col * S.cw, py = S.TOP + r * S.ch;
          x.drawImage(g.__probeVideo, 0, 0, 1280, 720, px, py, S.CW, S.CH);
          x.drawImage(g.__probeVideo, 360, 0, 560, 720, px + S.CW + 6, py, S.BW, S.CH);
          x.strokeStyle = '#7ce28b'; x.lineWidth = 1;
          x.strokeRect(px + S.CW + 5.5, py + 0.5, S.BW + 1, S.CH);
          x.fillStyle = '#b9b9c8'; x.font = '12px system-ui, sans-serif'; x.textAlign = 'left';
          x.fillText(label, px, py + S.CH + 14);
        }, [ai, bi, avatar + ' / ' + bg + '  (pose: ' + pose + ')']);
      }
    }
    const sheet = await page.evaluate(() => globalThis.__sheet.c.toDataURL('image/png').split(',')[1]);
    writeFileSync(shotDir + '/sheet-' + st.name + '.png', Buffer.from(sheet, 'base64'));
    console.log('  sheet ' + shotDir + '/sheet-' + st.name + '.png');
  }
}

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
