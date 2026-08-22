/**
 * SCREENSHARE — present to the room.
 *
 * The share surface is the canvas defined by CAMERA_INIT_SCRIPT: that script patches
 * navigator.mediaDevices.getDisplayMedia, so clicking Meet's "Share screen" hands Meet OUR stream
 * and Chrome's picker is never consulted.
 *
 * That matters because every route through Chrome's own capture is a dead end in this image:
 *  - X11 DESKTOP capture (screen and window) fails at device launch — `Create(source=screen:0:0)`
 *    → `OnDeviceLaunchFailed`, error 31 — with the X capturer initialising fine. Ruled out:
 *    missing X extensions, GPU flags, /dev/shm size. Root cause never found.
 *  - `--use-fake-ui-for-media-stream` (required for JOIN — without it the humanized clicker misses
 *    every control and the bot never joins) auto-answers getDisplayMedia with that broken screen.
 * Patching in the page sidesteps both, because the request never reaches Chrome.
 *
 * Earlier this file opened a "stage" tab and tried to pick it from Meet's share submenu. That was
 * built on a false premise: Meet's Present button opens NO submenu, it calls getDisplayMedia
 * immediately, so there was never an "a tab" option to click.
 */
import type { Page } from '@vexa/remote-browser';
import { sweep } from './modals.js';

const SHARE = 'button[aria-label*="Share screen" i], button[aria-label*="Present now" i]';
// Real Meet's stop control carries NO matching aria-label — its TEXT is
// "cancel_presentationStop presenting" (a material-icon ligature followed by the label), so an
// aria-label-only selector fails while the share is genuinely running. Match text as well.
const STOP = 'button:has-text("Stop presenting"), button:has-text("Stop sharing"), ' +
             'button[aria-label*="Stop presenting" i], button[aria-label*="Stop sharing" i]';

export interface ScreenShareController {
  share(text: string): Promise<void>;
  stop(): Promise<void>;
}

export function createScreenShareController(page: Page, platform: string): ScreenShareController {
  // Meet auto-hides the toolbar after a few seconds without pointer activity and the bot never
  // moves a real mouse, so controls read isVisible:false and clicks time out from idle.
  const wake = async () => {
    await page.mouse.move(640, 360).catch(() => {});
    await page.mouse.move(900, 700).catch(() => {});
    await page.waitForTimeout(400);
  };

  return {
    async share(text: string): Promise<void> {
      if (platform !== 'google_meet') throw new Error(`screen_share unsupported on ${platform}`);
      await page.bringToFront();
      await sweep(page, 'share', (m) => console.log(m));
      await page.evaluate((t) => (globalThis as any).__vexaCam?.set(t, 'presenting'), text);
      await wake();
      await page.locator(SHARE).first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator(SHARE).first().click({ timeout: 10_000 });

      // Proof, not optimism: a share that did not start must fail the act loudly rather than
      // report a success nobody in the room can see.
      await page.locator(STOP).first().waitFor({ state: 'visible', timeout: 20_000 });
      console.log('[share] ' + JSON.stringify({ presenting: true, text }));
    },

    async stop(): Promise<void> {
      await page.bringToFront();
      await wake();
      await page.locator(STOP).first().click({ timeout: 10_000 });
      console.log('[share] ' + JSON.stringify({ presenting: false }));
    },
  };
}
