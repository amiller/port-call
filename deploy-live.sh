#!/usr/bin/env bash
# Push committed patches/ into this rig's live/ tree and recompile in place.
#
# patches/ is the truth; the image and live/ both derive from it. Until 2026-08-19 this step was
# done by hand, which is how the #16 recorder fix came to exist in live/ on one machine and nowhere
# else for a week. Scripted, it is also what makes a rig a deployment target rather than a pet.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D"

for f in patches/bot-*.ts; do
  n=$(basename "$f" .ts); cp "$f" "live/services-bot-src/${n#bot-}.ts"
done
cp patches/browser-args.ts    live/modules-join-src/browser-args.ts
cp patches/gmeet-selectors.ts live/modules-join-src/googlemeet/selectors.ts

./hotswap.sh
