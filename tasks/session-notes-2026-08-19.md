# Session handoff — 2026-08-18 night into 2026-08-19

Written to survive a context compact. Facts here were verified, not assumed; where something is
unverified it says so. **No personal addresses in this file** — they live in `roster.json` beside the
archive on fractal, deliberately outside git, because this repo is public.

## Rig state, 2026-08-19 afternoon

- fractal up since 2026-08-18 15:35. Console current and serving on `192.168.100.4:8090`, tokens
  present, `@reboot` recovery installed in crontab.
- Nightly backup cron ran clean unattended at 08:15 UTC: `total=1.1G dumps=21 unrepairable=0`.
- Archive at `/media/amiller/fractal-nvme2/vexa-archive/` — per-rig `logs/` + `recordings/`,
  `pgdump/`, `backup.sh`, `repair.py`, `webm-init.bin`, `roster.py`, `roster.json`, `improved99.txt`.
  Root is 93% full: never put anything on `/`.

## Fixed and verified

1. **#16 recorder clobber — CLOSED on real evidence.** The sink kept the largest master per key and
   dropped any later one that would shrink it (`live/services-bot-src/recording.ts`, deployed via
   `hotswap.sh`). Meeting 111 (2h): is_final 103,783,250B, session-close 91,547B, `DROPPED shrinking
   master` logged, **103,783,250B on disk**, decodes to **2:00:03** of audio. Before the fix that
   meeting's audio would have been a 91 KB fragment. Audio lost before 2026-08-19 is NOT recoverable.
2. **Reboot recovery.** `relaunch.sh` was broken two ways on fractal: it sourced a nonexistent
   `~/projects/ic3camp-teexai/.../.env` (aborting at line 14 under `set -e`, every reboot), and the
   admin user-create raced postgres readiness and died parsing a non-JSON error page. Both fixed,
   `@reboot sleep 45 && cd ~/vexa-rig && ./relaunch.sh` installed. Proven by running the script;
   NOT yet proven by an actual reboot.
3. **`live.sh <meet-code>`** — join, wait for the meeting row, start the forwarder, print the
   shareable link. `fwd.py` moved out of `/tmp` into the repo. Both deployed and used live.
4. **`await-admit.sh <code>`** — waits for the bot to be admitted from the Meet lobby and then starts
   the forwarder by itself. Used successfully on meeting 111.
5. **`backup.sh`** no longer aborts the whole run (postgres dumps included) on one unrepairable
   recording; keeps it as `.raw`, names it, counts it in the summary.
6. **#16 made durable, and the image made buildable again (2026-08-19).** The fix had been living
   only in `live/` on fractal. Now `patches/bot-recording.ts` (renamed to match the
   `patches/bot-X.ts` → `src/X.ts` convention) is COPY'd by `Dockerfile.patched`, the bot `tsc`
   rung greps `DROPPED shrinking` in `dist/recording.js`, and `populate-live.sh` asserts the same
   string in `live/` after seeding. Guard proven **both ways**: builds green with the patch, and
   builds RED when the upstream `recording.ts` is substituted.
   Found while proving it: **the image had not been buildable since 2026-08-17.** That commit added
   `RUN cd /app && npm install --no-save jsdom`; `/app` is a **pnpm** tree (`packageManager` in its
   package.json), so npm's arborist walks pnpm's symlinks and dies on `Cannot read properties of
   null (reading 'matches')`. And node's **ESM resolver ignores NODE_PATH**, so the accompanying
   `NODE_PATH=/app/node_modules` in `bench.sh` could never have resolved `import { JSDOM }` even if
   it had built. jsdom now installs into its own tree at `/opt/probe` and `bench.sh` runs the rung
   from there. That rung now passes — **10/10, the first time it has ever run.**
7. **Console drift.** fractal was running the Aug 12 `board.py`; commit `dbbe745` (the camera skin
   picker) was committed Aug 17 and never deployed. Deployed; old copy at `board.py.aug12.bak`.
   Nothing deploys `board.py` automatically — `relaunch.sh` only starts whatever file is there.

