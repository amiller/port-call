#!/usr/bin/env bash
# Poll both seats until they are linked, then run the e2e once. Exists so the demonstration does
# not wait on someone being at the keyboard to announce a QR scan: scan whenever, it runs itself.
# pipefail matters here: this script is usually run piped into tee, and without it the pipeline
# reports tee's exit status — a give-up (exit 1) then reads as success.
set -uo pipefail
cd "$(dirname "$0")"
A=${A_PORT:-9334}; B=${B_PORT:-9335}
DEADLINE=$(( $(date +%s) + ${WAIT_SECS:-3600} ))
cat js/lib.js js/link-state.js > /tmp/pc-linkstate.js
linked() { node cdp.mjs "$1" eval /tmp/pc-linkstate.js 2>/dev/null | grep -q '"linked": *true'; }
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if linked "$A" && linked "$B"; then
    echo "[watch] both seats linked at $(date +%H:%M:%S) — running e2e"
    exec ./e2e.sh
  fi
  sleep 15
done
echo "[watch] gave up after ${WAIT_SECS:-3600}s — seats still unlinked" >&2
exit 1
