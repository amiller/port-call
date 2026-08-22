# Signal as a Port Call lane — what was measured, 2026-08-22

Continues `session-notes-2026-08-20.md`. Started as three ideas from Ahmed (screenshare relay,
browser extension, Signal) and turned into a working Signal lane. **Everything below was run, not
inferred**; the one thing that did not run is named at the bottom.

## The finding that reframes the platform

Signal Desktop is Electron and honours `--remote-debugging-port` with no filtering. So the whole
UI — join, mute, camera, call links, device pickers — is CDP-drivable exactly like Meet's DOM.

But **video and audio are asymmetric, and that asymmetry is the whole design**:

- **Video goes through the renderer.** `getUserMedia` is called with `{audio:false, video:…}` for
  camera and screenshare. So `CAMERA_INIT_SCRIPT` from `patches/bot-camera.ts` works **verbatim** —
  injected into Signal's renderer it fooled Signal exactly as it fools Meet, and the rooster HUD
  appeared on Andrew's phone. The patch never has to know which app it is lying to.
- **Audio never enters JS.** RingRTC is a native module (`libringrtc-x64.node`) containing
  libwebrtc's `AudioDeviceModuleImpl` + `AudioMixerManagerLinuxPulse`; it opens PulseAudio itself.
  `@signalapp/ringrtc`'s public API confirms it: `sendVideoFrame`/`receiveVideoFrame` cross the
  boundary as raw buffers, while audio has only `getAudioInputs/setAudioInput`, `getAudioOutputs/
  setAudioOutput`, and `onAudioLevels`. There is no PCM API in either direction.

Consequence: both audio directions are virtual PulseAudio devices — the same `tts_sink` →
`virtual_mic` graph the rig already uses. Confirmed by measurement, TTS through the container's
graph: peak 14099, rms 1544.

## Proven live, in a real call

Andrew joined from his phone; a linked Signal Desktop held the other seat.

| Surface | How |
|---|---|
| Join a call link | CDP clicks the React UI; two devices of ONE account can both hold seats ("2 people") |
| Camera HUD | `installHud()` injected into the renderer; visible on his phone |
| Transcribe | `call_out` null sink → `parec` → near.ai whisper-large-v3 (the TEE path) |
| Speak / play audio | `paplay` → `tts_sink` → remapped `virtual_mic` → RingRTC |

