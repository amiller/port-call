/**
 * Anti-repetition guard — prevents the bot from emitting the same spoken or chat line
 * twice within a configurable window. Suppression is always loud; never silent.
 *
 * Motivation: live user complaint 2026-08-12, Tina interrupted mid-thought:
 * "Why does this keep on saying the same line?" Being too chatty/repetitive is a
 * named product failure mode; the quietest-channel principle is core to this product.
 *
 * This is pure logic — no I/O, no external dependencies. It normalizes text
 * (trim/case/whitespace-collapse), tracks recent utterances per channel, and
 * returns allow/suppress verdicts. Sound effects (!airhorn-style lines) are exempt:
 * repeating a sound effect is intentional comedy, per the Brainrot register.
 *
 * Window: a line is suppressed if it matches one still inside BOTH bounds — within the
 * last N lines AND newer than T. Whichever bound lapses first releases the line.
 * Default: 20 lines, 10 minutes.
 */

/** Channel type for tracking utterances independently. */
export type Channel = 'speak' | 'chat';

/** Single utterance record with timestamp and normalized text. */
interface Utterance {
  normalized: string;
  timestamp: number;
}

/** Configuration for the repetition guard. */
export interface RepetitionGuardConfig {
  /** Minimum number of lines to keep in history (default: 20). */
  minLines?: number;
  /** Minimum time window in milliseconds (default: 10 minutes). */
  minTimeMs?: number;
}

/** Verdict returned by check() — either allow or suppress with details. */
export type Verdict =
  | { allowed: true }
  | { allowed: false; reason: 'duplicate'; normalized: string; seenAt: number };

/**
 * Normalize text for duplicate detection: trim, lowercase, collapse whitespace.
 * Sound effects (lines starting with "!") are never normalized — they bypass
 * the guard entirely in check().
 */
export function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Check if a line is a sound effect (exempt from repetition checking).
 * Sound effects start with "!" — repeating them is intentional comedy.
 */
export function isSoundEffect(text: string): boolean {
  return text.trim().startsWith('!');
}

/**
 * Create a repetition guard for a specific channel.
 *
 * The guard tracks recent utterances in a ring buffer (capped at maxLines) AND
 * evicts by time (older than maxTimeMs). A line is suppressed if it matches ANY
 * line still inside BOTH bounds; the first bound to lapse releases it.
 *
 * Errors propagate — no fallbacks, no silent failures.
 */
export function createRepetitionGuard(channel: Channel, config: RepetitionGuardConfig = {}): RepetitionGuard {
  const maxLines = config.minLines ?? 20;
  const maxTimeMs = config.minTimeMs ?? 10 * 60 * 1000; // 10 minutes

  const history: Utterance[] = [];

  return {
    channel,
    check(line: string): Verdict {
      // Sound effects are exempt — always allowed
      if (isSoundEffect(line)) {
        return { allowed: true };
      }

      const normalized = normalize(line);
      const now = Date.now();

      // Check for duplicate within window
      for (let i = 0; i < history.length; i++) {
        const utterance = history[i];
        const age = now - utterance.timestamp;

        // Both conditions must be met for the utterance to be in-window:
        // - Within maxLines (already true since we're iterating the array)
        // - Within maxTimeMs
        if (age <= maxTimeMs && utterance.normalized === normalized) {
          return { allowed: false, reason: 'duplicate', normalized, seenAt: utterance.timestamp };
        }
      }

      // Line is unique — record it
      history.push({ normalized, timestamp: now });

      // Evict expired entries:
      // 1. Drop old entries beyond maxLines (FIFO from front)
      while (history.length > maxLines) {
        history.shift();
      }
      // 2. Drop entries older than maxTimeMs (scan from front)
      const cutoff = now - maxTimeMs;
      let drop = 0;
      for (let i = 0; i < history.length; i++) {
        if (history[i].timestamp >= cutoff) break;
        drop++;
      }
      while (drop-- > 0) {
        history.shift();
      }

      return { allowed: true };
    },

    /** Clear all history (for testing or reset). */
    clear(): void {
      history.length = 0;
    },

    /** Get current history size (for testing/observability). */
    get size(): number {
      return history.length;
    },
  };
}

/** A repetition guard instance per channel. */
export interface RepetitionGuard {
  /** The channel this guard is checking. */
  readonly channel: Channel;
  /**
   * Check if a line should be allowed or suppressed.
   * Returns a verdict; suppressions include the duplicate's timestamp.
   */
  check(line: string): Verdict;
  /** Clear all history. */
  clear(): void;
  /** Current number of lines in history. */
  readonly size: number;
}
