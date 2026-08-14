# vexa-poc — an interactive Google Meet participant, built on Vexa

A proof of concept that turns [Vexa](https://github.com/Vexa-ai/vexa) (Apache-2.0) from a
*transcription* bot into a bot that **acts in the meeting**: it speaks, posts and reads chat, sends
emoji reactions, publishes a live video feed it draws itself, and shares a screen — all driven by
one `redis PUBLISH`.

Everything here was measured against real Google Meet, not inferred. The failure notes are the
point: most of the work was discovering *why* the obvious approach silently does nothing — they
live in **[docs/findings.md](docs/findings.md)**.

```
./e2e.sh                        # 10 checks against a real meeting, unattended, ~90s
./bench.sh                      # 8 checks with no meeting, no bot, no human, ~40s
./hotswap.sh                    # ~3s: edit TypeScript, next act runs it, bot keeps its seat
./demo.sh join                  # a long-lived bot you iterate against
```

---

## What works

| Surface | How | Verified |
|---|---|---|
| Join | Vexa's join layer, headless Chromium | ✅ real Meet |
| Transcribe | Vexa pipeline → Whisper (we ran it against a **TEE** endpoint) | ✅ speaker-attributed |
| Speak | TTS shim → PulseAudio null sink → the bot's mic | ✅ |
| Sound effects | `!airhorn` in the speak text returns a wav instead of speech — **no bot-side code** | ✅ |
| Chat send / read | Meet's chat panel, driven by Playwright | ✅ |
| Emoji reactions | Meet's reaction picker | ✅ |
| Camera | canvas → `getUserMedia` patch → a live HUD + animated avatar | ✅ |
| Screenshare | the same canvas → `getDisplayMedia` patch | ✅ presenting confirmed in DOM |

The camera renders a **live transcript caption and an animated character**, with state *derived*
rather than commanded — the bird's "listening" animation follows transcript recency, so the face
cannot claim the pipeline is healthy when it isn't.

---

## Architecture

```
redis  acts.v1  ──►  bot process (Node/TS, one per meeting)  ──►  Playwright Page ──► Google Meet
                        │  speak → PulseAudio null sink → virtual mic
                        │  camera/share → canvas → patched getUserMedia/getDisplayMedia
                        │  chat/reactions → Meet DOM
                        ▼
redis  transcript.v1  ◄── Whisper (TEE endpoint)
```

The bot process owns join + capture + speak + chat + camera + share for exactly one reason: it
holds the **Playwright `Page` handle**, a live pipe to one Chromium. Anything touching that DOM
must run in that process. Nothing else is coupled — **acts in / transcripts out, both over redis**,
so the "brain" can live anywhere, in any language.

**Hot swap.** Surface controllers are `import()`ed fresh per act, keyed on file mtime, so a
recompile lands on the next act with the bot still in the meeting. Only the composition root
(`index.ts`) needs a respawn.

---

## Setup

1. **A Google Cloud project you control.** Enable the Meet API on it:
   `https://console.cloud.google.com/apis/library/meet.googleapis.com?project=YOUR_PROJECT`
2. **A desktop OAuth client** (`http://localhost` redirect). Point `LAB_CLIENT_SECRETS` at its JSON.
3. `python3 -u lab-room.py auth` → approve → `python3 lab-room.py create` prints a permanent open
   room code. Put it in `e2e.sh` as the default.
4. `NEAR_API_KEY=… docker compose up -d --build` (the shims need a transcription endpoint).
5. `./e2e.sh` — it should print 10 passes.

That gets you guest joins to open rooms. Joining **calendared personal-account meetings** needs a
signed-in Google identity for the bot, and the calendar Join list needs its own laptop-side OAuth —
the four credential tiers, what each unlocks, and what can never ship are in
**[docs/credentials.md](docs/credentials.md)**.

## Developing and testing

Day-to-day development is a ~10s hot-swap loop against a live bot, backed by a three-rung test
ladder (`bench.sh` with no meeting → `e2e.sh` against real Meet → `journeys.sh` for the paths e2e
can't see). How `live/` gets populated on a fresh clone, the `patches/`↔`live/` sync discipline,
hot-swap semantics, and the mock-from-a-dump testing rules are in **[docs/dev.md](docs/dev.md)**.

## Known gaps

- An external **observer** (a second automated participant, for verifying what the bot can't see
  about itself) is blocked by Google's "You can't join this video call" interstitial. Four launch
  strategies were tried; the bot itself joins the same room fine.
- Transcription can't self-prove in an empty room — `segments=0` passes legitimately.
- Avatar/HUD changes need a respawn: re-injection builds a new canvas, but Meet keeps publishing
  the track it already acquired.

## License and attribution

This repository contains **modified files from [Vexa](https://github.com/Vexa-ai/vexa)**, which is
Apache-2.0. Those modifications live in `patches/` and are offered under the same license; see
`NOTICE` for what was changed. The harness, shims, and documentation are original work under
Apache-2.0.

This is a **proof of concept**, not a product. It automates a Google Meet UI that Google does not
offer an API for; expect it to break when that UI changes, and don't deploy a bot into anyone's
meeting without their knowledge.
