/**
 * Google Meet chat reader — SHARED browser module, mirror of teams-chat.ts / zoom-chat.ts.
 * Watches the Meet chat panel and emits each new message as { sender, text }.
 * Pure DOM observation — no audio, no network.
 *
 * Meet is friendlier than Teams/Zoom here: the message rows carry real data-* attributes
 * (data-message-id / data-sender-name / data-message-text) and the list is a [role="log"]
 * aria-live region. Those are tried FIRST and obfuscated classes only as a last resort —
 * gmeet-speakers.ts documents a class-learning heuristic that was REMOVED after it mislearned
 * a class and collapsed every channel onto one speaker. Do not repeat that mistake here.
 *
 * Two constraints inherited from Meet itself:
 *   • the chat panel must be OPEN or the messages are not in the DOM at all;
 *   • Meet delivers only messages sent AFTER you join — there is no backfill to scrape.
 *
 * getState() surfaces what matched plus a structural dump, so the selectors below can be
 * tuned from live telemetry rather than guessed at again.
 */

export interface GmeetChatMessage { sender: string; text: string }

export interface GmeetChatOptions {
  log?: (m: string) => void;
  onMessage: (msg: GmeetChatMessage) => void;
}

export interface GmeetChat {
  destroy(): void;
  getState(): {
    matchedContainer: string | null;
    seen: number;
    recent: GmeetChatMessage[];
    candidates: Array<{ sel: string; count: number }>;
    sample: { sel: string; structure: string[] } | null;
  };
}

// Semantic first, obfuscated last.
const CONTAINER_SELECTORS = [
  'div[aria-live="polite"][role="log"]',
  'div[role="log"]',
  '[aria-label*="Messages from"]',
  '[aria-label*="In-call messages"]',
  '[jsname][data-chat-container]',
  '[class*="chat-messages"]',
];
const MESSAGE_SELECTORS = [
  'div[data-message-id]',
  'div[data-message-text]',
  'div[jsname][data-sender-name]',
  '[role="listitem"]',
  '[class*="chat-message"]',
];
const SENDER_SELECTORS = [
  '[data-sender-name]',
  '[class*="sender-name"]',
  '[class*="senderName"]',
];
const TEXT_SELECTORS = [
  '[data-message-text]',
  '[class*="message-text"]',
  '[class*="messageText"]',
  'div[jsname][dir="auto"]',
  'div[dir="auto"]',
];

