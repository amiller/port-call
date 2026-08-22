# Two capture lanes — issue drafts, 2026-08-21

Drafts only. Nothing filed, nothing pushed. Two ideas that both change *where the audio comes
from*, which is the one thing this project has never varied: today every transcript comes from a
Playwright-driven Chromium that had to be admitted to a Google Meet.

Issue numbers in this file are this repo (`amiller/vexa-poc`, currently #1–#43). Upstream issues are
written `Vexa-ai/vexa#NNN` — except `patches/bot-capture-bridge.ts:100,107`, which cites upstream
#478 bare; that is the only bare cross-repo reference in the tree and it is worth normalising when
either of these lands.

---

## A. Extension capture: the host half already ships in the image, and the lane has no act surface

**Title:** The extension capture lane — the host half is already in our image, unstarted, and the
lane has no way to act and nobody in the participant list

### What is missing today

Port Call has exactly one way to get audio: spawn a bot, get it admitted, hold a Playwright `Page`.
Everything in `docs/findings.md` under *Getting in* and *Driving the Meet UI* is the cost of that
one decision — the host-only knock, the Gemini consent modal the bot deliberately will not click
(`Vexa-ai/vexa#429`), the toolbar that auto-hides because a bot never moves a mouse, the
`[role="alert"]` eviction detector that read "you're presenting" as a removal.

The other lane needs none of it: capture from inside the tab the human is already in. Upstream calls
it the extension lane, and **the receiving half of it is already inside the image we run.** It has
never been started, nothing in this repo speaks to it, and the lane has no act surface at all.

### What already exists

Verified 2026-08-21 against the running staging container, `vexa-rig4-vexa-lite-1`.

**Host side — in our image, not running.** `/app/core/meetings/services/desktop` = `@vexa/desktop`,
"the meetings all-in-one host", src and dist both present:

| | |
|---|---|
| ingest WS | `WebSocketServer`, default port **9099** (`src/desktop.ts:329`); the connection reads `?platform=` / `?native=` off the URL (`:334`–`:337`) |
| lane routing | `MIXED_PLATFORMS = {zoom, teams, msteams, youtube}` → `mixed-pipeline`; everything else, Meet included → `gmeet-pipeline` (`:36`) |
| gateway | default port **8056** (`:325`) |
| gateway routes | `POST /extension/sessions` (`:213`), `POST /extension/sessions/end` (`:223`), `POST /telemetry` (`:238`), `GET /telemetry` (`:249`), `GET /bots` (`:257`), `GET /health` (`:266`), plus `GET /transcripts/{p}/{n}`, `GET /recordings/{p}/{n}`, `/player`, `WS /ws` |
| STT | real, over `TRANSCRIPTION_SERVICE_URL` (`@vexa/transcribe-whisper`) |
| tests | `src/*.test.ts`, including `recording-e2e.test.ts` (synthetic `recording.v1` over the real ingest WS, no meeting) and `desktop-e2e.live.test.ts` (real STT) |

**Two facts that change the shape of the work:**

1. **`@vexa/desktop` is not started.** `/etc/supervisor/conf.d/vexa.conf` declares redis, xvfb,
   fluxbox, pulseaudio, pulseaudio-setup, x11vnc, websockify, admin-api, runtime, agent-api,
   meeting-api, gateway, terminal — no `desktop`. Nothing listens on 9099.
2. **Its default gateway port collides.** 8056 in that container is already the Python
   `gateway` service (PID 35 on rig 4). `DesktopOptions.gatewayPort` (`:87`) has to be set, or the
   two fight.

**Wire format.** `/app/core/meetings/modules/capture-codec` = `@vexa/capture-codec`, "the ONE
serialization both capture lanes share", "drift-gated so a **bot-captured** and an
**extension-captured** fixture are byte-identical". Sender stamps capture time, receiver never
restamps.

**Page side, one brick, two hosts.** `patches/gmeet-capture-index.ts:5`–`:7`: the capture module runs
inside the meeting page "injected by the bot, or loaded by the extension" — bot wires frames to an
in-process sink, extension to a WebSocket. That is the same `@vexa/gmeet-capture` the rig already
runs.

**The extension source.** It is **in the upstream monorepo**, `Vexa-ai/vexa` at `clients/extension/`
(MV3, TypeScript: `inpage.ts` → `content.ts` → `background.ts` → `ws://localhost:9099/ingest`,
`encodeAudioFrame` called in `background.ts`). It is absent from our image because
`/app/pnpm-workspace.yaml` scopes the open-core build to `core/*` plus `clients/terminal` only.
`Vexa-ai/vexa-chrome-extension` is a *different, stale* repo (last push 2025-03-25, predates
`capture.v1`) — not the one.

Its README states the property this issue is about, plainly: it runs "inside the Google Meet tab you
are already in (**no bot, no waiting room**)".

### The consent regression, stated

This is the part worth arguing before any code.

Today the bot is a **participant**. It shows in the tile grid, it has a name, somebody had to admit
it, and `docs/findings.md` records that we refuse to auto-click the "this call is being transcribed"
modal because consent is a human's to give. The room can see it and can throw it out.

The extension lane inverts that. There is no tile, no admission, no name. Capture happens inside one
attendee's browser and every other participant's audio is taken with no signal of any kind. And any
act built on that lane would be performed **as that human** (their mic, their chat, their identity),
not as a labelled non-human in the room. That is a different consent posture, and #34 (the bot's own
sharing identity and access policy) is the existing thread it belongs to.

