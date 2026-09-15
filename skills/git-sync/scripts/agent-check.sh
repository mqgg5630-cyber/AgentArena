#!/usr/bin/env bash
# agent-check.sh - the arena <-> local auto-verification handshake.
#
# The loop (config key "handshake", default results/status/handshake.json):
#
#   agent:  bash skills/git-sync/scripts/agent-sync.sh "work ..." &&
#           bash skills/git-sync/scripts/agent-check.sh --request "verify X"
#             -> handshake: round+1, arena_state=awaiting_check, local_state=pending
#   local:  .\watch.ps1 -Register  (once; a scheduled task then polls every
#             N minutes) - it sees awaiting_check, syncs, runs check_cmd,
#             writes results/status/check_rN_<stamp>.log, pushes the verdict
#   agent:  bash skills/git-sync/scripts/agent-check.sh --read
#             exit 0 = local checks passed, 2 = failed, 3 = still pending
#           passed AND you are satisfied ->
#               bash skills/git-sync/scripts/agent-check.sh --accept
#             (arena_state=accepted - the watcher goes idle, the loop ends)
#           failed -> fix, agent-sync.sh, --request again (round+1)
#
# Exit codes: 0 ok/passed, 1 guard error, 2 failed, 3 pending, 3 also "no
# handshake yet".

set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

CFG="skills/git-sync/sync.config.json"
BRANCH=""; REMOTE="origin"; HANDSHAKE="results/status/handshake.json"
if [ -f "$CFG" ]; then
  BRANCH="$(python3 -c "import json;print(json.load(open('$CFG',encoding='utf-8')).get('branch',''))" 2>/dev/null || true)"
  REMOTE="$(python3 -c "import json;print(json.load(open('$CFG',encoding='utf-8')).get('remote','origin'))" 2>/dev/null || true)"
  HANDSHAKE="$(python3 -c "import json;print(json.load(open('$CFG',encoding='utf-8')).get('handshake','results/status/handshake.json'))" 2>/dev/null || true)"
fi
[ -z "$BRANCH" ] && BRANCH="$(git rev-parse --abbrev-ref HEAD)"

ACTION=""; NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --request) ACTION="request"; shift ;;
    --read)    ACTION="read";    shift ;;
    --accept)  ACTION="accept";  shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) NOTE="$1"; shift ;;
  esac
done
[ -z "$ACTION" ] && { echo "usage: agent-check.sh --request [note] | --read | --accept [note]" >&2; exit 1; }

case "$BRANCH" in
  main|master) echo "[REFUSED] never work on $BRANCH" >&2; exit 1 ;;
esac
CURRENT="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT" != "$BRANCH" ] && { echo "[REFUSED] HEAD is $CURRENT, expected $BRANCH" >&2; exit 1; }

HS_NORM="${HANDSHAKE//\\//}"
ORIGIN="$REMOTE/$BRANCH"
git config "remote.$REMOTE.fetch" "+refs/heads/*:refs/remotes/$REMOTE/*"
git fetch "$REMOTE" --quiet || { echo "[ERROR] fetch failed" >&2; exit 1; }

# read the handshake from the REMOTE tip - that is where the local watcher
# pushes its verdict, and the agent worktree may be one step behind
hs_from_origin() {
  git show "$ORIGIN:$HS_NORM" 2>/dev/null
}

json_get() {  # $1 = json text, $2 = key  (utf-8-sig: PS 5.1 writes a BOM)
  printf '%s' "$1" | python3 -c "import json,sys;d=json.loads(sys.stdin.buffer.read().decode('utf-8-sig'));print(d.get('$2',''))" 2>/dev/null
}

