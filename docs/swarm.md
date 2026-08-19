# How this gets maintained

Most of this repo was written by agents. That only works because of a specific constraint on what
they are allowed to be assigned, and it is worth writing down, because the obvious version does not
work.

## The problem with agents on this particular codebase

The bot's job is to click a UI that only exists inside a live Google Meet with other humans in it.
That is the worst possible target for unattended work: an agent cannot get into a meeting, cannot
tell whether a click did anything, and cannot distinguish "the selector is wrong" from "the room
was empty." On 2026-08-12 every single live failure turned out to be one bug — *a selector that
takes the first document-wide match and never checks what it got* — and every one of them **passed
the test suite**, because in an empty lab room each selector has exactly one candidate.

So the rule is: an agent is only assigned work whose success condition it can observe by itself.
Everything else waits for a human in a call.

## The three rungs

Work is placed on the rung where its evidence lives.

| Rung | Command | Needs | What it can prove |
|---|---|---|---|
| Bench | `./bench.sh` | nothing — no meeting, no bot, no human | canvas, capture, selector resolution against saved DOM |
| E2E | `./e2e.sh` | a standing open lab room | join, transcribe, speak, chat, react, share — 10 checks, ~90s |
| Journeys | `./journeys.sh` | a real room, sometimes a human | consent gates, populated-room audio, the paths e2e structurally cannot see |

The bench rung is the one that makes agent work possible, and two pieces of it were built
specifically to move evidence *down* a rung:

- **The DOM fixture harness** runs the real selectors against a saved populated-call DOM snapshot
  and asserts what each one resolves to. This turns the entire 08-12 bug class — the one that
  needed five humans in a room to reproduce — into a unit test with no browser at all.
- **`probe/camera-bench.mjs`** proves the whole camera surface on `about:blank`. The camera is the
  only surface that needs no meeting, no other participants, and no clicking, which is exactly why
  the camera roadmap is the most agent-suitable work in the repo.

The queue in [`tasks/todo.md`](../tasks/todo.md) is ordered by this principle rather than by value.

## Which rig, and the gate

There are four rigs on fractal. **Rig 1 is the one Andrew takes meetings on.** `e2e.sh` spawns bots
and DELETEs every bot in the room it targets, so an agent running it against rig 1 can tear the bot
out of a live call. Swarm work goes on another rig — 4 is the staging rig.

`rig-env.sh` derives the container, the gateway port and the token paths from one `RIG` variable,
and infers it from the directory name: a script run inside `~/vexa-rig4` drives rig 4 without being
told. Before that, `hotswap.sh`, `demo.sh`, `join-meeting.sh` and `relaunch.sh` all hardcoded rig 1,
so a gate run from `~/vexa-rig4` recompiled the human's rig instead. `e2e.sh` also takes a per
rig+room `flock`, so two agents queue rather than killing each other's bot mid-assertion.

| | |
|---|---|
| `RIG=4 ./bench.sh` | no meeting, no bot, no human |
| `RIG=4 ./e2e.sh <code>` | a standing open lab room |
| `./gate.sh` (from `~/vexa-rig4`) | pre-flight build → deploy → bench → e2e. Refuses rig 1. |

### staging and prod

There are two environments, and they are rigs, not branches:

| | | |
|---|---|---|
| **staging** | rig 4 | moves **by itself** when a branch passes the gate |
| **prod** | rig 1 — the rig Andrew takes meetings on | moves only when a human runs `./deploy-prod.sh` |

This is the split the oauth3 side already uses: agents commit to branches and never deploy, and
staging vs prod is a *deploy target* rather than a branch (`deploy-staging-core.sh` /
`deploy-prod-core.sh`, each taking a git ref). The one thing added here is that landing on staging
is automatic — an agent runs `./promote.sh <branch>` itself and the merge happens if the gate is
green. Nobody shepherds branches into a shared stream by hand.

`main` means *what is on prod*: nothing but `deploy-prod.sh` moves it, so reading `main` answers the
question the rig cannot — which commit Andrew's meetings are actually running. `staging` is always
at or ahead of it.

`deploy-prod.sh` refuses any ref that is not staging or an ancestor of it, so code that skipped the
gate cannot reach the rig Andrew is in a meeting on. It archives before it touches anything and
deploys by hot-swap, never by recreating the container — `docker compose up -d` recreates if the
compose file drifted, and that destroys in-container recordings.

**Committing is free; promoting is gated.** The gate hangs off `.githooks/pre-merge-commit` and
fires only on merges into `staging`, via `./promote.sh <branch>` (always `--no-ff`, because a
fast-forward makes no merge commit and would slip past the hook). Deliberately not pre-commit: an
agent commits constantly to save work, and blocking that on a three-minute image build and a live
meeting makes the swarm slower without making main safer.

This exists because until 2026-08-19 every rung was `docker exec` into an already-running container
whose bot code was the gitignored `live/` bind-mount, so nothing ever executed `Dockerfile.patched`
and "proven" meant "passes against the mutated container in front of me". A Dockerfile line that
could not build sat on main for two days inside a commit titled *"and prove it"*. Test the artifact.

## What makes iteration cheap

`./hotswap.sh` — surface controllers are `import()`ed fresh per act, keyed on file mtime, so a
recompile lands on the next act with the bot still holding its seat in the meeting. About three
seconds. Only the composition root needs a respawn. An agent that had to rejoin a meeting per
iteration would be unusable; one that doesn't can try twenty things in a demo's worth of time.

## The strongest evidence it works

On 2026-08-13 an agent was pointed at a second host (`zed`) with nothing but this repository and
told to bring the rig up. It reached **e2e 10/10 from the repo alone**, and reported back two
layout bugs it had to work around by hand: compose referenced shim paths at the repo root when the
canonical copies were in `shims/`, and the `live/` bind-mounts start empty on a fresh clone.

That is the same test as "could someone else run this", which is why those two papercuts became
blocking issues rather than notes. An agent doing a cold bring-up is a fresh user who complains in
structured form.

## What it is not

There is **no standing autonomous process**. No cron, no always-on worker, no agent watching the
issue tracker. Work happens when agents are dispatched from a session, several at a time, scoped to
files that do not overlap. The queue and the rung discipline are what make those dispatches
productive; they are not a robot that maintains the repo while nobody is looking.

The pieces that would close that gap already exist: a queue whose items carry their own success
conditions, and a bench rung broad enough that most work can be proven without a meeting. Nothing
is scheduled to run them.

## Rules that came out of the failures

- **Never "first match wins" across the whole document.** Scope the query to a container, verify
  the resolved element's `aria-label` before clicking, log what was hit.
- **Derived state, not commanded state.** The HUD's listening animation follows transcript
  recency, so the face cannot claim the pipeline is healthy when it isn't. Anything that reports
  status must be downstream of the thing it reports on.
- **Measure before designing.** The WebGL frame budget gets an asserted fps floor before a shader
  gets written, because the bench runs without a GPU and the answer might be "you cannot afford
  this."
- **A passing test in an empty room is not evidence.** Say `[UNVERIFIED]` in the commit message
  until a real call proves it, and mean it.