## Why "proven" did not mean anything (2026-08-19)

There is **no merge gate at all**: no `.github/workflows`, no `core.hooksPath`, no PRs — 16 commits,
0 merges, everything straight to main. Nothing runs on commit.

The suite itself is not the problem; it is detailed and good. The problem is *what it points at*.
Every rung in `bench.sh`, `e2e.sh` and `journeys.sh` is `docker exec` into an **already-running**
container, whose bot code is the gitignored `live/` bind-mount that `hotswap.sh` compiles in place.
So `Dockerfile.patched` — the artifact that carries this code to any other machine — was never on
the test surface. "Proven" meant "passes against the mutated container in front of me", which is
precisely the state no other machine can reproduce.

Closed by three changes to `bench.sh`:
1. rung 1 builds `Dockerfile.patched` (its internal COPY/grep guards then assert themselves);
2. rung 2 diffs committed `patches/` against the running `live/` tree;
3. the DOM fixture rung now runs in a **throwaway container from the image just built**, not in the
   ambient rig — testing the artifact, not the hand-mutated environment.

Both reds that first run produced are now resolved. The camera drift was real and is gone —
`patches/bot-camera.ts` (with the parked `AVATARS.hancock`) is deployed to rig 1's `live/`, so
committed == running and skin-bench passes 4 avatars x 3 backgrounds. The audio red was **not** a
real failure: the click train was inline in `bench.sh` with a fixed `sleep 1` before playback, and
pulse leaves both devices SUSPENDED, so on a loaded box `parecord` had not begun capturing when the
first click played. It is now `probe/audio-bench.sh`, which waits for capture to actually start.
5/5 deterministic on rig 4, 3/3 on rig 1. **The bot is not inaudible** — an earlier note here said
it might be, and that was the flaky rung talking.

## The gate (2026-08-19)

- `rig-env.sh` — one `RIG` variable derives container / gateway / token paths, inferred from the
  directory name. `hotswap.sh`, `demo.sh`, `join-meeting.sh`, `relaunch.sh` all hardcoded rig 1, so
  a gate run from `~/vexa-rig4` recompiled the human's rig. `e2e.sh` takes a per rig+room `flock`.
- `gate.sh` — pre-flight build → `deploy-live.sh` → `bench.sh` → `e2e.sh`. **Refuses rig 1** unless
  `GATE_ALLOW_RIG1=1`. Pre-flight is before the deploy on purpose: deploying an unbuildable tree
  would leave the staging rig broken by the very check that rejected it.
- `.githooks/pre-merge-commit` fires **only on merges into `staging`**; `./promote.sh <branch>`
  merges `--no-ff` (a fast-forward makes no merge commit and would slip past the hook).
- **Proven both ways.** GATE GREEN on rig 4: bench green + e2e 10/10 in a real room. Then a branch
  reverting the #16 sink was refused at pre-flight, before the deploy touched the rig.
- Two bugs the gate found by being run — both now fixed and committed: the hook synced with
  `rsync --delete-excluded`, which **deletes** excluded paths on the destination (plain `--delete`
  protects them), and it wiped rig 4's `live/` and `.env`; and the promoted tree overwrote the
  rig's `docker-compose.yml`, so rig 4 came back trying to bind rig 1's ports. Host ports now come
  from the rig's own `.env` (`VEXA_GW_PORT` / `VEXA_UI_PORT`, defaulting to rig 1).
- rig 4's `.env` was restored from its own running container's environment — **not** copied from
  rig 1, and the value was never printed.

**Three commits on `main`, not pushed.** `origin/main` is 3 behind; pushing is Andrew's call.

## The post-meeting doc pipeline — BUILT, not yet unattended

`postdoc.py` in the repo and on fractal (identical). **Run it from the laptop** — postgres and the
roster are reached over ssh; the Drive token stays local.

```
./postdoc.py <id>                     notes -> doc -> share
./postdoc.py <id> --dry-run           print markdown, create nothing
./postdoc.py --poll [--since 24]      every completed meeting with no doc yet
```

