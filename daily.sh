#!/usr/bin/env bash
# THE DAILY RUNG. One unattended run of every rung that needs no human, every morning, with the
# evidence kept and browsable afterwards.
#
#   ./daily.sh [meet-code]          # from ~/vexa-rig4; cron: 0 5 * * *
#
# Why this exists: until 2026-08-27 nothing in this project ran on a schedule. The gate fires only
# when an agent promotes a branch, so a rig that died in the night — tokens wiped by a reboot, a
# shim back on its network with no IP, Meet's DOM drifting under the selectors — stayed silent
# until Andrew tried to use it in a meeting. Every one of those failures is invisible from the
# outside and all of them are caught by rungs that already exist. Nothing was missing except a
# clock.
#
# It runs the STAGING rig for the same reason gate.sh does: e2e.sh DELETEs every bot in the room it
# targets, and doing that at 05:00 against rig 1 would tear the bot out of an early call.
#
# What it keeps, per run, under $ARCHIVE/daily/<stamp>/:
#   bench.log   every no-meeting rung, verbatim
#   e2e.log     the ten live checks, verbatim
#   e2e/        RECORD=1 evidence — an mp4 of the bot's own X display for the whole run, a
#               screenshot after every surface act, and report.html tying them together
# and one line in ledger.tsv, which index.html renders as the list of every run there has been.
#
# NO FALLBACKS: a red rung is recorded red and the script exits non-zero. The value of a daily run
# is entirely in it being believed.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
. "$D/rig-env.sh"

if [ "$RIG" = 1 ] && [ "${DAILY_ALLOW_RIG1:-0}" != 1 ]; then
  echo "daily: refusing rig 1 (the human's rig) — run from ~/vexa-rig4" >&2
  exit 1
fi

CODE=${1:-tog-tccc-szk}
ARCHIVE=${VEXA_ARCHIVE:-/media/amiller/fractal-nvme2/vexa-archive}/daily
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=$ARCHIVE/$STAMP

# The run list, rebuilt from the ledger every run so it can never disagree with it.
#
# Hrefs are ABSOLUTE under /daily/. board.py serves the index at /daily with no trailing slash, and
# a browser resolves a relative href against the parent of that path — so `20260827-110710/...`
# became `/20260827-110710/...`, missed the route, and fell through to the console page. Every
# evidence link led back to the control panel (found 2026-08-27, by clicking one).
write_index() {
  {
    echo "<!doctype html><meta charset=utf-8><title>Port Call — daily rung</title>"
    echo "<style>body{background:#0d0d12;color:#e8e8f0;font:15px system-ui;margin:0;padding:32px;max-width:900px}"
    echo "h1{font-size:20px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:7px 10px;"
    echo "border-bottom:1px solid #26263a}a{color:#8ab4ff}.g{color:#7ce38b}.r{color:#ff7b72}code{color:#8a8aa0}</style>"
    echo "<h1>Port Call — daily rung</h1><p><code>bench + e2e, 05:00, staging rig. Newest first.</code></p>"
    echo "<table><tr><th>when<th>rig<th>bench<th>e2e<th>evidence"
    tac "$ARCHIVE/ledger.tsv" | while IFS=$'\t' read -r when rig bench score stamp; do
      case "$bench" in *GREEN) bc=g ;; *) bc=r ;; esac
      case "$score" in *"0 failed") ec=g ;; *) ec=r ;; esac
      printf '<tr><td>%s<td>%s<td class=%s>%s<td class=%s>%s<td>' \
        "$when" "$rig" "$bc" "${bench#bench=}" "$ec" "${score#e2e=}"
      [ -f "$ARCHIVE/$stamp/e2e/report.html" ] && printf '<a href="/daily/%s/e2e/report.html">report</a> · ' "$stamp"
      printf '<a href="/daily/%s/bench.log">bench.log</a> · <a href="/daily/%s/e2e.log">e2e.log</a>\n' "$stamp" "$stamp"
    done
    echo "</table>"
  } >"$ARCHIVE/index.html"
}

# `./daily.sh --index-only` rebuilds index.html from the ledger without running anything, which is
# what you want after editing how the page is written or after the retention prune drops runs.
[ "${1:-}" = --index-only ] && { write_index; echo "index -> $ARCHIVE/index.html"; exit 0; }

mkdir -p "$OUT"
echo "═══ DAILY — rig $RIG ($C), room $CODE, $STAMP ═══"

"$D/bench.sh" >"$OUT/bench.log" 2>&1; BR=$?
[ $BR -eq 0 ] && BENCH=GREEN || BENCH=RED
echo "bench $BENCH"

# ART sends the recording and the screenshots into this run's directory rather than $RIGDIR/artifacts.
RECORD=1 ART="$OUT/e2e" "$D/e2e.sh" "$CODE" >"$OUT/e2e.log" 2>&1; ER=$?
# "---- 10 passed, 0 failed ----". Absent when e2e died before its first assertion (no token, no
# spawn), and that absence is the interesting case, so carry the last line instead of inventing a score.
SCORE=$(grep -oE '[0-9]+ passed, [0-9]+ failed' "$OUT/e2e.log" | tail -1)
[ -n "$SCORE" ] || SCORE="died: $(tail -1 "$OUT/e2e.log" | cut -c1-90)"
echo "e2e $SCORE"

printf '%s\t%s\tbench=%s\te2e=%s\t%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "rig$RIG" "$BENCH" "$SCORE" "$STAMP" >>"$ARCHIVE/ledger.tsv"

# 21 days, the retention backup.sh already uses for recordings of the same meetings.
find "$ARCHIVE" -maxdepth 1 -type d -name '20*' -mtime +21 -exec rm -rf {} + 2>/dev/null

write_index

echo "evidence -> $OUT   ·   index -> $ARCHIVE/index.html"
[ $BR -eq 0 ] && [ $ER -eq 0 ]
