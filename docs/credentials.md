# Credentials

Four separate credentials, each unlocking a different capability. The design rule they follow: the
rig holds only what it must (a transcription key, one Google identity for the bot itself);
everything that can read *your* life — calendar, room-minting OAuth — stays on the laptop and
sends derived data across.

| credential | unlocks | lives | ships? |
|---|---|---|---|
| `NEAR_API_KEY` | transcription via `near-shim` | compose env on the rig | documented requirement; any OpenAI-compatible `/v1/audio/transcriptions` endpoint substitutes |
| Meet REST OAuth | `lab-room.py` minting a permanent `accessType: OPEN` room — what makes unattended e2e possible | laptop; desktop OAuth client, loopback flow, scope `meetings.space.created` | per-operator (README setup steps) |
| bot Google account | joining calendared / personal-account meetings, which wall out anonymous participants | a full Chromium profile dir in the container | never — see below |
| Calendar OAuth | the console's Join list (`push-upcoming.py`) | laptop only; tokens never cross to the rig | per-operator; script currently lives outside this repo |

## The bot's Google account

Anonymous participants are walled out of calendared personal-account meetings behind a Google
sign-in page; no amount of retrying helps. The fix is a real Google account whose **full Chromium
profile directory** sits in the container (`/var/lib/vexa/google-session-live`). Its presence
switches every spawn to authenticated mode (name-entry skipped, `--incognito` stripped); move the
dir aside to revert to guest joins.

Hard-won specifics:

- **Only the whole profile dir works.** Upstream's subset save/restore (`loadSessionLocal`) is not
  sufficient — the restored session doesn't survive.
- **Provisioning** goes through upstream's `provisionLogin` plus a look at the screen over noVNC.
  If Google signs the session out (container recreated, security event), re-login the same way.
- **Moving the profile to a new host:** strip the `Singleton*` lock files after unpacking. The same
  profile works on two rigs at once (verified on two hosts, 2026-08-13).
- A **fresh account gets first-run popups** ("people can hear you" style) on its first Meet joins,
  and they block every toolbar act until dismissed.

## Calendar

`push-upcoming.py` runs on the laptop, reads your calendar with its own OAuth tokens, and pushes
only the derived list — title, time, Meet code — to the console's Join list on the rig. The
console needs to know what to offer a Join button for; it does not need the ability to read your
calendar. The tokens never leave the laptop.
