#!/usr/bin/env bash
# Land swarm work on `staging` through the gate.
#
#   ./promote.sh <branch>
#
# --no-ff is not cosmetic: a fast-forward creates no merge commit, and the gate lives in the
# pre-merge-commit hook. Fast-forwarding would promote unproven work silently, which is the exact
# failure mode this whole apparatus exists to stop.
set -euo pipefail
cd "$(dirname "$0")"
BRANCH=${1:?usage: ./promote.sh <branch>}

# The hook is a repo-local git config, so a fresh clone has it unset and every merge sails through.
# Set it here rather than trusting anyone to remember.
[ "$(git config core.hooksPath || true)" = .githooks ] || git config core.hooksPath .githooks

git rev-parse --verify "$BRANCH" >/dev/null
git rev-parse --verify staging >/dev/null 2>&1 || git branch staging main
git checkout staging
git merge --no-ff "$BRANCH" -m "Promote $BRANCH to staging (gate green)"

echo
echo "staging now at $(git rev-parse --short HEAD) — gate passed."
echo "To ship:  git checkout main && git merge --ff-only staging"
