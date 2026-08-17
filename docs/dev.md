# Development environment

## Two copies of the bot source

The canonical sources are `patches/` in this repo. The code that *runs* is `live/` on the rig,
bind-mounted into the container at four paths (bot src/dist, join src/dist). Compose creates
`live/` empty on a fresh clone, and mounting that emptiness over the bot's src/dist leaves a
container with no bot code in it. Populate from the built image before the first `up`:

```bash
./populate-live.sh          # builds vexa-lite, docker cp's the four dirs out of it
```

The edit loop: change a file in `patches/`, copy it to the matching path in `live/`, run
`./hotswap.sh`. Keep the two in sync — if they drift, a from-scratch image build fails while the
running system looks fine. The drift is the price of the ~10s loop; the image build (which CI
should run) is the source of truth.

## Hot swap semantics

`hotswap.sh` runs `tsc` inside the running container; the **next bot spawn** executes the new
code, and any live bot keeps its seat. Surface controllers (`chat`, `camera`, `reactions`,
`screen-share`, `selfcheck`) go further: they are `import()`ed fresh per act, keyed on file mtime,
so most edits land on the very next act with no respawn at all. Two things do need a respawn: the
composition root (`index.ts`), and the avatar/HUD canvas — re-injection builds a new canvas, but
Meet keeps publishing the video track it already acquired.

**One bot per container.** The container runs a single Xvfb `:99`; concurrent bots click into each
other's windows. Fan test swarms out across analysis, never across rooms.

## The test ladder

Three rungs, in the order you should climb them:

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
rather than silently grabbing a neighbor (the bug class that broke 2026-08-12). These tests encode
the rule: **scope the query to a
container, then verify the resolved element's aria-label before clicking. Never "first match wins"
across the whole document.**

`e2e.sh` runs the same surfaces against real Meet (the permanent lab room, unattended, ~90s) and
asserts Meet's own view (presenting flag, camera toggle state), not just our side.
`RECORD=1 ./e2e.sh` also captures per-step screenshots and an mp4 of the bot's X display, then
writes an HTML report — that's how the camera bug was caught, because the act reported success
while the tile showed an avatar.

`journeys.sh` covers the real-call paths e2e structurally can't see (the consent gate,
populated-room audio). FULL mode spawns and kills its own bot — dedicated open rooms only;
`MODE=observe` attaches to an existing bot and is safe mid-call. Never run `e2e.sh` or full-mode
`journeys.sh` against a meeting with people in it.

## Driving a bot by hand

`./demo.sh join` gives you a long-lived bot; every act (`say`, `chat`, `react`, `camera`, `share`,
`transcript`, `check`, `shot`, …) is one command. `board.py` is the same bus with a browser on it:
port 8090, paste a Meet link, Join button, live transcript, sfx/reaction buttons.

## When the machine reboots

The API tokens live in `/tmp` and die with the host. `./relaunch.sh` recovers everything: compose
up, tokens re-minted, console restarted.
