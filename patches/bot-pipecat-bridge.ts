/**
 * PIPECAT BRIDGE — the Google Meet audio lane, run outside this process.  (not in upstream Vexa)
 *
 * The built-in lane (@vexa/gmeet-pipeline) buffers each stream here in Node, re-sends the whole
 * unconfirmed window to Whisper every 2s, and calls text final when two passes agree. This lane
 * does none of that itself: it streams each Meet audio stream to a Pipecat service
 * (pipecat_local.py) and publishes what comes back. There, a voice detector cuts the utterance
 * when the speaker stops, Whisper hears it once, and a sound-based turn detector (Smart Turn) says
 * when the speaker has finished their turn — the event a spoken reply will hang off when the
 * voice leg is switched on.
 *
 * Selected by PIPECAT_URL in the bot's environment (see pipeline.ts). Unset, nothing here runs.
 *
 * What stays in this process, on purpose:
 *  - WHO SPOKE. Pipecat sees a stream of sound; only this process sees which tile was lit. Each
 *    block is sent with its capture time, each transcript comes back with the span it covers, and
 *    the name is whichever tile was lit for most of that span.
 *  - THE SINK. Transcripts leave through the same TranscriptSink as before, so the console, the
 *    on-camera captions and the database see no difference.
 *  - THE HALLUCINATION FILTER, for parity with the built-in lane. Note it drops any one-word
 *    utterance under 10 characters ("Yes."), which a conversational bot will want changed.
 *
 * Wire format (matches pipecat_local.py): to the service, a binary message of 8 bytes of
 * little-endian capture time in ms, then PCM16 mono 16 kHz. From it, JSON text events.
 * Node 22's global WebSocket is the client; no dependency is added.
 */
import { isHallucination } from '@vexa/gmeet-pipeline';
import type { TranscriptSegment } from './contracts.js';
import type { BotPipeline } from './pipeline.js';
import type { TranscriptSink } from './ports.js';
import { claims } from './optout.js';

interface Channel {
  ws: any | null;
  opening: boolean;
  retryAt: number;
  /** Blocks captured while the socket is still opening, so an utterance keeps its first words. */
  pending: Buffer[];
  /** Which tile was lit, by capture time — the only record of who a span of sound belongs to. */
  names: { t: number; name: string }[];
  lastName: string;
  seq: number;
}

const PENDING_MAX = 40;        // ~10s of 256ms blocks; past that the service is down, not slow
const RETRY_MS = 2000;

