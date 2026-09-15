# drain-and-push.ps1 - the ONE manual command for the local-runner queue.
#
# Use it when you do not want to wait for the watcher (or when the watcher's
# check chain is suspect): it drains local-runs/jobs/ once and, if anything
# changed, commits and pushes the results back to the branch.
#
#   .\code\drain-and-push.ps1                 # drain + commit + push if dirty
#   .\code\drain-and-push.ps1 -Message "..."  # custom commit message
#   .\code\drain-and-push.ps1 -NoPush         # drain only, do not push
#
# ASCII-only (Windows PowerShell 5.1 / GBK). Exit codes: 0 fine, 1 a job
# failed, 127 node or the runner is missing.

param(
    [string]$Message = 'results: local-runner drain',
    [switch]$NoPush
)

$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')     # repo root

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Output '[FAIL] node not found on PATH'; exit 127 }

$runner = Join-Path $PSScriptRoot 'local-runner.mjs'
if (-not (Test-Path -LiteralPath $runner)) { Write-Output "[FAIL] missing $runner"; exit 127 }

& $node.Source $runner --drain-once
$code = $LASTEXITCODE

if ($NoPush) { exit $code }

$dirty = git status --porcelain
if (-not $dirty) {
    Write-Output '== nothing to commit (queue was empty)'
    exit $code
}

# push.ps1 refuses to run on main/master and does pull --ff-only first
$push = Join-Path $PSScriptRoot '..\push.ps1'
if (Test-Path -LiteralPath $push) {
    & $push $Message
    if ($LASTEXITCODE -ne 0) { Write-Output "[WARN] push.ps1 exited $LASTEXITCODE - commit the results by hand" }
} else {
    Write-Output "[WARN] push.ps1 not found - run .\push.ps1 ""$Message"" yourself"
}

exit $code
