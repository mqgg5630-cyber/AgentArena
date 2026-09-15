# watch.ps1 - the local half of the auto-verification handshake.
#
# Registers a Windows scheduled task that polls the remote branch every N
# minutes. When the agent requests a check (arena_state=awaiting_check,
# local_state=pending in the handshake file), the watcher automatically:
#     sync -> run the local check (check_cmd) -> write the log ->
#     push the verdict (passed/failed) back to the branch.
# The agent then reads the verdict with agent-check.sh --read and either
# accepts (loop ends) or fixes and requests another round.
#
# Usage (inside the repo folder):
#     .\watch.ps1 -Register              # once per machine: create the task
#     .\watch.ps1 -Register -Interval 10 # poll every 10 minutes instead of 5
#     .\watch.ps1                        # one manual poll right now
#     .\watch.ps1 -Unregister            # remove the scheduled task
#
# The task runs as the current user "only when logged on" and reuses the git
# credentials Windows already has (the ones push.ps1 uses).
#
# ASCII-only on purpose (Windows PowerShell 5.1 decodes .ps1 as ANSI/GBK).

param(
    [int]$Interval = 2,
    [string]$Config = '',
    [switch]$Register,
    [switch]$Unregister
)

$ErrorActionPreference = 'Continue'

# repo root = walk up from this script until .git appears, so the script also
# works when run straight from skills\git-sync\scripts\
$repo = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
while ($repo -and -not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    $up = Split-Path -Parent $repo
    if (-not $up -or $up -eq $repo) { break }
    $repo = $up
}
Set-Location -LiteralPath $repo

