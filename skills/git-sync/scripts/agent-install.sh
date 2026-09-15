#!/usr/bin/env bash
# agent-install.sh - install (or upgrade) the git-sync skill in ANY repository.
# This is the one-command installer a brand-new Arena session can run.
#
# One-liner for a brand-new Arena session (run inside the target repo; git
# clone works in the sandboxes where raw.githubusercontent.com is blocked):
#   git clone --quiet --depth 1 -b arena/01a09fc1-git-pull-arena \
#        https://github.com/mqgg5630-cyber/git-pull-arena.git /tmp/git-sync-src \
#     && bash /tmp/git-sync-src/skills/git-sync/scripts/agent-install.sh \
#            --branch <working-branch>
# (after the skill is merged to main, use: -b main ... /tmp/git-sync-src)
#
# From a local checkout of the skill source repo:
#   bash agent-install.sh [--repo /path/to/target] [--branch arena/xxx] \
#        [--source <git-url | local-path>] [--source-branch <b>] [--gha]
#
# What it does:
#   1. locate the target repo (cwd or --repo); refuse to install on main/master
#   2. fetch the skill folder from the source: --source (git URL or local path)
#      or the canonical repo below (tries main first, then the arena branch)
#   3. copy skills/git-sync/ into the repo; an EXISTING sync.config.json is
#      kept (only branch/remote and missing keys are updated) - an upgrade
#      never throws away your download_sets / upload_map / gate
#   4. copy the 8 user-side .ps1 scripts to the repo root
#   5. create code/check_all.sh (the ASCII + config gate) when missing
#   6. --gha also installs .github/workflows/gate.yml (run the gate on push)
#   7. nothing is committed - finish with agent-sync.sh
#
# Exit codes: 0 ok, 1 usage/guard, 2 source problem, 3 git/config problem.

set -u -o pipefail

DEFAULT_SOURCE_REPO="https://github.com/mqgg5630-cyber/git-pull-arena.git"
DEFAULT_SOURCE_BRANCHES=("main" "arena/01a09fc1-git-pull-arena")

REPO=""; BRANCH=""; SOURCE=""; SOURCE_BRANCH=""; GHA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)          REPO="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --source)        SOURCE="$2"; shift 2 ;;
    --source-branch) SOURCE_BRANCH="$2"; shift 2 ;;
    --gha)           GHA=1; shift ;;
    -h|--help)       sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- 1. target
[ -z "$REPO" ] && REPO="$PWD"
REPO="$(cd "$REPO" 2>/dev/null && pwd)" || { echo "[ERROR] cannot enter repo: $REPO" >&2; exit 3; }
[ -d "$REPO/.git" ] || { echo "[ERROR] not a git repository: $REPO" >&2; exit 3; }
cd "$REPO"
[ -z "$BRANCH" ] && BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
case "$BRANCH" in
  HEAD|'')
    echo "[ERROR] cannot detect the working branch (empty repo?) - pass --branch <name>" >&2
    exit 1 ;;
esac
case "$BRANCH" in
  main|master)
    echo "[REFUSED] target branch is $BRANCH - create/switch to a working branch first (--branch arena/...)" >&2
    exit 1 ;;
esac
REMOTE_NAME="$(git remote | head -1)"
[ -z "$REMOTE_NAME" ] && REMOTE_NAME="origin"

echo "== target : $REPO"
echo "== branch : $BRANCH  (remote: $REMOTE_NAME)"

# ---------------------------------------------------------------- 2. source
fetch_source() {  # $1 url  $2 branch -> prints the tmp dir, or empty on failure
  local d
  d="$(mktemp -d)"
  if git clone --quiet --depth 1 --branch "$2" "$1" "$d" 2>/dev/null; then
    echo "$d"
  else
    rm -rf "$d"
    echo ""
  fi
}

SRC=""; LOCAL_SOURCE=0
if [ -n "$SOURCE" ]; then
  if [ -d "$SOURCE/skills/git-sync" ]; then
    SRC="$SOURCE"
    LOCAL_SOURCE=1
    echo "== source: $SOURCE (local)"
  else
    if [ -z "$SOURCE_BRANCH" ]; then
      echo "[ERROR] --source <git-url> also needs --source-branch <b>" >&2
      exit 2
    fi
    SRC="$(fetch_source "$SOURCE" "$SOURCE_BRANCH")"
    [ -z "$SRC" ] && { echo "[ERROR] clone failed: $SOURCE ($SOURCE_BRANCH)" >&2; exit 2; }
    echo "== source: $SOURCE ($SOURCE_BRANCH)"
  fi
else
  for B in "${DEFAULT_SOURCE_BRANCHES[@]}"; do
    TRY="$(fetch_source "$DEFAULT_SOURCE_REPO" "$B")"
    if [ -n "$TRY" ] && [ -d "$TRY/skills/git-sync" ]; then
      SRC="$TRY"
      echo "== source: $DEFAULT_SOURCE_REPO ($B)"
      break
    fi
    [ -n "$TRY" ] && rm -rf "$TRY"
  done
fi
[ -n "$SRC" ] && [ -d "$SRC/skills/git-sync" ] || {
  echo "[ERROR] could not fetch the skill from any source (offline?)" >&2; exit 2; }

