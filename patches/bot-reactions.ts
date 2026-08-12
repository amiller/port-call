/**
 * REACTIONS — send a Meet emoji reaction.
 *
 * The toolbar control is `Send a reaction` (confirmed from a live aria-label dump, not guessed).
 * It opens a picker whose entries are buttons labelled with the emoji name, e.g. "Send 🎉" /
 * "party popper". We match loosely because Meet localises and re-words these.
 *
 * Like every other toolbar act this must WAKE THE TOOLBAR first: Meet auto-hides it after a few
 * seconds without pointer activity and the bot never moves a real mouse, so controls read
 * isVisible:false and clicks time out.
 */
import type { Page } from '@vexa/remote-browser';

const REACT_BTN = 'button[aria-label*="Send a reaction" i], button[aria-label*="reaction" i]';

export interface ReactionController { send(emoji: string): Promise<void>; }

export function createReactionController(page: Page): ReactionController {
  return {
    async send(emoji: string): Promise<void> {
      await page.bringToFront();
      await page.mouse.move(640, 360).catch(() => {});
      await page.mouse.move(900, 700).catch(() => {});
      await page.waitForTimeout(400);

      // force:true — while the bot is PRESENTING, Meet lays a banner/overlay over the toolbar, so
      // the locator resolves but Playwright's actionability check never settles and the click
      // times out. A reaction needs no trusted gesture, so bypassing the check is safe here.
      await page.locator(REACT_BTN).first().waitFor({ state: 'attached', timeout: 20_000 });
      await page.locator(REACT_BTN).first().click({ timeout: 10_000, force: true });
      await page.waitForTimeout(1200);

      // Match the picker entry IN THE PAGE rather than with a CSS selector: an emoji in a
      // `[aria-label*="..."]` selector does not survive Playwright's selector parser (astral-plane
      // characters), which failed with a visibility timeout even though the entry was on screen.
      // A reaction needs no trusted-gesture guarantee (unlike getDisplayMedia), so a DOM click is
      // sufficient here.
      const res = await page.evaluate((e: string) => {
        const doc = (globalThis as any).document;
        const nodes = Array.from(doc.querySelectorAll('button,[role="menuitem"],[role="button"],img'));
        // Meet may render a reaction as an <img alt="🎉"> or via aria-label rather than text, so
        // consider all three surfaces before deciding the entry is absent.
        const label = (n: any) => [n.getAttribute('aria-label'), n.getAttribute('alt'),
                                   n.getAttribute('data-emoji'), n.textContent].filter(Boolean).join(' ');
        const hit = nodes.find((n: any) => label(n).includes(e));
        if (hit) { const h = hit as any; (h.closest('button,[role="button"]') || h).click(); return { ok: true }; }
        // Self-diagnosing failure: report the candidates instead of just "not found".
        const dlg = doc.querySelector('[role="dialog"],[role="menu"]');
        return { ok: false, candidates: Array.from((dlg || doc).querySelectorAll('button,img'))
          .map((n: any) => label(n).trim().slice(0, 24)).filter(Boolean).slice(0, 24) };
      }, emoji);
      if (!res.ok) {
        console.log('[reaction] ' + JSON.stringify({ missing: emoji, candidates: res.candidates }));
        throw new Error(`reaction picker has no entry for ${emoji}`);
      }
      console.log('[reaction] ' + JSON.stringify({ sent: emoji }));
    },
  };
}