### The missing act surface

Every act in `patches/bot-contracts.ts:76`–`:92` (`speak`, `speak_audio`, `speak_stop`, `chat_send`,
`chat_read`, `screen_show`, `screen_stop`, `avatar_set`, `avatar_reset`, `screen_share`,
`screen_share_stop`, `selfcheck`, `camera_show`, `camera_off`, `reaction`) depends on something the
extension lane does not have:

| act | how it works today | why it does not port |
|---|---|---|
| `chat_send` / `chat_read` | Playwright clicks Meet's chat panel, polls `div[data-message-id]` (`patches/bot-chat.ts:27`–`:30`) | needs a driven page; in-tab it would post as the human |
| `reaction` | Playwright clicks `Send a reaction`, wakes the toolbar first (`patches/bot-reactions.ts:14`) | same |
| `camera_show` / `camera_off` | init-script patches `getUserMedia` to return our canvas; Playwright toggles `Turn on camera` (`patches/bot-camera.ts:769`–`:770`, `:827`) | the human's camera is the human's camera |
| `screen_share` | patched `getDisplayMedia` + Playwright click on Present (`patches/bot-screen-share.ts:22`–`:28`) | same |
| `speak` | **not a page act** — piper PCM → `paplay --device=tts_sink` → `virtual_mic`, which Chromium captures as its mic (`patches/bot-tts-playback.ts:4`–`:8`, `patches/bot-capture-bridge.ts:353`–`:356`); the page half only unmutes Meet's own mic button, scoped to the exact label `Turn on/off microphone` (`:389`–`:402`) | requires the container's PulseAudio graph and a browser we own; on a human's laptop there is neither |

"Port the acts" is the wrong framing. **The extension lane is a capture-only lane**, and a Port Call
that runs on it is a notetaker rather than a participant.

### First slice

Capture-only, on the rig, no extension, no human:

1. Start `@vexa/desktop` in the rig container (or beside it) with `gatewayPort` off 8056 and
   `TRANSCRIPTION_SERVICE_URL` pointed at the shim the rig already uses.
2. Replay a recorded `capture.v1` stream into `ws://…:9099/ingest?platform=google_meet&native=<code>`
   and read the transcript back off `GET /transcripts/{p}/{n}`.
   We already have the tape: `patches/bot-capture-tap.ts` writes one `CapturedFrame` JSON per line
   with verbatim base64 Float32LE PCM (switch = `mkdir /tmp/vexa-capture-tap`), and
   `makeTelemetryTap` (`patches/bot-capture-bridge.ts:68`) tees every frame before the pipeline with
   the `ts` stamped at `:210`.