# ------------------------------------------------------------------- config
if ($Config -and -not (Test-Path -LiteralPath $Config)) {
    Write-Host "[ERROR] config not found: $Config" -ForegroundColor Red
    exit 1
}
$cfgPath = @()
if ($Config) { $cfgPath += $Config }
if ($env:GIT_SYNC_PROFILE) {
    $prof = 'sync.config.' + $env:GIT_SYNC_PROFILE + '.json'
    $cfgPath += @(
        (Join-Path $repo ('skills\git-sync\' + $prof)),
        (Join-Path $repo $prof),
        (Join-Path $PSScriptRoot $prof)
    )
}
$cfgPath += @(
    (Join-Path $repo 'skills\git-sync\sync.config.json'),
    (Join-Path $PSScriptRoot 'sync.config.json')
)
$cfgPath = $cfgPath | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

$Branch = ''; $Remote = 'origin'
$Handshake = 'results/status/handshake.json'
$CheckCmd  = 'powershell -NoProfile -ExecutionPolicy Bypass -File code/local_check.ps1'
if ($cfgPath) {
    $cfg = Get-Content -LiteralPath $cfgPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($cfg.branch) { $Branch = [string]$cfg.branch }
    if ($cfg.remote) { $Remote = [string]$cfg.remote }
    if ($cfg.handshake) { $Handshake = [string]$cfg.handshake }
    if ($cfg.check_cmd) { $CheckCmd = [string]$cfg.check_cmd }
}
if (-not $Branch) { $Branch = (git rev-parse --abbrev-ref HEAD).Trim() }

$taskName = 'git-sync-watch-' + (Split-Path -Leaf $repo)

# ------------------------------------------------------------ register task
if ($Register -or $Unregister) {
    if ($Unregister) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        if ($?) { Write-Host "== removed scheduled task: $taskName" -ForegroundColor Green }
        else { schtasks /Delete /TN $taskName /F 2>$null; Write-Host "== removed (schtasks): $taskName" }
        exit 0
    }
    $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $PSCommandPath
    try {
        $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
                    -RepetitionInterval (New-TimeSpan -Minutes $Interval) `
                    -RepetitionDuration (New-TimeSpan -Days 3650)
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null
        Write-Host "== scheduled task registered: $taskName (every $Interval min)" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Register-ScheduledTask failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "        trying schtasks.exe instead ..." -ForegroundColor Yellow
        schtasks /Create /F /TN $taskName /SC MINUTE /MO $Interval /TR "powershell.exe $arg"
        if ($LASTEXITCODE -ne 0) { exit 1 }
    }
    Write-Host "== this watcher will now:"
    Write-Host "   poll $Remote/$Branch every $Interval minutes"
    Write-Host "   and run this check when the agent requests one:"
    Write-Host "     $CheckCmd"
    Write-Host "== remove any time with:  .\watch.ps1 -Unregister"
    exit 0
}

# ------------------------------------------------------------- single poll
$lock = Join-Path $env:TEMP ($taskName + '.lock')
if (Test-Path -LiteralPath $lock) {
    # a hard crash can leave the lock behind and stall the watcher forever -
    # a lock older than 30 minutes is stale: drop it and continue
    try {
        $lockAge = ((Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime).TotalMinutes
        if ($lockAge -gt 30) {
            Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
            Write-Output "stale lock removed (age: $([int]$lockAge) min)"
        } else { exit 0 }
    } catch { exit 0 }
}
Set-Content -LiteralPath $lock -Value (Get-Date).ToString('s')
try {
    git fetch $Remote --quiet 2>$null

    # read the handshake from the REMOTE tip - do not touch the worktree yet
    # (decode git output as UTF-8 so the Chinese note survives PS 5.1's GBK)
    $hsGit = $Handshake -replace '\\', '/'
    $prevEnc = [Console]::OutputEncoding
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    $raw = git show "$Remote/$Branch`:$hsGit" 2>$null
    try { [Console]::OutputEncoding = $prevEnc } catch { }
    if (-not $raw) { exit 0 }                        # no handshake yet
    $hs = (($raw -join "`n") | ConvertFrom-Json)
    if ($hs.arena_state -ne 'awaiting_check' -or $hs.local_state -ne 'pending') { exit 0 }

    $round = [int]$hs.round
    Write-Host ("== round {0}: the agent requested a local check - syncing ..." -f $round)

    # 1. sync (stash + pull; the same command the user runs by hand)
    $sync = Join-Path $repo 'sync.ps1'
    if (-not (Test-Path -LiteralPath $sync)) { $sync = Join-Path $PSScriptRoot 'sync.ps1' }
    $global:LASTEXITCODE = 0
    & $sync
    if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] sync failed - retrying next poll" -ForegroundColor Red; exit 1 }

    # 1b. re-read the handshake from the synced worktree (UTF-8, BOM-tolerant)
    $hsAbs = Join-Path $repo $hsGit
    $hs = Get-Content -LiteralPath $hsAbs -Encoding UTF8 -Raw | ConvertFrom-Json

    # 2. run the local check and capture everything to a log
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logRel = "results/status/check_r${round}_${stamp}.txt"
    $logAbs = Join-Path $repo ($logRel -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logAbs) | Out-Null
    Write-Host ("== running: {0}" -f $CheckCmd)
    $code = 1
    try {
        $out = Invoke-Expression $CheckCmd 2>&1
        $code = $LASTEXITCODE
        if (-not $? -and $code -eq 0) { $code = 1 }
    } catch {
        $out = $_.Exception.Message
        $code = 1
    }
    $verdict = if ($code -eq 0) { 'passed' } else { 'failed' }
    $text = @("check round $round on $env:COMPUTERNAME - $verdict (exit $code)", "cmd: $CheckCmd", "") + @($out)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($logAbs, ($text -join "`r`n"), $utf8)
    Write-Host ("== check {0} (log: {1})" -f $verdict, $logRel) -ForegroundColor $(if ($code -eq 0) { 'Green' } else { 'Red' })

    # 3. update the handshake (worktree) with the verdict - UTF-8 WITHOUT BOM
    #    (PS 5.1 Set-Content -Encoding UTF8 adds a BOM that breaks json.load
    #     on the agent side, so write the bytes explicitly)
    $hs.local_state  = $verdict
    $hs.local_updated = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $hs.host = $env:COMPUTERNAME
    $hsJson = $hs | ConvertTo-Json -Depth 6
    $utf8nb = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($hsAbs, $hsJson + "`r`n", $utf8nb)

    # 4. push the verdict back
    $push = Join-Path $repo 'push.ps1'
    if (-not (Test-Path -LiteralPath $push)) { $push = Join-Path $PSScriptRoot 'push.ps1' }
    & $push ("check: round {0} {1}" -f $round, $verdict)
} finally {
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
}
