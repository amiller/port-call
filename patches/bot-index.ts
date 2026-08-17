/**
 * @vexa/bot — the COMPOSITION ROOT (P7 worker entrypoint).
 *
 * The ONLY place wiring happens (Seemann): validate the invocation.v1 config from the env,
 * build the real adapters for every port, hand them to the pure orchestrator, run to a
 * terminal lifecycle.v1 state, and exit. The container boots here, works, emits, and dies.
 *
 * ┌─ INCREMENT 2a wired the LIVE redis/HTTP transports for the data/control plane:
 * │    • LifecycleSink  → HTTP POST to inv.meetingApiCallbackUrl (lifecycle.v1, retry/backoff)  ✅ LIVE
 * │    • TranscriptSink → redis stream + pub/sub (transcript.v1)                                ✅ LIVE
 * │    • ActsSource     → redis pub/sub on actsChannel(meetingId) (acts.v1)                     ✅ LIVE
 * ├─ INCREMENT 2b wires the browser join + capture + recording (THIS file):
 * │    • JoinDriver     → @vexa/join.joinMeeting over a @vexa/remote-browser page               ✅ WIRED (L4)
 * │    • Pipeline       → capture bridge → @vexa/{gmeet,mixed}-pipeline → @vexa/transcribe-whisper ✅ WIRED (L4 capture · L2/L3 lane)
 * │    • RecordingSink  → @vexa/recording assembler → upload to inv.recordingUploadUrl          ✅ WIRED (L4 upload · L2/L3 assembler)
 * │    • Speak          → acts.v1 `speak`/`speak_stop` → meeting-UI mic + VM TTS chain          ✅ WIRED (L4)
 * └─ The browser/capture/recording-upload/speak legs are BROWSER- or VM-resident → L4-gated
 *    (proven by the O6 VM run, not unit tests). The lane + assembler cores are L2/L3-proven.
 *
 * Robustness: if the browser cannot be launched (e.g. no display in a non-VM context), the
 * composition root falls back to NO browser session and the orchestrator drives to a clean
 * terminal `failed` (join_failure) rather than crashing the root — same disposability as the
 * lazy redis connect.
 */
import { loadInvocation, InvocationError, type Invocation } from './config.js';
import type { Act, LifecycleEvent } from './contracts.js';
import { createOrchestrator } from './orchestrator.js';
import { createHttpLifecycleSink } from './adapters/lifecycle-http.js';
import { createRedisTranscriptSink, redisClientFrom } from './adapters/transcript-redis.js';
import { createRedisActsSource, redisActsClientFrom } from './adapters/acts-redis.js';
import { createBrowserJoinDriver } from './join-driver.js';
import { createBotPipeline, type BotPipeline } from './pipeline.js';
import { createBotRecordingSink } from './recording.js';
import { launchBrowser, startCaptureBridge, startRecording, createSpeakController, type BrowserSession, type SpeakController } from './capture-bridge.js';
import { type ScreenShareController } from './screen-share.js';
import { type SelfCheck } from './selfcheck.js';
import { type ChatController } from './chat.js';
import { createCameraController, type CameraController } from './camera.js';
import { type ReactionController } from './reactions.js';
import { statSync, existsSync } from 'node:fs';

/**
 * Load a surface controller FRESH per act, cache-busted by the file's mtime.
 *
 * Static imports freeze a controller at process start, so editing one meant killing the bot and
 * rejoining the meeting just to try a selector — which is absurd when the change is one line of
 * DOM driving. dist/ is bind-mounted from the host, so `./hotswap.sh` recompiles in place and the
 * NEXT act picks it up: no restart, no rejoin, the bot keeps its seat. ESM caches by URL, hence
 * the mtime query — unchanged files still hit the cache and cost nothing.
 */
async function surface(name: string): Promise<any> {
  const url = new URL(`./${name}.js`, import.meta.url);
  let v = '0';
  try { v = String(statSync(url).mtimeMs); } catch { /* fall back to the cached module */ }
  return import(`${url.href}?v=${v}`);
}
import { installSignalHandlers } from './signals.js';
import type {
  JoinDriver,
  Pipeline,
  LifecycleSink,
  TranscriptSink,
  ActsSource,
  RecordingSink,
} from './ports.js';

/** A console-only lifecycle sink — used for self-host (no `meetingApiCallbackUrl`) and as the
 *  pre-config fallback. The live HTTP sink (createHttpLifecycleSink) replaces it when a
 *  callback URL is configured. */
