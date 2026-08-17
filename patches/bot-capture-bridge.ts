/**
 * Capture bridge (2b) — the browser-resident capture → pipeline pump + the speak path.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════════════╗
 * ║ L4 (O6/VM): live-validated against a real meeting.                                      ║
 * ║ This whole file is BROWSER-RESIDENT glue: it injects page-side capture, bridges PCM     ║
 * ║ frames over the Playwright boundary, and drives the meeting-UI mic for speaking. None   ║
 * ║ of it can be proven by a unit test (no DOM, no MediaRecorder, no PulseAudio in CI) — it ║
 * ║ is code-complete + build-clean, and PROVEN only by the O6 VM run. The offline-provable  ║
 * ║ engine it pumps into is pipeline.ts (L2/L3).                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Ported faithfully from the working production bot
 *   services/vexa-bot/core/src/index.ts:
 *     • launch (authenticated, persistent context + S3 restore)  → index.ts:2313–2347
 *     • the per-speaker bridge binding + page-side capture wiring → index.ts:1930, 1947–1957
 *     • the Node-side frame callback shape (speakerIndex, number[]) → index.ts:1598–1605
 *     • the speak path (Redis act → meeting-UI mic unmute → PulseAudio tts_sink) → index.ts:595, 1039–1059
 *
 * Isolation note: the page-side capture module (@vexa/gmeet-capture / @vexa/capture-codec) is
 * NOT a bot dependency (gate:isolation) — it is a BROWSER bundle loaded into the page at runtime
 * (production's `window.VexaBrowserUtils`, installed via addInitScript of the prebuilt
 * browser-utils.global.js). The Node side here imports nothing from those packages; PCM frames
 * cross as plain `(speakerIndex: number, samples: number[])` over `page.exposeFunction`, exactly
 * as production does, so the bot's import surface stays within the gate.
 */
import { existsSync } from 'fs';
import {
  launchPersistentBrowser,
  syncBrowserDataFromS3,
  cleanStaleLocks,
  getAuthenticatedBrowserArgs,
  makeEphemeralProfileDir,
  removeProfileDir,
  type Page,
  type BrowserContext,
} from '@vexa/remote-browser';
import { getJoinBrowserArgs } from '@vexa/join';
import type { RecordingMasterFormat } from '@vexa/recording';
import type { Invocation } from './config.js';
import type { BotPipeline } from './pipeline.js';
import type { BotRecordingSink } from './recording.js';
import type { TelemetrySink } from './ports.js';
import { createTtsPlayback } from './tts-playback.js';
import { CAMERA_INIT_SCRIPT } from './camera.js';
import { createRepetitionGuard } from './repetition-guard.js';

/** Float32 PCM → base64 of its little-endian bytes — the EXACT codec wire payload, so a stored
 *  captured-signal.v1 frame round-trips through @vexa/capture-codec (encode→decode→same PCM). */
export function pcmToBase64(pcm: Float32Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}
/** Cheap level read for a captured frame (and the no-signal/silence oracle later). */
export function rmsOf(pcm: Float32Array): number {
  if (!pcm.length) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
}

/**
 * Build the O-TEL-1 raw-signal tap — the EXACT closure the capture bridge tees each frame into,
 * factored out so it is offline-provable WITHOUT a Playwright page (telemetry.test.ts drives this
 * directly). When `telemetry` is unset the returned tap is a single truthiness check — zero
 * overhead, the proven O6 capture path is byte-for-byte unchanged. captureFrame is fire-and-forget;
 * a tap throw is swallowed so it can NEVER reach the pipeline.
 */
export function makeTelemetryTap(lane: 'gmeet' | 'mixed', telemetry?: TelemetrySink) {
  let seq = 0;
  return (speakerIndex: number, pcm: Float32Array, ts: number, speakerName?: string, hint?: string): void => {
    if (!telemetry) return;   // unset ⇒ one branch, nothing computed (never alter the capture path)
    try {
      telemetry.captureFrame({ seq: seq++, ts, speakerIndex, speakerName, hint, pcm: pcmToBase64(pcm), pcm_len: pcm.length, rms: rmsOf(pcm), lane });
    } catch { /* telemetry must not break capture */ }
  };
}

