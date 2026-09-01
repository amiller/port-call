# Roadmap

What this is trying to become, and what stands between here and there. Open work lives in
[GitHub issues](https://github.com/amiller/port-call/issues); this page is the shape those issues
make.

## Where it is now

A bot that can *act* in a Google Meet — speak, chat, react, publish a camera feed, share a screen —
driven entirely by `redis PUBLISH`. Every surface has been verified against real Meet, including a
populated call with humans in it on 2026-08-13. The bot holds a Playwright `Page` handle and
nothing else; the brain is not in the bot.

Since then it has grown a second lane (Signal Desktop over CDP, where the HUD is a real `v4l2`
camera device), a hosted lane (a Phala CVM a tenant reaches over HTTPS), and a clock (`daily.sh`,
05:00, staging rig, evidence kept).

The honest summary of reception, from mining the 08-12 transcripts: **amused, not impressed.** The
entertainment value came from the failure modes. That verdict set the agenda below and it has not
been retired, because the thing that would retire it has not shipped yet.

The second honest summary, from 2026-08-29: **the bot has looked and sounded identical for two
weeks, and almost none of that was a missing feature.** Four avatars, four backgrounds, the
repetition guard and the speak wind-up are all deployed on rig 1 — the rig Andrew actually takes
meetings on, byte-identical to staging. What kept the bird on screen is `avatar: 'rooster'`,
hardcoded at `bot-camera.ts:38`, plus nobody passing the other arguments `demo.sh camera` has always
accepted.

Only two of the complaints are real gaps. The TTS shim accepted a `voice` argument and discarded it
— `synth()` ran one hardcoded piper model until 2026-08-29, so for two weeks there was exactly one
voice. And caption modes have never existed; there is no `captionMode` anywhere in `patches/`.

That distinction matters more than it looks, because the two produce opposite lessons. A missing
feature is a backlog problem. A shipped feature nobody switched on is a *decision* problem, and this
repo has no queue for decisions at all — see below.

## The thesis

Port Call is a meeting participant that improves itself from what participants say about it.

The loop, from the observer's seat: someone in a call says *"why does this keep saying the same
line?"* — that sentence is already in the transcript, because transcribing is the thing this bot
was built on top of. It becomes an issue with the quote in the body. An agent is dispatched against
that issue, works it on a staging rig, and posts its evidence back to the issue. It lands. The next
meeting has a bot that does not repeat itself, and the person who complained can see their own
sentence in the commit history.

Everything on this roadmap is either a surface that loop can act on, a rung that lets an agent
prove it acted, or the plumbing that carries the result to someone who isn't Andrew.

### Why the loop has not been running

Worth writing down, because the fix is structural and not effort. Two mechanisms:

**The tracker was not the queue.** Work was dispatched from `tasks/todo.md`. Nothing in the repo
read the issue tracker — no `gh issue` call in any script — so 75 issues accumulated as a
write-only log while agents worked from a different file. The sibling repo (`oauth3`) already
dispatches by issue number and posts results back with `gh issue comment`; Port Call never adopted
it.

**The dispatch rule filtered out everything that matters.** From `docs/swarm.md`: *an agent is only
assigned work whose success condition it can observe by itself*, and the queue is *"ordered by this
principle rather than by value."* That rule is correct and was bought with real pain — on 08-12
every live failure was one selector bug that passed the entire suite. But apply it to *is this
voice better*, *does hancock read at tile size*, *did that joke land*: every one is judged by a
human in a call, so none can ever be dispatched. Two weeks of commits are what that sentence looks
like in practice.

The unblock is the move this repo already knows how to make. The DOM fixture harness pulled the
08-12 bug class down from "five humans in a room" to a unit test. `duel.sh` pulled audio down from
"needs a call" to two bots hearing each other. The same move applies to taste: an agent cannot
judge a voice, but it can render **a page of ten voices saying the same line** or **a contact sheet
of every avatar at the real tile crop**, and the judgement that took a meeting now takes sixty
seconds. That is what [#57](https://github.com/amiller/port-call/issues/57) and
[#62](https://github.com/amiller/port-call/issues/62) are, and it is why they are in the first
milestone rather than filed under tooling.

---

## M1 — A bot worth being in a room with

**Target: 2026-09-05.** Milestone `demo-day 09-05`.

**Shipped 2026-08-29, gate green on rig 4** (bench green including the voice-cast and caption-mode
rungs, e2e 19/19): the voice cast and its listenable sheet (#61, #62), the skin registry with
hancock in front and `frog`/`scope`/`starfield` new (#58), caption modes (#78), acts through the
gateway (#72), the provenance card (#73), the console reading the registry (#37), `publish-images.sh`
(#79), the fleet board, and the second-join rung (#76). What remains in M1 is the hosted republish
and wiring the read side of `AVATAR_VOICE`.

Today the tile is a rooster and the last three transcript lines, in one voice. That caption is a
good *heartbeat* — you can watch words land and know Whisper is following — and a poor
*background*, because three lines is all it will ever be.

Separate the three things that are currently one thing:

| Axis | Today | Target |
|---|---|---|
| Background | transcript strip, always | selectable mode ([#4](https://github.com/amiller/port-call/issues/4) ✔, [#29](https://github.com/amiller/port-call/issues/29), [#40](https://github.com/amiller/port-call/issues/40)) |
| Character | rooster, hardcoded | a registry, not an edit to drawing code ([#58](https://github.com/amiller/port-call/issues/58), [#59](https://github.com/amiller/port-call/issues/59)) |
| Voice | one piper model, `voice` discarded | a cast, switchable at runtime ([#61](https://github.com/amiller/port-call/issues/61)) |

- **The judgement artifact for voice** ([#62](https://github.com/amiller/port-call/issues/62)) — a
  page of every candidate saying the same lines, with its measured time-to-first-audio beside it.
  The camera half already exists: `probe/skin-bench.mjs` renders the contact sheet, crops to the
  ~560px band Meet actually shows (`CROP_X = 360, CROP_W = 560`, mirroring bot-camera.ts) because
  half the vitals panel was drawing outside it, and re-feeds a fixed corpus per cell because a sheet
  that fed the swarm field once and then walked twenty combinations captured a field that had
  already faded, and reported the background broken when the bench was the broken thing. #57 shipped
  2026-08-25. Only the voice sheet is missing.
- **Default to hancock.** A default is an identity decision, which is why it sat for four days
  waiting for Andrew's call. Being disappointed for four days *is* the call.
- **Acts through the gateway** ([#72](https://github.com/amiller/port-call/issues/72)) — every
  trick this project is about travels on the container's redis bus, which `demo.sh`, `board.py` and
  `e2e.sh` all reach by `docker exec`. A tenant has no exec. Until this exists a hosted bot joins,
  sits there with its camera off, and nothing a tenant can reach will change that.
- **Caption modes** off / headline-only / full — the one genuinely unbuilt participant complaint.
  Albiona, meeting 67: *"it's a little distracting to read what I'm saying."* The speaker should not
  read their own words back in real time. Twelve days open and counting; there is no `captionMode`
  in `patches/`.
- **Prove and close what already shipped.** Anti-repetition (Tina, m76: *"Why does this keep on
  saying the same line? Can you not learn something?"*) landed 2026-08-17 in `1ee577d` —
  `patches/bot-repetition-guard.ts`, suppression loud and never silent, sound effects exempt because
  repeating an airhorn is the joke, wired into both `bot-chat.ts` and `bot-capture-bridge.ts`. The
  speak wind-up ([#3](https://github.com/amiller/port-call/issues/3)) landed in the same commit.
  Both are unproven in a real call and neither has an issue to close, which is precisely how they
  came to be listed as open work twelve days later.
- **Harvest to issue.** A complaint is already in the transcript — transcribing is what this bot was
  built on. Turning it into a filed issue with the quote and the meeting id is a transcript pass and
  a `gh issue create`, it is mechanically checkable (does the issue carry the quote? is it deduped?)
  and therefore dispatchable under the swarm rule today. It is in M1 rather than M3 because the demo
  chain is not honest without it: the two harvests this project has done were both done by hand.
- **Links in side chat.** Andrew's ask, no issue until now. The chat surface already sends and
  reads; this is the cheapest agentic-looking trick available.
- **The image bump and the join-reliability cluster**
  ([#76](https://github.com/amiller/port-call/issues/76),
  [#69](https://github.com/amiller/port-call/issues/69)) — the demo runs on the hosted instance, so
  a fix that stops at the rigs is not in the demo. `publish-images.sh` now builds, pushes and
  re-pins in one command; #76 (the profile volume that poisons itself, so every join after the first
  fails) is on the critical path and had no milestone.
- **A fleet board.** Four rigs, the CVM, bench and e2e per rig, and how stale each number is. A rig
  that died in the night — tokens wiped from `/tmp` by a reboot, a shim back on its network with no
  IP, a meeting row stuck in `stopping` — is invisible from outside and each one is caught by a
  rung that already exists. Absence must never render as green.
- **Provenance on the tile** ([#73](https://github.com/amiller/port-call/issues/73)) — which commit
  is in the room. Free to add and it makes every demo self-dating.

**Cut to stretch, deliberately:** 3D avatars ([#59](https://github.com/amiller/port-call/issues/59)),
WebGL backgrounds ([#29](https://github.com/amiller/port-call/issues/29),
[#40](https://github.com/amiller/port-call/issues/40)), and the Kokoro engine half of #61 — the
piper cast covers the demo and a new engine is a VRAM question, not a demo question. None of the
three appear in the demo chain.

**Done when:** someone who was in the 08-12 call watches the bot and does not recognise it.

### The decision queue

The dispatch rule filters out work an agent cannot judge. Nothing catches what falls out, so it
lands on Andrew and waits — the hancock default sat four days *with the contact sheet already
rendered*, and the CVM's Google-profile question is sitting there now. That is not a backlog, it is
an unqueued decision, and it is the failure mode that produced "two weeks and the same rooster."

So: every judgement artifact ships with a **recommended default and a date after which silence
ratifies it.** Being disappointed for four days is a call, but it should never have had to be.

## M2 — It reads the room

The complaints in M1 are all one complaint: it talks too much and gives too little warning. M2 is
the other half — it should have something worth saying.

- **Facilitation** ([#42](https://github.com/amiller/port-call/issues/42),
  [#43](https://github.com/amiller/port-call/issues/43)) — twice-endorsed and the most likely thing
  this turns into: welcoming people, tracking who has not spoken, holding the agenda. Andrew
  mid-call on 08-13; Tina independently in m71, as a Shape Rotator grants cohort project. Note what
  [#42](https://github.com/amiller/port-call/issues/42) actually asks: inventory what the console
  can already do before deciding what should be automatic. The bot is a puppet; the question is
  which strings should pull themselves.
- **Breaking in is a control loop, not a speech act**
  ([#41](https://github.com/amiller/port-call/issues/41)) — and it belongs *below* the LLM. Barge-in
  timing is measured in hundreds of milliseconds; a round trip to a model is not.
- **Good point** ([#23](https://github.com/amiller/port-call/issues/23),
  [#36](https://github.com/amiller/port-call/issues/36)) — the thing that made the brainrot box feel
  agentic, and a ledger so its verdicts outlive the meeting.
- **Jokes, and whether they landed** ([#28](https://github.com/amiller/port-call/issues/28)) — the
  bot asks for its own feedback with chat reactions, the lowest-interference signal a participant
  can give. This is M3's input source, and the first thing that would make the loop self-feeding.
- **Playable, not merely measurable** ([#63](https://github.com/amiller/port-call/issues/63)) — the
  realtime interaction games are instruments today. "Taking over the meeting" is this issue with a
  scoreboard.
- **Knowing when to leave** ([#21](https://github.com/amiller/port-call/issues/21)) — decide from
  agreeing signals, never any one of them.
- **Asking for help** ([#54](https://github.com/amiller/port-call/issues/54)) over a channel someone
  reads.
- **The discoverability critique** ([#44](https://github.com/amiller/port-call/issues/44)) — a
  visible participant is the liability. Worth keeping in view while adding agency, because every
  item above makes the bot more present in a room where consent was given once, at the door.

**Done when:** the bot does something unprompted that a participant is glad it did.

## M3 — The loop closes itself

M1 and M2 are things a human noticed and an agent then built. M3 is the machine noticing.

- **Every meeting becomes evidence** ([#20](https://github.com/amiller/port-call/issues/20)) — a
  per-meeting review, a corpus, a weekly pass over it.
- **Doc comments are the correction loop**
  ([#32](https://github.com/amiller/port-call/issues/32)) — people already correct the shared notes
  in place; harvest those and regenerate.
- **Provenance per document** ([#33](https://github.com/amiller/port-call/issues/33)) — which
  prompt, model and session made it, because a corpus you cannot attribute cannot be audited.
- **Rolling summary by appending** ([#45](https://github.com/amiller/port-call/issues/45)), not by
  re-reading the transcript every time.

**Done when:** an issue exists that no human filed, and an agent closed it.

### The notes lane, which has no milestone and should

Shipping notes to participants is the thing participants actually *receive*, and it is a running
pipeline with a recipient roster already —
[#9](https://github.com/amiller/port-call/issues/9),
[#14](https://github.com/amiller/port-call/issues/14),
[#15](https://github.com/amiller/port-call/issues/15),
[#31](https://github.com/amiller/port-call/issues/31),
[#34](https://github.com/amiller/port-call/issues/34),
[#35](https://github.com/amiller/port-call/issues/35),
[#68](https://github.com/amiller/port-call/issues/68),
[#71](https://github.com/amiller/port-call/issues/71). It belongs in M3 because a doc someone
corrects in place is the highest-quality feedback this system can get, and #32 already says so.

## M4 — Someone else can run it

Everything above is worth nothing if it only runs on the machine under Andrew's desk.

- **Invite accounts** ([#64](https://github.com/amiller/port-call/issues/64)) — someone gets their
  own instance *and the operator cannot read their transcripts*. `invite.py` does the provisioning
  today; the missing half is the guarantee, and the guarantee is the reason this runs in a CVM at
  all.
- **A pod tenant, not a CVM** ([#56](https://github.com/amiller/port-call/issues/56)) — one image,
  so it runs where kernel modules cannot be built. The deployment matrix is real: a raw CVM can load
  `v4l2loopback`, zed cannot.
- **The tenant console's next slices** ([#70](https://github.com/amiller/port-call/issues/70)) —
  meeting names, live transcript, and what happens when the token is wrong.
- **Differential testing** ([#24](https://github.com/amiller/port-call/issues/24)) — the same
  meeting, the same acts, three bots: fractal, zed, a pod. The strongest evidence this repo has ever
  produced was an agent bringing up a second host from the repository alone and reaching 10/10; that
  test is "could someone else run this", and it should run continuously rather than once.

**First slice, dated: Shashank drives a hosted instance.** `invite.py` provisions the tenant and
prints the link today; #72 makes the link worth having. That is M4's first slice and it ships with
M1, because a demo of a hosted product that only its author can drive is a demo of a rig.

**Done when:** someone who is not Andrew drives the bot through a link, and Andrew cannot read
their transcript.

## M5 — It doesn't lie and it doesn't die

The unglamorous milestone, and the one that decides whether any of the others can be believed.

- **The silent-failure family** ([#19](https://github.com/amiller/port-call/issues/19),
  [#49](https://github.com/amiller/port-call/issues/49),
  [#50](https://github.com/amiller/port-call/issues/50),
  [#51](https://github.com/amiller/port-call/issues/51)) — a blocked action once reported success.
  Ten false-green paths were removed on 08-22 and the reason there were ten is that nothing else was
  looking.
- **Reboots** ([#66](https://github.com/amiller/port-call/issues/66),
  [#67](https://github.com/amiller/port-call/issues/67),
  [#74](https://github.com/amiller/port-call/issues/74)) — a rig does not come back from one; only
  rig 1 does, because of a single crontab line. Three things break and none announces itself.
- **The rung is pull-only** ([#75](https://github.com/amiller/port-call/issues/75)) — four red days
  passed unnoticed. A scheduled check nobody is told about is a log, not a monitor.
- **Retention is an accident, not a policy** ([#39](https://github.com/amiller/port-call/issues/39),
  and [#11](https://github.com/amiller/port-call/issues/11),
  [#12](https://github.com/amiller/port-call/issues/12),
  [#16](https://github.com/amiller/port-call/issues/16),
  [#17](https://github.com/amiller/port-call/issues/17),
  [#26](https://github.com/amiller/port-call/issues/26)) — recordings live in a container's `/tmp`
  and only postgres survives a recreate. Also [#46](https://github.com/amiller/port-call/issues/46)
  and [#47](https://github.com/amiller/port-call/issues/47): snapshot the shared screen, never the
  faces, and flag what probably should not be kept.
- **Transcription quality** ([#10](https://github.com/amiller/port-call/issues/10),
  [#22](https://github.com/amiller/port-call/issues/22),
  [#18](https://github.com/amiller/port-call/issues/18)) — it is not the model, it is the rolling
  window, the unpinned language, and the silence. Whisper hallucinates on quiet, and every
  downstream claim inherits that.

**Done when:** a red day tells you before you find it.

---

## The demo it is all pointing at

Twenty minutes, internal, on the hosted instance. The strongest thing to put on screen is not a new
voice — it is the chain:

> Albiona, meeting 67, 2026-08-12: *"it's a little distracting to read what I'm saying."* → the
> issue → the agent that read it → its evidence in the issue comment → the commit → and here it is,
> in this room, right now, with captions in headline-only mode.

Run that chain on the three things genuinely fixed this week: Albiona on captions, the room on the
rooster, and the single voice. Then show Tina's repetition complaint as the **precursor** — fixed on
08-17 by a human reading a transcript by hand, with no issue and no trace, which is the exact
manual labour the loop replaces. That framing is both honest and a better argument: the contrast
between how her fix happened and how this week's fixes happened *is* the product.

The one thing not to do is stage the chain for Tina's quote. No issue ever existed for it, the fix
predates the tracker-as-queue convention, and a fabricated provenance in a demo about provenance is
the one failure the audience would be right never to forgive.

## What this is not

There is still no standing autonomous process. There is cron — `daily.sh` at 05:00, `backup.sh` at
04:15, `@reboot relaunch.sh` on rigs 1 and 4 — but no always-on worker and nothing that reads the
tracker.
Agents are dispatched from a session, several at a time, scoped to files that do not overlap. M3 is
the milestone that changes it, and it is deliberately third: a loop that files its own issues while
the surfaces are still one bird and one voice would just automate the wrong taste.

## Deliberately not on this roadmap

Restored from the previous version, because silent drops read as accidents to a swarm.

- **A second, observer-only bot.** Every surface here assumes one participant with agency. A silent
  observer is a different product and it competes with [#44](https://github.com/amiller/port-call/issues/44)'s
  critique rather than answering it.
- **Removing the Google API dependency.** The lab room needs a Meet REST space with
  `accessType: OPEN` and a project we control. Worth knowing, not worth fixing.
- **Parked, explicitly:** [#1](https://github.com/amiller/port-call/issues/1) meeting screenshots,
  [#2](https://github.com/amiller/port-call/issues/2) shared-microphone attribution,
  [#13](https://github.com/amiller/port-call/issues/13) translation,
  [#38](https://github.com/amiller/port-call/issues/38) the toolsmith lane. All real; none on the
  path to a demo or to someone else running this.
- **The Signal lane** is built and green, and has no milestone on purpose. It exists to prove the
  act vocabulary is not Meet-specific. [#65](https://github.com/amiller/port-call/issues/65)
  (screenshare enumeration) is its only open item and it is parked with the rest.
