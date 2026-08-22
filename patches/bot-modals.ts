/**
 * MID-CALL MODAL SWEEP — shared by every surface that clicks the Meet UI.  (#50)
 *
 * Meet raises dialogs hours into a call: "Your call is ending soon", "Others might see more of
 * your background", and friends. They lay an overlay across the toolbar and panels, so Playwright's
 * actionability check never resolves and the act hangs until timeout — no click, no error, no log.
 *
 * `gmeet-selectors.ts` already dismisses the Gemini consent dialog and the error dialogs, but all
 * of that is consumed during the JOIN sequence. Nothing swept afterwards, which is why a chat send
 * silently did nothing on 2026-08-21 while the bot was otherwise healthy and transcribing.
 *
 * Scoping is the whole design. Inside a [role=dialog] an acknowledgement button is unambiguous, so
 * "Got it" / "Dismiss" / "OK" / "Close" are all safe. OUTSIDE a dialog only an exact "Got it" is
 * safe — an unscoped "Close" would hit the chat panel's own close button and shut the surface the
 * caller is about to use.
 *
 * Returns the labels it clicked so callers log a sweep rather than doing it invisibly: a modal
 * appearing every few minutes is itself a signal, and silently papering over it would hide that.
 */

/** Click acknowledgement buttons on any mid-call modal. Returns what it dismissed, newest first. */
export async function dismissModals(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const label = (b: any) => String(b.getAttribute('aria-label') || b.textContent || '').trim();
    const hit: string[] = [];
    for (const dlg of Array.from(doc.querySelectorAll('[role="dialog"],[role="alertdialog"]')) as any[]) {
      for (const b of Array.from(dlg.querySelectorAll('button,[role="button"]')) as any[]) {
        if (/^(got it|dismiss|ok|okay|close)$/i.test(label(b))) { b.click(); hit.push(label(b)); break; }
      }
    }
    if (!hit.length) {
      for (const b of Array.from(doc.querySelectorAll('button,[role="button"]')) as any[]) {
        if (/^got it$/i.test(label(b))) { b.click(); hit.push(label(b)); break; }
      }
    }
    return hit;
  });
}

/** Sweep, and say so. Every surface that is about to click the Meet UI should call this first. */
export async function sweep(page: any, who: string, log: (m: string) => void): Promise<void> {
  const cleared = await dismissModals(page);
  if (cleared.length) log(`[${who}] dismissed modal: ${JSON.stringify(cleared)}`);
}
