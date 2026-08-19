#!/usr/bin/env bash
# THE STAGING GATE. Runs on fractal, inside a rig directory that holds the tree being promoted.
#
#   ./gate.sh [meet-code]
#
# What it is for: until 2026-08-19 nothing ran on commit, and every test rung was `docker exec` into
# an already-running container whose bot code was a hand-compiled bind-mount. So "proven" meant
# "passes against the mutated container in front of me" — which is why a Dockerfile line that could
# not build sat on main for two days inside a commit titled "and prove it". A gate has to run the
# ARTIFACT, on a rig, in a room.
#
# Deliberately NOT a pre-commit hook. Committing is how an agent saves work in progress; blocking it
# on a 3-minute image build and a live meeting makes the swarm slower without making main safer.
# The promotion to staging is the point where "this actually works" has to be true.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
. "$D/rig-env.sh"

# Rig 1 is the rig Andrew takes meetings on. e2e.sh spawns bots and DELETEs every bot in the room,
# so gating there could tear the bot out of a live call. Refuse unless someone insists out loud.
if [ "$RIG" = 1 ] && [ "${GATE_ALLOW_RIG1:-0}" != 1 ]; then
  echo "gate: refusing to run against rig 1 (the human's rig). Run from ~/vexa-rig4, or set" >&2
  echo "      GATE_ALLOW_RIG1=1 if you really mean it." >&2
  exit 1
fi

CODE=${1:-tog-tccc-szk}
echo "═══ GATE — rig $RIG ($C, $GW), room $CODE ═══"
echo

# Pre-flight: does the candidate even build? This runs BEFORE the deploy on purpose — deploy-live.sh
# writes into live/, which is the code the rig runs, so deploying an unbuildable tree first would
# leave the staging rig broken by the very check that rejected it.
echo "── pre-flight: does this tree build at all? ──"
docker build -f "$D/Dockerfile.patched" -t vexa-lite:bench "$D" >/tmp/gate-build.log 2>&1 \
  || { echo "GATE RED — image does not build; tail of /tmp/gate-build.log:"; tail -15 /tmp/gate-build.log; exit 1; }
echo "PASS pre-flight build"
echo

# Only now is it safe to put this tree on the rig.
"$D/deploy-live.sh" || { echo "GATE RED — deploy-live"; exit 1; }

echo
# Rung 1: everything that needs no meeting — including the image build and the patches/↔live/ drift
# check, the two rungs whose absence let #16 and the jsdom breakage through.
"$D/bench.sh" || { echo; echo "GATE RED — bench"; exit 1; }

echo
# Rung 2: the artifact in a real room. bench.sh can prove a selector resolves against a saved DOM;
# only this can prove the bot joins, transcribes and acts.
"$D/e2e.sh" "$CODE" || { echo; echo "GATE RED — e2e"; exit 1; }

echo
echo "GATE GREEN — rig $RIG built the image, matched live/, and passed e2e in $CODE"
