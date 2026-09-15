# local-runner.ps1 - thin ASCII wrapper for code/local-runner.mjs
#
# The real executor is Node (code/local-runner.mjs) on purpose:
#   - it must be testable off-Windows (the agent sandbox has no pwsh);
#   - PowerShell 5.1 ConvertTo-Json collapses single-element arrays, which
#     would corrupt status.json artifacts/arrays;
#   - no BOM / GBK decoding traps for a file that handles JSON.
# This wrapper only locates node and forwards the arguments, so the documented
# entry point (code/local-runner.ps1) keeps working from the watcher and by hand.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\code\local-runner.ps1 -DrainOnce
#   .\code\local-runner.ps1 -DryRun                 # what would run
#   .\code\local-runner.ps1 -Job 20260915-001-capability-probe -Force
#   .\code\local-runner.ps1 -SelfTest
#
# Exit codes: 0 nothing to do / all selected jobs clean, 1 job failed,
# 2 usage, 3 internal, 127 node or executor missing.

param(
    [switch]$DrainOnce,
    [int]$MaxJobs = 0,
    [string]$Job = '',
    [switch]$Force,
    [switch]$DryRun,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Output '[FAIL] node not found on PATH - local-runner needs Node >= 22 (repo requirement)'
    exit 127
}

$executor = Join-Path $PSScriptRoot 'local-runner.mjs'
if (-not (Test-Path -LiteralPath $executor)) {
    Write-Output "[FAIL] missing $executor"
    exit 127
}

$nodeArgs = @($executor)
if ($MaxJobs -gt 0) { $nodeArgs += @('--max-jobs', "$MaxJobs") }
if ($Job) { $nodeArgs += @('--job', $Job) }
if ($Force) { $nodeArgs += '--force' }
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($SelfTest) { $nodeArgs += '--self-test' }
if ($DrainOnce) { $nodeArgs += '--drain-once' }

& $node.Source @nodeArgs
exit $LASTEXITCODE
