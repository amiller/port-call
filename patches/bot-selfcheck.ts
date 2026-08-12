/**
 * SELF-CHECK — what the bot can verify about itself, with no second participant in the room.
 *
 * An external observer would be better, but a second automated guest gets Google's "You can't
 * join this video call" interstitial (four launch strategies tried, all blocked, while the bot
 * itself walks in). Most surfaces don't need one: an outbound RTP track with a RISING framesSent
 * is proof the camera is really transmitting, not merely enabled, and Meet's own DOM tells us
 * whether we're presenting and what chat holds.
 *
 * The result is written to the bot's stdout as one `[selfcheck] {...}` line, which lands in
 * /tmp/vexa-workloads/mtg-<id>-*.log — so e2e.sh reads it with grep and needs no new plumbing.
 */
import type { Page } from '@vexa/remote-browser';

export interface SelfCheck { run(): Promise<void>; }

export function createSelfCheck(page: Page): SelfCheck {
  return {
    async run(): Promise<void> {
      // Sample twice: framesSent is only meaningful as a DELTA. A stalled encoder reports a
      // large-but-frozen count, which a single sample cannot distinguish from a live feed.
      const sample = () => page.evaluate(async () => {
        const g: any = globalThis as any;
        const doc = g.document;
        const out: any = { outboundVideo: [], outboundAudio: [] };
        const pcs = (g.__vexa_peer_connections as any[]) || [];
        out.peerConnections = pcs.length;
        for (const pc of pcs) {
          if (pc.connectionState === 'closed') continue;
          try {
            const stats = await pc.getStats();
            stats.forEach((r: any) => {
              if (r.type !== 'outbound-rtp') return;
              if (r.kind === 'video') out.outboundVideo.push({ frames: r.framesSent ?? 0, w: r.frameWidth ?? 0, h: r.frameHeight ?? 0 });
              if (r.kind === 'audio') out.outboundAudio.push({ packets: r.packetsSent ?? 0 });
            });
          } catch { /* a closing pc mid-iteration is not a failure */ }
        }
        const body: string = doc?.body?.innerText || '';
        out.presenting = /you are presenting|stop presenting/i.test(body);
        // Meet's own view of the camera: the toggle reads "Turn OFF camera" only while it is on.
        // Canvas frames prove our feed draws; this proves Meet is publishing it.
        out.hud = (g.__vexaCam && g.__vexaCam.state) ? g.__vexaCam.state() : null;
        out.cameraOn = Array.from(doc.querySelectorAll('button'))
          .some((b: any) => /turn off camera/i.test(b.getAttribute('aria-label') || ''));
        out.participantTiles = doc.querySelectorAll('[data-participant-id]').length;
        // Every visible control's aria-label. Meet's labels shift; writing selectors from a live
        // dump beats guessing (a guessed chat-button selector cost a whole test cycle).
        out.buttons = Array.from(doc.querySelectorAll('button,[role="button"]'))
          .filter((b: any) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map((b: any) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 60))
          .filter((s: string) => s);
        // Text-entry targets, for the same reason as buttons: write selectors from a live dump.
        out.inputs = Array.from(doc.querySelectorAll('textarea,input,[contenteditable="true"]'))
          .filter((b: any) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map((b: any) => `${b.tagName.toLowerCase()}[${b.getAttribute('aria-label') || b.getAttribute('placeholder') || b.getAttribute('jsname') || '?'}]`);
        // Structural dump of chat nodes: which data-* attributes REAL Meet actually puts where.
        // A mock built from assumption validated the assumption; this reads the truth.
        const logEl = doc.querySelector('[role="log"], [aria-live="polite"]');
        out.chatNodes = Array.from((logEl || doc).querySelectorAll('[data-message-id],[data-message-text],[data-sender-name]'))
          .slice(0, 6)
          .map((e: any) => `${e.tagName.toLowerCase()} attrs=[${e.getAttributeNames().filter((a: string) => a.startsWith('data-')).join(',')}] text="${(e.textContent || '').trim().slice(0, 40)}"`);
        out.chat = Array.from(doc.querySelectorAll('[data-message-text]')).map((e: any) => ({
          sender: e.getAttribute('data-sender-name') || '',
          text: e.getAttribute('data-message-text') || '',
        }));
        return out;
      });

      const a = await sample();
      await new Promise((r) => setTimeout(r, 2000));
      const b = await sample();

      const sum = (xs: any[], k: string) => xs.reduce((n, x) => n + (x[k] || 0), 0);
      const result = {
        peerConnections: b.peerConnections,
        presenting: b.presenting,
        cameraOn: b.cameraOn,
        hud: b.hud,
        participantTiles: b.participantTiles,
        buttons: b.buttons,
        inputs: b.inputs,
        chatNodes: b.chatNodes,
        chat: b.chat,
        videoFramesDelta: sum(b.outboundVideo, 'frames') - sum(a.outboundVideo, 'frames'),
        audioPacketsDelta: sum(b.outboundAudio, 'packets') - sum(a.outboundAudio, 'packets'),
        videoSize: b.outboundVideo.map((v: any) => `${v.w}x${v.h}`),
      };
      console.log('[selfcheck] ' + JSON.stringify(result));
    },
  };
}
