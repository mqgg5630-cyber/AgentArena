#!/usr/bin/env bash
# check_all.sh (template) - pre-commit gate, installed by agent-install.sh
# into code/check_all.sh when the target repo has none.
#
#   1. every .ps1 must be ASCII-only: Windows PowerShell 5.1 decodes BOM-less
#      .ps1 as ANSI/GBK, so any non-ASCII byte breaks the parser.
#      (Chinese goes into .md / .json only.)
#   2. skills/git-sync/sync.config.json must parse and point at a working
#      branch - never main/master.
#   3. the .ps1 copies at the repo root must be identical to the ones in
#      skills/git-sync/scripts/ (they are the same scripts).
#
# Exit 0 = ok, 1 = failed.

set -u -o pipefail
cd "$(dirname "$0")/.."
fail=0

# ---------------------------------------------------------------- 1. ps1
while IFS= read -r -d '' f; do
    if LC_ALL=C grep -qn '[^[:print:][:space:]]' "$f"; then
        echo "[FAIL] non-ASCII bytes in $f  (keep .ps1 ASCII-only; put Chinese in .md/.json)"
        fail=1
    fi
done < <(find . -name '*.ps1' -not -path './.git/*' -print0)
if [ "$fail" -eq 0 ]; then
    echo "OK: all .ps1 files are ASCII-only"
fi

# -------------------------------------------------------------- 2. config
if python3 - <<'PY'
import json
cfg = json.load(open('skills/git-sync/sync.config.json', encoding='utf-8'))
branch = cfg.get('branch', '')
assert branch and branch not in ('main', 'master'), 'bad branch: %r' % branch
assert cfg.get('remote'), 'remote missing'
print('OK: sync.config.json branch=%s' % branch)
PY
then
    :
else
    echo "[FAIL] skills/git-sync/sync.config.json is invalid or branch is main/master"
    fail=1
fi

# ------------------------------------------------- 3. root vs skill scripts
drift=0
for f in sync push upload download pack doctor bootstrap pr hardware watch; do
    if [ -f "$f.ps1" ] && [ -f "skills/git-sync/scripts/$f.ps1" ]; then
        if ! cmp -s "$f.ps1" "skills/git-sync/scripts/$f.ps1"; then
            echo "[FAIL] $f.ps1 differs from skills/git-sync/scripts/$f.ps1 - copy it over"
            drift=1
        fi
    fi
done
if [ "$drift" = "0" ]; then
    echo "OK: root scripts identical to skills/git-sync/scripts"
else
    fail=1
fi

exit $fail