cleanup() {
  if [ "$LOCAL_SOURCE" = "0" ] && [ -n "${SRC:-}" ] && [ -d "$SRC" ]; then
    rm -rf "$SRC"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- 3. install
# keep the target's existing config across the upgrade
# (some repos keep the config at the repo ROOT - a minimal install without
#  the skills folder, as seen on AgentArena - so check both locations)
OLD_CFG_B64=""
if [ -f "$REPO/skills/git-sync/sync.config.json" ]; then
  OLD_CFG_B64="$(base64 -w0 "$REPO/skills/git-sync/sync.config.json" 2>/dev/null || true)"
elif [ -f "$REPO/sync.config.json" ]; then
  OLD_CFG_B64="$(base64 -w0 "$REPO/sync.config.json" 2>/dev/null || true)"
fi

mkdir -p "$REPO/skills"
rm -rf "$REPO/skills/git-sync"
cp -r "$SRC/skills/git-sync" "$REPO/skills/git-sync"
VER=""
[ -f "$SRC/skills/git-sync/VERSION" ] && VER="$(tr -d '[:space:]' < "$SRC/skills/git-sync/VERSION")"
echo "OK: skills/git-sync installed${VER:+ (v$VER)}"

CFG="$REPO/skills/git-sync/sync.config.json"
if ! python3 - "$CFG" "$BRANCH" "$REMOTE_NAME" "$OLD_CFG_B64" <<'PY'
import base64, json, sys

cfg_path, branch, remote, old_b64 = sys.argv[1:5]
if old_b64:
    cfg = json.loads(base64.b64decode(old_b64).decode('utf-8'))
    mode = 'updated (existing sets / map / gate kept)'
else:
    cfg = {}
    mode = 'created (defaults)'

cfg['branch'] = branch
cfg['remote'] = remote
cfg.setdefault('download_dir', '')
cfg.setdefault('download_sets', {'final': ['deliverable']})
cfg.setdefault('upload_map', {
    '.docx': 'sources', '.doc': 'sources', '.pptx': 'sources', '.ppt': 'sources',
    '.pdf': 'sources', '.md': 'sources', '.txt': 'sources', '.zip': 'sources',
    '.py': 'code', '.ipynb': 'code',
    '.xlsx': 'results', '.xls': 'results', '.csv': 'results'})
cfg.setdefault('gate', 'bash code/check_all.sh')
cfg.setdefault('receipt', 'results/sync/last_sync.md')
cfg.setdefault('receipt_history', 'results/sync/history')
cfg.setdefault('hardware_dir', 'results/hardware')
cfg.setdefault('handshake', 'results/status/handshake.json')
cfg.setdefault('check_cmd', 'powershell -NoProfile -ExecutionPolicy Bypass -File code/local_check.ps1')

with open(cfg_path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('OK: sync.config.json ' + mode)
PY
then
  echo "[ERROR] writing sync.config.json failed (is python3 available?)" >&2
  exit 3
fi

# 4. the user-side scripts at the repo root
for f in sync push upload download pack doctor bootstrap pr hardware watch; do
  if [ -f "$REPO/skills/git-sync/scripts/$f.ps1" ]; then
    cp "$REPO/skills/git-sync/scripts/$f.ps1" "$REPO/$f.ps1"
  fi
done
echo "OK: user-side .ps1 scripts copied to the repo root"

# 5. the gate (create only - never overwrite a repo's own checks)
if [ ! -f "$REPO/code/check_all.sh" ] && [ -f "$REPO/skills/git-sync/templates/check_all.sh" ]; then
  mkdir -p "$REPO/code"
  cp "$REPO/skills/git-sync/templates/check_all.sh" "$REPO/code/check_all.sh"
  echo "OK: code/check_all.sh created (pre-commit gate)"
fi

# 5b. the local check template for the auto-verification loop (create only)
if [ ! -f "$REPO/code/local_check.ps1" ] && [ -f "$REPO/skills/git-sync/templates/local_check.ps1" ]; then
  mkdir -p "$REPO/code"
  cp "$REPO/skills/git-sync/templates/local_check.ps1" "$REPO/code/local_check.ps1"
  echo "OK: code/local_check.ps1 created (what watch.ps1 runs - edit it per repo)"
fi

# 6. optional: the GitHub Actions workflow that runs the gate on push
#    (the push needs workflows permission - user-side installs always work)
if [ "$GHA" = "1" ] && [ -f "$REPO/skills/git-sync/templates/gate.yml" ]; then
  mkdir -p "$REPO/.github/workflows"
  cp "$REPO/skills/git-sync/templates/gate.yml" "$REPO/.github/workflows/gate.yml"
  echo "OK: .github/workflows/gate.yml installed (gate runs on every push)"
  echo "    note: pushing it needs workflows permission - if the agent token lacks"
  echo "    it, commit it from the user side (.\\push.ps1) instead"
fi

cat <<EOF

== git-sync skill installed in:
   $REPO
   branch : $BRANCH
   config : skills/git-sync/sync.config.json  (edit sets / upload_map there)

next (assistant side):
   bash skills/git-sync/scripts/agent-sync.sh "feat: install git-sync skill"

next (user side, after the branch is pushed):
   git clone -b $BRANCH <remote-url> && cd <repo>
   .\\bootstrap.ps1
EOF