export function createGmeetChat(opts: GmeetChatOptions): GmeetChat {
  const log = opts.log || (() => {});
  const seenNodes = new WeakSet<Element>();
  const seenHashes = new Set<string>();
  const recent: GmeetChatMessage[] = [];
  let matchedContainer: string | null = null;
  let container: Element | null = null;

  const attr = (root: Element, selectors: string[], name: string): string => {
    for (const s of selectors) {
      const el = root.matches?.(s) ? root : root.querySelector(s);
      const v = el?.getAttribute?.(name)?.trim();
      if (v) return v;
    }
    return '';
  };

  const firstText = (root: Element, selectors: string[]): string => {
    for (const s of selectors) {
      const el = root.matches?.(s) ? root : root.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  };

  const extract = (node: Element): GmeetChatMessage | null => {
    // Preferred path: Meet puts both on attributes, so no text-scraping heuristics needed.
    let sender = attr(node, SENDER_SELECTORS, 'data-sender-name');
    let text = attr(node, TEXT_SELECTORS, 'data-message-text');

    if (!text) text = firstText(node, TEXT_SELECTORS);
    if (!sender) sender = firstText(node, SENDER_SELECTORS);

    // Sender is grouped: Meet prints one header for a run of messages from the same person,
    // so climb to the group wrapper before giving up.
    if (!sender) {
      let cur: Element | null = node.parentElement;
      for (let i = 0; i < 4 && cur && !sender; i++, cur = cur.parentElement) {
        sender = attr(cur, SENDER_SELECTORS, 'data-sender-name') || firstText(cur, SENDER_SELECTORS);
      }
    }

    // Last resort: largest leaf text is the body, a short sibling is the name.
    if (!text) {
      const frags = Array.from(node.querySelectorAll('*'))
        .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
        .filter((t) => t.length > 0);
      if (!frags.length) return null;
      const longest = frags.reduce((a, b) => (b.length > a.length ? b : a), '');
      text = longest;
      if (!sender) {
        const shortName = frags.find((f) => f !== longest && f.length <= 40 && !/^\d{1,2}:\d{2}/.test(f));
        if (shortName) sender = shortName;
      }
    }

    // Meet appends a time to the header row ("Andrew Miller 10:42 AM"); strip it.
    sender = sender.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, '').trim() || 'Unknown';
    if (!text) return null;
    return { sender, text };
  };

  const dumpNode = (node: Element): string[] =>
    Array.from(node.querySelectorAll('*')).slice(0, 25).map((e) => {
      const cls = (e.getAttribute('class') || '').slice(0, 40);
      const data = ['data-message-id', 'data-sender-name', 'data-message-text']
        .map((a) => (e.hasAttribute(a) ? `${a}=${(e.getAttribute(a) || '').slice(0, 20)}` : ''))
        .filter(Boolean).join(',');
      const aria = e.getAttribute('aria-label');
      const t = e.childElementCount === 0 ? (e.textContent || '').trim().slice(0, 30) : '';
      return `${e.tagName.toLowerCase()}${data ? '[' + data + ']' : ''}${cls ? '.' + cls : ''}${aria ? '[al=' + aria.slice(0, 30) + ']' : ''}${t ? ' »' + t : ''}`;
    });

  const emit = (node: Element) => {
    if (seenNodes.has(node)) return;
    seenNodes.add(node);
    const msg = extract(node);
    if (!msg) return;
    const hash = `${msg.sender} ${msg.text}`;
    if (seenHashes.has(hash)) return;   // the list re-renders the same row on scroll
    seenHashes.add(hash);
    recent.push(msg);
    if (recent.length > 30) recent.shift();
    log(`chat ${msg.sender}: ${msg.text.slice(0, 60)}`);
    try { opts.onMessage(msg); } catch { /* never break capture */ }
  };

  const scanMessages = (root: ParentNode) => {
    for (const sel of MESSAGE_SELECTORS) {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length) { nodes.forEach((n) => emit(n)); return; }
    }
  };

  const findContainer = (): Element | null => {
    for (const sel of CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) { matchedContainer = sel; return el; }
    }
    return null;
  };

  // The panel mounts/unmounts as chat is toggled — poll to (re)find the container, and let the
  // observer handle new messages while it is mounted.
  const observer = new MutationObserver(() => { if (container) scanMessages(container); });
  const attach = () => {
    const found = findContainer();
    if (found && found !== container) {
      container = found;
      observer.disconnect();
      observer.observe(container, { childList: true, subtree: true });
      scanMessages(container);
      log(`chat container matched: ${matchedContainer}`);
    } else if (found) {
      scanMessages(container!);
    }
  };
  attach();
  const poll = window.setInterval(attach, 2000);

  return {
    destroy() { window.clearInterval(poll); observer.disconnect(); },
    getState() {
      let sample: { sel: string; structure: string[] } | null = null;
      if (container) {
        for (const sel of MESSAGE_SELECTORS) {
          const n = container.querySelector(sel);
          if (n) { sample = { sel, structure: dumpNode(n) }; break; }
        }
      }
      return {
        matchedContainer,
        seen: seenHashes.size,
        recent: recent.slice(-10),
        candidates: CONTAINER_SELECTORS.map((sel) => ({ sel, count: document.querySelectorAll(sel).length })),
        sample,
      };
    },
  };
}
