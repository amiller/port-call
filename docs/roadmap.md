# Roadmap

What this is trying to become, and what stands between here and there. Open work lives in
[GitHub issues](https://github.com/amiller/vexa-poc/issues); this page is the shape those issues
make.

## Where it is now

A bot that can *act* in a Google Meet — speak, chat, react, publish a camera feed, share a screen —
driven entirely by `redis PUBLISH`. Every surface has been verified against real Meet, including a
populated call with humans in it on 2026-08-13. The bot holds a Playwright `Page` handle and
nothing else; the brain is not in the bot.

The honest summary of reception, from mining the 08-12 transcripts: **amused, not impressed.** The
entertainment value came from the failure modes. That verdict sets the agenda below.

## 1. The camera tile should be worth looking at

Today the tile is a rooster and the last three transcript lines. That caption is a good *heartbeat*
— you can watch words land and know Whisper is following — and a poor *background*, because three
lines is all it will ever be.

The plan is to separate three things that are currently one thing:

| Axis | Today | Target |
|---|---|---|
| Background | transcript strip, always | selectable mode ([#4](https://github.com/amiller/vexa-poc/issues/4)) |
| Character | rooster, hardcoded | selectable avatar ([#6](https://github.com/amiller/vexa-poc/issues/6)) |
| Headline | `camera_show` text | unchanged |

Any bird on any background. The first new background is the **brainrot box**
([#5](https://github.com/amiller/vexa-poc/issues/5)), under a constraint that keeps it honest: every animated element has to
trace to a real pipeline signal — segment arrival, RMS amplitude, speaker change — and none may be
a free-running timer. The existing HUD already works this way (the listening animation follows
transcript recency, so the face *cannot* claim the pipeline is healthy when it isn't), and a toy
that throws that away would be a downgrade dressed as a feature.

The gating question is cost, and it is empirical. The capture canvas is 2D and must stay 2D, so
WebGL renders offscreen and gets composited in. The bench runs with `--disable-gpu`, meaning
SwiftShader on the CPU. A full-frame fragment shader at 720p30 may simply not hold — so the fps
floor gets measured and asserted per mode *before* any shader is written, and the frame budget
becomes the design constraint.

## 2. The bot should read the room

- **Speak wind-up** ([#3](https://github.com/amiller/vexa-poc/issues/3)) — a visible pre-speech cue, because "the speaking not
  being easy to see when it's about to speak" is the single most-repeated live complaint. The beak
  is driven by actual TTS RMS, not a timer; same can't-lie principle as above.
- **Anti-repetition** — from Tina, mid-call: *"Why does this keep on saying the same line? Can you
  not learn something?"* Suppression is loud, never silent. Sound effects are exempt, because
  repeating an airhorn is the joke.
- **Caption modes** — off / headline-only / full. From Albiona, mid-call: *"it's a little
  distracting to read what I'm saying."* The speaker should not have to read their own words back
  in real time.

The through-line: being too chatty is a product failure, not a personality. The quietest useful
channel wins.

## 3. Facilitation

Twice-endorsed, and the most likely thing this turns into: an agent that manages the control flow
of a meeting — welcoming people, tracking who hasn't spoken, holding the agenda. Proposed
independently as a Shape Rotator grants cohort project. Everything in §1 and §2 is groundwork for
it; a facilitator that can't be seen about to speak, or that repeats itself, is worse than nothing.

## 4. Seeing what the transcript can't

- **Meeting screenshots** ([#1](https://github.com/amiller/vexa-poc/issues/1)) — a transcript of a screenshare is a transcript of
  someone saying "as you can see here."
- **Shared-microphone rooms** ([#2](https://github.com/amiller/vexa-poc/issues/2)) — several humans on one channel collapses
  speaker attribution. Conference-room audio is the common case, not the exotic one.

## 5. Portability

The rig is meant to run anywhere a Docker daemon does, including a CVM, which is why every shim is
a service rather than something on the host. See [where it runs](operations.md) for how far that
actually goes today.

## Deliberately not on the roadmap

- **A second automated observer participant.** Four launch strategies, all blocked by Google's
  "You can't join this video call" interstitial. A second *guest instance* turned out to be the
  cheaper answer to the same problem.
- **Anything that needs Google to ship an API.** This automates a UI Google does not offer an API
  for. It will break when that UI changes; that is the deal, and pretending otherwise would make
  the tests lie.
