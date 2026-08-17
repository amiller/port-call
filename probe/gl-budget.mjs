/**
 * GL BUDGET — how much rendering can the virtual camera actually afford?
 *
 * Gates issues #4/#5. The plan for camera backgrounds is: render WebGL to an OFFSCREEN canvas and
 * drawImage it into the 2D capture canvas as the first call in draw(). The capture canvas must stay
 * 2D (captureStream + the getUserMedia patch + screenshare all key off its identity), so every frame
 * pays a GL render AND a GPU->2D-canvas blit. On fractal there is no GPU: chromium runs with
 * --disable-gpu --in-process-gpu, so that is SwiftShader, on the CPU.
 *
 * This measures the REAL path, not a mock: it installs the bot's own CAMERA_INIT_SCRIPT, grabs the
 * canvas the HUD created, and splices the composite into the HUD's own draw loop by swapping the
 * full-frame background fillRect for renderGL()+drawImage. Achieved fps is read from
 * __vexaCam.frames() deltas over a wall-clock window — the frame counter that feeds the track — not
 * from a rAF tick count of our own.
 *
 * Cost ladder is octave count in a value-noise fbm: OCT=0 is a trivial shader (uv -> colour),
 * each octave is ~4 hashes + 3 mixes, so ~25-30 ALU ops per pixel per octave.
 *
 *   DISPLAY=:98 node gl-budget.mjs          # full sweep
 *   REPS=5 WINDOW=6000 node gl-budget.mjs
 */
import { readFileSync } from 'node:fs';
import { chromium } from '/app/core/meetings/modules/remote-browser/node_modules/playwright/index.mjs';

const { CAMERA_INIT_SCRIPT } = await import('/app/core/meetings/services/bot/dist/camera.js');

const REPS = Number(process.env.REPS ?? 4);
const WINDOW = Number(process.env.WINDOW ?? 5000);
const WARMUP = Number(process.env.WARMUP ?? 1200);
const load = () => Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

// Recorded before CAMERA_INIT_SCRIPT so the FIRST canvas created (the HUD's capture canvas) is ours.
// Also wraps rAF so every draw() call is timed: fps alone is vsync-capped at 60 and reports "fine"
// right up until it collapses, whereas ms/frame against the 33.3ms budget for 30fps is the number
// the design actually needs.
const grabCanvas = () => {
  const g = globalThis;
  const ce = g.document.createElement.bind(g.document);
  g.document.createElement = (n, ...a) => {
    const e = ce(n, ...a);
    if (String(n).toLowerCase() === 'canvas' && !g.__glbCapture) g.__glbCapture = e;
    return e;
  };
  g.__glbT = [];
  const raf = g.requestAnimationFrame.bind(g);
  g.requestAnimationFrame = (cb) => raf((ts) => {
    const a = performance.now(); cb(ts); g.__glbT.push(performance.now() - a);
  });
};

