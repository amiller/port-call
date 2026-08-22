/**
 * TTS playback adapter (2b) — the OS-level half of the SPEAK path.  // L4 (O6/VM).
 *
 * The browser half (unmute the meeting-UI mic) lives in capture-bridge.ts's SpeakController; this
 * is the audio half: synthesize `text` via the Vexa TTS service and play the returned PCM through
 * the container's PulseAudio `tts_sink` (→ `virtual_mic`, which Chromium captures as its mic). The
 * `tts_sink → virtual_mic` graph is created by entrypoint.sh; here we only unmute it during
 * playback, stream PCM to `paplay`, and re-mute after.
 *
 * Ported (focused: the streaming-PCM path only — no ffmpeg) from the production bot
 *   services/vexa-bot/core/src/services/tts-playback.ts (synthesizeViaTtsService + (un)mute).
 * acts.v1 `speak` already carries {text, voice} — no contract change. Config is infrastructure
 * (the TTS service URL/token), read from env like production (TTS_SERVICE_URL / TTS_API_TOKEN),
 * NOT the sealed invocation.v1. Gated by the SpeakController on inv.voiceAgentEnabled.
 *
 * Node-only (child_process + http/https) — no DOM, no workspace imports → gate:isolation-clean.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';

const RATE_HZ = 24000;
const PAPLAY_ARGS = ['--raw', '--format=s16le', `--rate=${RATE_HZ}`, '--channels=1', '--device=tts_sink'];
/** Amplitude envelope resolution — one RMS value per 100ms of AUDIO, emitted at 10Hz wall clock. */
const FRAME_MS = 100;

/**
 * Assert the PulseAudio graph exists, rebuilding it if it does not.  (#49)
 *
 * `tts_sink` -> `tts_sink.monitor` -> `virtual_mic` is created ONCE, by the image's
 * setup-pulseaudio-sinks.sh, when the container starts. Nothing recreated it if it went away — and
 * on 2026-08-21 it did: PulseAudio was up with only the fallback `auto_null`, so every speak act
 * hit "Stream error: No such entity", paplay exited instantly, and the resulting EPIPE took the
 * whole bot out of a live call (#48). Restoring the graph by hand fixed it.
 *
 * The setup script is idempotent, so the repair is just running it. LOUD on both branches: a graph
 * that had to be rebuilt is a fault worth seeing, not a detail to paper over — if this line starts
 * appearing every join, something is tearing the sinks down and that is the real bug.
 *
 * NOTE the caller must still respawn a bot whose Chromium already bound its microphone before the
 * repair: getUserMedia holds the source it was given at join, so a rebuilt virtual_mic reaches the
 * meeting only for bots that join afterwards.
 */
function ensureAudioGraph(log: (m: string) => void): void {
  const sinks = execSync('pactl list sinks short', { stdio: 'pipe' }).toString();
  if (sinks.includes('tts_sink')) return;
  log('[tts] AUDIO GRAPH MISSING — tts_sink is gone, rebuilding before playback');
  execSync('/usr/local/bin/setup-pulseaudio-sinks.sh', { stdio: 'pipe' });
  const after = execSync('pactl list sinks short', { stdio: 'pipe' }).toString();
  log(`[tts] graph rebuilt: ${after.includes('tts_sink') ? 'tts_sink present' : 'STILL MISSING'}`);
}

function setTtsMute(muted: boolean, log: (m: string) => void): void {
  const v = muted ? '1' : '0';
  try {
    execSync(`pactl set-sink-mute tts_sink ${v}`, { stdio: 'pipe' });
    // NEVER mute virtual_mic. Chromium has it open as its microphone for the whole call, and
    // muting a live capture source makes Meet report "Microphone muted by system" and stop
    // sending — observed 2026-08-12: every speak act reached the shim and returned real PCM, yet
    // nobody in the meeting heard a thing. Gating tts_sink is enough on its own, because
    // virtual_mic is fed by that sink and nothing else, so silence in means silence out.
    // Asserted unmuted on every call so a source left muted by an older build heals itself.
    execSync(`pactl set-source-mute virtual_mic 0`, { stdio: 'pipe' });
  } catch (err) {
    log(`[tts] pactl ${muted ? 'mute' : 'unmute'} failed: ${(err as Error).message}`);
  }
}

/** Called with RMS amplitude of each TTS PCM chunk (0.0–1.0 typical range). */
export type TtsAmplitudeCallback = (rms: number) => void;

export interface TtsPlayback {
  /** Synthesize `text` (voice optional) and play it into the meeting via tts_sink. Resolves when
   *  playback finishes. Best-effort: a synthesis/playback failure logs + resolves (never throws out
   *  — the voice handler must not break the orchestrator). */
  speak(text: string, voice?: string): Promise<void>;
  /** Interrupt any in-flight playback (barge-in) + re-mute. */
  stop(): void;
  /** Register a callback for PCM amplitude updates during playback (batched ~10Hz). */
  onAmplitude(cb: TtsAmplitudeCallback): void;
}

