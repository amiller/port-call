# The findings

These cost the most time and are the most reusable. Every one is a measurement.

## Getting in

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

## Driving the Meet UI

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

## Media

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
