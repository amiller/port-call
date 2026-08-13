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
