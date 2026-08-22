/**
 * CAPTURE TAP — persist raw received audio with a wall-clock stamp per frame.  // L4 (O6/VM).
 *
 * `makeTelemetryTap` in capture-bridge.ts has always teed every captured frame — exact PCM, the
 * `ts` the audio was captured at, the glow-bound speaker name — into an OPTIONAL `TelemetrySink`.
 * Nothing ever constructed one, so the tee was a single truthiness check and the frames were
 * dropped. This is the sink.
 *
 * Why it exists: every latency number the rig can otherwise produce is measured at the TRANSCRIPT,
 * which means it is downstream of buffering, Whisper, and LocalAgreement-2 confirmation, and so
 * says nothing about the audio path itself. To measure the acoustic round trip — bot's speaker to
 * a human's ear, their mouth back to the bot's mic — you have to align RECEIVED AUDIO against
 * TRANSMITTED AUDIO, and that needs the received samples with an honest timebase. `sync.py` plays
 * a metronome whose onsets are fixed at render time and cross-correlates this file against them.
 *
 * THE SWITCH IS A DIRECTORY, deliberately. The tap writes into /tmp/vexa-capture-tap and is OFF
 * whenever that directory does not exist — it is never created here. So turning it on is
 * `mkdir /tmp/vexa-capture-tap` inside the container and turning it off is `rm -rf`, with no
 * compose edit and no container recreate; the next bot spawn picks it up, the same way hotswap
 * lands new surface code. An env var would have meant recreating the container to toggle a
 * diagnostic, which on rig 1 is exactly the operation the notes say destroys recordings.
 *
 * The capture path is the one thing in this bot that must never be perturbed (O6), so: writes are
 * append-only and fire-and-forget, every fault is swallowed after one log line, and the whole
 * thing is bounded by `VEXA_CAPTURE_TAP_MB` (default 256) so a tap left on in a long meeting
 * cannot fill the container disk.
 *
 * FORMAT — one JSON object per line, exactly the `CapturedFrame` the bridge already builds:
 *
 *   {"seq":0,"ts":1787272106131,"speakerIndex":0,"speakerName":"Andrew Miller",
 *    "pcm":"<base64 Float32LE>","pcm_len":1024,"rms":0.0143,"lane":"gmeet"}
 *
 * `pcm` is the codec wire payload verbatim (base64 of Float32 little-endian), so a line
 * round-trips through @vexa/capture-codec unchanged and the envelope can be recomputed offline at
 * any resolution rather than being fixed to whatever the meter happened to emit.
 *
 * Node-only (fs) — no DOM, no workspace imports → gate:isolation-clean.
 */
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { CapturedFrame, TelemetrySink } from './ports.js';

const DEFAULT_CAP_MB = 256;

export interface CaptureTap extends TelemetrySink {
  /** Flush and close. Safe to call twice. */
  close(): void;
  /** Absolute path of the file being written — logged at open so a run can find its own data. */
  readonly path: string;
}

/** Where frames land, and the on/off switch: absent directory ⇒ no tap. Override for the VM
 *  harness only; the default is what `sync.py` and the runbook use. */
const TAP_DIR = process.env.VEXA_CAPTURE_TAP?.trim() || '/tmp/vexa-capture-tap';

/**
 * Build a capture tap writing `<TAP_DIR>/capture-mtg<meetingId>.jsonl`.
 * Returns undefined when TAP_DIR does not exist — the caller then passes nothing to
 * startCaptureBridge and the tee stays a single truthiness check, exactly as before.
 */
export function createCaptureTap(meetingId: string | number,
                                 log: (m: string) => void = () => { /* */ }): CaptureTap | undefined {
  const dir = TAP_DIR;
  // NOT mkdir: the directory existing is the whole switch. Creating it here would turn the tap
  // permanently on the first time a bot ran, which is the opposite of the intent.
  if (!existsSync(dir)) return undefined;

  const capBytes = Math.max(1, Number(process.env.VEXA_CAPTURE_TAP_MB ?? DEFAULT_CAP_MB)) * 1024 * 1024;
  const path = join(dir, `capture-mtg${meetingId}.jsonl`);
  let stream: WriteStream;
  try {
    stream = createWriteStream(path, { flags: 'a' });
  } catch (err) {
    // A tap that cannot open is a LOUD no-op, never a silent one: the whole point of this file is
    // producing evidence, and an empty measurement must not look like a quiet room.
    log(`[tap] DISABLED — cannot open ${path}: ${(err as Error).message}`);
    return undefined;
  }

  let bytes = 0, frames = 0, closed = false, capped = false;
  stream.on('error', (err) => { log(`[tap] write error, tap is now dead: ${err.message}`); closed = true; });
  log(`[tap] capture tap ON -> ${path} (cap ${Math.round(capBytes / 1024 / 1024)}MB)`);

  return {
    path,
    captureFrame(frame: CapturedFrame): void {
      if (closed) return;
      if (bytes >= capBytes) {
        if (!capped) { capped = true; log(`[tap] cap reached after ${frames} frames — no longer recording`); }
        return;
      }
      try {
        const line = `${JSON.stringify(frame)}\n`;
        bytes += line.length;
        frames++;
        stream.write(line);
      } catch (err) {
        log(`[tap] frame ${frames} dropped: ${(err as Error).message}`);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      log(`[tap] closing after ${frames} frames, ${(bytes / 1024 / 1024).toFixed(1)}MB -> ${path}`);
      try { stream.end(); } catch { /* closing is best-effort */ }
    },
  };
}
