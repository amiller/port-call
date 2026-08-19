#!/usr/bin/env bash
# Recompile the bot IN the running container. No image build, no compose restart, no rejoin.
#
# Bots are per-meeting processes spawned fresh by the runtime, so the NEXT spawn picks up the new
# dist/ while any live bot keeps running untouched. Edit ~/vexa-rig/live/*-src on the host, run
# this, spawn a bot. ~10s vs the ~5min rebuild+redeploy cycle.
set -euo pipefail
. "$(dirname "$0")/rig-env.sh"   # RIG picks the container; hardcoding rig 1 here meant a gate
                                 # run from ~/vexa-rig4 recompiled the human's rig instead.
for m in modules/join services/bot; do
  echo "tsc $m"
  docker exec "$C" sh -c "cd /app/core/meetings/$m && /app/node_modules/.bin/tsc"
done
echo "ok — next bot spawn runs the new code"
