/**
 * DOES THE LAB ROOM STILL EXIST, AND IS IT STILL OPEN — the join failures nothing else can name.
 *
 * A Meet code stops resolving: a Quick-access room dies with its call, and nobody has measured
 * whether an API-created OPEN space expires after long disuse. A room can also survive but stop
 * being OPEN, which leaves the bot knocking at a door only a host can answer. Both present exactly
 * like a sign-in wall, a wedged runtime and a dead X display: the meeting sits at `joining` until
 * the admission timeout, and the gateway can only ever say `joining`.
 *
 * Two things had to be measured before this could work at all (2026-08-28):
 *
 *   1. An unauthenticated GET cannot tell. meet.google.com returns the same 200 and the same
 *      4301-byte JS shell for a live code and for zzz-zzzz-zzz — the code is resolved client side.
 *   2. A PLAIN Playwright Chromium cannot tell either. Google serves it "You can't join this video
 *      call" for every code, live or dead — the same interstitial bot-selfcheck.ts documents. The
 *      bot itself walks in because of the join lane's flag set, so this probe borrows it verbatim.
 *      Without those args this rung reports every room dead, which is worse than not having it.
 *
 * Anonymous is deliberate: the question is whether a STRANGER can still get in, which is what the
 * lab rooms exist for. A signed-in probe would pass on a room no guest can enter.
 *
 *   node room-bench.mjs <code> [<code> ...]
 */
import { chromium } from '/app/core/meetings/modules/remote-browser/node_modules/playwright/index.mjs';

const { getJoinBrowserArgs } = await import('/app/core/meetings/modules/join/dist/index.js');
const { getAuthenticatedBrowserArgs } = await import('/app/core/meetings/modules/remote-browser/dist/index.js');

const codes = process.argv.slice(2);
if (!codes.length) { console.log('usage: room-bench.mjs <meet-code> [...]'); process.exit(2); }

const DEAD = /check your meeting code|invalid video call name|couldn'?t find/i;
const OPEN = /this call is open to anyone/i;          // accessType=OPEN, what lab-room.py mints
const LOBBY = /what'?s your name|ask to join|join now/i;   // resolves, but may require admission

const browser = await chromium.launch({
  executablePath: '/ms-playwright/chromium-1194/chrome-linux/chrome',
  headless: false,
  args: [...getAuthenticatedBrowserArgs(), ...getJoinBrowserArgs()].filter((a) => a !== '--incognito'),
});

let fail = 0;
for (const code of codes) {
  const page = await browser.newPage();
  await page.goto(`https://meet.google.com/${code}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The verdict is rendered by JS after the shell loads. Poll rather than guess one sleep length:
  // a slow render read as "undecided" would be a red rung for a healthy room.
  let text = '', verdict = null;
  for (let i = 0; i < 30 && !verdict; i++) {
    await page.waitForTimeout(1000);
    text = await page.evaluate(() => globalThis.document.body.innerText || '');
    if (DEAD.test(text)) verdict = 'dead';
    else if (OPEN.test(text)) verdict = 'open';
    else if (LOBBY.test(text)) verdict = 'closed';
  }
  if (verdict === 'open') console.log(`PASS room ${code} resolves and is still open to anyone`);
  else if (verdict === 'closed') console.log(`FAIL room ${code} resolves but is NO LONGER OPEN — a bot will knock forever; ./lab-room.py open ${code}`);
  else if (verdict === 'dead') console.log(`FAIL room ${code} NO LONGER RESOLVES — mint a new one with ./lab-room.py create`);
  else console.log(`FAIL room ${code} undecided after 30s — Meet's wording changed, or the join args no longer get past the bot interstitial`);
  if (verdict !== 'open') fail = 1;
  await page.close();
}

await browser.close();
console.log(fail ? 'ROOM CHECK RED' : 'ROOM CHECK GREEN');
process.exit(fail);