function consoleLifecycleSink(): LifecycleSink {
  return { async emit(e: LifecycleEvent) { console.log(`[bot] lifecycle.v1 ${e.status}${e.completion_reason ? ` (${e.completion_reason})` : ''}${e.failure_stage ? ` @${e.failure_stage}` : ''}`); } };
}

/** A no-op JoinDriver used ONLY when the browser fails to launch — it reports a join failure so
 *  the orchestrator drives to a clean terminal `failed`(join_failure) instead of the root crashing. */
function noBrowserJoinDriver(reason: string): JoinDriver {
  return {
    async join() { console.error(`[bot] no browser session: ${reason}`); return 'error'; },
    onRemoval() { return () => { /* */ }; },
    async leave() { /* */ },
    async withdraw() { /* no browser — nothing to withdraw */ },
  };
}

/** An offline Pipeline used when there is no browser to capture from (browser-launch failure):
 *  it satisfies the port so the orchestrator can teardown cleanly; it never captures. */
function noBrowserPipeline(): Pipeline {
  return { async start() { /* */ }, async stop() { /* */ } };
}

/** The meeting id that keys the redis transcript/acts channels (0.11 control-plane convention:
 *  the numeric `meeting_id`). Falls back to the platform native id / connection id when the
 *  numeric id is absent (e.g. self-host paths), so the channels are always well-formed. */
function meetingChannelId(inv: Invocation): string | number {
  return inv.meeting_id ?? inv.nativeMeetingId ?? inv.connectionId ?? 'session';
}

/**
 * Derive the hard active-phase cap (ms) from invocation.v1 `automaticLeave`.
 *
 *  `orchestrator.run({ maxActiveMs })` is a HARD ceiling on the active phase that resolves to
 *  `completed(max_bot_time_exceeded)` — a backstop so a bot can never live forever (the granular
 *  empty-room / waiting-room timeouts that map to left_alone/startup_alone are driven by the
 *  Pipeline/JoinDriver in 2b). This is a GENEROUS backstop (default 4h, override with
 *  BOT_MAX_ACTIVE_MS in ms) — the granular empty-room / waiting-room timeouts drive every NORMAL exit
 *  well before this fires. We floor it at max(everyoneLeft, noOneJoined, waitingRoom) + 60s margin so
 *  the backstop can never undercut those granular timeouts. */
const DEFAULT_MAX_ACTIVE_MS = 4 * 60 * 60 * 1000; // 4 hours
function deriveMaxActiveMs(inv: Invocation, env: NodeJS.ProcessEnv = process.env): number {
  const al = inv.automaticLeave ?? {};
  const everyoneLeft = al.everyoneLeftTimeout ?? 120_000;
  const noOneJoined = al.noOneJoinedTimeout ?? 600_000;
  const waitingRoom = al.waitingRoomTimeout ?? 300_000;
  const MARGIN_MS = 60_000; // give the granular timeouts room to fire first
  const floor = Math.max(everyoneLeft, noOneJoined, waitingRoom) + MARGIN_MS;
  const override = Number(env.BOT_MAX_ACTIVE_MS);
  const cap = Number.isFinite(override) && override > 0 ? override : DEFAULT_MAX_ACTIVE_MS;
  return Math.max(cap, floor);
}

/**
 * Tee an ActsSource so EVERY act reaches both the orchestrator (its single `handle`, which owns
 * `leave`) AND the bot's voice handler (speak / speak_stop), from ONE underlying subscription.
 * The orchestrator stays the pure core (it never imports the SpeakController); the voice path is
 * wired here at the composition root. The orchestrator's `subscribe(handler)` registers its
 * handler; we fan the live source's messages to it plus `voice`.
 */
function teeActs(source: ActsSource, voice: (act: Act) => void | Promise<void>): ActsSource {
  return {
    subscribe(handler) {
      return source.subscribe((act) => {
        void Promise.resolve(handler(act)).catch((e) => console.error(`[bot] acts: orchestrator handler rejected: ${String(e)}`));
        void Promise.resolve(voice(act)).catch((e) => console.error(`[bot] acts: voice handler rejected: ${String(e)}`));
      });
    },
  };
}

/** The bot's voice-act handler: route acts.v1 speak / speak_stop to the SpeakController, and
 *  screen_share / screen_share_stop to the ScreenShareController, chat_send / chat_read to the
 *  ChatController. Remaining unimplemented: screen_show / avatar_set / avatar_reset. */