export function createPipecatBotPipeline(
  url: string,
  meeting: string,
  sink: TranscriptSink,
  onError?: (e: unknown) => void,
): BotPipeline {
  const base = url.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const channels = new Map<number, Channel>();
  const log = (m: string): void => console.log(`[bot] [pipecat] ${m}`);
  let stopped = false;

  /** The tile lit for most of [t0, t1]; failing that the last one seen on this stream. An
   *  opted-out tile lit at any point in the span takes it instead, so the sink drops the whole
   *  utterance: when two people overlap, the doubt goes against keeping it (optout.ts). */
  const speakerFor = (c: Channel, t0: number, t1: number): string => {
    const votes = new Map<string, number>();
    for (const n of c.names) {
      if (n.t >= t0 - 300 && n.t <= t1 + 300) votes.set(n.name, (votes.get(n.name) ?? 0) + 1);
    }
    const out = claims(votes.keys());
    if (out) return out;
    let best = '', top = 0;
    for (const [name, v] of votes) if (v > top) { best = name; top = v; }
    return best || c.lastName || 'Speaker';
  };

  const onEvent = (ch: number, c: Channel, e: any): void => {
    if (e?.type === 'transcript') {
      const text = String(e.text ?? '').trim();
      const secs = ((e.t1 - e.t0) / 1000).toFixed(1);
      // Lengths and timings only: transcript text is meeting content and stays out of this log.
      if (!text) { log(`ch${ch} utterance ${secs}s -> no text, whisper ${e.stt_ms}ms`); return; }
      if (isHallucination(text)) { log(`ch${ch} utterance ${secs}s -> filtered (${text.length} chars)`); return; }
      const seg: TranscriptSegment = {
        segment_id: `pc-${meeting}-ch${ch}-${e.t0}-${++c.seq}`,
        speaker: speakerFor(c, e.t0, e.t1),
        speaker_key: `ch-${ch}`,
        text,
        start: e.t0 / 1000,
        end: e.t1 / 1000,
        language: e.language ?? null,
        completed: true,          // heard once, after the speaker stopped: there is no draft to revise
        absolute_start_time: new Date(e.t0).toISOString(),
        absolute_end_time: new Date(e.t1).toISOString(),
      };
      void sink.publish(seg).catch((err) => {
        (onError ?? ((x) => console.error(`[bot] [pipecat] transcript publish rejected: ${String(x)}`)))(err);
      });
      log(`ch${ch} utterance ${secs}s -> ${text.length} chars, whisper ${e.stt_ms}ms`);
    } else if (e?.type === 'turn_end') {
      log(`ch${ch} turn ended`);   // where a spoken reply begins, once the voice leg is on
    }
  };

  const open = (ch: number, c: Channel): void => {
    if (c.ws || c.opening || stopped || Date.now() < c.retryAt) return;
    c.opening = true;
    const ws = new (globalThis as any).WebSocket(
      `${base}/ws?meeting=${encodeURIComponent(meeting)}&channel=${ch}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      c.ws = ws; c.opening = false;
      log(`ch${ch} connected${c.pending.length ? `, sending ${c.pending.length} held block(s)` : ''}`);
      for (const b of c.pending.splice(0)) { try { ws.send(b); } catch (err) { onError?.(err); } }
    };
    ws.onmessage = (m: any) => {
      if (typeof m.data !== 'string') return;        // binary is the voice leg's audio, not on yet
      try { onEvent(ch, c, JSON.parse(m.data)); } catch (err) { onError?.(err); }
    };
    // Say it once per drop, loudly: while the service is away this stream is not transcribed, and
    // a meeting that silently stops producing a transcript is the failure this must not hide.
    const down = (why: string) => {
      if (c.ws !== ws && !c.opening) return;
      c.ws = null; c.opening = false; c.retryAt = Date.now() + RETRY_MS;
      const lost = c.pending.splice(0).length;
      if (!stopped) log(`ch${ch} ${why} — NOT TRANSCRIBING this stream until it reconnects${lost ? ` (${lost} block(s) lost)` : ''}`);
    };
    ws.onclose = () => down('service closed the connection');
    ws.onerror = () => down('service unreachable');
  };

  return {
    async start() { /* lazy, like the built-in lane: a stream connects on its first block */ },
    async stop() {
      stopped = true;
      for (const c of channels.values()) { try { c.ws?.close(); } catch { /* already gone */ } }
    },
    feedAudio(channel, glowName, pcm, tsMs) {
      let c = channels.get(channel);
      if (!c) {
        c = { ws: null, opening: false, retryAt: 0, pending: [], names: [], lastName: '', seq: 0 };
        channels.set(channel, c);
      }
      if (glowName) {
        c.names.push({ t: tsMs, name: glowName }); c.lastName = glowName;
        if (c.names.length > 480) c.names.splice(0, 120);     // ~2 minutes of history is plenty
      }
      const buf = Buffer.alloc(8 + pcm.length * 2);
      buf.writeBigUInt64LE(BigInt(Math.max(0, Math.round(tsMs))), 0);
      for (let i = 0; i < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 8 + i * 2);
      }
      if (c.ws) {
        try { c.ws.send(buf); } catch (err) { onError?.(err); }
        return;
      }
      if (c.pending.length < PENDING_MAX) c.pending.push(buf);
      open(channel, c);
    },
    feedMixedAudio() { /* Zoom/Teams keep the built-in mixed lane */ },
    recordHint() { /* not this lane */ },
  };
}