if [ "$ACTION" = "read" ]; then
  HS="$(hs_from_origin)"
  if [ -z "$HS" ]; then
    echo "== no handshake yet (nobody requested a check). Exit 3."
    exit 3
  fi
  ROUND="$(json_get "$HS" round)"; ASTATE="$(json_get "$HS" arena_state)"; LSTATE="$(json_get "$HS" local_state)"
  echo "== handshake (round $ROUND): arena=$ASTATE local=$LSTATE"
  printf '%s\n' "$HS" | python3 -c "import json,sys;print(json.dumps(json.loads(sys.stdin.buffer.read().decode('utf-8-sig')),indent=2,ensure_ascii=False))" 2>/dev/null || printf '%s\n' "$HS"
  LOG="$(ls -1 "$(dirname "$HS_NORM")"/check_r${ROUND}_*.txt 2>/dev/null | sort | tail -1)"
  if [ -n "$LOG" ] && [ -f "$LOG" ]; then
    echo ""
    echo "== last check log: $LOG (tail)"
    tail -15 "$LOG"
  else
    # the log may only exist on the remote yet - try it from the origin tip
    LOGS="$(git ls-tree --name-only "$ORIGIN" "$(dirname "$HS_NORM")" 2>/dev/null | grep "check_r${ROUND}_" | sort | tail -1)"
    if [ -n "$LOGS" ]; then
      echo ""
      echo "== last check log (from remote): $LOGS (tail)"
      git show "$ORIGIN:$LOGS" 2>/dev/null | tail -15
    fi
  fi
  if [ "$ASTATE" = "accepted" ]; then echo "== accepted - the loop is closed."; exit 0; fi
  case "$LSTATE" in
    passed) exit 0 ;;
    failed) exit 2 ;;
    *)      exit 3 ;;
  esac
fi

# ------------------------------------------------------- request / accept
# these WRITE the handshake in the worktree, then commit + push
round_prev=0
HS_OLD="$(hs_from_origin)"
[ -n "$HS_OLD" ] && round_prev="$(json_get "$HS_OLD" round)"
[ -z "$round_prev" ] && round_prev=0

# align HEAD with the remote first: the watcher may have pushed its verdict
# since our last sync, and committing on a stale HEAD gets the push rejected
# (worktree is kept; phantom deletions from the reset are restored)
if ! git merge-base --is-ancestor "$ORIGIN" HEAD 2>/dev/null; then
  git reset --mixed "$ORIGIN" || { echo "[ERROR] cannot align with $ORIGIN" >&2; exit 1; }
  git ls-files -d | xargs -r git checkout --
fi

mkdir -p "$(dirname "$HS_NORM")"
if [ "$ACTION" = "request" ]; then
  NEW_ROUND=$((round_prev + 1))
  python3 - "$HS_NORM" "$NEW_ROUND" "$NOTE" <<'PY'
import json, sys, datetime
path, rnd, note = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    d = json.load(open(path, encoding='utf-8-sig'))
except Exception:
    d = {}
d.update({
    'round': rnd,
    'arena_state': 'awaiting_check',
    'local_state': 'pending',
    'arena_updated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'local_updated': None,
    'host': '',
    'note': note,
})
with open(path, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
  MSG="check: request round $NEW_ROUND (awaiting local check)"
else
  # seed the file from the REMOTE handshake first: the worktree copy can be
  # stale (no sync since the request), and accepting on top of it would
  # clobber the watcher's verdict (local_state / host / local_updated)
  if [ -n "$HS_OLD" ]; then
    printf '%s\n' "$HS_OLD" > "$HS_NORM"
  fi
  python3 - "$HS_NORM" "$NOTE" <<'PY'
import json, sys, datetime
path, note = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path, encoding='utf-8-sig'))
except Exception:
    d = {}
d.update({
    'arena_state': 'accepted',
    'arena_updated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'note': note or d.get('note', ''),
})
with open(path, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
  MSG="check: accepted - local checks passed, loop closed"
fi

git add -A
if git diff --cached --quiet; then
  echo "== nothing to change in the handshake"
else
  git -c user.name="Arena Agent" -c user.email="agent@arena.ai" commit -q -m "$MSG"
  git push "$REMOTE" "$BRANCH" --quiet || { echo "[ERROR] push failed" >&2; exit 1; }
  echo "== committed + pushed: $MSG"
fi

if [ "$ACTION" = "request" ]; then
  echo ""
  echo "== the local watcher will pick this up on its next poll (default 2 min)."
  echo "   read the verdict later with: agent-check.sh --read"
else
  echo ""
  echo "== accepted. the watcher is idle until the next --request."
fi
