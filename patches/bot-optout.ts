/**
 * OPT-OUT — a person in the call keeps their words out of everything this bot writes down, by
 * typing in the Meet chat.  (not in upstream Vexa)
 *
 *   opt-out, opt-out 1   their words are not transcribed from here on. One marker line in the
 *                        transcript, under their name, records that they were here and chose this.
 *   opt-out 2            as above, and their name is written nowhere: no marker, no chat reads,
 *                        not even in the count the console shows.
 *   opt-in               back in, with a marker line.
 *
 * It is visible to the room on purpose: Meet chat has no private messages, so there is no silent
 * channel inside the call. The bot confirms in chat, and the confirmation names nobody.
 *
 * Where the cut is. Every transcript segment leaves the bot through one sink (index.ts); a segment
 * whose speaker is opted out is dropped there, before the camera HUD, redis and the database see
 * it. Whisper still hears the speech: the cut is at publish, not at capture. WHO spoke is a vote
 * over which tile was lit during the utterance, so two people talking at once can be misattributed;
 * the Pipecat lane therefore lets an opted-out tile that was lit at ANY point in the span claim the
 * whole utterance (claims(), used in pipecat-bridge.ts), so a doubtful one is dropped, not kept.
 * The built-in lane offers no such hook, so there the vote winner alone decides.
 *
 * Not covered: what was transcribed before the opt-out, Meet's own transcription, recordings
 * (off by default), and the bot's debug log inside the container, which dies with it.
 *
 * One bot per process, so the registry is module state: pipecat-bridge.ts and chat.ts read it
 * without being handed anything.
 */
import type { TranscriptSegment } from './contracts.js';

export type Level = 0 | 1 | 2;

/** The transcript lines that record a choice. The console dims lines with exactly this text. */
export const MARKER = {
  out: '(opted out of the transcript)',
  in: '(opted back into the transcript)',
} as const;

/** What the bot says back in chat. No names: at level 2 there is nothing to name, and at level 1
 *  the marker line already says it where it belongs. */
export const REPLY: Record<Level | 'unknown', string> = {
  1: 'Opt-out noted: your words are not transcribed from here on.',
  2: 'Opt-out 2 noted: your words and your name stay out from here on.',
  0: 'Opt-in noted: you are back in the transcript.',
  unknown: 'Opt-out received, but the sender could not be read. Try again in a moment.',
};

const key = (name: string): string => name.trim().toLowerCase();

/** key -> level and the display name as Meet showed it (level 1 only is ever printed). */
const levels = new Map<string, { level: Level; name: string }>();

/** "opt-out", "opt out", "optout", "opt-out 1", "opt-out 2", "opt-in". The whole message, nothing
 *  else in it: "I want to opt-out" is a sentence about opting out, not the act. */
export function parseOptOut(text: string): Level | null {
  const m = /^\s*opt[\s-]*(out|in)(?:\s+([12]))?\s*[.!]?\s*$/i.exec(text);
  if (!m) return null;
  if (m[1].toLowerCase() === 'in') return 0;
  return m[2] === '2' ? 2 : 1;
}

export function optOutLevel(name: string): Level {
  return levels.get(key(name))?.level ?? 0;
}

/** The first opted-out name among these, if any: the one that claims a span of doubtful speech. */
export function claims(names: Iterable<string>): string | undefined {
  for (const n of names) if (optOutLevel(n)) return n;
  return undefined;
}

export function setOptOut(name: string, level: Level): Level {
  const was = optOutLevel(name);
  if (level === 0) levels.delete(key(name));
  else levels.set(key(name), { level, name: name.trim() });
  return was;
}

/** Who is out, for the console: names at level 1, a count at level 2. */
export function roster(): { named: string[]; unnamed: number } {
  const named: string[] = [];
  let unnamed = 0;
  for (const v of levels.values()) { if (v.level === 1) named.push(v.name); else unnamed++; }
  return { named: named.sort(), unnamed };
}

/** Tests only. */
export function resetOptOut(): void { levels.clear(); }

export interface OptOutOptions {
  /** The bot's filtered transcript sink: markers go through it like any other line. */
  publish: (seg: TranscriptSegment) => Promise<void>;
  /** Post to the Meet chat, past the repetition guard: two people opting out get two replies. */
  post: (text: string) => Promise<void>;
  log?: (m: string) => void;
  /** The bot's own chat messages come back from the panel too; they are never commands. */
  botName?: string;
  now?: () => number;
}

export interface OptOut {
  /** One chat message. Returns the level applied, or null when the message was not a command. */
  onChat(sender: string, text: string): Promise<Level | null>;
}

export function createOptOut(o: OptOutOptions): OptOut {
  const log = o.log ?? ((m) => console.log(m));
  const now = o.now ?? Date.now;
  const self = new Set(['you', key(o.botName ?? '')]);

  const marker = async (name: string, text: string): Promise<void> => {
    const t = now();
    await o.publish({
      segment_id: `optout-${t}-${Math.random().toString(36).slice(2, 8)}`,
      speaker: name.trim(), speaker_key: 'optout', text,
      start: t / 1000, end: t / 1000, completed: true,
      absolute_start_time: new Date(t).toISOString(), absolute_end_time: new Date(t).toISOString(),
    });
  };

  // One line per change, for the console: the whole roster, so it never has to replay history,
  // and a note only when there is something the transcript itself does not show.
  const report = (note?: string): void => {
    log('[optout] ' + JSON.stringify({ ...roster(), ...(note ? { note } : {}) }));
  };

  return {
    async onChat(sender, text) {
      const level = parseOptOut(text);
      if (level === null || self.has(key(sender))) return null;
      if (!sender.trim()) {
        log('[optout] a command arrived with no readable sender');
        await o.post(REPLY.unknown);
        return null;
      }
      const was = optOutLevel(sender);
      if (level === 1) {
        if (was !== 1) await marker(sender, MARKER.out);     // before the cut, so it is published
        setOptOut(sender, 1);
        report();
      } else if (level === 2) {
        setOptOut(sender, 2);
        report('someone opted out entirely: no words and no name from here on');
      } else {
        setOptOut(sender, 0);
        if (was) await marker(sender, MARKER.in);           // after the cut is lifted
        report();
      }
      await o.post(REPLY[level]);
      return level;
    },
  };
}
