/**
 * E2E OBSERVER — a second participant that joins the meeting and reports what it can SEE.
 *
 * Everything e2e.sh asserted before this was the bot's own self-report, which cannot tell you
 * whether a chat message actually landed, a reaction fired, the camera shows a feed, or a tab is
 * really being shared. This joins as an ordinary guest and reads the DOM, so every surface of the
 * unofficial Meet API can be asserted from the outside, with no human in the room.
 *
 *   node observer.mjs <meet-code> [--name X] [--seconds N] [--json-out /tmp/obs.json]
 *
 * Prints one JSON object. Requires an OPEN meeting (Quick access on) — a guest that has to knock
 * cannot be admitted autonomously, which is the same constraint the bot lives under.
 */
import { chromium } from '/app/core/meetings/modules/remote-browser/node_modules/playwright/index.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';

const args = process.argv.slice(2);
const code = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const NAME = opt('--name', 'E2E Observer');
const SECONDS = Number(opt('--seconds', 25));
const OUT = opt('--json-out', '');
if (!code) { console.error('usage: observer.mjs <meet-code> [--name X] [--seconds N]'); process.exit(2); }

const result = { code, name: NAME, joined: false, participants: [], chat: [], presenting: null,
                 tilesWithVideo: [], reactions: [], errors: [] };

// Join with the EXACT args the bot uses. A hand-rolled flag set got "You can't join this video
// call" — Google's bot-detection interstitial, which @vexa/join's comments specifically warn
// about. Importing the canonical set means the observer is as joinable as the bot itself.
const { JOIN_BROWSER_ARGS } = await import('/app/core/meetings/modules/join/dist/browser-args.js');

// Use the BOT'S OWN launcher. remote-browser/browser.ts imports chromium from `playwright-extra`
// (a stealth wrapper); plain playwright — ephemeral OR persistent, with identical flags — got
// Google's "You can't join this video call" interstitial every time while the bot walked in.
// Reusing launchPersistentBrowser means the observer is exactly as joinable as the bot.
const rb = await import('/app/core/meetings/modules/remote-browser/dist/index.js');
const { launchPersistentBrowser, getAuthenticatedBrowserArgs } = rb.default ?? rb;

const dataDir = mkdtempSync('/tmp/observer-profile-');
const { context: ctx0 } = await launchPersistentBrowser({
  dataDir,
  args: [...getAuthenticatedBrowserArgs(),
         ...JOIN_BROWSER_ARGS.filter((a) => !a.startsWith('--auto-select-tab-capture')),
         '--window-position=980,0', '--window-size=920,900'],
});
const browser = { contexts: () => [ctx0], close: () => ctx0.close() };

try {
  const page = ctx0.pages()[0] || await ctx0.newPage();
  await page.goto(`https://meet.google.com/${code}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Guest pre-join: Meet asks for a name, then offers Ask to join / Join now.
  const nameBox = page.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first();
  await nameBox.waitFor({ state: 'visible', timeout: 30000 });
  await nameBox.fill(NAME);
  await page.locator('button:has-text("Ask to join"), button:has-text("Join now")').first()
            .click({ timeout: 15000 });

  // Admitted iff the in-call toolbar appears. On an open meeting this is immediate; if the room
  // is NOT open the guest sits in the lobby forever and this times out — report it rather than hang.
  await page.locator('button[aria-label*="Leave call" i]').waitFor({ state: 'visible', timeout: 60000 });
  result.joined = true;

  await page.waitForTimeout(SECONDS * 1000);   // let the bot do whatever is being tested

  // ── what the observer can see ───────────────────────────────────────────────────────────────
  Object.assign(result, await page.evaluate(() => {
    const txt = (el) => (el?.textContent || '').trim();
    const out = { participants: [], tilesWithVideo: [], presenting: null };

    // Participant names: Meet renders each tile's name in a text node inside the tile container.
    const names = new Set();
    for (const el of document.querySelectorAll('[data-participant-id]')) {
      const n = txt(el).split('\n')[0];
      if (n) names.add(n);
    }
    out.participants = [...names];

    // A tile is showing real video (not an avatar) iff its <video> has non-zero intrinsic size.
    for (const v of document.querySelectorAll('video')) {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        const tile = v.closest('[data-participant-id]');
        out.tilesWithVideo.push(`${txt(tile).split('\n')[0] || 'unknown'} ${v.videoWidth}x${v.videoHeight}`);
      }
    }

    // Presenting banner / tile.
    const body = document.body.innerText || '';
    const m = body.match(/([^\n]*)\s+is presenting/i);
    out.presenting = m ? m[1].trim() : (/you are presenting/i.test(body) ? 'self' : null);
    return out;
  }));

  // Chat panel — opening it is required; messages are not in the DOM until then.
  try {
    await page.locator('button[aria-label*="Chat with everyone" i], button[aria-label*="chat" i]')
              .first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    result.chat = await page.evaluate(() =>
      [...document.querySelectorAll('[data-message-text], [data-message-id]')]
        .map((e) => ({ sender: e.getAttribute('data-sender-name') || '',
                       text: (e.getAttribute('data-message-text') || e.textContent || '').trim() }))
        .filter((m) => m.text));
  } catch (e) { result.errors.push(`chat panel: ${e.message}`); }

} catch (e) {
  result.errors.push(String(e.message || e));
  // Evidence on failure, so a headless run is diagnosable without a human watching :99.
  try {
    const p = (await browser.contexts()[0]?.pages()) || [];
    if (p[0]) {
      await p[0].screenshot({ path: '/tmp/observer-fail.png' });
      result.failShot = '/tmp/observer-fail.png';
      result.failText = (await p[0].evaluate(() => (document.body.innerText || '').slice(0, 400)))
                          .replace(/\n+/g, ' | ');
    }
  } catch (e2) { result.errors.push(`shot: ${e2.message}`); }
} finally {
  await browser.close().catch(() => {});
}

const json = JSON.stringify(result, null, 1);
if (OUT) writeFileSync(OUT, json);
console.log(json);
process.exit(result.joined ? 0 : 1);
