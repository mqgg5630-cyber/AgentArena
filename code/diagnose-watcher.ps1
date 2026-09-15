# diagnose-watcher.ps1 - one-shot forensics for the auto-verification loop.
#
# Run it (from the repo root) whenever a round says "passed" but nothing seems
# to have happened, or whenever a queued local-runner job is not consumed:
#
#     .\sync.ps1
#     .\code\diagnose-watcher.ps1
#     .\code\drain-and-push.ps1 "results: probe run + watcher diagnostics"
#
# It writes results/status/diagnose-watcher.txt (tracked, ASCII) with:
#   - git HEAD / branch / status / stash list
#   - the EFFECTIVE check_cmd read exactly like watch.ps1 reads it
#   - availability of bash / node / pnpm under this console
#   - whether the local-runner files are present
#   - the real drain output (node code/local-runner.mjs --drain-once)
#   - a replay of watch.ps1's Invoke-Expression capture, to expose silent no-ops
#
# ASCII-only (Windows PowerShell 5.1 / GBK). Exit 0 always - it only reports.

$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$text) { $lines.Add($text) }

Add-Line "== diagnose-watcher  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Add-Line "host : $env:COMPUTERNAME"
Add-Line "cwd  : $(Get-Location).Path"
Add-Line ""

# --- git state
Add-Line "## git"
Add-Line ("HEAD   : " + ((git rev-parse --short HEAD) -join ' '))
Add-Line ("branch : " + ((git rev-parse --abbrev-ref HEAD) -join ' '))
Add-Line ("status : " + (((git status --porcelain) -join '; ')))
$stash = @(git stash list)
Add-Line ("stash  : " + $(if ($stash.Count) { $stash -join ' | ' } else { '(empty)' }))
Add-Line ""

# --- tool availability (this is the console's PATH, not the task's)
Add-Line "## tools (this console)"
foreach ($t in @('bash', 'node', 'pnpm', 'git')) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if ($c) { Add-Line ("{0,-5}: {1}" -f $t, $c.Source) } else { Add-Line ("{0,-5}: (not found)" -f $t) }
}
Add-Line ""

# --- which config watch.ps1 would read, and what check_cmd it carries
Add-Line "## config (resolved the way watch.ps1 does)"
$repo = (Get-Location).Path
$cfgCandidates = @(
    (Join-Path $repo 'skills\git-sync\sync.config.json'),
    (Join-Path $PSScriptRoot 'sync.config.json'),
    (Join-Path $repo 'sync.config.json')
)
foreach ($cand in $cfgCandidates) {
    if (Test-Path -LiteralPath $cand) {
        Add-Line "found  : $cand"
        try {
            $cfg = Get-Content -LiteralPath $cand -Encoding UTF8 -Raw | ConvertFrom-Json
            Add-Line ("branch    : " + $cfg.branch)
            Add-Line ("check_cmd : " + $cfg.check_cmd)
        } catch { Add-Line "  (parse failed: $($_.Exception.Message))" }
        break
    }
}
Add-Line ""

# --- local-runner files
Add-Line "## local-runner files"
foreach ($f in @('code\local_check.sh', 'code\local_check.ps1', 'code\local-runner.mjs', 'code\local-runner.ps1', 'code\drain-and-push.ps1')) {
    Add-Line ("{0,-28}: {1}" -f $f, $(if (Test-Path -LiteralPath $f) { 'present' } else { 'MISSING' }))
}
$queued = @(Get-ChildItem -LiteralPath '.\local-runs\jobs' -Filter '*.job.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
Add-Line ("queued jobs : " + $(if ($queued.Count) { $queued -join ', ' } else { '(none)' }))
Add-Line ("drain evidence file : " + $(if (Test-Path '.\results\status\local-runner-drain.txt') { 'present' } else { 'MISSING' }))
Add-Line ("drain-last.json     : " + $(if (Test-Path '.\local-runs\drain-last.json') { 'present' } else { 'MISSING' }))
Add-Line ""

# --- real drain (this actually consumes the queue if a job is ready)
Add-Line "## drain (node code/local-runner.mjs --drain-once)"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path '.\code\local-runner.mjs')) {
    $drainOut = & $node.Source '.\code\local-runner.mjs' '--drain-once' 2>&1
    Add-Line ("exit: $LASTEXITCODE")
    foreach ($l in @($drainOut)) { Add-Line "  $l" }
} else {
    Add-Line "skipped: node or code/local-runner.mjs unavailable"
}
Add-Line ""

# --- replay of what watch.ps1 does with check_cmd (silent no-op detector)
Add-Line "## replay: Invoke-Expression <check_cmd> (same capture watch.ps1 uses)"
if ($cfg -and $cfg.check_cmd) {
    $t0 = Get-Date
    $code = 1
    try {
        $out = Invoke-Expression ([string]$cfg.check_cmd) 2>&1
        $code = $LASTEXITCODE
        if (-not $? -and $code -eq 0) { $code = 1 }
    } catch {
        $out = $_.Exception.Message
        $code = 1
    }
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    $outLines = @($out | Where-Object { "$_" -match '\S' })
    Add-Line ("exit: $code   elapsed: ${secs}s   non-empty output lines: " + $outLines.Count)
    if ($outLines.Count -eq 0) { Add-Line '  (EMPTY capture - if elapsed is ~0s the command never really ran)' }
    foreach ($l in $outLines) { Add-Line "  $l" }
} else {
    Add-Line "skipped: no check_cmd resolved"
}

$target = Join-Path (Get-Location).Path 'results\status\diagnose-watcher.txt'
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($target, ($lines -join "`r`n") + "`r`n", $utf8)
    Write-Output "== wrote results/status/diagnose-watcher.txt"
} catch {
    Write-Output "[FAIL] could not write $target : $($_.Exception.Message)"
    exit 1
}
foreach ($l in $lines) { Write-Output $l }
exit 0