function voiceHandler(speak: SpeakController, page: any, platform: string,
                      cam: CameraController): (act: Act) => Promise<void> {
  return async (act) => {
    // speak stays statically wired: it owns PulseAudio + mic state, not page DOM.
    if (act.action === 'speak') return void await speak.speak(act.text, act.voice);
    if (act.action === 'speak_stop') return void await speak.stop();

    if (act.action === 'screen_share') {
      const m = await surface('screen-share');
      return void await m.createScreenShareController(page, platform).share(act.text);
    }
    if (act.action === 'screen_share_stop') {
      const m = await surface('screen-share');
      return void await m.createScreenShareController(page, platform).stop();
    }
    if (act.action === 'selfcheck') {
      const m = await surface('selfcheck');
      return void await m.createSelfCheck(page).run();
    }
    if (act.action === 'chat_send') {
      const m = await surface('chat');
      return void await m.createChatController(page).send(act.text);
    }
    if (act.action === 'chat_read') {
      const m = await surface('chat');
      return void await m.createChatController(page).read();
    }
    if (act.action === 'reaction') {
      const m = await surface('reactions');
      return void await m.createReactionController(page).send(act.emoji);
    }
    // Camera is dynamic too. HUD state lives in the PAGE (__vexaCam), not in this process, so a
    // freshly imported controller loses nothing — and it carries the newest canvas source, which
    // it re-injects on version change. The statically held `cam` is used only for pushing
    // transcript lines, which is version-agnostic.
    if (act.action === 'camera_show') {
      const m = await surface('camera');
      return void await m.createCameraController(page)
        .show(act.text, act.sub, { avatar: act.avatar, bg: act.bg });
    }
    if (act.action === 'camera_off') {
      const m = await surface('camera');
      return void await m.createCameraController(page).off();
    }
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // ── validate config (P14: fail fast) ──
  let inv: Invocation;
  try {
    inv = loadInvocation(env);
    // Signed-in mode is decided by the presence of the VNC-login profile (capture-bridge launches
    // with it), so the join layer must skip guest name-entry — signed-in Meet has no name field,
    // and the guest path stalls 2min hunting for it, then fails the join (2026-08-13).
    if (existsSync(env.VEXA_PROFILE_DIR ?? '/var/lib/vexa/google-session-live')) inv.authenticated = true;
  } catch (e) {
    if (e instanceof InvocationError) {
      // No valid connection_id to attribute the failure to → emit a best-effort terminal
      // event and exit non-zero. We have no validated callbackUrl yet, so this goes to the
      // console sink. (The live HTTP sink would POST validation_error once a URL is known.)
      console.error(`[bot] FATAL ${e.message}`);
      consoleLifecycleSink().emit({ connection_id: env.VEXA_CONNECTION_ID ?? '', status: 'failed', failure_stage: 'requested', completion_reason: 'validation_error', reason: e.message, exit_code: 1 }).catch(() => {});
      return 1;
    }
    throw e;
  }

  // ── build the LIVE transports → the pure orchestrator ──
  const meetingId = meetingChannelId(inv);

  // lifecycle.v1: HTTP POST to meeting-api when a callback URL is configured; console-only for
  // self-host (no callback). The HTTP sink retries/backs off and never throws out of emit.
  const lifecycle: LifecycleSink = inv.meetingApiCallbackUrl
    ? createHttpLifecycleSink({ callbackUrl: inv.meetingApiCallbackUrl, internalSecret: inv.internalSecret })
    : consoleLifecycleSink();

  // transcript.v1 + acts.v1: redis. Connect LAZILY — constructing the clients does NOT dial
  // redis, so an unreachable broker doesn't crash the composition root; the first publish/
  // subscribe surfaces the error and the orchestrator drives to a clean terminal `failed`.
  const transcriptClient = redisClientFrom(inv.redisUrl);
  const actsClient = redisActsClientFrom(inv.redisUrl);
  // The camera HUD is fed by teeing this sink (set once the browser exists, below). A HUD
  // failure must never affect transcript egress, so the tee swallows its own errors.
  let hudLine: ((speaker: string, text: string) => void) | null = null;
  const transcriptRaw: TranscriptSink = createRedisTranscriptSink({
    client: transcriptClient, meetingId, nativeMeetingId: inv.nativeMeetingId,
  });
  const transcript: TranscriptSink = {
    async publish(seg) {
      // Only COMPLETED segments reach the HUD: vexa resubmits each utterance as a growing window,
      // so provisional ones would make the on-camera text stutter and rewrite itself.
      try { if (seg.completed) hudLine?.(seg.speaker, seg.text); } catch { /* HUD is never critical */ }
      return transcriptRaw.publish(seg);
    },
  };
  const liveActs = createRedisActsSource({ client: actsClient, meetingId });

  // ── 2b: launch the browser + wire join / capture / recording / speak (L4-gated). ──
  // Browser-launch failure must NOT crash the root: fall back to the no-browser drivers so the
  // orchestrator still emits a clean terminal failed(join_failure).
  let session: BrowserSession | null = null;
  let join: JoinDriver;
  let pipeline: Pipeline;
  let botPipeline: BotPipeline | null = null;
  let stopCapture: () => Promise<void> = async () => { /* no-op until pipeline.start() wires capture */ };
  let stopRecording: () => Promise<void> = async () => { /* no-op until pipeline.start() wires recording */ };
  let acts: ActsSource = liveActs;
  const recording = inv.recordingEnabled ? createBotRecordingSink({ inv, log: (m) => console.log(`[bot] ${m}`) }) : undefined;

  try {
    session = await launchBrowser(inv);                                   // L4 (O6/VM)
    join = createBrowserJoinDriver(session.page, inv);
    botPipeline = createBotPipeline(inv, transcript, { onError: (e) => console.error(`[bot] pipeline fault: ${String(e)}`) });
    // Defer the page-side capture start to pipeline.start(): the orchestrator calls it AFTER
    // admission (orchestrator.ts:125), on the LIVE meeting page — where addInitScript has injected
    // window.VexaBrowserUtils and the participant <audio> elements exist. Starting it at launch ran
    // the page.evaluate on the BLANK pre-navigation page (no VexaBrowserUtils, no audio), and the
    // subsequent goto to the meeting URL destroyed that context — so capture never attached. (L4.)
    const sess = session, bp = botPipeline, rec = recording;
    pipeline = {
      async start() {
        stopCapture = await startCaptureBridge(sess.page, inv, bp);   // on the live meeting page
        if (rec) stopRecording = await startRecording(sess.page, inv, rec);   // MediaRecorder → recording.v1
        await bp.start();
      },
      async stop() {
        const sc = stopCapture; stopCapture = async () => {};
        await sc().catch(() => { /* best-effort */ });
        const sr = stopRecording; stopRecording = async () => {};
        await sr().catch(() => { /* best-effort */ });   // flush the final chunk → master assembly
        await bp.stop();
      },
    };
    // Voice: tee acts so `speak`/`speak_stop` reach the SpeakController (gated on voiceAgentEnabled).
    const speak = createSpeakController(session.page, inv);
    const cam = createCameraController(session.page);
    hudLine = (speaker, text) => cam.onLine(speaker, text);
    acts = teeActs(liveActs, voiceHandler(speak, session.page, inv.platform, cam));
  } catch (e) {
    console.error(`[bot] browser launch/capture wiring failed — falling back to clean terminal failed: ${String(e)}`);
    join = noBrowserJoinDriver(String(e));
    pipeline = noBrowserPipeline();
    acts = liveActs;
  }

  const orchestrator = createOrchestrator(inv, {
    lifecycle,
    join,
    pipeline,
    acts,
    recording: recording as RecordingSink | undefined,
  });

  // Disposability (P7): a termination signal ends the active phase gracefully (leave → flush →
  // terminal callback → exit 0) so the container never hangs after `active` — BOUNDED by the
  // force-exit watchdog in signals.ts (<25s, inside the runtime's SIGTERM→SIGKILL stop grace) so
  // a wedged teardown can never ride a `docker stop` all the way to a silent 137 (the incident's
  // exit code on BOTH orphaned bots). Wire before run(); release the listeners after.
  const releaseSignals = installSignalHandlers({ stop: (reason) => orchestrator.stop(reason) });
  try {
    const result = await orchestrator.run({ maxActiveMs: deriveMaxActiveMs(inv) });
    return result.exitCode;
  } finally {
    releaseSignals();
    // Tear down the capture bridge + browser (best-effort — a teardown failure must not change
    // the exit code). The orchestrator already stopped the pipeline + left the meeting.
    await stopCapture().catch(() => { /* best-effort */ });
    await stopRecording().catch(() => { /* best-effort */ });
    if (session) await session.close().catch(() => { /* best-effort */ });
    // Quit the redis connections on teardown (best-effort — a quit failure must not change the
    // exit code; they may never have connected if redis was unreachable).
    await transcriptClient.quit().catch(() => { /* best-effort */ });
    await actsClient.quit().catch(() => { /* best-effort */ });
  }
}

// Worker entrypoint: boot, work, emit, die (P7).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
