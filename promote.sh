#!/usr/bin/env bash
# Land finished work on `staging`. THIS IS THE AGENT'S FINISHING MOVE, not a human's — an agent that
# believes it is done runs this, and the merge happens by itself if the gate is green. Nobody should
# have to shepherd branches into a shared stream by hand.
#
#   ./promote.sh <branch>
#
# The merge is automatic; what is NOT automatic is prod. Staging is rig 4, prod is rig 1 — the rig
# Andrew takes meetings on — and that one moves only when a human runs ./deploy-prod.sh.
#
# --no-ff is not cosmetic: a fast-forward creates no merge commit, and the gate lives in the
# pre-merge-commit hook. Fast-forwarding would land unproven work silently.
set -euo pipefail
cd "$(dirname "$0")"
BRANCH=${1:?usage: ./promote.sh <branch>}

# Several agents finish at once. Without this they interleave checkouts of a shared working tree and
# corrupt each other's merge; with it they queue. The gate itself takes minutes, so wait generously.
exec 9>/tmp/vexa-promote.lock
flock -w 3600 9 || { echo "promote: timed out waiting for another promotion" >&2; exit 1; }

# The hook is repo-local git config, so a fresh clone has it unset and every merge sails through.
[ "$(git config core.hooksPath || true)" = .githooks ] || git config core.hooksPath .githooks

WAS=$(git rev-parse --abbrev-ref HEAD)
# Leave the tree where we found it even when the gate says no, so an agent's next command is not
# operating on staging by surprise.
trap 'git merge --abort 2>/dev/null || true; git checkout -q "$WAS" 2>/dev/null || true' EXIT

git rev-parse --verify "$BRANCH" >/dev/null
git rev-parse --verify staging >/dev/null 2>&1 || git branch staging main
git checkout -q staging
git merge --no-ff "$BRANCH" -m "Promote $BRANCH to staging (gate green)"

trap - EXIT
HEAD_=$(git rev-parse --short HEAD)
git checkout -q "$WAS"
echo
echo "staging now at $HEAD_ — gate green, merged automatically."
echo "Prod (rig 1) is unchanged. Ship it with: ./deploy-prod.sh"
