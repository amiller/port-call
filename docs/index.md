---
title: Port Call
description: An interactive Google Meet participant, built on Vexa
---

# Port Call

A proof of concept that turns [Vexa](https://github.com/Vexa-ai/vexa) from a *transcription* bot
into a bot that **acts in the meeting**: it speaks, posts and reads chat, sends emoji reactions,
publishes a live video feed it draws itself, and shares a screen — all driven by one
`redis PUBLISH`.

[Source on GitHub](https://github.com/amiller/vexa-poc) ·
[Issues](https://github.com/amiller/vexa-poc/issues)

```
./e2e.sh                        # 10 checks against a real meeting, unattended, ~90s
./bench.sh                      # 8 checks with no meeting, no bot, no human, ~40s
./hotswap.sh                    # ~3s: edit TypeScript, next act runs it, bot keeps its seat
./demo.sh join                  # a long-lived bot you iterate against
```

## What works

| Surface | How | Verified |
|---|---|---|
| Join | Vexa's join layer, headless Chromium | ✅ real Meet |
| Transcribe | Vexa pipeline → Whisper (against a **TEE** endpoint) | ✅ speaker-attributed |
| Speak | TTS shim → PulseAudio null sink → the bot's mic | ✅ |
| Sound effects | `!airhorn` in the speak text returns a wav instead of speech | ✅ |
| Chat send / read | Meet's chat panel, driven by Playwright | ✅ |
| Emoji reactions | Meet's reaction picker | ✅ |
| Camera | canvas → `getUserMedia` patch → a live HUD + animated avatar | ✅ |
| Screenshare | the same canvas → `getDisplayMedia` patch | ✅ |

The camera renders a live transcript caption and an animated character, with state *derived*
rather than commanded — the bird's "listening" animation follows transcript recency, so the face
cannot claim the pipeline is healthy when it isn't.

## The documents

- **[Findings](findings.md)** — the measurements that cost the most time. Why the obvious approach
  silently does nothing, per surface. Start here if you are building something similar.
- **[Roadmap](roadmap.md)** — what this is trying to become and what stands in the way.
- **[How it gets maintained](swarm.md)** — most of this was written by agents; this is the
  constraint that makes that work, and the honest account of what is *not* automated.
- **[Where it runs](operations.md)** — hosts, the CVM question, and what it would take to run this
  yourself.
- **[Development](dev.md)** — the hot-swap loop, the `patches/` ↔ `live/` discipline, the test
  ladder.
- **[Credentials](credentials.md)** — four tiers, what each unlocks, and what can never ship.

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
must run in that process. Nothing else is coupled — **acts in / transcripts out, both over redis**
— so the brain can live anywhere, in any language.

## License

Contains modified files from [Vexa](https://github.com/Vexa-ai/vexa) (Apache-2.0); the
modifications live in `patches/` under the same license, and `NOTICE` records what changed. The
harness, shims, and documentation are original work under Apache-2.0.

This is a **proof of concept**, not a product. It automates a Google Meet UI that Google does not
offer an API for; expect it to break when that UI changes, and don't deploy a bot into anyone's
meeting without their knowledge.
