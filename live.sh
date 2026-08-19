#!/usr/bin/env bash
# One command to get a shareable live transcript:  ./live.sh <meet-code>
# Joins the meeting, waits for the bot to be recording, starts the forwarder, prints the link.
set -euo pipefail
cd "$(dirname "$0")"
CODE=${1:?usage: ./live.sh <meet-code>   (e.g. ./live.sh abc-defg-hij)}

ROOM="$CODE" ./demo.sh join

# The forwarder keys off the postgres meeting id, which only exists once the bot has joined.
for i in $(seq 1 40); do
  MID=$(docker exec vexa-rig-postgres-1 psql -U postgres vexa -tAc \
    "select id from meetings where platform_specific_id='$CODE' order by id desc limit 1" | tr -d ' ')
  [ -n "$MID" ] && break
  sleep 3
done
[ -n "${MID:-}" ] || { echo "no meeting row for $CODE after 2 minutes — did the bot actually join?" >&2; exit 1; }

pkill -f "fwd.py $CODE" 2>/dev/null || true
(setsid nohup python3 "$PWD/fwd.py" "$CODE" "$MID" > /tmp/fwd-$CODE.log 2>&1 &)
sleep 10
tail -1 /tmp/fwd-$CODE.log

cat <<EOF

  meeting $MID in $CODE — paste this into the meeting chat:

  https://pod.dstack.soc1024.com/meeting-brainrot/#$CODE

  forwarder log: /tmp/fwd-$CODE.log     stop everything: ./demo.sh stop
EOF
