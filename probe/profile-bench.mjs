/**
 * PROFILE DETECTION — a mounted-but-empty volume is not a signed-in Google profile.
 *
 * The bot decides between signed-in mode and a guest join by looking at
 * /var/lib/vexa/google-session-live. That check used to be a bare existsSync on the DIRECTORY, and
 * Docker creates a mount point the moment a compose file declares the volume — so a hosted instance
 * with no profile at all reported itself authenticated, skipped guest name-entry, and then sat on
 * Meet's "What's your name?" with Join now greyed out until the 5-minute admission timeout
 * destroyed the workload. The gateway could only say "the bot never reported" (port-call-demo2,
 * 2026-08-27).
 *
 * It belongs on the bench rung and not in a room: it needs no meeting, no bot and no human, and the
 * one place it goes wrong is a machine whose volume is empty — which is every fresh deployment and
 * no rig. An e2e in an open lab room passes either way, which is exactly why this hid.
 *
 *   node profile-bench.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { hasSignedInProfile } = await import('/app/core/meetings/services/bot/dist/capture-bridge.js');

const empty = mkdtempSync(join(tmpdir(), 'prof-empty-'));      // what a declared volume looks like
const real = mkdtempSync(join(tmpdir(), 'prof-real-'));
writeFileSync(join(real, 'Local State'), '{}');                // what provisionLogin leaves behind

let fail = 0;
const is = (label, got, want) => {
  if (got !== want) { console.log(`FAIL ${label} (got ${got}, want ${want})`); fail = 1; }
  else console.log(`PASS ${label}`);
};

is('empty volume reads as guest', hasSignedInProfile(empty), false);
is('profile with Local State reads as signed in', hasSignedInProfile(real), true);
is('missing directory reads as guest', hasSignedInProfile(join(tmpdir(), 'no-such-profile-dir')), false);

console.log(fail ? 'FAIL profile detection' : 'PASS profile detection');
process.exit(fail);
