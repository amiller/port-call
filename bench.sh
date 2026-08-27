#!/usr/bin/env bash
# Every check that needs NO meeting, NO bot and NO human. Run this before touching a real room —
# most bugs this project hit were reachable here, and the ones that weren't (Meet DOM drift) are
# the only reason e2e.sh exists.
#
#   ./bench.sh
set -uo pipefail
FAIL=0

D="$(dirname "$0")"
. "$D/rig-env.sh"   # RIG selects the rig; see rig-env.sh

# Rungs 1 and 2 need no container, and they are the two this suite structurally lacked until
# 2026-08-19. Everything below them is `docker exec` into an ALREADY-RUNNING container, whose bot
# code is the live/ bind-mount that hotswap.sh compiles in place — so no rung here ever executed
# Dockerfile.patched. That is how a Dockerfile line that could not build (and could not have worked
# if it had) sat on main from 2026-08-17 to 2026-08-19 inside a commit titled "and prove it".
echo "== image: Dockerfile.patched builds, and its own COPY/grep guards hold =="
docker build -f "$D/Dockerfile.patched" -t vexa-lite:bench "$D" >/tmp/bench-build.log 2>&1 \
  && echo "PASS image builds" \
  || { echo "FAIL image build — tail of /tmp/bench-build.log:"; tail -15 /tmp/bench-build.log; FAIL=1; }

# The image is only half the story: live/ is what actually runs, and it is gitignored, so
# "committed" and "deployed" are separate states with nothing comparing them. #16 lived in that gap
# for a week — fixed in live/, absent from the image, and populate-live.sh seeds live/ FROM the
# image, so a fresh clone would have restored the version that destroys audio.
echo "== drift: committed patches/ vs the live/ tree that actually runs =="
DRIFT=0
for f in "$D"/patches/bot-*.ts; do
  n=$(basename "$f" .ts); n=${n#bot-}
  L="$D/live/services-bot-src/$n.ts"
  [ -f "$L" ] || { echo "  MISSING live/services-bot-src/$n.ts"; DRIFT=1; continue; }
  cmp -s "$f" "$L" || { echo "  DRIFT patches/bot-$n.ts != live/services-bot-src/$n.ts"; DRIFT=1; }
done
cmp -s "$D/patches/browser-args.ts" "$D/live/modules-join-src/browser-args.ts" \
  || { echo "  DRIFT patches/browser-args.ts"; DRIFT=1; }
cmp -s "$D/patches/gmeet-selectors.ts" "$D/live/modules-join-src/googlemeet/selectors.ts" \
  || { echo "  DRIFT patches/gmeet-selectors.ts"; DRIFT=1; }
[ "$DRIFT" -eq 0 ] && echo "PASS patches/ == live/" || FAIL=1

echo "== audio: click train (paplay rate/channels) =="
docker cp "$D/probe/audio-bench.sh" "$C:/tmp/audio-bench.sh" >/dev/null
docker exec "$C" bash /tmp/audio-bench.sh || FAIL=1

echo "== camera + getDisplayMedia patch =="
docker cp "$(dirname "$0")/probe/camera-bench.mjs" "$C:/tmp/camera-bench.mjs" >/dev/null
docker exec "$C" sh -c "DISPLAY=:99 node /tmp/camera-bench.mjs | tail -2" || FAIL=1

echo "== camera skins: every avatar x background renders, and renders DIFFERENTLY =="
docker cp "$(dirname "$0")/probe/skin-bench.mjs" "$C:/tmp/skin-bench.mjs" >/dev/null
docker exec "$C" sh -c "DISPLAY=:99 node /tmp/skin-bench.mjs | tail -4" || FAIL=1

echo "== profile: an empty volume is a GUEST, not a signed-in account =="
docker cp "$(dirname "$0")/probe/profile-bench.mjs" "$C:/tmp/profile-bench.mjs" >/dev/null
docker exec "$C" node /tmp/profile-bench.mjs | tail -1 || FAIL=1

echo "== surfaces: chat / camera / share / reaction vs Meet-shaped DOM =="
docker cp "$(dirname "$0")/probe/mock-meet.html" "$C:/tmp/mock-meet.html" >/dev/null
docker cp "$(dirname "$0")/probe/surface-bench.mjs" "$C:/tmp/surface-bench.mjs" >/dev/null
docker exec "$C" sh -c "DISPLAY=:99 node /tmp/surface-bench.mjs" || FAIL=1

echo "== tts amplitude envelope (drives the speaking beak) =="
docker cp "$(dirname "$0")/probe/tts-amplitude-bench.mjs" "$C:/tmp/tts-amplitude-bench.mjs" >/dev/null
docker exec "$C" node /tmp/tts-amplitude-bench.mjs || FAIL=1

echo "== anti-repetition guard: pure logic, no meeting =="
# The suite imports the canonical TS source by relative path, so the two files must land in the
# container with that relationship intact (node strips the types).
docker exec "$C" mkdir -p /tmp/rep/probe /tmp/rep/patches
docker cp "$(dirname "$0")/probe/repetition-tests.mjs" "$C:/tmp/rep/probe/" >/dev/null
docker cp "$(dirname "$0")/patches/bot-repetition-guard.ts" "$C:/tmp/rep/patches/" >/dev/null
docker exec "$C" node /tmp/rep/probe/repetition-tests.mjs || FAIL=1
# ...and prove it is WIRED, which the pure-logic suite structurally cannot see.
docker cp "$(dirname "$0")/probe/chat-guard-bench.mjs" "$C:/tmp/chat-guard-bench.mjs" >/dev/null
docker exec "$C" node /tmp/chat-guard-bench.mjs | tail -1 || FAIL=1

echo "== DOM fixture tests: selector ambiguity detection =="
# This rung runs in a THROWAWAY container from the image rung 1 just built — not in $C, the
# ambient rig. That distinction is the whole lesson of 2026-08-19: $C is a long-lived container
# from a week-old image with a hand-compiled live/ mount, so a rung exec'd into it proves nothing
# about the artifact a fresh machine would get. Testing the built image is what "proven" has to mean.
# It runs from /opt/probe because that is the only directory node resolves `jsdom` from — ESM
# ignores NODE_PATH — and fixture-tests.mjs reads fixtures from its OWN directory, so both go there.
P=$(docker run -d --rm --entrypoint sleep vexa-lite:bench 300)
docker exec "$P" mkdir -p /opt/probe/fixtures
docker cp "$D/probe/fixture-tests.mjs" "$P:/opt/probe/fixture-tests.mjs" >/dev/null
for f in populated-call no-bot-mic picker-closed pre-join-only; do
  docker cp "$D/probe/fixtures/$f.html" "$P:/opt/probe/fixtures/" >/dev/null
done
docker exec "$P" node /opt/probe/fixture-tests.mjs || FAIL=1
docker rm -f "$P" >/dev/null

echo
[ "$FAIL" -eq 0 ] && echo "BENCH GREEN" || echo "BENCH RED"
exit $FAIL
