/**
 * CHAT — post and read Google Meet chat messages.
 *
 * `chat_send` / `chat_read` have been declared in acts.v1 all along with no implementation; this
 * supplies both. Meet does not put chat messages in the DOM until the panel has been opened, so
 * every operation opens it first (idempotent — reopening a panel that is already open is a no-op
 * because we look for the message input before clicking).
 *
 * Read is a poll of the panel rather than the bundle's MutationObserver reader
 * (`createGmeetChat`): an act is request/response, and polling needs no page↔node bridge.
 *
 * Results go to stdout as one `[chat] {...}` line, landing in /tmp/vexa-workloads/mtg-<id>-*.log,
 * so the e2e harness reads them with grep — same convention as `[selfcheck]`.
 */
import type { Page } from '@vexa/remote-browser';

const OPEN = 'button[aria-label*="Chat with everyone" i], button[aria-label*="chat" i]';
const INPUT = 'textarea[aria-label*="Send a message" i], textarea[placeholder*="Send a message" i], ' +
              'div[contenteditable="true"][aria-label*="message" i]';
const SEND = 'button[aria-label*="Send message" i], button[aria-label*="Send a message" i]';

export interface ChatController {
  send(text: string): Promise<void>;
  read(): Promise<void>;
}

export function createChatController(page: Page): ChatController {
  // Meet AUTO-HIDES the in-call toolbar after a few seconds with no pointer activity, and the bot
  // never moves a real mouse — so every toolbar control reads isVisible:false and any click times
  // out. The join layer already fights this (googlemeet/admission.ts moves the pointer before
  // probing); do the same before touching the toolbar. This is why an act works right after
  // another act and fails from idle.
  const wakeToolbar = async (): Promise<void> => {
    await page.mouse.move(640, 360).catch(() => {});
    await page.mouse.move(900, 700).catch(() => {});
    await page.waitForTimeout(400);
  };

  const openPanel = async (): Promise<void> => {
    if (await page.locator(INPUT).first().isVisible().catch(() => false)) return;
    await wakeToolbar();
    await page.locator(OPEN).first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator(OPEN).first().click({ timeout: 10_000 });
    await page.locator(INPUT).first().waitFor({ state: 'visible', timeout: 10_000 });
  };

  // REAL Meet (dumped 2026-08-11) exposes only `data-message-id` on the message container — there
  // is NO `data-message-text` attribute, and no `data-sender-name` alongside it. An earlier
  // version read those attributes and returned NOTHING in production while passing a mock that
  // had invented them. So: take the container's text, minus the nested controls, because raw
  // textContent is "dom dump probeHover over a message to pin itkeepPin message".
  const messages = () => page.evaluate(() => {
    const doc = (globalThis as any).document;
    const log = doc.querySelector('[role="log"], [aria-live="polite"]') || doc;
    const out: Array<{ sender: string; text: string }> = [];
    for (const node of Array.from(log.querySelectorAll('div[data-message-id]')) as any[]) {
      if (node.closest('button')) continue;              // the "keep" button carries the id too
      const clone = node.cloneNode(true) as any;
      clone.querySelectorAll('button,[role="button"],[aria-label]').forEach((b: any) => b.remove());
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const holder = node.closest('[data-sender-name]');
      out.push({ sender: (holder?.getAttribute('data-sender-name') || '').trim(), text });
    }
    return out;
  });

  return {
    async send(text: string): Promise<void> {
      await page.bringToFront();
      await openPanel();
      const box = page.locator(INPUT).first();
      await box.click({ timeout: 5_000 });
      await box.fill(text);
      // Enter first (Meet's normal path); fall back to the explicit send button if the box did
      // not clear, which is the observable signal that the message was actually submitted.
      await box.press('Enter');
      if ((await box.inputValue().catch(() => '')) === text) {
        await page.locator(SEND).first().click({ timeout: 5_000 });
      }
      console.log('[chat] ' + JSON.stringify({ sent: text }));
    },

    async read(): Promise<void> {
      await page.bringToFront();
      await openPanel();
      console.log('[chat] ' + JSON.stringify({ messages: await messages() }));
    },
  };
}
