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
# Distinguish "answered, not linked" from "could not reach the seat". Swallowing both made a dead
# tunnel look identical to an unscanned QR, so the watcher polled for an hour and then reported the
# wrong diagnosis.
probe() { node cdp.mjs "$1" eval /tmp/pc-linkstate.js 2>/tmp/pc-probe-err.$1; }
linked() {
  local out; out=$(probe "$1") || { echo "[watch] seat on port $1 UNREACHABLE: $(tail -1 /tmp/pc-probe-err.$1)" >&2; return 1; }
  echo "$out" | grep -q '"linked": *true'
}
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if linked "$A" && linked "$B"; then
    echo "[watch] both seats linked at $(date +%H:%M:%S) — running e2e"
    exec ./e2e.sh
  fi
  sleep 15
done
echo "[watch] gave up after ${WAIT_SECS:-3600}s — seats still unlinked" >&2
exit 1
