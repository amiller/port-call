# vexa-poc — an interactive Google Meet participant, built on Vexa

A proof of concept that turns [Vexa](https://github.com/Vexa-ai/vexa) (Apache-2.0) from a
*transcription* bot into a bot that **acts in the meeting**: it speaks, posts and reads chat, sends
emoji reactions, publishes a live video feed it draws itself, and shares a screen — all driven by
one `redis PUBLISH`.

Everything here was measured against real Google Meet, not inferred. The failure notes are the
point: most of the work was discovering *why* the obvious approach silently does nothing.

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

## The findings

These cost the most time and are the most reusable. Every one is a measurement.

### Getting in

- **Only the HOST sees a bot's knock.** If you're an attendee, the admit prompt goes to the
  organizer and your bot times out looking broken. Three bots died this way before we noticed.
- **Google Meet's post-admission consent modal** ("This video call is being transcribed. Gemini is
  taking notes.") holds an admitted bot behind a dialog while the API still reports
  `awaiting_admission`. Vexa detects it and **deliberately refuses to auto-click** it
  (Vexa-ai/vexa#429) — consent is a human's to give.
- **A "Quick access" room dies with the call.** Once the meeting ends the code stops resolving and
  the bot is redirected to Meet's marketing page. For unattended testing you need a **Meet REST API
  space with `accessType: OPEN`** — `lab-room.py` mints one. That needs the
  `meetings.space.created` scope and the Meet API enabled on a project *you control*.
- Google **killed the OAuth out-of-band flow in 2022** — use a loopback redirect. And Python buffers
  stdout when it isn't a tty, so without `-u` the "visit this URL" line never appears and the flow
  hangs on a URL nobody saw.

### Driving the Meet UI

- **Meet collapses the toolbar at narrow widths.** Below ~1000px there is *no chat button in the
  DOM at all*. `--window-size=1600,900` fixes it.
- **Meet auto-hides the toolbar** after seconds without pointer movement, and a bot never moves a
  real mouse — so every control reads `isVisible:false` and clicks time out. Every toolbar action
  must `page.mouse.move()` first. This is why an act works right after another act and fails when
  idle.
- **The Present button opens no submenu.** It calls `getDisplayMedia` immediately; there is no "a
  tab" option to click.
- **Chat text is not in an attribute.** Real Meet gives you `div[data-message-id]` with a bare text
  node and a nested hover button — `textContent` returns
  `"hello thereHover over a message to pin itkeepPin message"`. Clone, strip
  `button,[role="button"],[aria-label]`, then read.
- **The reaction picker is 🎊 💗 💯 😆 🙁 😲 — no 👍, no 🎉** — and entries are `<img alt>`, not
  text. Also: **an emoji inside a Playwright CSS selector never matches** (astral-plane characters
  break the selector parser). Match in-page instead.
- **`[role="alert"]` is a landmine.** Vexa's removal detector treats any alert-role element as a
  host eviction — and Meet's "you're presenting" banner is one. Every bot that started a share left
  20–30s later with `leave_reason="evicted"`. Scope those selectors to real removal wording.

### Media

- **X11 desktop capture does not work in this image.** Screen *and* window both fail at device
  launch: `Create(source=screen:0:0)` → `OnDeviceLaunchFailed`, error 31, while the X capturer
  itself initialises fine (XShm + XRandR 1.6). Ruled out: missing X extensions (same failure on a
  fresh Xvfb with `+COMPOSITE +DAMAGE`), GPU flags, `/dev/shm` size. **Root cause unknown.**
- **The fix is to never reach Chrome's capture at all**: patch `getUserMedia` *and*
  `getDisplayMedia` in the page, before Meet's script runs, and hand back a
  `canvas.captureStream()`. Chrome's picker is never consulted, which also dissolves the conflict
  where `--use-fake-ui-for-media-stream` (required for joining) auto-answers `getDisplayMedia` with
  that broken screen.
- **Meet enumerates devices before it asks for video.** With no videoinput it renders "Camera not
  found" and never calls `getUserMedia` — the canvas draws to nobody. Patch `enumerateDevices` to
  advertise one.
- **One track cannot serve both camera and screenshare.** Sharing a MediaStreamTrack produced
  "Camera might be blocked" and "Can't share your screen". Call `captureStream()` fresh per request.
- **`meet.google.com`'s CSP blocks page-level `eval`**, so re-injecting a HUD as a source *string*
  silently does nothing. Pass a **function** to `page.evaluate` (Playwright evaluates over CDP).
- **`paplay` honours `--rate` but ignores `--channels`.** Measure playback with a **click train**,
  not a duration span — a span measure cannot tell a decay tail from a rate error, and told us mono
  was "2× fast" when it was correct.
- Whisper **hallucinates on silence**, and Vexa resubmits each utterance as a *growing* window —
  forward only `completed: true` segments or a polling agent responds to the same sentence six
  times.

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

Everything runs from bind-mounted source (`live/`), which is what makes `hotswap.sh` a
recompile-in-place rather than an image build.

---

## Testing

`bench.sh` runs everything that needs no meeting: an audio click train, the camera and
`getDisplayMedia` patches, all the surface controllers driven against `probe/mock-meet.html`, and
DOM fixture tests that catch selector-ambiguity bugs.

`probe/mock-meet.html` is a Meet-shaped DOM built **from a live aria-label dump**, deliberately
reproducing the toolbar auto-hide and the chat-attribute trap.

> A mock built from assumption is worse than no mock. Ours passed twice while production failed,
> because it invented a `data-message-text` attribute Meet doesn't have. Build the mock from a
> dump; when bench and production disagree, production is right.

`probe/fixture-tests.mjs` runs the REAL selector logic against serialized populated-call DOM
fixtures and asserts the EXACT behavior expected:
- `setMic` resolves the bot's own "Turn on/off microphone" button, never a tile "Mute Alice's microphone"
- Reaction emoji lookup resolves ONLY inside an OPEN picker, returns nothing when closed
- Consent accept resolves the dialog's "Join now", never a pre-join "Ask to join"

Each selector has a NEGATIVE fixture that asserts loud failure when the target element is absent,
rather than silently grabbing a neighbor (the bug class that broke 2026-08-12).

These tests encode the rule: **scope the query to a container, then verify the resolved element's
aria-label before clicking. Never "first match wins" across the whole document.**

`e2e.sh` runs the same surfaces against real Meet and asserts Meet's own view (presenting flag,
camera toggle state), not just our side. `RECORD=1 ./e2e.sh` also captures per-step screenshots and
an mp4 of the bot's X display, then writes an HTML report — that's how the camera bug was caught,
because the act reported success while the tile showed an avatar.

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
