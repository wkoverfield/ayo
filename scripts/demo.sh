#!/usr/bin/env bash
#
# Ayo demo — boots a local relay + a 3-person team and plays a scripted sequence
# so you can record the live board (and the toasts) coming alive.
#
# Usage:
#   pnpm -r build          # once, so dist/ exists
#   scripts/demo.sh        # then follow the prompt (open `ayo board` in another pane)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AYO="node $REPO/packages/cli/dist/ayo.js"
PORT=8787
export AYO_RELAY_URL="http://127.0.0.1:$PORT"

YOU=/tmp/ayo-demo-you
MAYA=/tmp/ayo-demo-maya
KENNY=/tmp/ayo-demo-kenny
RELAY_LOG=/tmp/ayo-demo-relay.log

cleanup() {
  AYO_DIR=$YOU $AYO daemon stop >/dev/null 2>&1 || true
  AYO_DIR=$MAYA $AYO daemon stop >/dev/null 2>&1 || true
  pkill -f "wrangler dev --local --port $PORT" >/dev/null 2>&1 || true
  pkill -f workerd >/dev/null 2>&1 || true
}
trap cleanup EXIT

[ -f "$REPO/packages/cli/dist/ayo.js" ] || { echo "Build first:  pnpm -r build"; exit 1; }
rm -rf "$YOU" "$MAYA" "$KENNY"

echo "▶ booting local relay (dev stub)…"
( cd "$REPO/packages/relay" && npx wrangler dev --local --port "$PORT" >"$RELAY_LOG" 2>&1 & )
for _ in $(seq 1 30); do grep -q "Ready on" "$RELAY_LOG" 2>/dev/null && break; sleep 1; done

echo "▶ setting up the team — you, maya, kenny…"
AYO_DIR=$YOU $AYO login --handle you >/dev/null
CODE=$(AYO_DIR=$YOU $AYO team create "Hack Midwest" | grep -oE 'join code: [A-Z0-9]+' | awk '{print $3}')
AYO_DIR=$YOU $AYO daemon start >/dev/null                       # your receiver (toasts land here)
AYO_DIR=$MAYA $AYO login --handle maya >/dev/null && AYO_DIR=$MAYA $AYO join "$CODE" >/dev/null
AYO_DIR=$KENNY $AYO login --handle kenny >/dev/null && AYO_DIR=$KENNY $AYO join "$CODE" >/dev/null
AYO_DIR=$MAYA $AYO daemon start >/dev/null                      # maya online on the board
AYO_DIR=$MAYA $AYO status "wiring oauth" >/dev/null
AYO_DIR=$KENNY $AYO status "food run, brb" >/dev/null           # kenny: offline but with a status

cat <<EOF

  ✅ Team ready. In ANOTHER terminal pane (the one you'll record), run:

      export AYO_RELAY_URL=$AYO_RELAY_URL
      AYO_DIR=$YOU $AYO board

  Turn on macOS notifications, then come back here.

EOF
read -r -p "  Press Enter to start the demo… " _

step() { printf "  → %s\n" "$1"; sleep "${2:-3}"; }

step "maya pings you: 'auth looks flaky, can you peek?'" 0
AYO_DIR=$MAYA $AYO you "auth looks flaky, can you peek?" >/dev/null; sleep 3
step "maya broadcasts: 'we're cooked, all hands' (urgent)" 0
AYO_DIR=$MAYA $AYO team "we're cooked, all hands on deck" --urgent >/dev/null; sleep 3
step "kenny's back: status 'on the deploy'" 0
AYO_DIR=$KENNY $AYO status "back — on the deploy" >/dev/null; sleep 3
step "maya hands off the deploy to you (open handoff appears)" 0
AYO_DIR=$MAYA $AYO handoff you "deploy is cooked, need eyes" >/dev/null; sleep 3

echo
echo "  ✨ Done. Your board shows the open handoff + the activity feed."
echo "     Ctrl-C the board when you've got the recording. (This window cleans up on exit.)"
