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
                   lastAt: 0, started: Date.now(), frames: 0, speaking: false,
                   windingUp: false, windUpStart: 0, amplitude: 0,
                   avatar: 'rooster', bg: 'transcript', speakerAt: 0, pose: 'idle', subAt: 0 };
  const W = 1280, H = 720;
  // Meet cover-crops the 16:9 canvas to the TILE's aspect, and a tile in a grid is nearly square.
  // Measured on a 3-up grid 2026-08-19: the tile was ~510x605, so only the central ~607px of the
  // canvas survived — anything outside it was drawn, published, and never seen by anybody. Treat
  // this band as the only real estate that exists. SAFE_W is deliberately narrower than measured,
  // because the tile gets squarer as participants are added.
  const SAFE_W = 560, SAFE_X0 = (W - SAFE_W) / 2, SAFE_X1 = SAFE_X0 + SAFE_W;
  const hashStr = (x: string) => {
    let h = 0;
    for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0;
    return h;
  };
  const wrap = (t: any, max: any) => {
    const words = String(t).split(/\s+/); const out = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    if (cur) out.push(cur);
    return out;
  };
  // ── the characters ───────────────────────────────────────────────────────────────────────
  // Drawn procedurally rather than loaded as an SVG asset: no fetch, no decode race, and every
  // part is animatable on its own. States are DERIVED, not commanded: "listening" follows recent
  // transcript activity and "speaking" is set by the speak path, so the face cannot lie about what
  // the bot is doing.
  // (No backticks anywhere in here — this whole script is a template literal. Everything the HUD
  // uses must also live INSIDE this function: the init script is installHud.toString(), so an
  // imported module would not survive stringification.)
  // FRONT-FACING and centred: a profile character parked at the edge reads as wallpaper, not as a
  // participant. A face looking at the camera from the middle of the frame is what makes a tile
  // in a grid of faces read as "someone is on this call".
  // Every avatar takes (cx, cy, sc, t, state) and consumes the SAME derived state, so they are
  // interchangeable and the state machine is written once.
  const AVATARS: any = {};

  AVATARS.rooster = (cx: any, cy: any, sc: any, t: any, state: any) => {
    const bob = Math.sin(t / (state === 'listening' ? 7 : 15)) * (state === 'listening' ? 9 : 4);
    const sway = Math.sin(t / 33) * 0.05;
    const bp = t % 240;
    const blink = bp < 7 || (bp > 15 && bp < 21);

    // ── Beak animation derived from actual audio amplitude ────────────────────────────────────
    // During speaking, beak opens proportionally to RMS amplitude. winding-up uses a small
    // chitter. Idle: closed.
    let beak = 0;
    if (state === 'winding-up') {
      const windAge = t - S.windUpStart;
      beak = windAge < 30 ? Math.sin(windAge / 3) * 6 : 0; // quick chitter at start
    } else if (state === 'speaking') {
      // amplitude is RMS (0–~0.5 typical). Map to beak opening (0–35px).
      // NO floor: a silent amplitude must render as a CLOSED beak. There used to be a
      // "faint breath" sine here for beak < 2, and it hid a dead amplitude channel for the whole
      // life of the feature — the tap was firing once per utterance on the leading silence, so the
      // beak was running off a timer while appearing to work. A lying mouth is worse than a still one.
      beak = Math.min(S.amplitude * 120, 35);
    }

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

  // Hancock — Andrew's actual rooster, from photo reference, front on. Where AVATARS.rooster is a
  // pale cartoon, this one is the bird: a close crop where deep red fleshy face fills the frame,
  // a heavy comb that flops rather than scallops, a bone-coloured beak (not the cartoon orange),
  // and an amber iris. Same contract and the same derived state as every other avatar — the beak
  // still opens on real RMS with no floor, because a mouth that moves on a timer lies.
  AVATARS.hancock = (cx: any, cy: any, sc: any, t: any, state: any) => {
    const bob = Math.sin(t / (state === 'listening' ? 7 : 15)) * (state === 'listening' ? 9 : 4);
    const sway = Math.sin(t / 33) * 0.05;
    const bp = t % 240;
    const blink = bp < 7 || (bp > 15 && bp < 21);

    let beak = 0;
    if (state === 'winding-up') {
      const windAge = t - S.windUpStart;
      beak = windAge < 30 ? Math.sin(windAge / 3) * 6 : 0;
    } else if (state === 'speaking') {
      beak = Math.min(S.amplitude * 120, 35);
    }

    const RED = '#a81b22', RED_HI = '#c9313a', RED_SH = '#6f1016';
    const BONE = '#e7dcb4', BONE_SH = '#c2b489';

    ctx.save();
    ctx.translate(cx, cy + bob); ctx.rotate(sway); ctx.scale(sc, sc);

    // hackle feathers behind — tan, the only warm non-red in the reference
    ctx.fillStyle = '#a8631f';
    ctx.beginPath(); ctx.ellipse(0, 210, 168, 130, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#7d4715';
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.ellipse(i * 42, 190 + Math.abs(i) * 9, 15, 54, i * 0.16, 0, 7);
      ctx.fill();
    }

    // comb — one heavy mass that flops right, not neat scallops. Lobes overlap into a single
    // silhouette so it reads as flesh rather than a cockscomb icon.
    const flop = Math.sin(t / 11) * 6;
    ctx.fillStyle = RED;
    for (let i = 0; i < 5; i++) {
      const lx = -74 + i * 38, drop = i * 5;
      ctx.beginPath();
      ctx.ellipse(lx + flop * (i / 4), -128 + drop + Math.sin(t / 9 + i) * 4, 34, 30 - i * 2, 0.25, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = RED_HI;
    ctx.beginPath(); ctx.ellipse(-52 + flop * 0.3, -140, 26, 15, 0.2, 0, 7); ctx.fill();

    // face — the close crop: red fills the frame, no white cartoon head
    ctx.fillStyle = RED;
    ctx.beginPath(); ctx.ellipse(0, -22, 132, 126, 0, 0, 7); ctx.fill();
    ctx.fillStyle = RED_SH;                                   // cheek hollows
    ctx.beginPath(); ctx.ellipse(-88, 10, 30, 52, 0.3, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(88, 10, 30, 52, -0.3, 0, 7); ctx.fill();
    ctx.fillStyle = RED_HI;                                   // brow ridge catching light
    ctx.beginPath(); ctx.ellipse(0, -86, 96, 34, 0, 0, 7); ctx.fill();

    // eyes — amber iris on a dark lid, both visible so it looks AT you
    for (const ex of [-54, 54]) {
      ctx.fillStyle = '#2a1109';
      ctx.beginPath(); ctx.ellipse(ex, -44, 34, blink ? 5 : 33, 0, 0, 7); ctx.fill();
      if (!blink) {
        const look = state === 'listening' ? Math.sin(t / 18) * 7 : 0;
        ctx.fillStyle = '#d9822b';
        ctx.beginPath(); ctx.arc(ex + look, -42, 20, 0, 7); ctx.fill();
        ctx.fillStyle = '#140b06';
        ctx.beginPath(); ctx.arc(ex + look, -42, 10, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(ex + look + 7, -50, 5, 0, 7); ctx.fill();
      } else {
        ctx.strokeStyle = '#2a1109'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(ex - 30, -44); ctx.lineTo(ex + 30, -44); ctx.stroke();
      }
    }

    // beak — bone, upper mandible fixed, lower drops with amplitude
    ctx.fillStyle = BONE;
    ctx.beginPath(); ctx.moveTo(-36, 6); ctx.lineTo(36, 6); ctx.lineTo(0, 62); ctx.closePath(); ctx.fill();
    ctx.fillStyle = BONE_SH;
    ctx.beginPath(); ctx.moveTo(-36, 6); ctx.lineTo(0, 20); ctx.lineTo(0, 62); ctx.closePath(); ctx.fill();
    if (beak > 1) {
      ctx.fillStyle = '#5e0f14';                              // open throat, not a lighter beak
      ctx.beginPath(); ctx.moveTo(-26, 14); ctx.lineTo(26, 14); ctx.lineTo(0, 62 + beak); ctx.closePath(); ctx.fill();
      ctx.fillStyle = BONE_SH;
      ctx.beginPath(); ctx.moveTo(-26, 40 + beak * 0.5); ctx.lineTo(26, 40 + beak * 0.5);
      ctx.lineTo(0, 62 + beak); ctx.closePath(); ctx.fill();
    }

    // wattles — long and heavy, swinging off the jaw with the beak
    ctx.fillStyle = RED;
    for (const wx of [-30, 30]) {
      ctx.beginPath();
      ctx.ellipse(wx, 92 + beak * 0.45, 22, 44 + beak * 0.3, wx < 0 ? 0.12 : -0.12, 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = RED_SH;
    ctx.beginPath(); ctx.ellipse(-30, 108 + beak * 0.45, 9, 20, 0.12, 0, 7); ctx.fill();
    ctx.restore();
  };

  // Tina — the flashbotsX rubiks bot. Mouth slot opens with amplitude; the top row twists like a
  // cube face on speaker change, and the bolt flickers while speaking.
  AVATARS.tina = (cx: any, cy: any, sc: any, t: any, state: any) => {
    const bob = Math.sin(t / (state === 'listening' ? 7 : 15)) * (state === 'listening' ? 9 : 4);
    const sway = Math.sin(t / 33) * 0.05;
    const blink = (t % 250) < 8;
    let mouth = 10;
    if (state === 'winding-up') {
      mouth = 10 + Math.abs(Math.sin(t / 3)) * 8;
    } else if (state === 'speaking') {
      mouth = 10 + Math.min(S.amplitude * 150, 26);   // no idle floor — see rooster
    }
    const twist = state === 'speaking' ? Math.sin(t / 10) * 0.05
                : ((t % 300) < 24 ? Math.sin((t % 300) / 24 * Math.PI) * 0.09 : 0);
    const poly = (pts: any) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath(); ctx.fill();
    };
    const rrf = (x: any, y: any, w2: any, h2: any, r: any) => {
      ctx.beginPath(); ctx.moveTo(x + r, y);
      ctx.arcTo(x + w2, y, x + w2, y + h2, r); ctx.arcTo(x + w2, y + h2, x, y + h2, r);
      ctx.arcTo(x, y + h2, x, y, r); ctx.arcTo(x, y, x + w2, y, r); ctx.closePath(); ctx.fill();
    };
    ctx.save();
    ctx.translate(cx, cy + bob); ctx.rotate(sway); ctx.scale(sc, sc);
    if (state === 'speaking' || (t % 90) > 12) {           // the bolt, flickering
      ctx.save(); ctx.translate(0, -158);
      if (state === 'speaking') { ctx.shadowColor = '#ffe01a'; ctx.shadowBlur = 22; }
      ctx.fillStyle = '#ffe01a';
      poly([[10, -34], [-16, 4], [-4, 4], [-10, 40], [18, -4], [6, -4], [14, -34]]);
      ctx.restore();
    }
    ctx.fillStyle = '#c0bbb1';                              // side pegs
    ctx.beginPath(); ctx.arc(-113, -60, 7, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(113, -60, 7, 0, 7); ctx.fill();
    ctx.fillStyle = '#d9d5cc'; rrf(-110, -37, 220, 147, 20); // mid + bottom rows
    ctx.fillStyle = '#a6a198';
    poly([[-110, 110], [-56, 110], [-110, 56]]); poly([[110, 110], [56, 110], [110, 56]]);
    ctx.strokeStyle = '#8f8a80'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-110, 37); ctx.lineTo(110, 37); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-37, 44); ctx.lineTo(-37, 106); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(37, 44); ctx.lineTo(37, 106); ctx.stroke();
    ctx.save(); ctx.translate(0, -37); ctx.rotate(twist);   // top row twists like a cube face
    ctx.fillStyle = '#d9d5cc'; rrf(-110, -73, 220, 76, 20);
    ctx.strokeStyle = '#8f8a80';
    ctx.beginPath(); ctx.moveTo(-37, -68); ctx.lineTo(-37, -6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(37, -68); ctx.lineTo(37, -6); ctx.stroke();
    ctx.fillStyle = '#e03d2c'; ctx.beginPath(); ctx.ellipse(0, -38, 24, 18, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#f4938a'; ctx.beginPath(); ctx.ellipse(-8, -44, 7, 4, -0.5, 0, 7); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#17181c'; rrf(-95, -30, 190, 60, 18);  // visor
    for (const ex of [-50, 50]) {
      const look = state === 'listening' ? Math.sin(t / 16) * 6 : 0;
      ctx.fillStyle = '#37cdc9';
      ctx.beginPath(); ctx.ellipse(ex + look, -1, 16, blink ? 3 : 20, 0, 0, 7); ctx.fill();
      if (!blink) {
        ctx.fillStyle = '#c8f4f2';
        ctx.beginPath(); ctx.ellipse(ex + look - 5, -8, 4.5, 6, 0, 0, 7); ctx.fill();
      }
    }
    ctx.fillStyle = '#17181c'; rrf(-28, 58, 56, mouth, 6);  // mouth slot opens with amplitude
    if (mouth > 22) { ctx.fillStyle = '#37cdc9'; ctx.fillRect(-20, 58 + mouth - 8, 40, 3); }
    ctx.restore();
  };

  // dmarz — flat-plane portrait, one big eye. Mouth opens with amplitude like the others.
  AVATARS.dmarz = (cx: any, cy: any, sc: any, t: any, state: any) => {
    const bob = Math.sin(t / (state === 'listening' ? 7 : 15)) * (state === 'listening' ? 9 : 4);
    const sway = Math.sin(t / 33) * 0.05;
    const blink = ((t + 90) % 260) < 8;
    let mouth = 0;
    if (state === 'winding-up') {
      mouth = Math.abs(Math.sin(t / 3)) * 6;
    } else if (state === 'speaking') {
      mouth = Math.min(S.amplitude * 120, 24);        // no idle floor — see rooster
    }
    const poly = (pts: any) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath(); ctx.fill();
    };
    ctx.save();
    ctx.translate(cx, cy + bob); ctx.rotate(sway); ctx.scale(sc, sc);
    ctx.fillStyle = '#1d3fbd'; ctx.fillRect(98, -170, 78, 348);   // cobalt backdrop panels
    ctx.fillStyle = '#2f6de0'; ctx.fillRect(142, -170, 22, 348);
    ctx.fillStyle = '#191921'; poly([[-95, -142], [65, -152], [95, -100], [-105, -95]]);  // hair
    ctx.fillStyle = '#1f47d8'; ctx.beginPath(); ctx.arc(-55, -105, 32, 0, 7); ctx.fill();
    ctx.fillStyle = '#e02420'; ctx.fillRect(-25, -135, 62, 38);
    ctx.fillStyle = '#6db9e8'; poly([[8, -135], [88, -118], [82, -45], [0, -55]]);
    ctx.fillStyle = '#2c7a3f'; poly([[-95, -90], [-30, -100], [-45, -25]]);
    ctx.fillStyle = '#c8b48e'; ctx.fillRect(-100, -40, 86, 86);
    const pulse = 1 + Math.sin(t / 22) * 0.045;
    ctx.fillStyle = '#e02420'; ctx.beginPath(); ctx.arc(-57, 3, 33 * pulse, 0, 7); ctx.fill();
    ctx.fillStyle = '#f5cf16'; poly([[-95, 50], [-18, 48], [-6, 140], [-105, 135]]);
    ctx.fillStyle = '#7fc6e8'; poly([[0, -60], [86, -50], [90, 95], [5, 118]]);
    ctx.fillStyle = '#3f9fbf'; poly([[2, 30], [90, 40], [90, 95], [5, 118]]);
    ctx.fillStyle = '#1f47d8'; poly([[-12, -45], [8, -50], [2, 45], [-14, 42]]);
    ctx.fillStyle = '#e6a0ac'; poly([[88, -15], [113, -22], [116, 35], [92, 38]]);
    ctx.save(); ctx.translate(42, -12);                            // the big eye
    ctx.fillStyle = '#f2f6fa';
    ctx.beginPath(); ctx.ellipse(0, 0, 24, blink ? 3 : 20, 0, 0, 7); ctx.fill();
    if (!blink) {
      const look = state === 'listening' ? Math.sin(t / 18) * 5 : 0;
      ctx.fillStyle = '#2c6fd6'; ctx.beginPath(); ctx.arc(look, 0, 12, 0, 7); ctx.fill();
      ctx.fillStyle = '#0b0b10'; ctx.beginPath(); ctx.arc(look, 0, 6, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(look + 3, -4, 2.5, 0, 7); ctx.fill();
    }
    ctx.strokeStyle = '#14141c'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-24, -18); ctx.lineTo(24, -22); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#2a1a20';                                     // mouth opens with amplitude
    poly([[4, 70], [54, 67], [50, 87 + mouth], [8, 89 + mouth]]);
    if (mouth > 4) {
      ctx.fillStyle = '#821c26';
      poly([[10, 78], [48, 75], [46, 84 + mouth * 0.8], [12, 86 + mouth * 0.8]]);
    }
    ctx.fillStyle = '#58b7e6'; ctx.fillRect(-40, 135, 72, 40);     // neck
    ctx.restore();
  };

  // ── the backgrounds ──────────────────────────────────────────────────────────────────────
  // Each paints the full frame BEFORE the avatar and the telemetry footer go on top. Same rule as
  // the avatars: what moves must be downstream of a real signal (segment arrival, RMS amplitude,
  // speaker change, recency), never a free-running timer, so an idle pipeline visibly goes quiet
  // instead of pretending. `hot` is transcript recency; `state` is the derived speak state.
  const BACKGROUNDS: any = {};

  // The heartbeat. Good at proving the pipeline is alive, bad at being looked at for an hour —
  // which is why it is now one option rather than the only one.
  BACKGROUNDS.transcript = (t: any, state: any, hot: any) => {
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
  };

  // The instrument. Everything the transcript strip could only imply, stated as a number: is the
  // pipeline flowing, how fast, how long since the last segment, and is audio actually leaving us.
  BACKGROUNDS.vitals = (t: any, state: any, hot: any) => {
    const upS = Math.max(1, (Date.now() - S.started) / 1000);
    const sinceS = S.lastAt ? (Date.now() - S.lastAt) / 1000 : -1;
    const rate = (S.segments / upS) * 60;
    const cell = (x: any, y: any, label: any, value: any, colour: any) => {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(label, x, y);
      ctx.fillStyle = colour; ctx.font = 'bold 60px system-ui, sans-serif';
      ctx.fillText(value, x, y + 62);
    };
    const green = '#7ce28b', amber = '#f5a524', red = '#ff7b72', dim = '#5a5a70';
    cell(70, 96, 'SEGMENTS', String(S.segments), S.segments ? green : dim);
    cell(340, 96, 'SEGMENTS / MIN', S.segments ? rate.toFixed(1) : '—', S.segments ? green : dim);
    cell(700, 96, 'SINCE LAST',
         sinceS < 0 ? 'never' : sinceS.toFixed(1) + 's',
         sinceS < 0 ? red : (sinceS < 6 ? green : amber));
    cell(1010, 96, 'UPTIME', Math.round(upS) + 's', dim);

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.font = '22px system-ui, sans-serif';
    ctx.fillText('SPEAKER', 70, 232);
    ctx.fillStyle = S.speaker ? '#ffffff' : dim; ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillText((S.speaker || 'nobody yet').slice(0, 24), 70, 282);

    // Outbound audio: the bar only moves when TTS PCM is actually flowing, so a dead speak path
    // reads as a flat bar rather than as silence you have to guess about.
    ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.font = '22px system-ui, sans-serif';
    ctx.fillText('OUR AUDIO OUT', 700, 232);
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(700, 252, 500, 34);
    const amp = Math.min(S.amplitude * 2, 1);
    ctx.fillStyle = state === 'speaking' ? green : (state === 'winding-up' ? amber : dim);
    ctx.fillRect(700, 252, Math.max(4, 500 * amp), 34);
    ctx.textAlign = 'center';
  };

  // The brainrot box. Entertainment that still cannot lie: the churn is driven by segment arrival
  // and RMS, the palette advances only when a segment lands, and a silent room calms it right down.
  // The swarm. The brainrot band-and-scatter is honest but says nothing: it redraws the last nine
  // words at pseudo-random positions every segment, so it reacts to whether anyone is talking and
  // never to what is being said. This one ACCUMULATES — a word keeps its place, grows when it
  // recurs, and fades when the room moves on — so the tile carries the shape of the conversation
  // instead of its volume. Same rule as everything else here: no free-running timers. Every
  // quantity below is a real signal (segment arrival, word frequency, speaker change, vocabulary
  // turnover) and a dead pipeline produces a still, decaying field rather than a busy one.
  const STOP = new Set(('the a an and or but so of to in on at for with is are was were be been am '
    + 'i you he she it we they me him her them my your our their this that these those as if then '
    + 'than there here what which who whom how why when where do does did done have has had will '
    + 'would can could should shall may might must not no yes just like really very much some any '
    + 'all its it\'s im i\'m dont don\'t thats that\'s well okay ok yeah yep uh um mm mhm right '
    + 'know think going get got go one two lot thing things kind sort mean say said').split(' '));
  const swarm: any = new Map();          // word -> {n, x, y, vx, vy, seen, hue}
  let swarmSeg = -1, shiftPulse = 0, prevVocab: any = new Set();

  BACKGROUNDS.swarm = (t: any, state: any, hot: any) => {
    const amp = Math.min(S.amplitude * 2, 1);

    // Ingest only when a segment actually lands. Doing this per frame would let the field grow
    // while nobody speaks, which is the exact lie the HUD is built to avoid.
    if (S.segments !== swarmSeg) {
      swarmSeg = S.segments;
      const hue = (Math.abs(hashStr(S.speaker || 'nobody')) % 360);
      const fresh: any = new Set();
      const toks = (S.lines.slice(-2).join(' ').toLowerCase().match(/[a-z']{3,}/g) || []);
      for (const w of toks) {
        if (STOP.has(w)) continue;
        fresh.add(w);
        const e = swarm.get(w);
        if (e) { e.n++; e.seen = S.frames; e.hue = hue; }
        else {
          const a = (Math.abs(hashStr(w)) % 360) * Math.PI / 180;   // stable angle per word
          // Spawn inside the visible band. The old ring used a 460px x-radius, which put most of
          // the field in the cropped margin — the tile looked empty while the swarm was busy.
          swarm.set(w, { n: 1, x: W / 2 + Math.cos(a) * (SAFE_W / 2 - 40),
                         y: 300 + Math.sin(a) * 210,
                         vx: -Math.cos(a) * 0.5, vy: -Math.sin(a) * 0.4, seen: S.frames, hue });
        }
      }
      // Topic shift: how little of this segment's vocabulary was in the previous one. Low overlap
      // after a real exchange is the cheapest honest "we moved on" signal available without a model.
      if (prevVocab.size && fresh.size) {
        let shared = 0;
        fresh.forEach((w: any) => { if (prevVocab.has(w)) shared++; });
        const overlap = shared / fresh.size;
        if (overlap < 0.12) shiftPulse = 1;
      }
      prevVocab = fresh;
      if (swarm.size > 80) {                                  // bound the field, oldest go first
        const old = [...swarm.entries()].sort((a: any, b: any) => a[1].seen - b[1].seen);
        for (let i = 0; i < old.length - 80; i++) swarm.delete(old[i][0]);
      }
    }

    // A shift pushes everything outward once — the room letting go of what it was holding.
    const shift = shiftPulse;
    shiftPulse *= 0.94;

    ctx.fillStyle = 'rgba(8,7,12,0.30)';                      // motion trails, cheap on CPU
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    swarm.forEach((e: any, w: any) => {
      const age = (S.frames - e.seen) / 900;                  // ~30s to fade at 30fps
      if (age > 1) { swarm.delete(w); return; }

      // Drift inward, then orbit. Speed follows amplitude, so a quiet room is a slow one.
      const dx = e.x - W / 2, dy = e.y - H / 2;
      const d = Math.max(60, Math.hypot(dx, dy));
      const pull = d > 190 ? 0.012 : -0.007;                  // ring, never a pile in the middle
      e.vx += (-dx / d) * pull + (-dy / d) * 0.012 * (0.3 + amp);
      e.vy += (-dy / d) * pull + (dx / d) * 0.012 * (0.3 + amp);
      e.vx += (dx / d) * shift * 1.6; e.vy += (dy / d) * shift * 1.6;
      const damp = hot ? 0.965 : 0.90;                        // silence settles the field
      e.vx *= damp; e.vy *= damp;
      e.x += e.vx; e.y += e.vy;
      if (e.x < SAFE_X0 + 24) { e.x = SAFE_X0 + 24; e.vx = Math.abs(e.vx); }
      if (e.x > SAFE_X1 - 24) { e.x = SAFE_X1 - 24; e.vx = -Math.abs(e.vx); }
      if (e.y < 60)  { e.y = 60;  e.vy = Math.abs(e.vy); }
      if (e.y > 560) { e.y = 560; e.vy = -Math.abs(e.vy); }

      const sz = 15 + Math.min(e.n, 9) * 6 + amp * 8;         // REPETITION is the size, not chance
      const a = (1 - age) * (0.30 + Math.min(e.n, 6) * 0.10);
      ctx.fillStyle = 'hsla(' + e.hue + ',88%,' + (58 + Math.min(e.n, 6) * 4) + '%,' + a + ')';
      ctx.font = (e.n > 2 ? 'bold ' : '') + sz + 'px system-ui, sans-serif';
      ctx.fillText(w, e.x, e.y);
    });

    if (shift > 0.05) {                                       // the shift, made visible
      ctx.strokeStyle = 'rgba(255,255,255,' + (shift * 0.5) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, 320 * (1.4 - shift), 0, Math.PI * 2); ctx.stroke();
    }
  };

  BACKGROUNDS.brainrot = (t: any, state: any, hot: any) => {
    const amp = Math.min(S.amplitude * 2, 1);
    const energy = (hot ? 0.55 : 0.06) + amp * 0.45;      // gated by REAL activity
    const hue = (S.segments * 37) % 360;                  // advances per segment, not per frame

    for (let i = 0; i < 7; i++) {                         // bands, wider as energy rises
      const p = (t * (0.6 + i * 0.35) * energy + i * 90) % (H + 180) - 90;
      ctx.fillStyle = 'hsla(' + ((hue + i * 24) % 360) + ',85%,55%,' + (0.05 + energy * 0.16) + ')';
      ctx.fillRect(0, p, W, 46 + energy * 54);
    }

    const words = (S.lines.slice(-3).join(' ').match(/\S+/g) || []).slice(-9);
    ctx.textAlign = 'center';
    words.forEach((w: any, i: any) => {                   // one word per recent token, no filler
      const seed = (i * 97 + S.segments * 31) % 360;
      // Alternate sides and keep clear of the middle third: the avatar stands there, and a word
      // drawn behind it is a word nobody reads.
      const x = i % 2 ? 830 + ((seed * 7) % 330) : 110 + ((seed * 7) % 330);
      const y = 130 + ((seed * 13) % 470);
      const sz = 26 + (seed % 30) + amp * 46;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(t / 26 + i) * 0.22 * energy);
      ctx.fillStyle = 'hsla(' + ((hue + seed) % 360) + ',95%,' + (62 + amp * 22) + '%,' + (0.30 + energy * 0.5) + ')';
      ctx.font = 'bold ' + sz + 'px system-ui, sans-serif';
      ctx.fillText(w.slice(0, 16).toUpperCase(), 0, 0);
      ctx.restore();
    });

    if (!S.segments) {                                    // honest empty state, not fake chaos
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.fillText('NO SEGMENTS YET', W / 2, 120);
    }
  };

  const draw = () => {
    S.frames++;
    const t = S.frames;
    const age = S.lastAt ? Date.now() - S.lastAt : 1e9;
    const hot = age < 6000;

    // ── State machine: winding-up → speaking → listening/idle ────────────────────────────────
    // winding-up: speak accepted, before TTS flows (throat-clearing). speaking: TTS audio flowing.
    let state = 'idle';
    if (S.windingUp) {
      state = 'winding-up';
    } else if (S.speaking) {
      state = 'speaking';
    } else if (hot) {
      state = 'listening';
    }
    S.pose = state;   // published by state() so tests read the SAME value the frame was drawn with

    ctx.fillStyle = '#07070c'; ctx.fillRect(0, 0, W, H);

    // activity band
    const puls = hot ? (Math.sin(t / 5) + 1) / 2 : 0;
    ctx.fillStyle = hot ? 'rgba(124,226,139,' + (0.25 + puls * 0.5) + ')' : 'rgba(255,123,114,0.30)';
    ctx.fillRect(0, 0, W, 12);

    // ── BACKGROUND, then CHARACTER: two independent choices, any avatar on any background.
    // Both names are validated when they are SET, so these lookups cannot miss — a bad name is
    // rejected at the act with the list of valid ones, rather than quietly rendering the default
    // and looking like the act was ignored. draw() runs inside requestAnimationFrame, where a
    // throw would silently kill the render loop, so it is not the place to find out.
    BACKGROUNDS[S.bg](t, state, hot);

    // the character, centred and low enough to clear the caption
    AVATARS[S.avatar](W / 2, 452, 1.15, t, state);

    // meter + counters
    for (let i = 0; i < 26; i++) {
      const h = hot ? 8 + Math.abs(Math.sin(t / 7 + i)) * 30 : 5;
      ctx.fillStyle = hot ? '#7cf' : '#23233a';
      ctx.fillRect(W / 2 - 286 + i * 22, 712 - h, 12, h);
    }
    ctx.fillStyle = '#5a5a70'; ctx.font = '24px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(state + ' · ' + S.segments + ' segs · ' + Math.round((Date.now() - S.started) / 1000) + 's', W - 44, 700);

    // GOOD POINT banner. Driven by S.sub, which camera_show already carries — so a judge running
    // anywhere can raise one with a plain act, no contract change and no respawn. The optional
    // "8|" score prefix picks the treatment, mirroring the original box: >=9 triumphant, >=8
    // bright, else warm. It animates on ARRIVAL (S.subAt is stamped when the text CHANGES) and
    // then holds still, so a stuck banner looks stuck instead of looking live.
    if (S.sub) {
      const age = (S.frames - S.subAt) / 30;                  // seconds since it landed
      if (age < 14) {
        const m = /^(\d{1,2})\|([\s\S]*)$/.exec(S.sub);
        const score = m ? parseInt(m[1], 10) : 7;
        const quote = m ? m[2] : S.sub;
        const hue = score >= 9 ? 45 : score >= 8 ? 175 : 25;   // triumphant / bright / warm
        const rise = Math.min(1, age * 3.2);                   // slides in over ~0.3s
        const fade = age > 11 ? Math.max(0, (14 - age) / 3) : 1;
        const a = rise * fade;
        const lines = wrap(quote, 26).slice(0, 3);        // narrow band -> fewer chars, more lines
        const bh = 50 + lines.length * 34;
        const by = 74 - (1 - rise) * 40;

        ctx.fillStyle = 'hsla(' + hue + ',70%,10%,' + (0.92 * a) + ')';
        ctx.fillRect(SAFE_X0, by, SAFE_W, bh);
        ctx.fillStyle = 'hsla(' + hue + ',95%,60%,' + a + ')';
        ctx.fillRect(SAFE_X0, by, 6, bh);

        ctx.textAlign = 'center';
        ctx.font = 'bold 19px system-ui, sans-serif';
        ctx.fillStyle = 'hsla(' + hue + ',95%,66%,' + a + ')';
        ctx.fillText('GOOD POINT' + (m ? '  ' + score + '/10' : ''), W / 2, by + 30);
        ctx.font = 'bold 27px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
        lines.forEach((l: any, i: any) => ctx.fillText(l, W / 2, by + 66 + i * 34));
      }
    }
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
    set(title: any, sub: any) { S.title = title || S.title;
                               const n = sub || ''; if (n !== S.sub) S.subAt = S.frames; S.sub = n; },
    version: 'hud-v9-safearea',
    avatars: () => Object.keys(AVATARS),
    backgrounds: () => Object.keys(BACKGROUNDS),
    hud(patch: any) {
      // Validate here, not in draw(): an unknown name is a caller error and must surface at the
      // act that made it. Throwing names the valid set, because the failure people actually hit
      // is a typo, and a silent default looks identical to a dropped act.
      if (patch.avatar !== undefined) {
        if (!AVATARS[patch.avatar]) {
          throw new Error('unknown avatar ' + patch.avatar + '; have ' + Object.keys(AVATARS).join(', '));
        }
        S.avatar = patch.avatar;
      }
      if (patch.bg !== undefined) {
        if (!BACKGROUNDS[patch.bg]) {
          throw new Error('unknown background ' + patch.bg + '; have ' + Object.keys(BACKGROUNDS).join(', '));
        }
        S.bg = patch.bg;
      }
      if (patch.line) { S.lines.push(patch.line); if (S.lines.length > 12) S.lines.shift();
                        S.segments++; S.lastAt = Date.now(); }
      if (patch.speaker) {
        if (patch.speaker !== S.speaker) S.speakerAt = S.frames;   // speaker CHANGE, for the skins
        S.speaker = patch.speaker;
      }
      if (patch.speaking !== undefined) { S.speaking = !!patch.speaking; if (!patch.speaking) S.amplitude = 0; }
      // Restamp on EVERY wind-up, not just the first. The old `&& !S.windUpStart` latched on the
      // first speak of the process, so from the second utterance onward windAge was always past the
      // 30-frame chitter and winding-up rendered identically to idle — the cue was there once and
      // then silently never again. capture-bridge sends this once per speak, so there is no retrigger.
      if (patch.windingUp !== undefined) { S.windingUp = !!patch.windingUp; if (patch.windingUp) S.windUpStart = S.frames; }
      if (patch.amplitude !== undefined) { S.amplitude = patch.amplitude; }
      if (patch.title) S.title = patch.title;
      if (patch.sub !== undefined) { if (patch.sub !== S.sub) S.subAt = S.frames; S.sub = patch.sub; }
    },
    frames: () => S.frames,
    // Report the DERIVED state too, not just the inputs. Without pose/amplitude here a test can
    // only assert "frames advanced", which passes with the entire speak feature deleted — that gap
    // is exactly how a beak running off a timer passed for a week.
    state: () => ({
      segments: S.segments, lines: S.lines.slice(-4), avatar: S.avatar, bg: S.bg,
      pose: S.pose, amplitude: S.amplitude, speaker: S.speaker,
    }),
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

/** Which character, and what it stands in front of. Independent: any avatar on any background. */
export interface CameraSkin {
  avatar?: string;
  bg?: string;
}

export interface CameraController {
  show(text: string, sub?: string, skin?: CameraSkin): Promise<void>;
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
    async show(text: string, sub = '', skin: CameraSkin = {}): Promise<void> {
      await page.bringToFront();
      // The HUD lives in the PAGE, installed at navigation — so a recompiled canvas would not
      // reach a bot already in a meeting. Re-evaluate it here whenever the version differs, and
      // HUD edits become hot too (no rejoin), matching the Node-side surfaces.
      const stale = await page.evaluate(() => {
        const g: any = globalThis as any;
        if (g.__vexaCam && g.__vexaCam.version === 'hud-v9-safearea') return false;
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
      // Skin selection is NOT caught: an unknown avatar/background name throws in the page with
      // the valid set named, and that must reach whoever published the act. Swallowing it here
      // would render the previous skin and report success.
      if (skin.avatar !== undefined || skin.bg !== undefined) {
        await page.evaluate((p: any) => (globalThis as any).__vexaCam.hud(p),
                            { avatar: skin.avatar, bg: skin.bg });
      }
      await wake();
      // Only click when the camera is off — clicking blindly would toggle a live feed off.
      if (await page.locator(CAM_ON).first().isVisible().catch(() => false)) {
        await page.locator(CAM_ON).first().click({ timeout: 10_000 });
      }
      const shown = await page.evaluate(() => {
        const c: any = (globalThis as any).__vexaCam;
        return { frames: c?.frames() ?? -1, ...(c?.state() ?? {}) };
      });
      console.log('[camera] ' + JSON.stringify(
        { text, sub, canvasFrames: shown.frames, avatar: shown.avatar, bg: shown.bg }));
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
