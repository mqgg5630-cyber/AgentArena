#!/usr/bin/env bash
# agent-wait.sh - request a local check AND wait for the verdict, so the whole
# verify loop closes inside ONE conversation turn (no per-round user input).
#
# Usage:
#     bash skills/git-sync/scripts/agent-wait.sh                          # wait for the pending request
#     bash skills/git-sync/scripts/agent-wait.sh --request "verify X"     # new round, then wait
#     bash skills/git-sync/scripts/agent-wait.sh --request "X" --timeout 900 --interval 30
#     bash skills/git-sync/scripts/agent-wait.sh --request "X" --auto-accept
#                                                         # passed -> accept automatically:
#                                                         # "work -> verify -> close" in one command
#
# Flow: [--request] -> agent-check.sh --request -> poll the remote handshake
# every --interval seconds until the local watcher pushes passed/failed (or
# arena_state=accepted) or --timeout (default 600s = up to 3 polls of a
# 2-minute watcher) -> print the verdict via agent-check.sh --read.
#
# Exit codes (same as agent-check.sh --read):
#     0 passed / accepted      2 failed      3 still pending / timeout

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$REPO_ROOT"

CFG="skills/git-sync/sync.config.json"
BRANCH=""; REMOTE="origin"; HANDSHAKE="results/status/handshake.json"
if [ -f "$CFG" ]; then
  BRANCH="$(python3 -c "import json;print(json.load(open('$CFG',encoding='utf-8')).get('branch',''))" 2>/dev/null || true)"
  REMOTE="$(python3 -c "import json;print(json.load(open('$CFG',encoding='utf-8')).get('remote','origin'))" 2>/dev/null || true)"
  HANDSHAKE="$(python3 -c "import json;print(json.load(open('$CFG',encoding='utf-8')).get('handshake','results/status/handshake.json'))" 2>/dev/null || true)"
fi
[ -z "$BRANCH" ] && BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HS_NORM="${HANDSHAKE//\\//}"
ORIGIN="$REMOTE/$BRANCH"

NOTE=""; DO_REQUEST=0; TIMEOUT=600; INTERVAL=30; AUTO_ACCEPT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --request) DO_REQUEST=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --auto-accept) AUTO_ACCEPT=1; shift ;;
    *) NOTE="$1"; shift ;;
  esac
done

# optional: open a new round first
if [ "$DO_REQUEST" = 1 ]; then
  bash "$HERE/agent-check.sh" --request "$NOTE" || exit 1
else
  git config "remote.$REMOTE.fetch" "+refs/heads/*:refs/remotes/$REMOTE/*"
  git fetch "$REMOTE" --quiet || { echo "[ERROR] fetch failed" >&2; exit 1; }
  if ! git show "$ORIGIN:$HS_NORM" >/dev/null 2>&1; then
    echo "[ERROR] no handshake yet - start a round with: agent-wait.sh --request \"note\"" >&2
    exit 1
  fi
fi

echo "== waiting for the local watcher (polling every ${INTERVAL}s, timeout ${TIMEOUT}s) ..."
read_hs() { git show "$ORIGIN:$HS_NORM" 2>/dev/null; }
hs_key() { printf '%s' "$(read_hs)" | python3 -c "import json,sys;d=json.loads(sys.stdin.buffer.read().decode('utf-8-sig'));print(d.get('$1',''))" 2>/dev/null; }
state="$(hs_key local_state)"
start=$SECONDS
while [ "$state" = "pending" ] || [ -z "$state" ]; do
  slept=$((SECONDS - start))
  [ "$slept" -ge "$TIMEOUT" ] && break
  printf '  [%3ds/%ds] still pending ...\r' "$slept" "$TIMEOUT"
  sleep "$INTERVAL"
  git fetch "$REMOTE" --quiet || true
  state="$(hs_key local_state)"
  astate="$(hs_key arena_state)"
  [ "$astate" = "accepted" ] && state="passed"
done
echo ""

case "$state" in
  passed) echo "== verdict: PASSED (after $((SECONDS - start))s)" ;;
  failed) echo "== verdict: FAILED (after $((SECONDS - start))s)" ;;
  *)      echo "== verdict: still pending after ${TIMEOUT}s (watcher offline? check .\\watch.ps1 and Get-ScheduledTask git-sync-watch-*)" ;;
esac

# --auto-accept: close the loop right away when the local checks passed
if [ "$state" = "passed" ] && [ "$AUTO_ACCEPT" = 1 ]; then
  echo "== auto-accept: local checks passed - closing the loop"
  bash "$HERE/agent-check.sh" --accept | head -2
fi

# full report + exit code from the reader (0 passed / 2 failed / 3 pending)
exec bash "$HERE/agent-check.sh" --read
