# Unattended work queue

Three workstreams, all runnable without a human in a meeting. (2) and (3) are the high-value pair:
(3) unlocks the populated-meeting condition that hid every bug on 2026-08-12, and (2) catches that
whole bug class with no meeting at all.

---

# 1. Camera HUD — WebGL background + skins

Filed 2026-08-12. Suited to unattended/swarm work: the camera surface is the ONLY part of this
system that needs no meeting, no other participants, and no clicking, so none of the failure modes
that dominated 2026-08-12 (selector ambiguity, modal wedges, consent gates) apply. `probe/camera-bench.mjs`
proves the whole surface on `about:blank`, and `journeys.sh` J3 already asserts the canvas is
*advancing* rather than merely present.

## Architecture decision

The HUD canvas is `document.createElement('canvas')` with a **2D** context, and `getUserMedia` is
monkey-patched to return `cvs.captureStream(30)` from it (`patches/bot-camera.ts:30-32,165`). A canvas
holds only one context type, so WebGL cannot go on that canvas.

Render WebGL to an **offscreen** canvas, then composite per frame:

```
glCanvas (webgl2)  --drawImage-->  cvs (2d, captured)  --> existing text/caption/HUD on top
```

This leaves `captureStream`, the getUserMedia patch, and the screen-share path untouched — the
capture canvas stays 2D and keeps its identity.

## Work items

- [ ] Extract the background layer out of `draw()` into a skin interface: `{ name, init(gl), frame(t, state) }`.
      `state` is the existing HUD state (speaker, segments, caption, started).
- [ ] Composite step: create `glCanvas` at the same dimensions, `ctx.drawImage(glCanvas, 0, 0)` as the
      FIRST call in `draw()`, before any text. Text rendering stays 2D and unchanged.
- [ ] Skin selection: extend the `camera_show` act payload with `skin` (default = current flat fill),
      so `./demo.sh camera "TEXT"` keeps working unchanged.
- [ ] Rooster WebGL background (the headline skin).
- [ ] Two additional skins.
- [ ] Extend `probe/camera-bench.mjs` to assert, per skin: track live, correct size, frames advancing,
      and a measured fps floor (see risk 1).
- [ ] Extend `journeys.sh` J3 to exercise each skin, not just the default.

## Two real risks, both measurable in the bench

1. **No GPU.** `camera-bench.mjs` launches with `--disable-gpu --in-process-gpu`, so WebGL runs on
   SwiftShader (CPU). A full-frame fragment shader at 30fps may not hold. MEASURE FIRST — add the fps
   assertion before writing the shaders, and treat the frame budget as the design constraint. If
   SwiftShader can't hold 30fps, the fallback is a cheaper shader, not a GPU.
2. **Display contention.** The bench runs `headless: false`, and fractal has a SINGLE `Xvfb :99`
   shared with any live bot. Run the bench on its own display (`Xvfb :98`) or headless, or it will
   fight a bot that is sitting in a real meeting.

## Verification note

A HUD change does NOT take effect on a running bot: the canvas is installed at navigation and Meet
keeps publishing the track it already acquired (`patches/bot-camera.ts:248-261`). Use `./demo.sh recam`
to re-inject, or respawn. `recam` toggles the camera button, which is a toolbar click — so it needs
the display to itself.

---

# 2. DOM fixture harness — catch selector ambiguity with no meeting

Every failure on 2026-08-12 was one bug: a selector that takes the FIRST document-wide match and
never checks what it got. In an empty lab room each has exactly one candidate, so all of them pass;
in a populated call the first match is someone else's tile control.

Run the real selectors against a saved populated-call DOM snapshot and assert what each resolves.
No browser, no meeting, no bot — a plain unit test.