/** Path (in the bot container image) to the prebuilt page-side capture bundle that defines
 *  window.VexaBrowserUtils (createGmeetCapture / createGmeetSpeakers / mixed taps). Mirrors
 *  production's browser-utils.global.js; injected via addInitScript so it is present on every
 *  navigation. Overridable by env for the VM harness. */
const BROWSER_UTILS_PATH = process.env.VEXA_BROWSER_UTILS_PATH ?? '/app/browser-utils.global.js';

/** A handle to the live browser the bot drives. The composition root closes it on teardown. */
export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launch the browser the bot joins through. Authenticated bots restore the persistent profile
 * from S3 first (so they join as a signed-in user); guest bots launch a fresh persistent context.
 * Always uses getJoinBrowserArgs() (the join lane's canonical flag set) merged with the
 * remote-browser auth args, so the page the JoinDriver receives is configured identically to
 * what @vexa/join expects.  // L4 (O6/VM): live-validated against a real meeting.
 */
export async function launchBrowser(inv: Invocation): Promise<BrowserSession> {
  // Every bot gets its OWN profile dir — concurrent bots sharing one dir die on Chromium's
  // SingletonLock (#478: joining → failed <1s, "Opening in existing browser session").
  // Authenticated: restore the S3 userdata into this bot's dir before launch (index.ts:2313–2347).
  // Signed-in joins (this rig has no S3): use the FULL profile dir written by the VNC login flow
  // (provisionLogin profileDir), not loadSessionLocal's auth-essential subset — the subset restore
  // left Google treating the bot as signed out (2026-08-13; 13 items loaded, still bounced to the
  // sign-in wall). Required for calendared personal-account meetings, which wall out anonymous
  // participants entirely. Move the dir aside to go back to guest joins. One bot at a time:
  // Chromium's SingletonLock on the shared dir kills a second launch (#478).
  const liveProfile = process.env.VEXA_PROFILE_DIR ?? '/var/lib/vexa/google-session-live';
  const signedIn = existsSync(liveProfile);
  const dataDir = signedIn ? liveProfile : makeEphemeralProfileDir();
  if (signedIn) cleanStaleLocks(dataDir);
  if (inv.authenticated && inv.userdataS3Path) {
    syncBrowserDataFromS3({
      userdataS3Path: inv.userdataS3Path,
      s3Endpoint: inv.s3Endpoint,
      s3Bucket: inv.s3Bucket,
      s3AccessKey: inv.s3AccessKey,
      s3SecretKey: inv.s3SecretKey,
    }, dataDir);
    cleanStaleLocks(dataDir);
  }

  // getAuthenticatedBrowserArgs() is the minimal clean set remote-browser uses for signed-in
  // joins; getJoinBrowserArgs() adds the fake-device / autoplay flags the join lane needs. The
  // join args win on conflict (later wins in Chromium arg parsing). --incognito would discard
  // the restored cookies, so a signed-in launch must drop it.
  const args = [...getAuthenticatedBrowserArgs(), ...getJoinBrowserArgs()]
    .filter((a) => !(signedIn && a === '--incognito'));
  const { context, page } = await launchPersistentBrowser({ dataDir, args });

  // Grant camera/mic the way --use-fake-ui-for-media-stream used to. That flag had to go because
  // it also auto-answers getDisplayMedia, and it answers with the screen — the one capture path
  // broken in this image (see @vexa/join browser-args.ts). Without it Chrome raises a permission
  // prompt that shifts the page ~130px, and the humanized join clicker then misses every control
  // ("click target verification FAILED after 4 corrections", join never completes). Granting via
  // CDP keeps the permission half without touching display capture. (2026-08-11)
  await context.grantPermissions(['camera', 'microphone'], { origin: 'https://meet.google.com' });

  // Camera: patch getUserMedia BEFORE any Meet script runs, so turning the camera on publishes
  // our canvas. Must be an init script — by the time an act could run, Meet has already resolved
  // its media devices.
  await context.addInitScript(CAMERA_INIT_SCRIPT);

  // Voice-agent gate the page reads to decide whether to keep the mic hot (production parity).
  await context.addInitScript(`window.__vexa_voice_agent_enabled = ${!!inv.voiceAgentEnabled};`);
  // Inject the page-side capture bundle on every navigation (defines window.VexaBrowserUtils).
  await context.addInitScript({ path: BROWSER_UTILS_PATH }).catch(() => {
    // The bundle may be loaded by other means in some images; capture wiring degrades to the
    // inline fallback below. Never fatal at launch.
  });

  // Zoom/Teams expose NO per-participant <audio> in the DOM — install the WebRTC hook so each
  // remote audio track is mirrored into a hidden <audio> element (→ __vexaCapturedRemoteAudioStreams)
  // the mixed lane combines. MUST run before the page builds its RTCPeerConnections; addInitScript
  // runs at document-start, after the bundle above has defined window.VexaBrowserUtils. (L4 — Zoom/Teams.)
  if (inv.platform === 'zoom' || inv.platform === 'teams') {
    await context.addInitScript(
      `try { window.VexaBrowserUtils && window.VexaBrowserUtils.installRemoteAudioHook && window.VexaBrowserUtils.installRemoteAudioHook({}); } catch (e) {}`,
    ).catch(() => { /* non-fatal */ });
  }

  // Observability (L4): route the page-side capture's log(m) → container stdout. gmeet-capture
  // calls window.logBot?.(...) ("stream N connected", "capture started with N stream(s)", …); without
  // exposing it those vanish and the capture is invisible. context.exposeFunction persists across the
  // navigation to the meeting URL. Also forward page console errors/capture markers so faults surface.
  await context.exposeFunction('logBot', (m: string) => console.log(`[page] ${m}`)).catch(() => { /* already registered */ });
  page.on('console', (msg) => {
    const t = msg.text();
    if (/perspeaker|capture|stream|vexabrowser|audiocontext|error|fail/i.test(t)) console.log(`[page-console:${msg.type()}] ${t}`);
  });

  return {
    context,
    page,
    async close() {
      await context.close().catch(() => { /* best-effort */ });
      // per-bot dir — leaking one per bot fills the disk in vexa-lite. NEVER remove the signed-in
      // live profile: it is the durable Google session, shared across spawns.
      if (!signedIn) removeProfileDir(dataDir);
    },
  };
}

/**
 * Wire the page-side capture to pipeline.feedAudio. Exposes the Node bridge binding
 * `__vexaPerSpeakerAudioData(speakerIndex, samples[], tsMs?)` and starts the in-page capture
 * (preferring the shared VexaBrowserUtils module, with production's inline fallback). For the
 * mixed lane (Zoom/Teams) it instead pumps the single mixed stream + active-speaker hints.
 * Returns a stop fn that tears the page-side capture down.
 *   // L4 (O6/VM): live-validated against a real meeting.
 *   Ported from services/vexa-bot/core/src/index.ts:1930, 1947–1957, 1598–1605.
 */
export async function startCaptureBridge(page: Page, inv: Invocation, pipeline: BotPipeline, telemetry?: TelemetrySink): Promise<() => Promise<void>> {
  const mixed = inv.platform === 'zoom' || inv.platform === 'teams';
  const lane: 'gmeet' | 'mixed' = mixed ? 'mixed' : 'gmeet';

  // ── O-TEL-1 raw-signal tap (a DUAL-sink) ──────────────────────────────────────────────────
  // When a TelemetrySink is wired, tee each raw frame to it BEFORE the pipeline consumes it, so a
  // live bug's exact signal is stored as captured-signal.v1 and replays offline (O-TEL-2). The tap
  // is OPTIONAL + zero-overhead when unset (makeTelemetryTap short-circuits to a single truthiness
  // check), so the proven O6 capture path is byte-for-byte unchanged. captureFrame is fire-and-forget.
  const tee = makeTelemetryTap(lane, telemetry);

  // ── Node-side frame sink: one capture.v1 frame crossing the Playwright boundary. ──
  // The page serializes PCM as a plain number[] (Array.from(Float32Array)); we restore the
  // Float32Array and stamp the capture time if the page didn't supply one (production stamps
  // Date.now() on the Node side — index.ts:1598–1605).
  const onPerSpeakerAudio = (speakerIndex: number, samples: number[], tsMs?: number): void => {
    const pcm = new Float32Array(samples);
    const ts = tsMs ?? Date.now();
    tee(speakerIndex, pcm, ts);                                 // O-TEL-1: tap BEFORE the pipeline
    if (mixed) pipeline.feedMixedAudio(pcm, ts);
    else pipeline.feedAudio(speakerIndex, undefined, pcm, ts); // glow name is bound page-side in the v1 producer; channel index here
  };
  // gmeet: the v1 producer stamps the glow name page-side; this named variant carries it through.
  const onNamedAudio = (channel: number, glowName: string | undefined, samples: number[], tsMs?: number): void => {
    const pcm = new Float32Array(samples);
    const ts = tsMs ?? Date.now();
    tee(channel, pcm, ts, glowName);                            // O-TEL-1: tap BEFORE the pipeline
    pipeline.feedAudio(channel, glowName, pcm, ts);
  };
  // mixed lane "who is lit" hint (Zoom/Teams active-speaker → the namer's time window).
  const onSpeakerHint = (name: string, tMs?: number, isEnd?: boolean): void => {
    pipeline.recordHint(name, tMs ?? Date.now(), isEnd);
  };

  await page.exposeFunction('__vexaPerSpeakerAudioData', onPerSpeakerAudio).catch((e: Error) => {
    if (!String(e.message).includes('already registered')) throw e;
  });
  await page.exposeFunction('__vexaNamedAudioData', onNamedAudio).catch(() => { /* optional */ });
  await page.exposeFunction('__vexaSpeakerHint', onSpeakerHint).catch(() => { /* optional */ });

  // ── Start the page-side capture (VexaBrowserUtils preferred; production inline fallback). ──
  // The body of this callback runs IN THE BROWSER (Playwright serializes it); DOM globals are
  // reached via globalThis (this file type-checks against the Node lib — no DOM types here).
  await page.evaluate(async (isMixed) => {
    const w = (globalThis as any) as Record<string, any>;
    if (isMixed) {
      // Zoom/Teams: installRemoteAudioHook (installed pre-nav) mirrors each remote WebRTC audio
      // track into w.__vexaCapturedRemoteAudioStreams. Combine them into ONE live stream (an
      // AudioContext destination), keep connecting late-arriving tracks via a rescan (a participant
      // who speaks later), and feed that single mix to the mixed lane (pyannote re-separates speakers).
      const setupMix = (): void => {
        const streams = (w.__vexaCapturedRemoteAudioStreams || []) as Array<{ id: string }>;
        if (!streams.length) return;
        if (!w.__vexaMixCtx) {
          w.__vexaMixCtx = new (globalThis as any).AudioContext({ sampleRate: 16000 });
          w.__vexaMixCtx.resume?.();
          w.__vexaMixDest = w.__vexaMixCtx.createMediaStreamDestination();
          w.__vexaMixSeen = new Set();
        }
        for (const s of streams) {
          if (!s || w.__vexaMixSeen.has(s.id)) continue;
          try {
            w.__vexaMixCtx.createMediaStreamSource(s).connect(w.__vexaMixDest);
            w.__vexaMixSeen.add(s.id);
            w.logBot?.('[mixed] connected remote stream ' + w.__vexaMixSeen.size);
          } catch { /* a stream may not be connectable yet */ }
        }
        if (!w.__vexaMixedCapture && w.__vexaMixSeen.size && w.VexaBrowserUtils?.createMixedAudioCapture) {
          w.__vexaMixedCapture = true; // guard re-entry while the async create resolves
          Promise.resolve(w.VexaBrowserUtils.createMixedAudioCapture(w.__vexaMixDest.stream, (pcm: Float32Array) => w.__vexaPerSpeakerAudioData(0, Array.from(pcm))))
            .then((cap: any) => { w.__vexaMixedCapture = cap; return cap?.start?.(); })
            .then(() => w.logBot?.('[mixed] capture started over ' + w.__vexaMixSeen.size + ' stream(s)'))
            .catch((e: any) => { w.__vexaMixedCapture = null; w.logBot?.('[mixed] capture start failed: ' + String(e)); });
        }
      };
      setupMix();
      w.__vexaMixRescan = (globalThis as any).setInterval(setupMix, 2000); // pick up late-arriving tracks
      return;
    }
    // gmeet lane: per-channel capture + glow attribution (the SAME module the extension runs).
    if (w.VexaBrowserUtils?.createGmeetCapture && !w.__vexaGmeetCapture) {
      w.__vexaGmeetSpeakers = w.__vexaGmeetSpeakers
        ?? w.VexaBrowserUtils.createGmeetSpeakers?.({ log: (m: string) => w.logBot?.('[PerSpeaker] ' + m) });
      w.__vexaGmeetCapture = w.VexaBrowserUtils.createGmeetCapture({
        log: (m: string) => w.logBot?.('[PerSpeaker] ' + m),
        onAudio: (index: number, pcm: Float32Array) => {
          w.__vexaGmeetSpeakers?.reportTrackAudio?.(index);
          // Bind the glow name at capture time (the v1 producer's inversion): exactly-one-lit ⇒ name.
          const lit: string[] = w.__vexaGmeetSpeakers?.litNames?.() ?? [];
          const glow = lit.length === 1 ? lit[0] : undefined;
          if (glow) w.__vexaNamedAudioData(index, glow, Array.from(pcm), Date.now());
          else w.__vexaPerSpeakerAudioData(index, Array.from(pcm), Date.now());
        },
      });
      await w.__vexaGmeetCapture.start();
    }
  }, mixed).catch((e) => {
    console.error(`[bot] capture bridge: page-side start failed: ${String(e)}`); // L4: surfaces only on the VM
  });

  // Stop fn: tear the page-side capture down on teardown (best-effort; the page may be closing).
  return async () => {
    await page.evaluate(() => {
      const w = (globalThis as any) as Record<string, any>;
      try { w.__vexaGmeetCapture?.stop?.(); } catch { /* best-effort */ }
      try { if (w.__vexaMixRescan) { (globalThis as any).clearInterval(w.__vexaMixRescan); w.__vexaMixRescan = null; } } catch { /* */ }
      try { if (w.__vexaMixedCapture && typeof w.__vexaMixedCapture.stop === 'function') w.__vexaMixedCapture.stop(); } catch { /* best-effort */ }
      try { w.__vexaMixCtx?.close?.(); } catch { /* best-effort */ }
      try { w.__vexaGmeetSpeakers?.destroy?.(); } catch { /* best-effort */ }
    }).catch(() => { /* page already gone */ });
  };
}

/**
 * Start the page-side recording tap → recording.v1 chunks → the BotRecordingSink.  // L4 (O6/VM).
 *
 * The MediaRecorder loop lives in @vexa/record-chunker (bundled into window.VexaBrowserUtils, like
 * the capture bricks). It records the meeting's combined audio mix, base64-encodes each timeslice,
 * and hands it to `onChunk`. We bridge those chunks over the Playwright boundary to `recording.chunk`
 * using the SAME key the orchestrator closes with (`platform/native`), so the assembler groups them
 * and the final chunk (on stop) assembles the master. Started post-admission (on the live meeting
 * page, where the participant <audio> elements exist), exactly like the capture bridge.
 */
export async function startRecording(page: Page, inv: Invocation, recording: BotRecordingSink): Promise<() => Promise<void>> {
  const key = `${inv.platform}/${inv.nativeMeetingId ?? inv.connectionId ?? 'session'}`;
  // Node-side: decode one base64 recording.v1 chunk → the assembler. mimeType→master format.
  await page.exposeFunction('__vexaRecordingChunk', (base64: string, chunkSeq: number, isFinal: boolean, mimeType: string): void => {
    const bytes = base64 ? new Uint8Array(Buffer.from(base64, 'base64')) : new Uint8Array(0);
    const format: RecordingMasterFormat = /wav/i.test(mimeType) ? 'wav' : 'webm';
    recording.chunk(key, chunkSeq, isFinal, format, bytes);
  }).catch((e: Error) => { if (!String(e.message).includes('already registered')) throw e; });

  // Page-side: start the generic recording tap (finds + combines the page audio elements).
  await page.evaluate(async () => {
    const w = (globalThis as any) as Record<string, any>;
    if (w.VexaBrowserUtils?.createRecordingTap && !w.__vexaRecordingTap) {
      w.__vexaRecordingTap = w.VexaBrowserUtils.createRecordingTap({
        timesliceMs: 15000,
        onChunk: async (c: { base64: string; chunkSeq: number; isFinal: boolean; mimeType: string }) => {
          try { await w.__vexaRecordingChunk(c.base64, c.chunkSeq, c.isFinal, c.mimeType); return true; }
          catch { return false; }
        },
      });
      await w.__vexaRecordingTap.start();
    }
  }).catch((e) => { console.error(`[bot] recording bridge: page-side start failed: ${String(e)}`); });

  // Stop fn: stop the recorder so it flushes the final (isFinal) chunk → master assembly.
  return async () => {
    await page.evaluate(async () => {
      const w = (globalThis as any) as Record<string, any>;
      try { await w.__vexaRecordingTap?.stop?.(); } catch { /* best-effort */ }
    }).catch(() => { /* page already gone */ });
  };
}

/**
 * The SPEAK path — inject TTS audio into the bot's mic.  // L4 (O6/VM): live-validated.
 *
 * Production (services/vexa-bot/core/src/index.ts:595, 1039–1059 + services/tts-playback.ts)
 * does this at the OS level, not via a page fake-mic: a PulseAudio chain `tts_sink → virtual_mic`
 * is what Chromium captures as its microphone. The bot writes synthesized PCM to the tts_sink
 * device (paplay) which feeds virtual_mic; silence between utterances is enforced there, by
 * gating tts_sink — no PCM, no sound.
 *
 * There is deliberately NO meeting-UI mic toggle. It used to click the first element whose
 * aria-label matched /microphone/i, which in any populated call is a participant tile's "Mute
 * <name>'s microphone" control, not the bot's own button: on 2026-08-12 that opened a "Mute X for
 * everyone?" modal in two live client meetings, left the bot muted (every speak act silent), and
 * wedged every other toolbar act behind the modal. The toggle only ever controlled Meet's visual
 * mute state — the audio gate is tts_sink — so it bought nothing and is gone. The bot now shows
 * as unmuted for the whole call, which is honest: its mic is live the whole call.
 *
 * This bot package does not own the PulseAudio/TTS process plumbing (that is the container
 * entrypoint + a TTS service, outside the bot's import surface). Speaking is gated on
 * inv.voiceAgentEnabled.
 */
export interface SpeakController {
  /** Begin speaking `text` (TTS synthesized + injected via the VM's PulseAudio chain). */
  speak(text: string, voice?: string): Promise<void>;
  /** Stop any in-flight speech (barge-in). */
  stop(): Promise<void>;
}

export function createSpeakController(page: Page, inv: Invocation): SpeakController {
  const enabled = !!inv.voiceAgentEnabled;
  const tts = createTtsPlayback((m) => console.log(`[bot] ${m}`));   // OS-level TTS→tts_sink half
  const guard = createRepetitionGuard('speak');                  // L+: anti-repetition guard

  // Wire amplitude updates to the page for beak animation. Audio flowing IS the transition out of
  // winding-up — clearing it here (not after playback) is what lets the speaking pose take over.
  tts.onAmplitude((rms: number) => {
    page.evaluate((r) => (globalThis as any).__vexaCam?.hud({ speaking: true, windingUp: false, amplitude: r }), rms)
      .catch(() => { /* page may be navigating */ });
  });

  // Meet's UI mute gates the outgoing WebRTC track, so the bot MUST be unmuted or the PulseAudio
  // audio never leaves — and Meet joins muted by default. The bot's own control is the only one
  // whose aria-label reads "Turn on/off microphone"; a participant tile's reads "Mute <name>".
  // Matching that exact phrasing is what keeps this off other people's tiles. SET, never toggle:
  // click only when it reads "Turn on" (i.e. currently muted). No re-mute afterwards — tts_sink is
  // the silence gate — so this runs once per utterance and is a no-op after the first.
  const ensureUnmuted = async (): Promise<string> => page.evaluate(() => {
    const doc = (globalThis as any).document;
    const btn = Array.from(doc.querySelectorAll('button,[role="button"]'))
      .find((b: any) => /turn (on|off) microphone/i.test(b.getAttribute('aria-label') ?? '')) as any;
    if (!btn) return 'mic button NOT FOUND';
    const label = String(btn.getAttribute('aria-label'));
    if (/turn on microphone/i.test(label)) { btn.click(); return `unmuted (was "${label}")`; }
    return `already unmuted ("${label}")`;
  });

  return {
    async speak(text: string, voice?: string): Promise<void> {
      if (!enabled) { console.error('[bot] speak ignored: voiceAgentEnabled is false'); return; }

      // L+: anti-repetition guard — suppress duplicates within window
      const verdict = guard.check(text);
      if (!verdict.allowed) {
        const ageMs = Date.now() - verdict.seenAt;
        console.log(`[guard] suppressed repeat speak: "${text.slice(0, 60)}" (seen ${Math.round(ageMs / 1000)}s ago as "${verdict.normalized}")`);
        return; // LOUD suppression — no silent fallbacks
      }

      console.log(`[bot] speak: "${text.slice(0, 60)}"`);
      console.log(`[bot] mic: ${await ensureUnmuted()}`);

      // Signal winding-up state (throat-clearing) before TTS flows
      await page.evaluate(() => (globalThis as any).__vexaCam?.hud({ windingUp: true }))
        .catch(() => { /* page may be navigating */ });

      // Synthesize via the TTS service + stream PCM to tts_sink → virtual_mic (the bot's mic).
      // tts_sink is unmuted for the duration and re-muted after, which IS the audio gate.
      await tts.speak(text, voice).catch((e) => console.error(`[bot] speak: tts failed: ${String(e)}`));

      // Clear speaking state after playback
      await page.evaluate(() => (globalThis as any).__vexaCam?.hud({ speaking: false, windingUp: false }))
        .catch(() => { /* page may be navigating */ });
    },
    async stop(): Promise<void> {
      if (!enabled) return;
      tts.stop();                                             // barge-in: kill playback + re-mute tts_sink
      console.log('[bot] speak_stop');
      await page.evaluate(() => (globalThis as any).__vexaCam?.hud({ speaking: false, windingUp: false }))
        .catch(() => { /* page may be navigating */ });
    },
  };
}