const browser = await chromium.launch({
  executablePath: '/ms-playwright/chromium-1194/chrome-linux/chrome',
  headless: false,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--in-process-gpu',
         '--use-fake-ui-for-media-stream', '--window-position=1200,0', '--window-size=600,400'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(grabCanvas);
await ctx.addInitScript(CAMERA_INIT_SCRIPT);
const page = await ctx.newPage();
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

const env = await page.evaluate(async () => {
  const g = globalThis;
  await g.navigator.mediaDevices.getUserMedia({ video: true });   // publish the track, as Meet does

  const cap = g.__glbCapture;
  const c2 = cap.getContext('2d');
  const glc = g.document.createElement('canvas');
  const gl = glc.getContext('webgl2', { antialias: false, depth: false, alpha: false,
                                        preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');

  const VS = '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}';
  const FS = (oct) => `#version 300 es
precision highp float;
uniform vec2 R; uniform float T;
out vec4 o;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
void main(){
  vec2 uv=gl_FragCoord.xy/R;
  float v=0.0,a=0.5; vec2 q=uv*4.0+T*0.1;
  for(int k=0;k<${oct};k++){ v+=a*n(q); q*=2.03; q+=vec2(T*0.03,-T*0.02); a*=0.5; }
  o=vec4(uv.x*0.2+v, uv.y*0.2+v*0.8, 0.35+v*0.6, 1.0);
}`;
  const mk = (oct) => {
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS(oct)));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return { p, R: gl.getUniformLocation(p, 'R'), T: gl.getUniformLocation(p, 'T') };
  };
  const progs = {}; for (const o of [0, 1, 2, 4, 8, 16, 32]) progs[o] = mk(o);   // 64 is NOT here: SwiftShader
  // spends minutes JIT-compiling a fully unrolled 64-iteration fbm loop, which blocks the page.

  // cfg.oct: null = no GL at all (today's flat fill). cfg.every: render GL every Nth draw.
  const cfg = g.__glb = { oct: null, w: 1280, h: 720, every: 1, tick: 0, t0: performance.now() };
  const renderGL = () => {
    if (glc.width !== cfg.w || glc.height !== cfg.h) { glc.width = cfg.w; glc.height = cfg.h; }
    const pr = progs[cfg.oct];
    gl.viewport(0, 0, cfg.w, cfg.h);
    gl.useProgram(pr.p);
    gl.uniform2f(pr.R, cfg.w, cfg.h);
    gl.uniform1f(pr.T, (performance.now() - cfg.t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Splice the composite into the HUD's OWN draw loop: its first call is the full-frame background
  // fillRect, which is exactly the call the WebGL background is meant to replace.
  const orig = c2.fillRect.bind(c2);
  c2.fillRect = (x, y, w, h) => {
    if (cfg.oct !== null && x === 0 && y === 0 && w === 1280 && h === 720) {
      if (cfg.tick++ % cfg.every === 0) renderGL();
      c2.drawImage(glc, 0, 0, 1280, 720);
    } else orig(x, y, w, h);
  };

  g.__glbMeasure = async (ms) => {
    g.__glbT.length = 0;
    const f0 = g.__vexaCam.frames(), t0 = performance.now();
    await new Promise(r => setTimeout(r, ms));
    const fps = (g.__vexaCam.frames() - f0) / ((performance.now() - t0) / 1000);
    const d = g.__glbT.slice().sort((a, b) => a - b);
    return { fps, msMed: d[d.length >> 1] ?? -1, msP95: d[Math.floor(d.length * 0.95)] ?? -1 };
  };
  return { canvas: cap.width + 'x' + cap.height,
           renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
           vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) };
});
console.log('# env ' + JSON.stringify(env));
console.log('# reps=' + REPS + ' window=' + WINDOW + 'ms warmup=' + WARMUP + 'ms');

const CONDITIONS = [
  { label: 'a  baseline 2D only (today)',        oct: null, w: 1280, h: 720, every: 1 },
  { label: 'b  GL trivial      1280x720',        oct: 0,    w: 1280, h: 720, every: 1 },
  { label: 'c1 GL fbm  1 oct   1280x720',        oct: 1,    w: 1280, h: 720, every: 1 },
  { label: 'c2 GL fbm  2 oct   1280x720',        oct: 2,    w: 1280, h: 720, every: 1 },
  { label: 'c4 GL fbm  4 oct   1280x720',        oct: 4,    w: 1280, h: 720, every: 1 },
  { label: 'd8 GL fbm  8 oct   1280x720',        oct: 8,    w: 1280, h: 720, every: 1 },
  { label: 'd16 GL fbm 16 oct  1280x720',        oct: 16,   w: 1280, h: 720, every: 1 },
  { label: 'd32 GL fbm 32 oct  1280x720',        oct: 32,   w: 1280, h: 720, every: 1 },
  { label: 'r  GL fbm  4 oct    960x540 upscale', oct: 4,   w: 960,  h: 540, every: 1 },
  { label: 'r  GL fbm  4 oct    640x360 upscale', oct: 4,   w: 640,  h: 360, every: 1 },
  { label: 'r  GL fbm  4 oct    320x180 upscale', oct: 4,   w: 320,  h: 180, every: 1 },
  { label: 'r  GL fbm  8 oct    640x360 upscale', oct: 8,   w: 640,  h: 360, every: 1 },
  { label: 'r  GL fbm 16 oct    320x180 upscale', oct: 16,  w: 320,  h: 180, every: 1 },
  { label: 'h  GL fbm  4 oct   1280x720 every2', oct: 4,    w: 1280, h: 720, every: 2 },
  { label: 'h  GL fbm  8 oct   1280x720 every2', oct: 8,    w: 1280, h: 720, every: 2 },
  { label: 'h  GL fbm  8 oct   1280x720 every4', oct: 8,    w: 1280, h: 720, every: 4 },
  // isolate the blit: trivial shader, so the whole cost is GL->2D drawImage at that source size
  { label: 'x  GL trivial       640x360 upscale', oct: 0,   w: 640,  h: 360, every: 1 },
  { label: 'x  GL trivial       320x180 upscale', oct: 0,   w: 320,  h: 180, every: 1 },
  // headroom at reduced res
  { label: 'x  GL fbm 32 oct    640x360 upscale', oct: 32,  w: 640,  h: 360, every: 1 },
  { label: 'x  GL fbm 32 oct    320x180 upscale', oct: 32,  w: 320,  h: 180, every: 1 },
];

const PICK = process.env.ONLY ? CONDITIONS.filter(c => c.label.includes(process.env.ONLY)) : CONDITIONS;

const stat = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  return { mean: m, sd, min: Math.min(...xs), max: Math.max(...xs) };
};

const rows = [];
for (const c of (process.env.SWEEP === '0' ? [] : PICK)) {
  await page.evaluate(([oct, w, h, every]) => Object.assign(globalThis.__glb, { oct, w, h, every, tick: 0 }),
                      [c.oct, c.w, c.h, c.every]);
  const fps = [], ms = [], p95 = [], loads = [];
  for (let i = 0; i < REPS; i++) {
    await page.evaluate((w) => new Promise(r => setTimeout(r, w)), WARMUP);
    loads.push(load());
    const r = await page.evaluate((w) => globalThis.__glbMeasure(w), WINDOW);
    fps.push(r.fps); ms.push(r.msMed); p95.push(r.msP95);
  }
  const s = stat(fps), sm = stat(ms), sp = stat(p95), sl = stat(loads);
  rows.push({ ...c, fps: s, ms: sm, p95: sp, samples: fps, msSamples: ms, load: sl.mean });
  console.log(`${c.label.padEnd(32)} ${s.mean.toFixed(1).padStart(6)} fps ±${s.sd.toFixed(2).padStart(5)} ` +
              `[${s.min.toFixed(1)}–${s.max.toFixed(1)}] | draw ${sm.mean.toFixed(1).padStart(5)}ms ` +
              `±${sm.sd.toFixed(2)} p95 ${sp.mean.toFixed(1)}ms | load ${sl.mean.toFixed(2)}`);
}

// What actually reaches the TRACK. Read straight off one captureStream track with
// MediaStreamTrackProcessor — a <video> + requestVideoFrameCallback also works but costs a
// full-size paint per frame, which perturbs the very thing being measured, and each rep leaked
// another live track onto the same canvas.
const delivered = [];
if (process.env.DELIVERED !== '0') {
  await page.evaluate(async () => {
    const g = globalThis;
    const track = (await g.navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
    const rd = new g.MediaStreamTrackProcessor({ track }).readable.getReader();
    g.__glbN = 0;
    (async () => { for (;;) { const { value, done } = await rd.read(); if (done) return; value.close(); g.__glbN++; } })();
  });
  for (const c of PICK) {
    await page.evaluate(([oct, w, h, every]) => Object.assign(globalThis.__glb, { oct, w, h, every, tick: 0 }),
                        [c.oct, c.w, c.h, c.every]);
    const reps = [];
    for (let i = 0; i < REPS; i++) {
      await page.evaluate((w) => new Promise(r => setTimeout(r, w)), WARMUP);
      reps.push(await page.evaluate(async (ms) => {
        const g = globalThis;
        const n0 = g.__glbN, f0 = g.__vexaCam.frames(), t0 = performance.now();
        await new Promise(r => setTimeout(r, ms));
        const dt = (performance.now() - t0) / 1000;
        return { track: (g.__glbN - n0) / dt, draw: (g.__vexaCam.frames() - f0) / dt };
      }, WINDOW));
    }
    const st = stat(reps.map(r => r.track)), sd = stat(reps.map(r => r.draw));
    delivered.push({ label: c.label, track: st, draw: sd });
    console.log(`# delivered ${c.label.padEnd(32)} track ${st.mean.toFixed(1).padStart(5)} fps ±${st.sd.toFixed(2)} ` +
                `[${st.min.toFixed(1)}–${st.max.toFixed(1)}]  draw ${sd.mean.toFixed(1)} fps  load ${load().toFixed(2)}`);
  }
}

await browser.close();
console.log(JSON.stringify({ env, rows, delivered }, null, 1));
