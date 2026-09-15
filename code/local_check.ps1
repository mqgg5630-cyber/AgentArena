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

# 1b. local-runner queue (docs/local-runner-protocol.md): drain
#     local-runs/jobs/ when an agent session queued a job. With no queued job
#     this returns in well under a second and never affects normal checks.
#
#     This block is SELF-EVIDENCING on purpose: the watcher's own output
#     capture has been unreliable on some machines (check logs came back empty
#     with exit 0), so the drain result is ALSO written to the tracked file
#     results/status/local-runner-drain.txt. If that file is missing/stale the
#     hook never ran (stale checkout); if it exists it says exactly what the
#     runner saw. The body is driven by node (code/local-runner.mjs).
$drainerScript = '.\code\local-runner.mjs'
$drainLog      = '.\results\status\local-runner-drain.txt'
$nodeExe = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
$runnerFound = Test-Path -LiteralPath $drainerScript
$queueNames = @(Get-ChildItem -LiteralPath '.\local-runs\jobs' -Filter '*.job.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
$drainLines = @(
    "== local-runner hook  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "host  : $env:COMPUTERNAME",
    "cwd   : $(Get-Location).Path",
    "node  : $(if ($nodeExe) { $nodeExe } else { '(not found)' })",
    "runner: $drainerScript $(if ($runnerFound) { '(found)' } else { '(MISSING)' })",
    "queued: $($queueNames -join ', ')"
)
$drainCode = 0
if ($runnerFound -and $nodeExe) {
    $drainOut  = & $nodeExe $drainerScript --drain-once 2>&1
    $drainCode = $LASTEXITCODE
} elseif (-not $runnerFound) {
    $drainOut  = @('[FAIL] code/local-runner.mjs is missing - stale checkout?')
    $drainCode = 127
} else {
    $drainOut  = @('[FAIL] node not found on PATH - a queued job cannot run')
    $drainCode = 127
}
$drainText = $drainLines + @("exit: $drainCode", '') + @($drainOut | ForEach-Object { "$_" }) + @('')
try {
    $utf8nb = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path (Get-Location).Path 'results\status\local-runner-drain.txt'), ($drainText -join "`r`n"), $utf8nb)
} catch {
    Write-Output "[warn] could not write results/status/local-runner-drain.txt: $($_.Exception.Message)"
}
foreach ($line in $drainText) { Write-Output $line }
if ($drainCode -ne 0) { Write-Output '[FAIL] local-runner: a queued job failed (see local-runs/results/)'; $fail = 1 }

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