- **Drive write token** at `~/projects/teleport/planning/scripts/drive_write_token.json`, scope
  `drive.file`, has refresh_token. Minted 2026-08-19 by browser consent. VERIFIED to create and own
  Docs. The `my-sheets` **service account does NOT work** — `403 storageQuotaExceeded`; service
  accounts own no Drive storage on a personal account. Do not revisit that path.
  Note `drive.file` means the token can only touch files **it** created — it cannot read Docs made
  by the MCP integration.
- **Notes are generated by `claude -p --model opus`**, not an API key — there is no
  `ANTHROPIC_API_KEY` anywhere and Claude Code auth here is the OAuth subscription. **Andrew has
  explicitly accepted this** for personal meeting transcripts, will keep it maintained, and wants it
  to **alert via Matrix if the auth goes stale**. It runs on his desktop, which he considers fine.
  Matrix alerting is NOT built yet.
- Idempotency keyed on Drive `appProperties.vexaMeeting`, so it survives a rename; the check runs
  before the model call so a re-run is free. Measured ~2 min for a 1169-segment meeting.
- `--poll` collects per-meeting failures, reports each, and exits non-zero naming all of them —
  deliberately does not stop on the first.
- Header block (date, times, participants, attribution, ASR caveat) is assembled from postgres and
  the roster, never by the model. Only Notes and Follow-ups are model-written.

**It is roster-blocked, not code-blocked.** A 24 h sweep found six unknown speakers. Meeting 111 now
resolves (addresses taken from the calendar invite); 100 and 103 still do not.

## Issues filed 2026-08-19 (all PII scrubbed — repo is PUBLIC)

- **#19** the rig fails silently — DOM modal detection every ~15s, allowlisted auto-dismiss (never an
  unrecognised button, the same machinery renders *Leave call*), metered visual model on join /
  every ~5 min / on suspicion. Plus: acts must verify their own outcome, not just report intent.
- **#20** turn every meeting into evidence — per-meeting review, a corpus, a weekly loop. The
  argument: meetings 100/101's audio was destroyed and nobody would ever have known.
- **#21** the bot never leaves on its own — decide from agreeing signals (silence window, participant
  count, calendar end, farewells in transcript) plus a grace period that cancels on activity. Never
  leave a live meeting is the unforgivable failure. Fixtures: meetings 99/100/101/111.
- **#22** brief the stenographer — prime Whisper's `initial_prompt` with attendee names (from the
  calendar) and a project glossary. `near-shim.py` forwards to an OpenAI-compatible endpoint that
  accepts `prompt`; it is simply never populated.

**PII scrub done 2026-08-19**: issues 14, 15, 22 and two comments contained real names and email
addresses on a public repo. All removed; a sweep across all 13 issues and their comments is clean.
Keep it that way — the roster belongs outside git.

## Open, needing a decision

- **32 kbps encode went into the wrong file.** Patched `browser-utils.global.js`; the live recorder
  is upstream `modules/record-chunker/dist/index.js`, which has zero `audioBitsPerSecond`. Meeting
  111 came out ~115 kbps. Not done.
- **#12 bind-mount: TRIED, FAILED, REVERTED.** Persisting the container's `/tmp` broke the bot
  ("died during join") — Xvfb's socket dir `/tmp/.X11-unix` lives there. Next attempt should mount
  only `/tmp/vexa-workloads`; recordings need a vendor patch because `writeBlob` hardcodes `/tmp` in
  `modules/recording`, which `hotswap.sh` does not rebuild.
- **#17 container-side pruning** deferred with the mount. **Matrix alerting** for postdoc auth.
- **dstack deployment still has NO issue** — largest untracked item. Verified 2026-08-19: 51 CVMs on
  the Phala account, zero named vexa; no vexa images on Docker Hub. Only the viewer
  (`meeting-brainrot`) runs on the pod. Blocker is pushing two images (~2.4 GB + ~0.9 GB) plus
  token minting with no docker socket inside a CVM.
