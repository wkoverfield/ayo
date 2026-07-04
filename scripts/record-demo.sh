#!/usr/bin/env bash
#
# Record docs/demo.gif on demand — a real, reproducible terminal gif of the Ayo
# CLI. The gif is NOT committed (it's gitignored): the terminal is only one of
# Ayo's surfaces, so the README leads with the handoff-page screenshot instead.
# This stays here so a gif is one command away when you want one.
#
# Boots a local relay (dev auth stub) + a two-person team, pre-seeds deterministic
# state (an inbound handoff with real git context, and a blocked agent ask), then
# runs `vhs scripts/demo.tape`. Every frame in the gif is genuine `ayo` output.
#
# The toast and the handoff web PAGE are other surfaces a terminal recorder can't
# capture — see scripts/demo.sh (live board + real toasts, for a screen capture).
#
# Usage:  pnpm -r build && scripts/record-demo.sh
# Needs:  charmbracelet/vhs (`brew install vhs`), a local build in dist/.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AYO="node $REPO/packages/cli/dist/ayo.js"
PORT=8899
BASE=/tmp/ayo-demo-rec
YOU=$BASE/you
MAYA=$BASE/maya
BIN=$BASE/bin
RELAY_LOG=$BASE/relay.log
export AYO_RELAY_URL="http://127.0.0.1:$PORT"

cleanup() {
  pkill -f "wrangler dev --local --port $PORT" >/dev/null 2>&1 || true
  pkill -f "workerd" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v vhs >/dev/null || { echo "vhs not found — brew install vhs"; exit 1; }
[ -f "$REPO/packages/cli/dist/ayo.js" ] || { echo "Build first:  pnpm -r build"; exit 1; }

rm -rf "$BASE"; mkdir -p "$YOU" "$MAYA" "$BIN"

echo "▶ booting local relay (dev stub) on :$PORT…"
( cd "$REPO/packages/relay" && npx wrangler dev --local --port "$PORT" \
    --var AYO_DEV_AUTH:1 --var INTERNAL_SECRET:dev-internal-secret \
    >"$RELAY_LOG" 2>&1 & )
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/v1/me" 2>/dev/null && break || true
  # /v1/me 401s when up; curl -f treats 401 as failure, so also grep the log.
  grep -qE "Ready on|Listening on" "$RELAY_LOG" 2>/dev/null && break
  sleep 0.5
done

echo "▶ team: you + maya…"
AYO_DIR=$YOU $AYO login --handle you   >/dev/null
AYO_DIR=$MAYA $AYO login --handle maya >/dev/null
CODE=$(AYO_DIR=$YOU $AYO team create "Hack Midwest" | grep -oE 'join code: [A-Z0-9]+' | awk '{print $3}')
AYO_DIR=$MAYA $AYO join "$CODE" >/dev/null

echo "▶ seeding an inbound handoff (real git context from this repo)…"
# Run from the repo so captureContext picks up branch + changed files + diffstat.
( cd "$REPO" && AYO_DIR=$MAYA $AYO handoff you \
    "oauth callback 400s — the token exchange rejects our redirect_uri" >/dev/null )

echo "▶ seeding a blocked agent ask (your agent, waiting on you)…"
TOKEN=$(python3 -c "import json;print(json.load(open('$YOU/session.json'))['token'])")
TEAM=$(python3 -c "import json;print(json.load(open('$YOU/config.json'))['activeTeamId'])")
EXP=$(python3 -c "from datetime import datetime,timedelta,timezone;print((datetime.now(timezone.utc)+timedelta(hours=2)).isoformat().replace('+00:00','Z'))")
curl -fsS -X POST "$AYO_RELAY_URL/v1/teams/$TEAM/ayo" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"to\":[\"you\"],\"body\":\"Retry queue: exponential backoff or fixed interval?\",\"kind\":\"ask\",\"urgency\":\"normal\",\"expiresAt\":\"$EXP\",\"ask\":{\"options\":[\"backoff\",\"fixed\"]}}" \
  >/dev/null

echo "▶ writing the clean \`ayo\` wrapper + env the tape sources…"
cat >"$BIN/ayo" <<EOF
#!/usr/bin/env bash
exec node "$REPO/packages/cli/dist/ayo.js" "\$@"
EOF
chmod +x "$BIN/ayo"
cat >"$BASE/env.sh" <<EOF
export AYO_RELAY_URL="$AYO_RELAY_URL"
export AYO_DIR="$YOU"
export PATH="$BIN:\$PATH"
EOF

echo "▶ recording docs/demo.gif with vhs…"
( cd "$REPO" && vhs scripts/demo.tape )

echo "✓ wrote docs/demo.gif"