Transcript from that call, his voice: *"Hello. Hey, Bot. Hey, Bot, are you there?"* — with the
usual `"you"`/`"Thank you."` silence hallucinations at 30s intervals (#10, #18; not Signal-specific).

**Signal does not suppress music the way Meet does.** Meet's noise suppression mangles anything
non-speech, which is why `!airhorn` always sounded thin there. Signal passed a music track through
clean. Sound effects and TTS arrive as authored — a real advantage of the lane.

## Landmines, all of which cost time

1. **RingRTC drops `.monitor` sources** from its device enumeration, so a bare null sink is
   invisible to Signal. The monitor must be remapped (`module-remap-source`) into a real source —
   which is exactly what the rig has always done for Meet. And it enumerates **once at startup**:
   a device created after launch stays invisible until Signal restarts.
2. **The permission prompt is a separate CDP target** (`permissions_popup.html`), not a node in the
   main page. Anything scripting Signal hangs at first join without handling it. Signal asks twice.
3. **The profile is sealed to the host keyring.** `config.json` carries `encryptedKey` +
   `safeStorageBackend=gnome_libsecret`, so a logged-in profile CANNOT be copied to another machine
   or container. `--password-store=basic` at FIRST launch makes it portable; after that it is too late.
4. **Bidi isolates in display names.** Signal wraps names in U+2066–2069, so the Calls row reads
   `⁨Signal Call⁩` and `/^Signal Call$/` never matches — a find-or-create helper silently made a new
   call link every run. All text matching is normalised in `signal-lane/js/lib.js`.
5. **CDP `Runtime.evaluate` shares one execution context**, so a top-level `const` in an injected
   helper throws "already been declared" on the second action. `lib.js` is an IIFE for that reason.
6. **Signal allows one call at a time** and blocks a join behind a modal. A seat left in a call by
   a previous run fails the next one in a way that looks like a broken join — and `join.js` reported
   `joined:true` while `inCall` was 0. Hence `js/reset.js`, run before every join.
7. **The TTS shim returns headerless raw PCM** (s16le/24000/mono) because Vexa pipes it into
   `paplay --raw`. And a **muted `tts_sink` records pure silence**, indistinguishable from a dead
   chain — its own docstring warns about this.
8. **`pulseaudio --system` denies non-`pulse-access` users**; without `usermod -aG pulse-access root`
   every `pactl` call in a container entrypoint dies with "Access denied".
9. **Each `sgnl://` URL push spawns a launcher process.** They forward the URL to the running
   instance and should exit; 22 accumulated once and one of them stole the CDP port. The e2e now
   reaps them after each push — the entrypoint fix covered only the stale-PulseAudio half.
10. **Electron ignores `--remote-debugging-address`** and binds CDP to loopback regardless, so a
   published container port reaches nothing. socat republishes it.

## What is in the tree

`signal-lane/` — Dockerfile + entrypoint + compose (two seats, A and B), `cdp.mjs`
(eval / screenshot / clear-permission-popup), `js/` (nine action scripts + the generated `hud.js`),
`e2e.sh` (six checks), `watch-and-run.sh`. Deployed to `~/port-call-signal` on fractal as
`port-call-signal-a` and `port-call-signal-b`. CDP is bound to **loopback only** and reached over an
ssh tunnel — it is unauthenticated and would be total control of a linked account.

## The two-seat e2e — RAN

`signal-lane/e2e.sh`, unattended, two container seats on fractal. The first run reported
**11 pass / 1 fail**, but a review of the harness found that two of those PASS lines were printed
UNCONDITIONALLY — `reset.js` and `leave.js` had their return values piped to /dev/null. The honest
reading of that run is **9 tested, 2 asserted, 1 failed**. Both are now checked, along with eight
other false-green paths listed below; the harness collects screenshots and the transcript as
evidence so a green line always has an artifact behind it.

**Audio loopback is closed**: piper TTS → seat A `tts_sink` → `virtual_mic` → Signal → seat B
`call_out` → `parec` → near.ai whisper → *"The harbour and the cricket share a velvet morning."*
Effectively exact — 2/3 keywords only because Whisper spelled it "harbour", which is also why the
matcher now compares on a stem.

**Camera loopback does NOT work in-container.** `getUserMedia` on seat A does return the HUD canvas
(1280x720, verified), the fake `Vexa Camera` device enumerates, and Signal's control reads "camera
on" — but seat B renders A's tile as the account avatar, and A's own `<video>` has no `srcObject`.
The same HUD injection DID transmit from the laptop's Signal that morning, where a real camera
device exists. Working hypothesis: RingRTC's video capture path wants a real device and the JS-level
fake is not enough; the rig solves the equivalent on Meet with Chromium's
`--use-file-for-fake-video-capture`, which this container does not pass. Untested.

### Joining two seats: what actually works

Matching a call link by LIST ROW does not: links do not reliably sync between two devices of one
account, and the "Active" marker depends on a periodic SFU peek a second device may never see.
What works is handing BOTH seats the same URL — `signal-desktop <user-data-dir> "sgnl://signal.link/call/#key=…"`
forwards to the running instance — then clicking Join **scoped to the calling container**: there are
two "Join" buttons on screen and a document-order match hits the call-link details panel's, which
merely reopens the lobby while reporting success.

Two more container landmines found by running it: stale `/var/run/pulse` survives
`docker compose restart` and makes PulseAudio refuse to start (container restart-loops — the
entrypoint now clears it), and each URL push spawns a launcher process, so repeated pushes left 22
`signal-desktop` processes and one of them stole the CDP port.

## Earlier blocker, now resolved

**The two-seat e2e had never run.** Both container seats are unlinked: linking requires the phone
as primary, and a QR cannot be scanned by the only device that is displaying it. Options left with
Andrew: scan at the laptop, decode the QR to a tappable `sgnl://linkdevice` URI (the decode was
blocked by the permission classifier and needs his approval — it exposes the same secret the QR
already carries), or VNC into the container's own display.

Every action script IS validated against a real linked seat (his laptop's), so what remains untested
is specifically the two-seat interaction: `2 in call`, the audio round trip between seats, and the
remote-video frame check.

## The limit worth stating

Both seats are linked devices of ONE account, so Signal sees one identity twice. This e2e can prove
audio, video, join and control — it **cannot** prove speaker attribution. That needs a second
account (a number, ~$15 prepaid SIM). Attribution is what issue #2 and the bridge idea both
actually need, so the green checks must not be read as covering it.

## Bridge — Andrew's idea, parked

Not "relay a meeting into another meeting" but a genuine **cross-platform bridge**: some people on
Signal, some on Meet, a bot relaying audio/video between them. Today made it far more buildable —
the bot can now both hear and speak on the Signal side, and already can on the Meet side. It is
also the one case where the relay's attribution cost is unavoidable rather than self-inflicted,
since a bridge is inherently one mixed channel per side. Worth its own issue.