- [ ] Fixture format: a serialized participant-grid DOM (5+ tiles with hover controls) + the bottom
      toolbar. Hand-author or synthesize until a real capture exists (see #3); a real one is better
      because Meet's aria-label phrasing is the whole ballgame.
- [ ] Assert `setMic` resolves the button labelled `Turn on/off microphone` (the bot's own control),
      NOT any `Mute <name>'s microphone` tile control. This is the regression that caused two live
      "Mute X for everyone?" modals.
- [ ] Assert the reactions picker search resolves an emoji entry inside the OPEN picker, and resolves
      NOTHING when the picker is closed (rather than matching a stale or hidden node).
- [ ] Assert the consent accept resolves the dialog's `Join now`, not a pre-join button.
- [ ] Add a negative fixture per selector: a DOM where the RIGHT element is absent, asserting the
      selector fails loudly instead of silently grabbing a neighbour.
- [ ] Wire into `bench.sh` so it runs with no room.

## The rule these encode

Scope the query to a container, then verify the resolved element's aria-label before clicking, and
log what was hit. Never "first match wins" across the whole document.

---

# 3. Stooge participant — make the lab room populated, unattended

The Vexa API refuses a second BOT per meeting (`An active meeting already exists for
google_meet/<code>`), but a second PARTICIPANT is not a bot and never touches that API. This is the
missing piece: with one other tile in the room, the lab room finally reproduces real-meeting
conditions, and the audio/reaction fixes become verifiable without a client call.

- [ ] A headless Chromium on fractal with a PERSISTED Google profile (`--user-data-dir`), joining the
      lab room as a plain participant. Log in once by hand; the profile carries the session after.
- [ ] Give it its OWN display (`Xvfb :98`). fractal has a single `Xvfb :99` shared by any live bot,
      and `bringToFront()` plus fixed-coordinate clicks means co-resident browsers fight for focus.
- [ ] Capture a real populated-call DOM snapshot from it — this is the fixture #2 wants, and the only
      honest source for Meet's actual aria-label phrasing.
- [ ] Audio assertion: tap the stooge's inbound audio (Web Audio on the remote stream) and assert
      non-zero level while the bot speaks. This is the end-to-end proof of the speak path that no
      solo bot can produce — Meet never loops a participant's own mic back to it.
- [ ] Then extend `journeys.sh`: the reaction and speak journeys stop reporting SKIP and start
      actually testing.

## Caveat

This puts a real Google identity in the room. Use the lab room only, never a client meeting, and
keep the profile off any shared credential path.

## 2026-08-13 live-run follow-ups (Luc meeting — first signed-in calendared join)

Live results: signed-in join worked; transcript, chat, reactions, and AUDIBLE speech/sfx all
verified in a real populated meeting — the mute fixes graduate from [UNVERIFIED]. One blocker
found, cleared by hand:

- [ ] Auto-dismiss Meet's first-run onboarding popups ("people can hear you" style) that a FRESH
      Google account gets on its first joins. One blocked all toolbar acts until Andrew cleared it
      over VNC. Same shape as the Gemini-consent fix: detect + click through in the act/join path
      (and add to selfcheck so a blocked overlay is visible from outside). Popup likely per-account
      one-time, so reproduce with a second fresh account or a cleared profile before calling it fixed.
- [ ] Rename the bot account's display name ("Account Link" → "Vexa") in Google account settings.
- [ ] Free-tier Meet caps 3+ participant calls at 60 min — the bot should surface "call ending soon"
      (it's already in selfcheck's buttons dump) rather than dying silently with the room.

## 2026-08-13 feedback-derived items (mined from 08-12 transcripts, meetings 67-76)

Reception verdict: amused, not impressed — entertainment value currently comes from failure modes.
Two concrete usability complaints, both actionable:

- [ ] HUD caption is DISTRACTING to the speaker (Albiona, m67: "it's a little distracting to read
      what I'm saying"). Add caption modes to camera_show: off / headline-only / full; consider
      delay or fade so the speaker isn't reading their own words live.
- [ ] Anti-repetition guard for spoken/chat lines (Tina, m76: "Why does this keep on saying the
      same line? Can you not learn something?"). Track recently-said lines; refuse or vary repeats.
- [ ] Facilitator role is now doubly endorsed: Andrew mid-call 08-13 ("managing the control flow
      of a meeting, welcoming everyone") and Tina in m71 proposed "the live conversation
      facilitator agent" as a Shape Rotator grants/bounties cohort project.

## 2026-08-13 zed-rig portability papercuts (from the rig bring-up agent; fixes wanted for dstack)

zed rig reached e2e 10/10 from the repo alone. Two layout bugs it worked around by hand:
- [x] compose references ./near-shim.py, ./tts-shim.py, ./sfx at repo root; canonical copies are in
      shims/. Point compose at shims/ paths so a fresh clone composes without file copies.
      (2026-08-17: compose volumes AND Dockerfile.shims COPY lines both fixed — the build needed
      them at root too, not just the mounts.)
- [x] live/ bind-mounts start empty on a fresh clone; document (or script) populating them from the
      built image before first run. This is the from-scratch path dstack will take.
      (2026-08-17: ./populate-live.sh; plain `docker build`, not `compose build`, so it does not
      demand NEAR_API_KEY to interpolate the file before the key is needed.)
- [x] BONUS, found by the fresh-clone test: Dockerfile.patched never copied patches/bot-tts-playback.ts,
      so capture-bridge's playback.onAmplitude failed tsc and the image build died. The rig looked
      healthy because live/ had the file. Fixed. patches/bot-repetition-guard.ts is still UNTRACKED
      while Dockerfile.patched COPYs it — `git add` it or the next fresh clone breaks again.

## 2026-08-17 dstack / Phala CVM: what is actually left (see docs/operations.md)

Fresh clone verified end to end in a scratch dir: build both images -> populate-live -> up ->
gateway 200, TTS 200 (55KB wav), patched code present. docker-compose.cvm.yml added (no build:,
no bind mounts, images by registry tag) and verified running locally in that shape.
- [ ] push the two images to a registry — the ONLY thing between here and a CVM. ~2.4GB + ~0.9GB,
      both already amd64. Nothing is pushed yet (checked socrates1024/* and ghcr.io/amiller/*).
- [ ] `phala deploy -c docker-compose.cvm.yml` with >= 4 vCPU / 8GB / 60GB. The 1/2GB/40GB default
      is too small on all three axes (bot = ~1.4GB RSS, ~2.3 cores at Chromium start, 6.2GB image).
- [ ] token minting in a CVM: relaunch.sh docker-execs admin-api on 127.0.0.1:8001 inside the
      container. No docker socket in a CVM. Needs --dev-os + ssh, a pre-launch script, or exposing
      admin-api through the gateway (a real decision — that endpoint mints tokens).
- [ ] relaunch.sh sources NEAR_API_KEY from ~/projects/ic3camp-teexai/... — exists on one machine.
- [ ] Shared signed-in profile: strip Singleton* lock files when installing the tar on a new host.
      Works on two rigs at once (verified zed+fractal 2026-08-13); each rig needs its own lab room
      eventually — both defaulting to tog-tccc-szk means tests can collide.

## 2026-08-13 speak-state HUD (Andrew, after first live speaking session) — promoted to issue #3 (+ lag measurement) 2026-08-14

"The speaking not being easy to see when it's about to speak" — add visual speak states to the HUD:
- [ ] 'winding-up': on speak act accepted (pre-TTS), rooster throat-clear — comedic, brainrot
      register (AHEM beat). Gives the room the pre-speech cue humans get from body language.
- [ ] 'speaking': beak animates DRIVEN BY ACTUAL TTS PCM level (RMS per chunk -> beak openness),
      not a timer — derived state, same can't-lie principle as the listening animation.
- [ ] back to derived listening/idle after. Extend camera-bench to assert the state transitions.

---

# 4. Upstream the performance-fleet capabilities (from the 2026-08-13 synthetic-meeting experiment)

The cloned-voice meeting demo (see teleport planning session 2026-08-13) validated capabilities
that currently live as loose scripts on fractal (~/setup_fleet.sh, ~/record_show.sh, ~/conduct3.sh)
and per-rig forks. Fold them into the repo:

- [ ] `fleet.sh`: N guest-mode compose instances from one checkout (port offsets, per-instance
      token files, `. ./.env` not the teexai path, sed'd demo.sh/relaunch.sh). Guest mode = absent
      /var/lib/vexa/google-session-live; BOT_NAME sets the Meet display name at join.
- [ ] `record.sh`: synchronized multitrack recording — x11grab of one instance's :99
      (MUST be -pix_fmt yuv420p; default yuv444 renders black on phone hw decoders) + each
      instance's `pulse tts_sink.monitor` at 48k mono (44.1k stereo capture showed pulse-underrun
      doubled word-tails; verify tails by autocorrelation). Remote meeting audio never reaches
      pulse (bots hear via in-page WebRTC) — own-track multitrack + mix is the only clean path.
- [ ] **speak queue bug**: a `speak` act arriving while the bot is mid-playback is silently
      dropped (shim pads 600ms lead/400ms tail widen the window). Queue speaks (or return busy)
      in the playback path. e2e: fire two back-to-back says, assert two audio blocks in the
      tts_sink.monitor capture.
- [ ] **#3 stooge is now cheap**: a second guest instance IS the populated-room participant.
      Wire journeys.sh full mode against a room populated by another instance, and capture a real
      populated-call DOM snapshot for the #2 fixtures from it.
- [ ] First-run Google modals block toolbar acts (chat/react/camera) but NOT speak; auto-dismiss
      at join (current workaround: xdotool click ~(957,707) on :99).
- [ ] Document: the big canvas headline is a DERIVED active-speaker label (whoever that bot last
      heard), not the camera_show text — reads as crossed names until you know.

## 2026-08-18 act logs and recordings were never persisted — archived, nightly backup installed

Found while asking whether the reaction/speak events from a live meeting survive. They did not.
`docker inspect vexa-rig-vexa-lite-1` mounts only bot/join src+dist and `vexa-rig_recordings`;
`/tmp/vexa-workloads/` (every `[bot] speak` / `[chat]` / `[reaction]` / `[camera]`) and
`/tmp/recording_*.webm` are on the container's writable layer. The recordings volume that IS
mounted was empty — the recorder writes to /tmp instead. Postgres has `vexa-rig_pgdata`, so
transcripts were the only thing a `--force-recreate` would have spared.

Done: 1.2GB rescued to `/media/amiller/fractal-nvme2/vexa-archive/` (root is at 93%; the nvme2
drive has 171G). Per-rig `logs/` + `recordings/`, plus `pgdump/`. rig1 dump restore-tested into a
scratch db — 96 meetings / 5496 transcriptions against 5497 live. `backup.sh` there is idempotent
and runs 04:15 nightly via cron; logs+dumps also rsynced to `archive/` in this repo (gitignore it).
NOTE: fractal's host `pg_restore` is too old to read these dumps — use the one in the container.

- [ ] Bind-mount `/tmp/vexa-workloads` and point the recorder at `/var/lib/vexa/recordings`, so
      this stops depending on a cron winning a race with a container recreate. Needs a recreate,
      which is exactly the event that destroys the data — archive first, always.
### Raw audio: it was never lost, it was unreadable (2026-08-18)

Issue #11 says audio "is dropped" and a post-pass is "currently impossible". That premise is
wrong. The recorder writes a full-meeting Opus stream to `/tmp/recording_<id>_<uid>.webm` — but it
concatenates MediaRecorder chunks WITHOUT the init segment, so every file starts mid-cluster and
no decoder opens it. Exactly one archived file (recording_87) kept its header.

Prepending that 146-byte EBML+Tracks preamble to the first whole cluster makes them decodable.
Meeting 99 recovered 1,565,348 kB of PCM = 2h16m at 48k stereo, matching its 13:04-15:25 wall
clock. Backfilled the archive: 28 repaired, 3 already valid, 9 too short to hold a cluster (all
under 170KB, dead test bots). `webm-init.bin` + `repair.py` live in the archive; `backup.sh`
now repairs and ffprobe-verifies every recording as it copies it out.

Retention: 21 days on archived audio, in backup.sh. Nothing qualifies yet (oldest is 2026-08-12),
so the first deletion happens ~2026-09-02. Rate is ~60MB/hour at the current stereo 133kbps —
roughly 5GB per 21 days at 4h/day, against 171G free. Mono at 32kbps would cut that ~10x.

- [ ] Prune `/tmp/recording_*.webm` inside the containers after a verified archive — it grows
      unbounded until a recreate, and a recreate is the thing that loses it.
- [ ] Decide stereo-133k vs mono-32k at the recorder, per #11's "encode, do not store raw".
- [ ] `credentials.md`: what the rig retains and for how long. #11 lists it as done-when, and
      21 days of other people's voices is the kind of thing disclosed, not discovered.
- [ ] Fix the recorder to emit the header itself, so repair.py stops being load-bearing.
- [ ] Acts to a table keyed by meeting_id, with an emit timestamp. The log lines carry NO
      wall-clock time; ordering against `[SpeakerStreams]` events is recoverable, exact latency is
      not. "Which reaction landed, when, against which transcript line" is the signal worth having
      (Andrew 2026-08-18: "getting reactions from people is incredible alpha").

## 2026-08-18 night — reboot recovery and the recorder clobber, both fixed

fractal rebooted at 15:36 EDT and the rig did not come back. The host `/tmp` was wiped, taking the
API tokens with it, so `board.py` died on startup with FileNotFoundError and the console at
192.168.100.4:8090 was dead. The overlay was never the problem — ping and ssh were fine throughout.

`relaunch.sh` exists precisely to recover from this, and was itself broken on fractal in two ways:

- It sourced `~/projects/ic3camp-teexai/teexai-transcribe/.env` for NEAR_API_KEY. That path does not
  exist on fractal, and with `set -e` recovery aborted at line 14 — every reboot, silently. The key
  is already in `~/vexa-rig/.env`, which docker compose reads natively, so the line was vestigial.
- admin-api reports healthy before postgres accepts writes, so the user-create returned a non-JSON
  error page and the script died on the parse. Now retried for up to 2 minutes, then fails loudly.

Both fixed, `relaunch.sh` run end to end (containers reconciled, NOT recreated — data intact), and
an `@reboot` cron installed. Recovery is now automatic.

- [ ] The @reboot path is proven by running the script, not by an actual reboot. Verify on the next
      real one, and note `docker compose up -d` will recreate containers if the compose file has
      drifted since they were built — which destroys the in-container recordings. Archive first.

### #16 recorder clobber — fixed

Sink wrapper now keeps the largest master per key and drops any later one that would shrink it.
Deployed with `hotswap.sh`. Test bot 106: is_final 24816B, session-close 464B, `DROPPED shrinking
master` logged, 24816B on disk. Before tonight that file would have been 464B.

- [ ] Confirm on a 30+ minute call — ffprobe duration against wall clock. Tomorrow's first meeting.
- [ ] Why meeting 99 survived the old bug is still unexplained.

### Also tonight

- `live.sh <meet-code>` — joins, waits for the meeting row, starts the forwarder, prints the
  shareable link. Tested end to end (bot 105, page reported known:true). `fwd.py` moved out of
  /tmp into the repo, where the reboot cannot eat it.
- `backup.sh` aborted on the first unrepairable recording, taking the postgres dumps with it —
  one bad webm would have killed tonight's 04:15 cron entirely. Now keeps it as `.raw`, reports it
  by name, counts it in the summary line, and continues.

## Rename to Port Call — phased plan (2026-08-19)

Three things are called "vexa" here and only the first is the project. Ordered by value-per-risk.

### Phase 1 — prose identity  [DONE]
- [x] `README.md`, `docs/index.md`, `docs/_config.yml`, `NOTICE` ("Port Call (formerly vexa-poc)")
- [x] The published atlas artifact
- [x] New registry images: `ghcr.io/amiller/port-call-lite`, `-shims`
- Cost: none. Nothing resolves these strings.

### Phase 2 — the name in the room  (issue #25, ~30 min)
- [ ] `board.py:299` `"bot_name": "Vexa"`, `demo.sh:37` `${BOT_NAME:-Vexa}`,
      `e2e.sh:45` `"Vexa E2E"`, `journeys.sh:54` `"Vexa Journeys"`
- [ ] **Add the new display name to `roster.json` as `{"bot": true}` BEFORE the first meeting.**
      The roster keys on the Meet display name; renaming the bot without this makes the next
      `postdoc.py` run roster-block on an unknown speaker. This is the one trap in Phase 2.
- Cost: near zero, no infra touched. Highest visible value — it is the name participants read.

### Phase 3 — the GitHub repo  (~15 min, one-way-ish)
- [ ] Rename `amiller/vexa-poc` → `port-call`; `git remote set-url origin`
- [ ] Optionally rename the local checkout `~/projects/vexa-poc`
- GitHub permanently redirects the old URLs, so the 10 issue links in `docs/` keep working and
  are worth leaving alone rather than rewriting.
- **Do it before the first push.** `origin/main` is currently behind by a full day's work, so
  right now the rename costs nothing; after pushing, other clones inherit the old name.

### Phase 4 — infrastructure  [BLOCKED — do not start]
Would touch: 4 rig dirs, 18 containers, 8 volumes, 2 crontab lines, the archive root, the
`/tmp/vexa-*-token.txt` paths, `rig-env.sh`'s derivation, `backup.sh`, and the compose project
name (which comes from the directory name).

**Blocked by #26.** Renaming the directories changes the compose project name, which recreates
every container — and #26 means recordings currently exist ONLY in a container's `/tmp`. Doing
this today would destroy meeting audio to achieve a cosmetic change. Revisit only after #26
persists recordings to a volume, and even then the value is low: these strings are what
`docker`, the gate, the crontab and the archive resolve, and nobody outside sees them.

### Never rename
`vexaai/vexa-lite`, `@vexa/join` — upstream software, and what `docker pull` resolves.
