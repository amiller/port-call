/**
 * CAMERA — give the bot a real video feed it controls, without touching desktop capture.
 *
 * Approach: an init-script (installed at launch, BEFORE Meet loads) patches
 * navigator.mediaDevices.getUserMedia so any video request returns a canvas captureStream we own.
 * Turning the camera on in the UI then publishes OUR canvas. The same script also patches
 * getDisplayMedia, so SCREENSHARE presents this canvas too — see screen-share.ts for why every
 * route through Chrome's own capture is a dead end in this image.
 *
 * It also sidesteps the stats problem — we own the track, so frames are measurable at the source
 * rather than through Vexa's __vexa_peer_connections hook, which only wraps connections created
 * after it installs and therefore misses Meet's.
 *
 * `INIT_SCRIPT` must be added via context.addInitScript at launch; the controller only draws and
 * toggles.
 */
import type { Page } from '@vexa/remote-browser';

/** Runs in EVERY page before any site script. Defines the canvas + the getUserMedia patch. */
/**
 * Installed BOTH ways from one source: as a launch init-script (stringified) and re-injected into
 * a live page via page.evaluate(installHud). The second path must pass a FUNCTION, not a string —
 * meet.google.com's CSP blocks page-level eval, so evaluating source text silently did nothing and
 * a rebuilt HUD never reached a bot already in a meeting. Playwright evaluates functions over CDP,
 * which CSP does not gate.
 */