/** Build a TtsPlayback that streams the TTS service's PCM straight to paplay. */
export function createTtsPlayback(log: (m: string) => void = () => { /* */ }): TtsPlayback {
  let proc: ChildProcess | null = null;
  let ampCallback: TtsAmplitudeCallback | null = null;
  const tickers = new Set<NodeJS.Timeout>();

  const stopTickers = (): void => { tickers.forEach(clearInterval); tickers.clear(); };

  const stop = (): void => {
    if (proc) {
      try { proc.stdin?.destroy(); proc.kill('SIGKILL'); } catch { /* */ }
      proc = null;
    }
    stopTickers();
    setTtsMute(true, log);
  };

  const speak = async (text: string, voice = 'auto'): Promise<void> => {
    // Say-to-audible instrumentation (#3). Epoch ms on BOTH lines so a reader differences them
    // without parsing the mixed-format bot log: bare [bot] lines carry no ts of their own.
    const beganAt = Date.now();
    log(`[tts] begin ts=${beganAt} chars=${text.length}`);
    const base = process.env.TTS_SERVICE_URL?.trim();
    if (!base) { log('[tts] TTS_SERVICE_URL not set — speak is a no-op'); return; }
    const postData = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'pcm' });
    let url: URL;
    try { url = new URL(`${base.replace(/\/$/, '')}/v1/audio/speech`); }
    catch { log(`[tts] bad TTS_SERVICE_URL: ${base}`); return; }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(postData)),
    };
    const token = process.env.TTS_API_TOKEN?.trim();
    if (token) headers['X-API-Key'] = token;

    await new Promise<void>((resolve) => {
      const req = (url.protocol === 'https:' ? https : http).request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }, (res) => {
        if (res.statusCode !== 200) {
          let body = ''; res.on('data', (c) => (body += c));
          res.on('end', () => { log(`[tts] service ${res.statusCode}: ${body.slice(0, 120)}`); resolve(); });
          return;
        }
        ensureAudioGraph(log);                        // #49: the sink can vanish mid-run
        setTtsMute(false, log);                       // open the mic only during playback
        const p = spawn('paplay', PAPLAY_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
        proc = p;
        p.stderr?.on('data', (d: Buffer) => log(`[tts] paplay: ${d.toString().trim()}`));
        const done = () => { if (proc === p) proc = null; stopTickers(); setTtsMute(true, log); resolve(); };
        p.on('exit', done);
        p.on('error', (e) => { log(`[tts] paplay error: ${String(e)}`); done(); });

        // ── Amplitude envelope for the beak animation ────────────────────────────────────────
        // The TTS service does NOT trickle audio in realtime: it answers with a Content-Length
        // body, so 5.9s of PCM arrives in ~5ms across 6 chunks (measured on tts-shim 2026-08-17).
        // Emitting RMS as bytes ARRIVE therefore fires once, on the leading-silence chunk, and the
        // beak sees amplitude 0 for the whole utterance. So: build a per-frame envelope indexed by
        // PLAYBACK POSITION, and emit it on a wall clock started when paplay starts consuming.
        const FRAME_SAMPLES = (RATE_HZ * FRAME_MS) / 1000;
        const envelope: number[] = [];
        let sumSquares = 0, frameSamples = 0;
        let odd: number | null = null;                // a chunk boundary can split one s16 sample
        res.on('data', (chunk: Buffer) => {
          let i = 0;
          if (odd !== null) {                         // finish the sample straddling the boundary
            const s = ((chunk[0] << 8) | odd) << 16 >> 16;
            sumSquares += (s / 32768) ** 2; frameSamples++; odd = null; i = 1;
          }
          for (; i + 1 < chunk.length; i += 2) {
            const s = chunk.readInt16LE(i);
            sumSquares += (s / 32768) ** 2;
            if (++frameSamples === FRAME_SAMPLES) {
              envelope.push(Math.sqrt(sumSquares / FRAME_SAMPLES));
              sumSquares = 0; frameSamples = 0;
            }
          }
          if (i < chunk.length) odd = chunk[i];
        });
        res.on('end', () => { if (frameSamples) envelope.push(Math.sqrt(sumSquares / frameSamples)); });

        const startedAt = Date.now();
        // The shim answers with a Content-Length body (see above), so the response only begins
        // once synthesis is DONE — startedAt is therefore the first sample paplay consumes, and
        // synth_ms is the dead air between the act and any sound at all.
        log(`[tts] audible ts=${startedAt} synth_ms=${startedAt - beganAt}`);
        const ticker = setInterval(() => {
          if (!ampCallback) return;
          const frame = Math.floor((Date.now() - startedAt) / FRAME_MS);
          ampCallback(envelope[frame] ?? 0);
        }, FRAME_MS);
        ticker.unref?.();
        tickers.add(ticker);

        // paplay can exit early — a dead PulseAudio, a lost tts_sink, a failed unmute. The pipe
        // then writes into closed stdin, which emits 'error' on a stream nobody listened to, and
        // an unhandled 'error' event takes the WHOLE PROCESS down. That killed bot 154 out of a
        // live call on 2026-08-21, seconds after `pactl set-sink-mute tts_sink 0` failed: one
        // muffed utterance evicted the bot and ended the recording. A TTS fault must never be able
        // to do that. Name it, drop the utterance, stay in the meeting.
        p.stdin?.on('error', (e: any) => {
          log(`[tts] playback pipe died (${e?.code || String(e)}) — utterance dropped, bot stays in the call`);
          try { res.destroy(); } catch { /* the response is already gone */ }
          done();
        });
        res.on('error', (e: any) => { log(`[tts] response stream error: ${String(e)}`); done(); });

        res.pipe(p.stdin!);                           // stream PCM straight to the mic sink
      });
      req.on('error', (e) => { log(`[tts] request error: ${String(e)}`); resolve(); });
      req.write(postData); req.end();
    });
  };

  const onAmplitude = (cb: TtsAmplitudeCallback): void => { ampCallback = cb; };

  return { speak, stop, onAmplitude };
}