- **Nine uncommitted files.** Nothing committed all session, per Andrew's standing rule.
  `patches/bot-camera.ts` holds an unfinished rooster experiment that should NOT ship.

## Facts worth not rediscovering

- Same model both passes: `openai/whisper-large-v3` live (`near-shim.py:44`), `large-v3` in the
  post-pass. Quality difference is the rolling window, not the model. Post-pass on meeting 99:
  18,268 → **23,143 words (+27%)**, 692 s at 12x realtime on the 3090, `faster_whisper`,
  `HF_HOME=/media/amiller/fractal-nvme2/huggingface-cache`.
- Recordings are headerless; `repair.py` + the 146-byte `webm-init.bin` makes them decodable.
- The recorder starts **~102 seconds late** — every meeting misses its opening. Unexplained.
- The bot lands in the Meet **lobby** for calendared meetings (its account isn't on the invite) and
  **times out** if nobody admits it. Inviting the bot's address to the event would fix it.
- Google drops modal dialogs into Meet that silently eat every command. Escape hatch:
  `./demo.sh shot`, find the button, then
  `docker exec vexa-rig-vexa-lite-1 sh -c "DISPLAY=:99 xdotool mousemove X Y click 1"`.
- Drive API returns `Internal error encountered` on `permissions.create` calls that SUCCEED — always
  verify by reading `permissions.list` back.
- `docker compose up -d` recreates containers if the compose file drifted, destroying in-container
  recordings and act logs. A plain restart/reboot does NOT. **Archive before any recreate.**
- fractal's host `pg_restore` is too old to read the dumps; use the one in the postgres container.
- The **calendar** answers three problems at once: who to share the doc with, who the bot should
  expect, and what names to prime the transcriber with (#22). `push-upcoming.py` already reads it.

## Avatar work — parked

Rooster avatars are canvas draw functions in `patches/bot-camera.ts`, not images. Several rounds
failed (read as rabbit, then devil, then cyclops). Andrew's diagnosis was the useful one: roosters
are prey birds with eyes on the sides, so dead-on reads as a predator; full profile reads as
wallpaper. Reference art (matchbox labels, heraldic cock, Jakuchū) is in the session scratchpad.
Last direction: **3D models**. Objaverse LVIS category `cock` has 75 models with direct download
(no auth) — several good ones found, including an actual rooster *head* sculpt (`f84480d3a0…`).
three.js render harness works locally. Parked mid-flight; head framing needs more work.

## Two team notes drafted, never published

`router_write` was blocked by the auto-mode classifier. Drafts in the session scratchpad
(`note-1-header.md`, `note-2-reactions.md`). One describes a private meeting's dynamics and should
be scrubbed the same way the issues were before it goes anywhere.

## Late night: participant feedback became the doc pipeline (2026-08-19, after midnight UTC)

- Meeting 115 (69 min) was a live evaluation of the bot's summaries by a participant who does
  expert manual post-processing. Their feedback is now IN postdoc.py: <=300-word forwardable
  Digest (third parties neutral — first generation violated this, doc replaced in place with
  --update), abridged corrected transcript REPLACING raw (raw stays in postgres, --raw opts in),
  privacy rule first, comment invite, writer access granted on request. Their doc also carries an
  ARIA-cohort context block sourced from meeting 112 — with 112's budget figures deliberately kept
  out — as a demo of recipient-aware crafting.
- #16 guard: THREE saves today (meetings 112, 113, 115). Recording 115 (66.7MB) archived by hand;
  upload still 500s (#26).
- Issues #31–#38 filed from the evening's lessons; PII sweep over #23–#38 clean ("a participant",
  never a name; `avatar: tina` in #37 is a public code identifier, matching issue #6's precedent).
- Everything committed on `night-19-aug` and promoted — GATE GREEN, staging at bc2d79d. Prod runs
  the same code via hotswap but main/prod deploy is Andrew's call, as is pushing to origin
  (origin/main now 10+ commits behind).
- Sidecars (fwd.py, goodpoint.py) all stopped; the lifecycle problem they demonstrate is #35.
