# Session handoff — 2026-08-20 (context reset point)

Continues `session-notes-2026-08-19.md` — read that first for the gate, the staging/prod split,
the rename, and the doc-pipeline rebuild. This file is what changed since, verified not assumed.
**No personal addresses here** — they live in `roster.json` on fractal, outside git, on purpose.

## Git / deploy state at handoff

- `staging` == `night-19-aug` == promoted at `97b72b1` (gate green, twice). `main` = prod = the
  previous deploy; **prod runs staging's code via hotswap** but main has not been moved (prod
  deploy = Andrew's call, via `./deploy-prod.sh`). **Nothing pushed to origin** — origin/main is
  ~12 commits behind; pushing is Andrew's call. GitHub repo not yet renamed (rename before first
  push — see the plan in tasks/todo.md).
- **Uncommitted right now:** `demo.sh` (stop now reads the DELETE response — it lied "stopped"
  while the bot stayed in a live call), `postdoc.py` (roster-prefs hook + honest retention
  footer), this notes file. Small, coherent — commit + `./promote.sh` next session.

## The doc pipeline in practice (mtgs 111, 115, 116)

- 111 (souk, nikete+Xyn): generated + shared on request. **Then Xyn flagged the withheld raw
  transcript** — they'd asked for the transcript itself. Regenerated `--update --raw` in place.
  Lesson recorded as Andrew's framing: **inferred per-person preferences go in roster.json
  `prefs`, never in public issues** ("what will become my user-preferences expressed"). Xyn has
  `prefs.raw_transcript: true` with a dated `_why`; postdoc reads prefs (any raw-preferring
  recipient ⇒ raw included — permissive side chosen, per-recipient split is #31). Memory note:
  `port-call-recipient-prefs.md`.
- 115 (Tina eval): retitled "Recipient-Aware Distillation" (model had titled it with an ASR
  mishear of the bot's name; prompt now forbids tooling names in NAME). Tina upgraded to writer.
  ARIA context block from mtg 112 inserted (budget figures deliberately excluded).
- 116 (hermes office hours): James Barnes added to roster (address from calendar), doc
  "Research Router Position Paper" shared with him as commenter.
- Retention footer now states facts: raw text on operator hardware, no third party, audio deleted
  at 21 days, **"ask and it gets deleted"** — a promise with no automation (#39); Andrew was told
  he can veto the wording, hasn't answered.
- **#14 cron STILL not installed** — offered three times, never confirmed. Every "was it
  automatic?" answer is still no. This is the top irritant; get an explicit yes/no.

## Auto-leave (#21) — now measured, not suspected

Upstream declares `automaticLeave.everyoneLeftTimeout` (120s → left_alone) and
`noOneJoinedTimeout` (600s → startup_alone). **No meeting has ever completed with either reason.**
- Empty-from-start: bot in empty lab room exited after ~12 min, reason `evicted` — probably
  Meet's own eviction, possibly our timer with the wrong label. Acceptable either way.
- **Everyone-leaves (the real case): DEAD.** Two-bot test (rig1 bot joins rig4 bot in the lab
  room — bots count each other as participant tiles), B deleted 15:24:59, A still active at
  15:33 (8+ min >> 120s). Full writeup in a comment on #21. Reproducible with no humans.
  Fix direction: the participant count observed at admission stops being consulted afterward.

## Meetings 116/117 bookkeeping

116 audio archived (63.4MB — **#16 guard's 4th save**, a 106KB fragment would have replaced it).
Recording upload still 500s (#26) — every recording still archived by hand. Test meetings on
rig4: 9 (evicted), 10 (killed manually); rig1: 117 (test bot B, stopped). No sidecars left
running anywhere (verified at handoff).

## Issues filed this session

#31 notes-not-transcripts (participant feedback) · #32 doc comments as correction loop ·
#33 doc provenance (the ~/.claude accidental audit trail is GONE now notes run on NEAR) ·
#34 bot sharing identity + access policy · #35 sidecar lifecycle · #36 bangers ledger ·
#37 console preset coupling · #38 toolsmith lane · #39 retention is an accident, not a policy.
PII sweep across #23–#39: clean ("a participant", never a name).

## Facts worth not rediscovering

- `demo.sh stop` failure mode (now fixed): DELETE response was discarded; always read gateway
  responses. Kills of fractal-side sidecars must run ON fractal — a local `pkill` on the laptop
  silently does nothing to them (this bit twice).
- Meeting completions all say `stopped` even when nobody stopped them; completion_reason is
  unreliable evidence.
- Roster gained: James Barnes, Port Call/Port Call E2E/Port Call Journeys (bot entries — without
  these postdoc roster-blocks after the rename), Xyn prefs.
- goodpoint.py ran live at min-score 5 in office hours (Andrew: "it's great!"); banners turn the
  camera on — lurker→visible is a posture change worth asking about each time.
- Two Andrew tiles appeared in office hours (he was in twice); Meet was also recording natively,
  and a second notetaker bot was present.

---

# Session 2 — 2026-08-20 evening: latency, measured

Andrew asked three things: can the swarm test end to end, what is the round-trip ping, and can we
make progress on breaking into a conversation (#41). The first two are now facts.

## The numbers (measured, not derived)

Component legs, on the live rigs:

| Leg | Measured |
|---|---|
| ASR — near.ai TEE whisper-large-v3 | min 639ms, p50 2493ms, p90 3147ms, max 5895ms (n=40) |
| TTS — piper via tts-shim | 1185–1287ms, and `ttfb == full` — **not streaming** |
| LLM — DeepSeek-V4-Flash | 1051ms warm one-word, 3183ms cold, 3471ms at 180 tokens |

**ASR cost is not proportional to audio length** — 0.1s of silence cost 2420ms, 9.0s of speech cost
1133ms. It is queue/network dominated at near.ai, so chunking smaller makes it worse, not better.

End-to-end, from `./duel.sh` (two bots, 32 turns across two verified runs):

| | p50 | range |
|---|---|---|
| say-to-audible (`synth`) | ~1.35s | 1.28–1.95s, very stable |
| partner's audio ends → **draft** visible | ~0.7–2.1s | 0.03–3.03s |
| partner's audio ends → **`completed`** | ~6.3–8.5s | 4.46–11.04s |
| partner's audio ends → our reply audible (`rtt`) | ~7.9–9.9s | 5.87–13.03s |

**The headline: drafts arrive 5–6 seconds before `completed`, and everything downstream throws them
away.** `board.py` and `demo.sh` filter `completed`; a draft containing the number was sometimes
visible *before the speaker finished the sentence* (draft=0.03s). Driving off drafts would take the
round trip from ~8s to ~2.2s with no pipeline change at all, and streaming TTS would take it under
1s. This is the single biggest available win and it costs nothing.

## The 40-second finding

`transcriptions.created_at − end_time` over the six largest real meetings (~5,650 segments):
**p50 39.9s, p90 50.6s, max 79.6s.** Not ASR — `db_writer.py` holds a segment for
`IMMUTABILITY_THRESHOLD` (30s) after its last update and flushes on a 10s tick. Postgres is a
durability layer designed to be ~40s stale.

`goodpoint.py` read postgres directly, plus a 20s poll. **Every GOOD POINT banner in office hours
was reacting to something said 40–60s earlier.** Fixed: it now reads the gateway, which merges the
in-flight redis hash. Still `completed`-only, so *what* gets judged is unchanged.

## The 2-second cliff

`minAudioDuration` is 2s and `submitInterval` is 2s, and a turn only closes early when new audio
arrives after a >1s gap (`ONSET_GAP`) — but capture emits nothing during silence, so after a short
utterance nothing arrives to close it and the 15s idle timer is what finally submits. Measured: a
**1.5s utterance sat 16.7s** before being submitted at all. An utterance over 2s appears in ~2s.
It is a cliff, not a slope, and it is exactly the interjection case #41 cares about.

Also: `one, one, one` came back from Whisper as `1-1-1.` and was killed by the HallucinationFilter.
A repeated single token is what Whisper emits over silence, so a carrier has to be a sentence.
And the anti-repetition guard suppresses an identical repeat, so a retry must reword.

## What shipped

- **`ping.py`** — the counting game. One loop; `--lead` takes the odds, without it the evens. One
  instance + a human is the real number; two instances on two rigs is unattended. Per turn it
  records synth / draft / final / rtt, writes JSONL, prints percentiles. `--terse` measures the
  2s cliff on purpose.
- **`duel.sh`** — the two-bot rung (#24). Two rigs, one room, each bot hears the other. **DUEL
  GREEN** on rig 4 + rig 3. Refuses rig 1, pre-cleans stale rows, stops both bots on any exit.
- **`patches/bot-tts-playback.ts`** — `[tts] begin` / `[tts] audible` with epoch stamps. This is
  #3's "logged latency breakdown per speak act", and it is what makes `synth` measurable.
- **`goodpoint.py`** — reads the gateway, not postgres.
- **`docs/swarm.md`** — the fourth rung, and what a reboot does.

Deployed to rigs 3 and 4 only (`deploy-live.sh`). **Not on rig 1, not committed, not promoted.**

## Reboot findings (fractal rebooted at 18:00:49 mid-run)

Only rig 1 recovers, via one crontab line. Rigs 2/3/4 come back with no tokens (gate dead), meeting
rows stuck in `stopping` (spawns refused, `DELETE` will not clear them — had to close two rows in
postgres by hand), and — on rig 3 — shims attached to the network with **no IP**, so the bot joined,
went active, spoke, and could not transcribe a word. Nothing upstream went red. Full writeup in
docs/swarm.md.

**Self-inflicted, worth knowing:** my `rsync --delete` removed root-level `near-shim.py` /
`tts-shim.py` from rig 3, whose containers were created from an older compose that bind-mounts those
paths. Docker recreated them as *directories* and the containers then could not start. The gate
hook uses the same `--delete`, so this is live in `.githooks/pre-merge-commit`. Recovery: `rmdir`,
then `docker compose up -d near-shim tts-shim`. Rig 1 has the same empty directories but mounts
`shims/`, so it is unaffected — left alone.

## Open / next

- **#41 fast responder** is the next piece and is now tunable against real numbers: the floor
  signal (per-speaker RMS, already emitted at frame rate) needs no ASR and no LLM, so claiming the
  floor is a ~100ms decision while *what to say* stays seconds away. The carrier-then-splice shape
  is what the `hi... hi... hi...` trick was doing by hand.
- Streaming TTS out of piper — 1.2s of dead air per utterance, pure loss.
- Draft consumption downstream (board.py, goodpoint.py) — 5–6s per turn, free.
- Reboot recovery for rigs 2/3/4 — one crontab line each, **not added, needs Andrew's yes**.
- `ping.py` human mode has not been run against a human voice yet. Every number above is TTS
  hearing TTS; a human mouth may transcribe differently.

## The capture tap — the telemetry sink that was never wired

Andrew's correction, and he was right: the counting game should be a **metronome and a phase
measurement**, not turn-taking. Turn-taking couples the number to Whisper's confirmation logic and
measures the transcript loop; he wanted the AUDIO loop — transmit a known rhythm, count along with
what you hear, align received audio against transmitted audio. That needs raw samples with an
honest timebase, which the rig could not produce.

`makeTelemetryTap` (capture-bridge.ts:68) has always teed every captured frame — exact PCM, the
capture `ts`, the glow-bound speaker name — into an OPTIONAL `TelemetrySink`. **Nothing ever
constructed one**, so the tee was a single truthiness check and every frame was dropped.

Now wired: `patches/bot-capture-tap.ts` + four lines in `bot-index.ts` + a Dockerfile COPY.

- **The switch is a directory**, not an env var: the tap writes into `/tmp/vexa-capture-tap` and is
  off whenever that directory is absent (it is never created by the bot). `mkdir` turns it on,
  `rm -rf` turns it off, next bot spawn picks it up — no compose edit, no container recreate. An
  env var would have meant recreating the container to toggle a diagnostic, which on rig 1 is the
  operation that destroys recordings.
- Bounded by `VEXA_CAPTURE_TAP_MB` (default 256). Append-only, fire-and-forget, every fault
  swallowed after one log line. A tap that cannot open says so loudly rather than going quiet.
- Format: one `CapturedFrame` JSON per line, `pcm` = base64 Float32LE verbatim.

**Measured geometry:** frames are 4096 samples = **256ms at 16kHz**, arriving every ~256ms. `ts` is
stamped Node-side as the frame crosses the Playwright boundary (capture-bridge.ts:210), so it marks
the END of the block: sample i occurred at `ts - (pcm_len - i)/16000`. The PCM is intact inside the
frame, so the 256ms cadence is only the ANCHOR resolution — the envelope is computed at 5ms.

## First real acoustic measurement

`make-metronome.py` renders 1..10 at exact 1.000s onsets (each number head/tail-trimmed) into
`shims/sfx/count.wav`, played via the shim's `!name` path. rig3 played it, rig4's tap recorded it:

- **One-way acoustic latency, bot -> Meet -> bot: 495ms** by cross-correlation (5ms resolution).
- 8 of 10 beats recovered at 1s spacing. **Beat 0 was lost entirely**, and beat 1 came back at
  rms 0.619 against 0.20–0.31 for everything after.

That last point is worth more than the headline. It is consistent with Meet's own transmission
ramp / AGC swallowing the first ~1s of audio after silence — which is exactly #41's claim that
*"the first sounds you make are swallowed"*, arrived at there by social reasoning and here by
measurement. If it holds, the `hi... hi... hi...` carrier is not merely a politeness device: the
leading audio is **technically discarded**, so any barge-in must spend a sacrificial prefix.
Caveat: one run, and a window-edge artifact is not excluded. Repeat before relying on it.

**`!count` went audible in 82–91ms** vs 1300–1900ms for ordinary TTS — the sfx path streams a
pre-rendered file instead of running piper. A pre-rendered carrier can therefore start claiming the
floor in under 100ms while the LLM takes its seconds deciding what to say. That is the whole
carrier-then-splice mechanism, already shipped, for sound effects.

## sync.py

Coarse from words, fine from samples: a 1.000s metronome is periodic, so audio cross-correlation
alone is ambiguous at whole-second multiples. The transcript says which beat you started on
(unambiguous); the audio gives the sub-beat offset. Neither alone is enough. Refuses to run when
the bot is alone in the room (`participantTiles <= 1`) — three rounds were once played into an
empty call because nothing checked.

## Mistakes this session, for the lessons file

- **`rsync -a patches/foo.ts host:rigdir/` puts the file at the RIG ROOT, not in `patches/`.** The
  wiring silently did not deploy, `dist/index.js` had zero references to it, and two stray `.ts`
  files were left at the rig root — the same litter that broke rig 3. Always `host:rigdir/patches/`.
- Started a human test without checking `participantTiles`. Three rounds into an empty room.
- The retry in ping.py re-said the identical sentence, which the anti-repetition guard suppresses
  by design, so the run stalled waiting on audio that was never emitted. Retries must reword.

## acoustic.py — the self-test Andrew actually asked for

"Instead of making me join again figure out how you can do audio processing and self test in lab
room" — then, on seeing one-way legs only: "I want two bots playing the sync game over audio to
each other." Both are now built. Four legs, no human, repeatable:

1. **Loopback** — paplay -> tts_sink -> virtual_mic via parecord. No meeting, no bot, no browser.
   The metronome survives our own plumbing at 1.000s +/- 0.02 spacing. The ABSOLUTE offset here is
   NOT trustworthy (parecord's capture does not begin when the shell backgrounds it: +40ms one run,
   -260ms the next) — it is a smoke test of the chain, not a latency figure. Said so in the code.
2. **A -> B** and 3. **B -> A** — one bot plays, the other's capture tap records.
4. **The duet** — B watches its OWN tap, detects the beat by energy alone, locks phase, and counts
   along on the beat it HEARS. A then measures B's counts against A's transmit onsets. This is the
   closed loop, with B sitting in the seat a human occupies.

Measured, self-consistent run (rigs 4 and 3, lab room):

| | |
|---|---|
| rig 4 -> rig 3, one way | **145 ms** |
| rig 3 -> rig 4, one way | **225 ms** |
| sum of the one ways (pure audio round trip) | **370 ms** |
| duet closed loop | **525 ms** |

The 155ms gap between the duet and the sum is **B's own act -> audible cost** — redis, bot, sfx
path, paplay. That is precisely the fast responder's latency budget in #41, now a number.

For scale: the human run through a phone measured ~600ms, same family.

### Three estimator bugs found by disagreement, all worth keeping

- **Aliasing.** The duet search ran to 1800ms — nearly two beats of a 1.000s metronome — and
  reported a real 465ms round trip as **1465ms**. Every search is now capped inside one period.
- **Box-fit reads late.** Correlating a 250ms box against each onset centres on a word's energy
  MASS, not its attack: it said 495ms where the attack detector said 145ms. The attack is the
  latency; the difference is the word's rise time. Both are printed so neither hides.
- **Swallowed leading beats.** `rig 3 -> rig 4` read **1220 ms** — not a slow network, but Meet's
  transmission ramp eating the first beat, so the earliest detected attack was beat 1. The fix is
  to take the attack MODULO the beat period, which is robust to however many leading beats are
  lost, and to report how many were. This is the third independent sighting of the ramp effect
  (also: beat 0 lost in the first rig3->rig4 metronome run, and the AGC decay 0.62 -> 0.20).

That ramp is #41's "the first sounds you make are swallowed" — reached there by social reasoning,
measured here three times. A barge-in must spend a sacrificial prefix because the leading audio is
**discarded**, not merely impolite. With `!count`-style pre-rendered audio going audible in 82-91ms,
the carrier is cheap enough to always pay.
