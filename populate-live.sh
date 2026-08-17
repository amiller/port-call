#!/usr/bin/env bash
# Fill the four live/ bind-mount dirs from the built image. Run once on a fresh clone, BEFORE the
# first `docker compose up` — compose would otherwise create them empty and mount the emptiness
# over the bot's src/dist, leaving a container with no bot code in it.
set -euo pipefail
cd "$(dirname "$0")"

# Plain docker build, not `compose build`: compose would demand NEAR_API_KEY to interpolate the
# file, and populating live/ has nothing to do with the transcription key.
docker build -f Dockerfile.patched -t vexa-lite:patched .
C=$(docker create vexa-lite:patched)
trap 'docker rm -f "$C" >/dev/null' EXIT
for pair in services/bot:services-bot modules/join:modules-join; do
  IN=${pair%%:*}; OUT=${pair##*:}
  for d in src dist; do
    mkdir -p "live/$OUT-$d"
    docker cp "$C:/app/core/meetings/$IN/$d/." "live/$OUT-$d/"
  done
done
echo "live/ populated:"; du -sh live/*
