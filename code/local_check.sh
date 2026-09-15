#!/usr/bin/env bash
# local_check.sh - the PowerShell-free check entry for the auto-verification
# loop (sync.config.json -> check_cmd -> this file).
#
# Why it exists: on this machine the watcher's `powershell -NoProfile -File
# code/local_check.ps1` chain produced EMPTY check logs with exit 0 and no side
# effects at all (every results/status/check_rN_*.txt is two lines), i.e. the
# child PowerShell never really ran the script. This entry needs no PowerShell:
# the watcher runs `bash code/local_check.sh`, which is a plain native command.
#
# Order and semantics:
#   1. drain the local-runner queue (local-runs/jobs/) - writes its own evidence
#      to local-runs/drain-last.json + local-runs/results/<jobId>/
#   2. run the repo gate (code/check_all.sh)
#   3. exit non-zero if EITHER failed (the watcher turns that into a failed
#      handshake, which is exactly what a failed job must do)
#
# ASCII-only on purpose; keep it that way.

set -u
cd "$(dirname "$0")/.."   # repo root (this file lives in code/)

code=0

# 1. local-runner queue
if [ -f code/local-runner.mjs ]; then
    if command -v node >/dev/null 2>&1; then
        node code/local-runner.mjs --drain-once || code=1
    else
        echo "[FAIL] node not found on PATH - a queued job cannot run"
        code=1
    fi
else
    echo "[FAIL] code/local-runner.mjs is missing - stale checkout?"
    code=1
fi

# 2. the gate (.ps1 ASCII + branch guard + script consistency)
if [ -f code/check_all.sh ]; then
    bash code/check_all.sh || code=1
else
    echo "[FAIL] code/check_all.sh is missing"
    code=1
fi

# 3. summary line - short, greppable, and it lands in the tracked drain log too
if [ "$code" -eq 0 ]; then
    echo "== local checks passed (local-runner + gate)"
else
    echo "== local checks FAILED (see local-runs/drain-last.json and local-runs/results/)"
fi

exit $code
