# signal-lane — Port Call as a seat in a Signal call

Two containerised Signal Desktops, driven over CDP, that join a Signal call link, speak, and
transcribe. `./e2e.sh` proves it with no human in the room: seat A speaks, seat B listens.

```bash
docker compose up -d --build          # two seats, A and B
./e2e.sh                              # 12 checks, ~3 min
./watch-and-run.sh                    # poll until both seats are linked, then run e2e
```

## Why it is shaped this way

Signal Desktop is Electron and honours `--remote-debugging-port`, so its whole React UI is
drivable. **Video and audio take different routes, and that decides everything.** Video is captured
by the renderer through `getUserMedia`, so `patches/bot-camera.ts`'s HUD works unmodified. Audio
never enters JavaScript: RingRTC is a native module carrying libwebrtc's device layer and opens
PulseAudio itself. `@signalapp/ringrtc` says so on npm — `sendVideoFrame`/`receiveVideoFrame` cross
the boundary, audio has only device selection and `onAudioLevels`. There is no PCM API.

So both audio directions are virtual devices, the same graph the Meet rig already uses:

    piper TTS ─► tts_sink ─► virtual_mic (remapped) ─► RingRTC ─► SFU
    SFU ─► RingRTC ─► call_out ─► parec ─► whisper

`virtual_mic` is a `module-remap-source`, not a raw monitor: RingRTC **drops `.monitor` sources**
from enumeration, and enumerates only at startup.

## Linking a seat

Each seat needs to be linked to a Signal account once, from a phone (a linked device cannot
authorize another). The container serves a live view of its own screen so the QR can be scanned
from the real window rather than a screenshot that expires:

    http://127.0.0.1:6080/vnc.html?autoconnect=1   # seat A, over an ssh tunnel
    http://127.0.0.1:6081/vnc.html?autoconnect=1   # seat B

The profile is portable **only because** the entrypoint passes `--password-store=basic` at first
launch; otherwise Electron seals the SQLCipher key against the host keyring and the volume cannot
be moved. Set it before linking or it is too late.

## Layout

| | |
|---|---|
| `Dockerfile`, `entrypoint.sh` | Signal + Xvfb + PulseAudio graph + x11vnc + socat CDP bridge |
| `docker-compose.yml` | two seats; CDP and VNC bound to **loopback only** |
| `cdp.mjs` | `eval` / `shot` / `init` / `perms` against one seat |
| `js/lib.js` | page-side helpers, prepended to every action |
| `js/hud.js` | **generated** — see `js/README.md` |
| `e2e.sh` | the twelve checks |

CDP is unauthenticated and grants total control of a linked Signal account. Never expose it beyond
loopback; reach it over an ssh tunnel.

## What this cannot prove

Both seats are linked devices of **one account**, so Signal sees one identity twice. The e2e
establishes audio, control and join — it says nothing about speaker attribution, which needs a
second account. The camera also does not transmit in-container (it does from a host with a real
camera); see `../tasks/session-notes-2026-08-22.md`.
