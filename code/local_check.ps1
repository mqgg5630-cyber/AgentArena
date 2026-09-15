# local_check.ps1 (template) - the repo-specific checks that run on YOUR
# machine. watch.ps1 executes this whenever the agent requests a check
# (config key check_cmd), captures all output to
# results\status\check_rN_<stamp>.log and pushes the verdict back.
#
# Exit 0 = passed, anything else = failed. Edit freely - this file belongs to
# the repo, the installer only creates it when it is missing.
#
# Ideas for real checks (pick what fits the repo):
#   - deliverable files exist and have sane sizes
#   - open an Office file via COM to prove it is not corrupt
#   - python -c "import torch; assert torch.cuda.is_available()"  (GPU smoke test)
#   - run a script from code\ and compare its output
#
# ASCII-only on purpose (Windows PowerShell 5.1 decodes .ps1 as ANSI/GBK).

$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')   # repo root (this file lives in code\)

$fail = 0

# 1. the standard gate (.ps1 ASCII + branch guard + script consistency)
#    (forward slashes on purpose: this also runs under the scheduled task,
#     where bash may eat backslashes; Write-Output on purpose: the watcher
#     captures stdout, and PS 5.1 Write-Host bypasses it)
if (Test-Path -LiteralPath '.\code\check_all.sh') {
    bash code/check_all.sh
    if ($LASTEXITCODE -ne 0) { Write-Output '[FAIL] gate failed'; $fail = 1 }
}

# 2. AgentArena-specific checks (pnpm monorepo: packages/ + apps/ + tests/).
#    Enable the ones that fit; the heavier ones cost a few minutes.
#    Note: keep this file ASCII-only (Windows PowerShell 5.1 / GBK).
#
# 2a. the workspace must build and the unit tests must be green
# pnpm build
# if ($LASTEXITCODE -ne 0) { Write-Output '[FAIL] pnpm build'; $fail = 1 }
# pnpm test
# if ($LASTEXITCODE -ne 0) { Write-Output '[FAIL] pnpm test'; $fail = 1 }
#
# 2b. lint + typecheck (fast, no build output needed)
# pnpm lint
# if ($LASTEXITCODE -ne 0) { Write-Output '[FAIL] pnpm lint'; $fail = 1 }
# pnpm typecheck
# if ($LASTEXITCODE -ne 0) { Write-Output '[FAIL] pnpm typecheck'; $fail = 1 }
#
# 2c. the deliverable of a benchmark round (uncomment what the round produces):
# if (-not (Test-Path '.\results')) { Write-Output '[FAIL] results\ missing'; $fail = 1 }

# 3. add your own checks here ...

if ($fail -eq 0) { Write-Output '== local checks passed' }
exit $fail
