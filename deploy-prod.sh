#!/usr/bin/env bash
# Ship a proven ref to PROD — rig 1, the rig Andrew takes meetings on.
#
#   ./deploy-prod.sh [ref]        default: staging
#
# This is the one step that is NOT automatic. Staging (rig 4) moves by itself the moment a swarm
# agent's branch passes the gate; prod moves when a human says so. That split is the convention the
# oauth3 side already uses — agents commit to branches and never deploy, and staging vs prod is a
# deploy target rather than a branch.
#
# It deploys by hot-swap, NOT by recreating the container: `docker compose up -d` recreates if the
# compose file drifted, and that destroys in-container recordings and act logs. Archive first
# regardless, because the one thing this project cannot get back is meeting audio.
set -euo pipefail
cd "$(dirname "$0")"
REF=${1:-staging}
HOST=${PROD_HOST:-fractal}
RIGDIR=${PROD_RIGDIR:-vexa-rig}

git rev-parse --verify "$REF" >/dev/null
git merge-base --is-ancestor "$REF" staging 2>/dev/null || [ "$(git rev-parse "$REF")" = "$(git rev-parse staging)" ] || {
  echo "refusing: $REF is not staging or an ancestor of it — it has not been through the gate." >&2
  exit 1; }

echo "── archiving rig 1 before touching it ──"
ssh "$HOST" '/media/amiller/fractal-nvme2/vexa-archive/backup.sh' || {
  echo "refusing to deploy: the archive failed, so a mistake here would be unrecoverable." >&2; exit 1; }

echo "── syncing $REF to $HOST:$RIGDIR ──"
TREE=$(mktemp -d)
trap 'rm -rf "$TREE"' EXIT
git archive "$REF" | tar -x -C "$TREE"
# Same exclusions as the staging gate: live/ is the rig's compiled tree, .env holds its key, and
# host ports come from that .env. --delete (never --delete-excluded, which deletes them).
rsync -a --delete --exclude '.git' --exclude 'live/' --exclude '.env' \
  --exclude 'artifacts/' --exclude 'tasks/' "$TREE/" "$HOST:$RIGDIR/"

echo "── deploying and re-checking on rig 1 ──"
ssh "$HOST" "cd $RIGDIR && ./deploy-live.sh && ./bench.sh"

# main means "what is on prod". Nothing else moves it, so reading `main` answers the question the
# rig cannot: which commit is Andrew's meetings actually running. staging is always at or ahead of it.
git branch -f main "$REF"
echo
echo "prod (rig 1) now running $(git rev-parse --short "$REF"); main moved to match."