export function installHud(): void {
  const g: any = globalThis as any;
  if (g.__vexaCam) return;
  const cvs = g.document.createElement('canvas');
  cvs.width = 1280; cvs.height = 720;
  const ctx = cvs.getContext('2d');
  // `any`: this function is stringified into the PAGE, where it is plain JS. Typing the drawing
  // state buys nothing and costs a cast on every canvas call.
  const S: any = { title: 'VEXA', sub: '', lines: [] as string[], speaker: '', segments: 0,
                   lastAt: 0, started: Date.now(), frames: 0, speaking: false };
  const W = 1280, H = 720;
  const wrap = (t: any, max: any) => {
    const words = String(t).split(/\s+/); const out = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    if (cur) out.push(cur);
    return out;
  };
  // ── the character ────────────────────────────────────────────────────────────────────────
  // Drawn procedurally rather than loaded as an SVG asset: no fetch, no decode race, and every
  // part is animatable on its own. States are DERIVED, not commanded: "listening" follows recent
  // transcript activity and "speaking" is set by the speak path, so the face cannot lie about what
  // the bot is doing. Swap in richer art later; the state machine is the part worth keeping.
  // (No backticks anywhere in here — this whole script is a template literal.)
  // FRONT-FACING and centred: a profile bird parked at the edge reads as wallpaper, not as a
  // participant. A face looking at the camera from the middle of the frame is what makes a tile
  // in a grid of faces read as "someone is on this call".
  const rooster = (cx: any, cy: any, sc: any, t: any, state: any) => {
    const bob = Math.sin(t / (state === 'listening' ? 7 : 15)) * (state === 'listening' ? 9 : 4);
    const sway = Math.sin(t / 33) * 0.05;
    const bp = t % 240;
    const blink = bp < 7 || (bp > 15 && bp < 21);
    const beak = state === 'speaking' ? Math.abs(Math.sin(t / 4)) * 20 : 0;

    ctx.save();
    ctx.translate(cx, cy + bob); ctx.rotate(sway); ctx.scale(sc, sc);

    // body behind the head
    ctx.fillStyle = '#dfe3ee';
    ctx.beginPath(); ctx.ellipse(0, 200, 150, 120, 0, 0, 7); ctx.fill();

    // comb — three lobes across the top, wobbling
    ctx.fillStyle = '#e0343f';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(-46 + i * 46, -122 + Math.sin(t / 9 + i) * 5, 27, Math.PI, 0);
      ctx.fill();
    }

    // head
    ctx.fillStyle = '#f4f6fb';
    ctx.beginPath(); ctx.ellipse(0, -30, 118, 112, 0, 0, 7); ctx.fill();

    // eyes — both visible, so it is looking AT you
    for (const ex of [-46, 46]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(ex, -46, 30, blink ? 4 : 31, 0, 0, 7); ctx.fill();
      if (!blink) {
        ctx.fillStyle = '#0b0b10';
        const look = state === 'listening' ? Math.sin(t / 18) * 7 : 0;
        ctx.beginPath(); ctx.arc(ex + look, -44, 15, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(ex + look + 5, -50, 5, 0, 7); ctx.fill();
      } else {
        ctx.strokeStyle = '#0b0b10'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(ex - 26, -46); ctx.lineTo(ex + 26, -46); ctx.stroke();
      }
    }

    // beak pointing at the viewer — opens while speaking
    ctx.fillStyle = '#f5a524';
    ctx.beginPath(); ctx.moveTo(-30, 8); ctx.lineTo(30, 8); ctx.lineTo(0, 52); ctx.closePath(); ctx.fill();
    if (beak > 1) {
      ctx.fillStyle = '#c9821a';
      ctx.beginPath(); ctx.moveTo(-24, 12); ctx.lineTo(24, 12); ctx.lineTo(0, 52 + beak); ctx.closePath(); ctx.fill();
    }

    // wattles
    ctx.fillStyle = '#e0343f';
    ctx.beginPath(); ctx.ellipse(-22, 66 + beak * 0.3, 16, 26, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(22, 66 + beak * 0.3, 16, 26, 0, 0, 7); ctx.fill();
    ctx.restore();
  };

  const draw = () => {
    S.frames++;
    const t = S.frames;
    const age = S.lastAt ? Date.now() - S.lastAt : 1e9;
    const hot = age < 6000;
    const state = S.speaking ? 'speaking' : (hot ? 'listening' : 'idle');

    ctx.fillStyle = '#07070c'; ctx.fillRect(0, 0, W, H);

    // activity band
    const puls = hot ? (Math.sin(t / 5) + 1) / 2 : 0;
    ctx.fillStyle = hot ? 'rgba(124,226,139,' + (0.25 + puls * 0.5) + ')' : 'rgba(255,123,114,0.30)';
    ctx.fillRect(0, 0, W, 12);

    // ── BACKGROUND: the transcript ──
    ctx.textAlign = 'center';
    ctx.fillStyle = hot ? 'rgba(124,226,139,0.9)' : 'rgba(90,90,112,0.9)';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText((S.speaker || 'listening…').slice(0, 26).toUpperCase(), W / 2, 52);

    // Caption ABOVE the character: in a Meet grid the viewer's own picture-in-picture sits over
    // the bottom-right of every remote tile, so anything written low is the first thing occluded.
    const last = S.lines.length ? S.lines[S.lines.length - 1] : '';
    const rows = wrap(last || 'say something…', 30).slice(-2);
    ctx.fillStyle = 'rgba(7,7,12,0.72)';
    ctx.fillRect(0, 76, W, rows.length * 62 + 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px system-ui, sans-serif';
    rows.forEach((r: any, i: any) => ctx.fillText(r, W / 2, 136 + i * 60));

    ctx.fillStyle = 'rgba(76,76,102,0.95)'; ctx.font = '26px system-ui, sans-serif';
    S.lines.slice(-3, -1).reverse().forEach((l: any, i: any) =>
      ctx.fillText(l.slice(0, 54), W / 2, 96 + rows.length * 62 + 34 + i * 30));

    // ── the character, centred and low enough to clear the caption ──
    rooster(W / 2, 452, 1.15, t, state);

    // meter + counters
    for (let i = 0; i < 26; i++) {
      const h = hot ? 8 + Math.abs(Math.sin(t / 7 + i)) * 30 : 5;
      ctx.fillStyle = hot ? '#7cf' : '#23233a';
      ctx.fillRect(W / 2 - 286 + i * 22, 712 - h, 12, h);
    }
    ctx.fillStyle = '#5a5a70'; ctx.font = '24px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(state + ' · ' + S.segments + ' segs · ' + Math.round((Date.now() - S.started) / 1000) + 's', W - 44, 700);
    g.requestAnimationFrame(draw);
  };
  draw();
  // A FRESH captureStream per request. Handing the same MediaStreamTrack to both getUserMedia and
  // getDisplayMedia made Meet report "Camera might be blocked" and "Can't share your screen":
  // whichever consumer got it second was fighting the first for one track. captureStream() may be
  // called repeatedly on a canvas, each call yielding an independent track off the same pixels.
  const fresh = () => cvs.captureStream(30);
  const held = [];                      // keep references so tracks are not garbage-collected
  const takeVideo = () => {
    const st = fresh(); held.push(st);
    const out = new g.MediaStream();
    st.getVideoTracks().forEach((t: any) => out.addTrack(t));
    return out;
  };
  const stream = fresh();               // the canonical one, for __vexaCam.stream consumers
  g.__vexaCam = {
    stream,
    set(title: any, sub: any) { S.title = title || S.title; S.sub = sub || ''; },
    version: 'hud-v5-captop',
    hud(patch: any) {
      if (patch.line) { S.lines.push(patch.line); if (S.lines.length > 12) S.lines.shift();
                        S.segments++; S.lastAt = Date.now(); }
      if (patch.speaker) S.speaker = patch.speaker;
      if (patch.speaking !== undefined) S.speaking = !!patch.speaking;
      if (patch.title) S.title = patch.title;
      if (patch.sub !== undefined) S.sub = patch.sub;
    },
    frames: () => S.frames,
    state: () => ({ segments: S.segments, lines: S.lines.slice(-4) }),
  };
  const md = g.navigator.mediaDevices;
  if (md && md.getUserMedia) {
    // Meet ENUMERATES devices before it ever calls getUserMedia. With --use-file-for-fake-video-
    // capture=/dev/null there is no usable videoinput, so Meet renders "Camera not found", never
    // requests video, and the getUserMedia patch never fires — the canvas was drawing happily to
    // nobody. Advertise a device so Meet asks for it. (Caught by SCREENSHOTTING the meeting:
    // the act reported success while the tile showed an avatar.)
    if (md.enumerateDevices) {
      const origEnum = md.enumerateDevices.bind(md);
      md.enumerateDevices = async () => {
        const list = await origEnum();
        if (!list.some((d: any) => d.kind === 'videoinput')) {
          list.push({ deviceId: 'vexa-cam', kind: 'videoinput', label: 'Vexa Camera',
                      groupId: 'vexa', toJSON() { return this; } });
        }
        return list;
      };
    }
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c: any) => {
      if (c && c.video) {
        const s = takeVideo();
        if (c.audio) {
          try { (await orig({ audio: c.audio })).getAudioTracks().forEach((t: any) => s.addTrack(t)); }
          catch (e) { /* audio may be denied; video still flows */ }
        }
        return s;
      }
      return orig(c);
    };
    // SCREENSHARE, without Chrome's picker — see screen-share.ts for why every route through
    // Chrome's own capture is a dead end in this image.
    md.getDisplayMedia = async () => takeVideo();
  }
}

export const CAMERA_INIT_SCRIPT = `(${installHud.toString()})();`;

const CAM_ON = 'button[aria-label*="Turn on camera" i]';
const CAM_OFF = 'button[aria-label*="Turn off camera" i]';

export interface CameraController {
  show(text: string, sub?: string): Promise<void>;
  off(): Promise<void>;
  /** Push one transcript line onto the on-camera HUD. Fire-and-forget: a HUD update must never
   *  slow down or break the transcript path it is teed off. */
  onLine(speaker: string, text: string): void;
}

export function createCameraController(page: Page): CameraController {
  const wake = async () => {
    await page.mouse.move(640, 360).catch(() => {});
    await page.mouse.move(900, 700).catch(() => {});
    await page.waitForTimeout(400);
  };

  return {
    async show(text: string, sub = ''): Promise<void> {
      await page.bringToFront();
      // The HUD lives in the PAGE, installed at navigation — so a recompiled canvas would not
      // reach a bot already in a meeting. Re-evaluate it here whenever the version differs, and
      // HUD edits become hot too (no rejoin), matching the Node-side surfaces.
      const stale = await page.evaluate(() => {
        const g: any = globalThis as any;
        if (g.__vexaCam && g.__vexaCam.version === 'hud-v5-captop') return false;
        try { delete g.__vexaCam; } catch { g.__vexaCam = undefined; }
        return true;
      }).catch(() => false);
      if (stale) {
        await page.evaluate(installHud).catch(() => { /* page busy; next act retries */ });
        // Re-injecting builds a NEW canvas and a NEW stream — but Meet is still publishing the
        // track it acquired from the OLD one, so the tile keeps showing the previous HUD forever.
        // Force a re-acquire by toggling the camera; getUserMedia then hands over the new canvas.
        await wake();
        if (await page.locator(CAM_OFF).first().isVisible().catch(() => false)) {
          await page.locator(CAM_OFF).first().click({ timeout: 8_000 }).catch(() => {});
          await page.waitForTimeout(1200);
        }
      }
      await page.evaluate(([t, s]) => (globalThis as any).__vexaCam?.set(t, s), [text, sub]);
      await wake();
      // Only click when the camera is off — clicking blindly would toggle a live feed off.
      if (await page.locator(CAM_ON).first().isVisible().catch(() => false)) {
        await page.locator(CAM_ON).first().click({ timeout: 10_000 });
      }
      const frames = await page.evaluate(() => (globalThis as any).__vexaCam?.frames() ?? -1);
      console.log('[camera] ' + JSON.stringify({ text, sub, canvasFrames: frames }));
    },

    onLine(speaker: string, text: string): void {
      void page.evaluate((p: any) => (globalThis as any).__vexaCam?.hud(p),
                         { line: text, speaker })
        .catch(() => { /* page may be navigating; the HUD is diagnostics, never critical */ });
    },

    async off(): Promise<void> {
      await page.bringToFront();
      await wake();
      if (await page.locator(CAM_OFF).first().isVisible().catch(() => false)) {
        await page.locator(CAM_OFF).first().click({ timeout: 10_000 });
      }
      console.log('[camera] ' + JSON.stringify({ off: true }));
    },
  };
}
