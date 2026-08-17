# Where this runs, and what a CVM costs you

Two hosts run it today: fractal and zed, from a plain clone. The interesting question is the third
target — a dstack CVM on Phala Cloud — because the rig was written for it: the shims are containers
reached by compose service name rather than host processes reached through `host.docker.internal`,
precisely because a confidential VM has no host to put a Python file on.

## Does it run in a Phala CVM?

Not yet, and the reason is packaging, not the design. A CVM is handed exactly one file — the
compose — and nothing else: no repo, no build context, no host filesystem. Phala's pre-deploy rules
say so explicitly ([compose-check](https://github.com/Phala-Network/phala-cloud/blob/main/skills/compose-check/SKILL.md)):
`build:` fails ("build context directory not available on CVM"), `dockerfile:` fails, and a host
bind mount of source files fails because "host files don't exist on CVM". The development
`docker-compose.yml` does all three — it builds both images from this checkout and bind-mounts
`live/` for the hot-swap loop.

So the CVM shape is the development file with every host dependency removed, which is
`docker-compose.cvm.yml`. It references two images by registry tag instead of building them, and
it drops the mounts, which costs nothing: the shim sources and `sfx/` are baked into the shims
image, and the bot's `src`/`dist` are baked into the vexa image. What the mounts buy is the ~10s
edit loop, and that loop needs a host to edit files on, so it could not exist in a CVM anyway.

That file was run locally with no build context and no bind mounts — the full stack came up
healthy, the gateway answered `/health` with 200, the bot's `dist/index.js` still contained
`createChatController` (so the patched code is genuinely in the image, not arriving through a
mount), and TTS returned a 55KB wav. Everything the rig needs is in the two images.

What is left is a push and a deploy:

```bash
docker build -f Dockerfile.patched -t $VEXA_IMAGE  . && docker push $VEXA_IMAGE    # ~2.4GB
docker build -f Dockerfile.shims   -t $SHIMS_IMAGE . && docker push $SHIMS_IMAGE   # ~0.9GB
phala deploy -n vexa -c docker-compose.cvm.yml -e cvm.env --vcpu 4 --memory 8192 --disk-size 60
```

Neither image has been pushed anywhere yet; both are local tags (`vexa-lite:patched`,
`vexa-shims:local`), which is the single thing standing between the current state and a CVM. Both
are already amd64, which a TDX CVM requires.

Size the instance by the measurement in the compose header, not by the default: a bot in a meeting
costs ~1.4GB RSS and ~0.6 core steady, spiking to ~2.3 cores while Chromium starts, and the vexa
image alone is 6.2GB on disk. The 1 vCPU / 2GB / 40GB default is too small on all three axes.

## What a CVM cannot be given

Two of the four credentials in [credentials.md](credentials.md) do not travel:

**The bot's Google account** is a full Chromium profile directory. It never ships, so a CVM
instance does guest joins to open rooms — which is what `e2e.sh` exercises anyway. Calendared
personal-account meetings stay on a host that has the profile.

**`NEAR_API_KEY`** is a transcription credential belonging to whoever provisions the CVM; it goes
in the env file passed to `phala deploy -e`, which is encrypted client side, and it is not copied
out of an existing rig. If you have no key, delete the `near-shim` service: join, speak, chat,
camera and screenshare need no credential at all. Transcription is then dead, loudly — the camera's
"listening" animation is derived from transcript recency, so the bird stops reacting rather than
lying about a pipeline that isn't there.

## The operational gap nobody has closed yet

`relaunch.sh` mints the API tokens by `docker exec`ing into the container, because admin-api binds
`127.0.0.1:8001` *inside* it. A CVM gives you no docker socket. Getting tokens out of a CVM
therefore needs one of: `phala deploy --dev-os` with an SSH key, a pre-launch script, or exposing
admin-api through the dstack gateway — which is a real decision, since that endpoint mints tokens.
Until that is settled, a deployed CVM boots and is unreachable as a rig.

`relaunch.sh` also sources `NEAR_API_KEY` from a path under `~/projects/ic3camp-teexai/`, which
exists on exactly one machine. That is a host assumption a CVM cannot satisfy either.

## Fresh clone

The from-scratch path is the one a CVM takes, so it is worth keeping honest. As of 2026-08-17 a
clone into an empty directory builds both images and comes up with no manual file copying —
verified by cloning into a scratch directory and running it, not by inspection. Three things had to
be fixed to make that true, all of which had been worked around by hand on zed:

- compose and `Dockerfile.shims` referenced `near-shim.py`, `tts-shim.py` and `sfx/` at the repo
  root; they live in `shims/`.
- `live/` starts absent, and compose creating it empty mounts that emptiness over the bot's source.
  `./populate-live.sh` fills it from the built image.
- `patches/bot-capture-bridge.ts` calls `playback.onAmplitude`, which only exists in
  `patches/bot-tts-playback.ts` — a file `Dockerfile.patched` did not copy. The running rig was
  fine because `live/` had it; the image build failed on `tsc`. This is the `patches/`↔`live/`
  drift [dev.md](dev.md) warns about, caught by a fresh clone doing what a CVM would do.
