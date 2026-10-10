# Sourced by bench.sh / e2e.sh / journeys.sh. One variable, RIG, selects which of the parallel rigs
# a run targets, so a swarm agent can prove its work without touching the rig Andrew is in a meeting
# on. The mapping is not invented here — it is the convention the four existing rigs already use:
#
#   RIG=1  ~/vexa-rig   vexa-rig-vexa-lite-1   gateway :8056  tokens /tmp/vexa-{bot,tx}-token.txt
#   RIG=4  ~/vexa-rig4  vexa-rig4-vexa-lite-1  gateway :8059  tokens /tmp/vexa4-{bot,tx}-token.txt
#
# RIG=1 is the human's rig. Swarm work belongs on any other one; gate.sh defaults to RIG=4.
# RIG defaults to the rig this copy of the tree IS: ~/vexa-rig4 -> 4, ~/vexa-rig -> 1, and a plain
# checkout (vexa-poc) -> 1. Inferring it beats defaulting to 1 everywhere, where running a script
# from inside ~/vexa-rig4 would have quietly driven rig 1 — the human's rig — instead.
if [ -z "${RIG:-}" ]; then
  case "$(basename "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")" in
    vexa-rig) RIG=1 ;;
    vexa-rig[0-9]*) RIG=$(basename "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" | tr -dc 0-9) ;;
    *) RIG=1 ;;
  esac
fi
[ "$RIG" = 1 ] && RIGSFX="" || RIGSFX="$RIG"
# The container is named by compose from COMPOSE_PROJECT_NAME in .env, and the gateway port is
# VEXA_GW_PORT there, so read the same file compose reads. A tree with no .env yet gets the
# numbered-rig defaults above.
_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env"
_PROJECT=; _GWPORT=
[ ! -f "$_ENV" ] || _PROJECT=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$_ENV" | tail -1)
[ ! -f "$_ENV" ] || _GWPORT=$(sed -n 's/^VEXA_GW_PORT=//p' "$_ENV" | tail -1)
C=${C:-${_PROJECT:-vexa-rig$RIGSFX}-vexa-lite-1}
GW=${GW:-http://localhost:${_GWPORT:-$((8055 + RIG))}}
RIGDIR=${RIGDIR:-$HOME/vexa-rig$RIGSFX}
TOKBOT=/tmp/vexa$RIGSFX-bot-token.txt
TOKTX=/tmp/vexa$RIGSFX-tx-token.txt

# Fail here rather than three rungs later with an empty token and an unreadable 401. relaunch.sh is
# the only thing that mints these and they die with every reboot.
rig_require_tokens() {
  for f in "$TOKBOT" "$TOKTX"; do
    [ -s "$f" ] || { echo "no token at $f — run ./relaunch.sh in $RIGDIR (RIG=$RIG)" >&2; exit 1; }
  done
}
