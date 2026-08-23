# signal-lane — Port Call as a seat in a Signal call

Two containerised Signal Desktops, driven over CDP, that join a Signal call link, speak, and
transcribe. `./e2e.sh` proves it with no human in the room: seat A speaks, seat B listens.

```bash
docker compose up -d --build          # two seats, A and B
./e2e.sh                              # 12 checks + evidence dir, ~3 min
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

The containers publish CDP on fractal's loopback as 9333 (A) and 9335 (B); the tunnel this repo
assumes is `-L 9334:127.0.0.1:9333 -L 9335:127.0.0.1:9335`, which is why `e2e.sh` defaults
`A_PORT=9334` and `B_PORT=9335`.

The profile is portable **only because** the entrypoint passes `--password-store=basic` at first
launch; otherwise Electron seals the SQLCipher key against the host keyring and the volume cannot
be moved. Set it before linking or it is too late.

## Layout

| | |
|---|---|
| `Dockerfile`, `entrypoint.sh` | Signal + Xvfb + PulseAudio graph + x11vnc + socat CDP bridge |
| `docker-compose.yml` | two seats; CDP and VNC bound to **loopback only** |
| `cdp.mjs` | `eval` / `shot` / `init` / `perms` against one seat; every call is timeout-bounded |
| `js/lib.js` | page-side helpers, prepended to every action |
| `js/hud.js` | **generated** — see `js/README.md` |
| `e2e.sh` | the twelve checks. Serialized with a flock, resets both seats on any exit, picks a NEW phrase each run, and writes screenshots of both seats, the captured wav and the transcript to an evidence dir it prints |

CDP is unauthenticated and grants total control of a linked Signal account. Never expose it beyond
loopback; reach it over an ssh tunnel.

## Running it somewhere other than fractal

Four requirements, and only one is a real obstacle:

| | fractal | zed | raw CVM | webhost pod |
|---|---|---|---|---|
| docker | ✅ | ✅ 24.0.7 | ✅ | ✅ (one container per project) |
| `v4l2loopback` for the camera | ✅ loaded | ⚠️ dkms present, **unbuildable** | ✅ via pre-launch script | ⚠️ needs the pod's startup changed |
| two linked seats | ✅ | copy the volumes | copy the volumes | copy the volumes |
| TTS/STT shims reachable | ✅ rig 4 | ✅ already running | must ship in the image | must ship in the image |

`SIGNAL_HOST`, `SHIM_HOST`, `TTS_CONTAINER` and `STT_CONTAINER` are all env knobs, so the harness
itself is not fractal-bound — `SIGNAL_HOST=zed ./e2e.sh` is the whole invocation once the host is
prepared. `./ensure-camera.sh <host>` loads the loopback module idempotently and runs before every
e2e; it needs this on the target host and nothing else:

    (root) NOPASSWD: /usr/sbin/modprobe v4l2loopback *, /usr/sbin/modprobe -r v4l2loopback

**The seat profiles are portable.** They were created with `--password-store=basic`, so the
`signal-a-data` / `signal-b-data` volumes can be copied to another host instead of re-scanning two
QR codes. That is the one piece of this that would otherwise need a human with a phone.

**The camera travels, but each host earns it differently.**

*zed* is the awkward one. `v4l2loopback-dkms` 0.12.3 is installed but `dkms status` says only
`added`, never built: the box runs a **mainline** kernel, `5.15.0-051500-generic`, and there is no
`linux-headers-5.15.0-051500-generic` in apt (`Candidate: (none)`), so DKMS has nothing to build
against. Fixing it means fetching the matching mainline headers .deb by hand, then
`dkms install v4l2loopback/0.12.3`, then the sudoers line. Everything else on zed is ready — it
already runs a full rig (`vexa-poc-{vexa-lite,tts-shim,near-shim,postgres}-1`), so `SHIM_HOST=zed`
needs no new services.

*A raw CVM* can do it: dstack's **pre-launch script** runs before compose and can configure kernel
things, so loading v4l2loopback there is a startup-script change rather than an impossibility.

*A webhost pod tenant* inherits whatever the pod's startup does, so the same change has to land in
the pod rather than in our project — that is a request against dstack-webhost, not something a
tenant fixes locally.

## What this cannot prove

Both seats are linked devices of **one account**, so Signal sees one identity twice. The e2e
establishes audio, control and join — it says nothing about speaker attribution, which needs a
second account. The camera also does not transmit in-container (it does from a host with a real
camera); see `../tasks/session-notes-2026-08-22.md`.