3. Diff that transcript against what the bot's own pipeline produced from the *same* frames.

That is a bench-rung item by `docs/swarm.md`'s definition: no meeting, no bot, no human. It proves
the receiving half works on our infrastructure before anyone touches a Chrome extension.

### Proof

- `bench.sh`-style: desktop host comes up, ingest accepts a replayed tape, `GET /transcripts` returns
  segments, exit non-zero otherwise.
- The equality that matters is the codec's own claim: assert a bot-captured and an
  extension-captured (or replayed) frame are **byte-identical**, since upstream says they are and
  drift-gates for it. That check is cheap and it is the whole premise of the lane.
- Transcript comparison must be coarser than equality: two ASR passes over identical audio are not
  byte-equal. Same problem #24 names.

### Known unknowns

- Does `clients/extension` build against the brick versions in our image, or has it moved? Our image
  is behind upstream (see B — upstream now has `jitsi-capture`, ours does not).
- Where the extension would run. On Andrew's laptop it is a real install; on a rig there is no human
  tab to sit in, so the entire bench story is replay, and the live story needs a human.
- Whether the desktop host can run inside the existing container without fighting supervisord, or
  wants to be a sibling service.
- `@vexa/desktop`'s store is in-memory single-process (its README: 🟡 partial). A crash loses the
  meeting. Unclear whether that matters for a diagnostic use.
- No answer yet on whether the extension can capture a room the human is *not* the host of, or how
  it behaves when the human closes the tab.

### Risks / regressions

- **Consent posture**, above. Filing this without §"The consent regression, stated" would be filing
  half the issue.
- **Loses every act.** Whatever is built here cannot speak, react, show a camera or share. Roadmap
  §2 and §3 (reading the room, facilitation) do not exist on this lane.
- **Loses the rungs.** `e2e.sh`'s ten checks are join / chat_send / chat_read / camera canvas /
  camera ON in Meet / screen_share / reaction / presenting-in-DOM / transcript endpoint / survived
  the run. Eight of them have no meaning here. A lane that cannot be tested by the harness we have is
  a lane whose failures go quiet, which is #19's whole subject.
- **Port collision on 8056** will look like a broken gateway, not a config error.

---

## B. A Jitsi lane: lib-jitsi-meet instead of the Meet DOM, and E2EE the TEE can actually claim

**Title:** A Jitsi join lane — replace the Meet DOM driver with `lib-jitsi-meet`, and get an E2EE
property the TEE story can actually claim

### What is missing today

With Google Meet, capture is the *only* thing we control. Google holds the media. Moving the
transcriber into a TEE therefore rearranges plumbing without changing who can read the audio: the
server in the middle is Google's either way. Nothing in this repo can currently say otherwise, and
`docs/roadmap.md` already concedes the shape of it: "Anything that needs Google to ship an API" is
deliberately off the roadmap, and "it will break when that UI changes; that is the deal."

A self-hosted Jitsi lane changes what can be claimed. E2EE in Jitsi is client-side
(insertable streams + AES-GCM); the SFU never holds the key. So plaintext audio exists **only inside
a keyed participant**, which is exactly the seat an attested TEE bot occupies.

### What already exists

**A working proof, ours, outside this repo.**
`/home/amiller/projects/ic3camp-teexai/teexai-transcribe/jitsi-e2ee-poc` — one-shot
`docker compose`, self-cleaning, exit code is the verdict:

| | |
|---|---|
| stack | vendored `jitsi/docker-jitsi-meet` stable-9646 (web / prosody / jicofo / jvb), `jitsi/docker-compose.yml` pulled in via compose `include` |
| bots | `bots/bot.js` — `lib-jitsi-meet`, three roles (publisher / listener / eavesdropper) from one image, role by env |
| E2EE | `conf = connection.initJitsiConference(ROOM, { e2ee: { externallyManagedKey: true } })` (`bots/bot.js:35`), then `toggleE2EE(true)` + `setMediaEncryptionKey({encryptionKey, index:0})` (`:53`–`:54`) |
| audio in | publisher speaks a fixture: `espeak-ng` → `ffmpeg -ar 44100 -ac 2 -sample_fmt s16` → `--use-file-for-fake-audio-capture` (`bots/entrypoint.sh`) |
| audio out | remote track → muted autoplay `<audio>` (`bots/bot.js:73`–`:75`) **and** `AudioContext({sampleRate:16000})` → `AudioWorkletNode` → WS to the ASR shim (`:81`ff) |
| ASR | thin shim forwarding to near.ai `whisper-large-v3` — the same TEE path `teexai-transcribe` uses; no local model |
| assertion | `test-runner/run.py`: content-word overlap, `listener >= 0.5` **and** `eavesdropper < 0.3`, `sys.exit(0 if ok else 1)` |
| status | M1–M5 all green in its README; example PASS shows eavesdropper `samples=1232000 overlap=0.00 text=''` — it *receives* frames and recovers nothing |

Design doc: `../agentic-meeting-skill/jitsi-e2ee-docker-poc.md`. The argument for the lane at all:
`../agentic-meeting-skill/meet-bot-detection-vs-jitsi.md` — "No adversary… there is no detector to
evade, so the CAPTCHA / fingerprint arms race does not exist", plus recall.ai's flat statement that
Google offers no API for a bot to join and record.

**Upstream already has a Jitsi lane, and ours does not have it yet.** `Vexa-ai/vexa` contains:

- `core/meetings/modules/jitsi-capture/` — `createJitsiSpeakers` (reads the app's own redux
  dominant-speaker state, `.dominant-speaker` DOM fallback), `createJitsiChat`,
  **`sendJitsiChatMessage` (posts via the app's own `sendTextMessage` API)**
- `core/meetings/modules/join/src/jitsi/` — `join.ts` / `admission.ts` / `leave.ts` / `removal.ts` /
  `password.ts` / `selectors.ts`; admission and removal "prefer the app's own runtime verdict
  (`APP.conference.isJoined()`) over DOM heuristics"
- `core/meetings/contracts/invocation.v1/golden/Invocation.jitsi.json`

None of it is in `vexa-rig4-vexa-lite-1` (the image's `modules/` has no `jitsi-capture`), so our
image predates it.

Two things follow. First, a Jitsi lane is **not from scratch**: upstream has join, admission, chat
send, and speaker attribution. Second, upstream's version is still **Playwright driving the
jitsi-meet web app** and says nothing about E2EE, which is precisely the half the POC supplies.
Those are complementary, not competing.

Also note upstream routes jitsi into the **mixed** lane — one mixed stream, names from temporal
hints — not the per-channel gmeet lane. Every per-speaker measurement the rig has (the glow-bound
name on the audio frame, `acoustic.py`'s per-leg timing) is a gmeet-lane property and does not
automatically survive the move.

### First slice

The POC is green and self-contained; re-proving it is not the slice. The slice is the join driver:

1. Stand the POC's Jitsi stack up on a rig and get **one Port Call bot** into that room —
   `lib-jitsi-meet` join, shared key, PCM tap — feeding the rig's existing STT path instead of the
   POC's ASR shim.
2. Keep it capture-only for the slice. Speak is the second slice and it is a real question
   (below), not a port.
3. Report `participantTiles`-equivalent liveness so `sync.py`'s "refuses to run when the bot is alone
   in the room" guard has an analogue.

### Proof

- `run.sh` already is the model: build, assert, always tear down, exit code is the verdict. Reuse the
  shape.
- The E2EE assertion has to survive the port: a keyed Port Call bot transcribes, a keyless one in the
  same room does not. That is `test-runner/run.py`'s two-sided test and it is what makes the claim a
  measurement rather than an assertion.
- The rig's own instruments should transfer: `duel.sh` (two bots, one room,
  each hears the other) and `acoustic.py` (one-way legs and the closed duet loop, measured at 145 ms
  / 225 ms / 525 ms on Meet, rigs 4 and 3). **Same numbers on a self-hosted Jitsi is a directly
  comparable measurement and nobody has it.** If Jitsi's legs are materially shorter, #41's whole
  barge-in budget changes.
- Also worth re-measuring on Jitsi: the transmission-ramp effect. `tasks/session-notes-2026-08-20.md`
  sights it three separate times on Meet (beat 0 lost, AGC decay 0.62 → 0.20, `rig 3 → rig 4` read
  1220 ms from a swallowed leading beat). Whether it survives on a self-hosted SFU is a fact we can
  now get.

### Known unknowns

- **Speak.** The POC never speaks — the publisher injects a WAV via a Chrome launch flag, which is a
  fixture, not an act. On Jitsi, is speak still the PulseAudio `tts_sink → virtual_mic` chain, or does
  `lib-jitsi-meet` take a track directly (which would also remove the `ensureUnmuted` DOM click)?
  Unverified; it decides how much of `patches/bot-tts-playback.ts` survives.
- **The rest of the act surface.** `sendJitsiChatMessage` exists upstream, so chat is an API call
  rather than a DOM click. Camera and screenshare on `lib-jitsi-meet` are unexamined.
- **E2EE + capture together.** The POC taps a decrypted remote track in the same page that holds the
  key. Whether upstream's `mixed-capture-core` tap works unchanged under E2EE was not checked.
- **Headless.** The POC is deliberately *pseudo*-headed (Xvfb + real Chromium) because
  `--headless=new` support for insertable streams was never confirmed. Our rig is already Xvfb, so
  this costs nothing here, but the question is still open and it is written down as open.
- **Distribution.** `meet-bot-detection-vs-jitsi.md` is honest about it: "The Meet browser-bot wins on
  distribution: it meets people where they already are." Nobody Andrew takes meetings with is on a
  self-hosted Jitsi. This lane is for the demonstrable-property case, not the daily one.
- The POC needs `NEAR_API_KEY` and network egress — **it is not hermetic**, and its README says so.

### Risks / regressions — from the POC's own "hard-won fixes"

Verbatim from `jitsi-e2ee-poc/README.md`, because each one is a silent failure:

- **The E2EE worker must be co-located.** Crypto runs in a Web Worker; `lib-jitsi-meet.e2ee-worker.js`
  has to be vendored next to the main lib and served from the page origin, "or **decryption silently
  never engages**." `bots/entrypoint.sh` curls both files explicitly and prints `MISSING` per file.
- **Startup race.** Bots joining before jicofo joins the bridge brewery get
  `CONFERENCE_FAILED focusDisconnected`. Handled by a 15 s settle plus rejoin retries in `bot.js`
  (`onConfFailed`, `startConnection`) — and *"jicofo's `/about/health` is 404 in this build, so don't
  poll it."*
- **Secure context.** Insertable streams need HTTPS or `localhost`. Each bot gets it free by serving
  its own page from `http://localhost:8080` inside its container; the cross-origin `wss` to `web`
  uses `--ignore-certificate-errors`.
- Attach the remote track to a muted autoplay `<audio>` element too, or Web Audio yields silence
  (`bot.js:73`–`:75`); launch with `--autoplay-policy=no-user-gesture-required`.

Beyond the POC:

- **Our image is behind upstream.** Adopting `jitsi-capture` / `join/src/jitsi` means a rebase onto a
  newer vexa-lite, and `Dockerfile.patched` currently copies twenty patched files in by path. That is the
  real cost and it is not visible in either the POC or the roadmap.
- **The mixed lane loses per-speaker channels**, and with them the glow-bound name on the audio frame
  that the gmeet pipeline uses instead of a diarizer. #2 (shared-microphone rooms) is the same
  failure by a different route.
- One inaccuracy in the POC to fix before anyone builds on it: its README's Layout table says the bot
  page is "served BY the web container, https origin". It is not — `bots/entrypoint.sh` runs
  `python3 -m http.server 8080 --directory /srv` inside each bot container and loads
  `http://localhost:8080/bot.html`. The Hard-won-fixes section has it right; the Layout line does not.
  The design doc's expectation of an extension-driven bot was also not what got built — it is a hosted
  page.
