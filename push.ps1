# push.ps1 (skill version) - commit local changes and push them to the remote.
#
# Usage (inside the repo folder):
#     .\push.ps1                      # auto commit message
#     .\push.ps1 "add midterm files"  # custom commit message
#     .\push.ps1 -Branch other/branch
#     .\push.ps1 -Gate "msg"          # also run the repo gate before committing
#                                      # (needs bash - it ships with Git for Windows)
#
# Branch / remote come from sync.config.json when present. A safety guard
# refuses to push to main / master, so a stray edit can never move the shared
# branch.
#
# ASCII-only on purpose (Windows PowerShell 5.1 decodes .ps1 as ANSI/GBK).

param(
    [string]$Message = '',
    [string]$Branch  = '',
    [string]$Remote  = '',
    [string]$Config = '',
    [switch]$Gate
)

$ErrorActionPreference = 'Stop'

# repo root = walk up from this script until .git appears, so the script also
# works when run straight from skills\git-sync\scripts\
$repo = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
while ($repo -and -not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    $up = Split-Path -Parent $repo
    if (-not $up -or $up -eq $repo) { break }
    $repo = $up
}
Set-Location -LiteralPath $repo

if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    Write-Host "[ERROR] Not a git repository: $repo" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------- config
# resolution order: -Config <path> > profile file (sync.config.<PROFILE>.json,
# PROFILE from $env:GIT_SYNC_PROFILE) > skills\git-sync\sync.config.json >
# next to this script
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
if ($cfgPath) {
    $cfg = Get-Content -LiteralPath $cfgPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if (-not $Branch -and $cfg.branch) { $Branch = [string]$cfg.branch }
    if (-not $Remote -and $cfg.remote) { $Remote = [string]$cfg.remote }
}
if (-not $Remote) { $Remote = 'origin' }
if (-not $Branch) { $Branch = (git rev-parse --abbrev-ref HEAD).Trim() }

# -------------------------------------------------------------------- guard
if ($Branch -eq 'main' -or $Branch -eq 'master') {
    Write-Host "[REFUSED] pushing straight to $Branch is not allowed." -ForegroundColor Red
    Write-Host "          Set a working branch in skills\git-sync\sync.config.json" -ForegroundColor Yellow
    exit 1
}

# git refuses to commit without an identity; set a local one if missing
if (-not (git config user.name)) {
    git config user.name  'mqgg5630-cyber'
    git config user.email 'mqgg5630-cyber@users.noreply.github.com'
    Write-Host "== set a default git identity for this repo (change it with git config user.name)" -ForegroundColor Yellow
}

Write-Host "== repo  : $repo" -ForegroundColor Cyan
Write-Host "== branch: $Branch" -ForegroundColor Cyan

# Get the server side first so the push cannot be rejected as non-fast-forward
git fetch $Remote
git checkout $Branch
git pull --ff-only $Remote $Branch

git add -A
if (-not (git status --porcelain)) {
    Write-Host ""
    Write-Host "== nothing new to commit. done." -ForegroundColor Green
    exit 0
}

# optional: run the repo gate before committing, so a broken change (e.g. a
# .ps1 with non-ASCII bytes) can never reach the remote from this side either
if ($Gate) {
    $gateCmd = ''
    if ($cfgPath -and $cfg -and $cfg.gate) { $gateCmd = [string]$cfg.gate }
    if (-not $gateCmd) { $gateCmd = 'bash code/check_all.sh' }
    if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
        Write-Host "[ERROR] -Gate needs bash on PATH (it ships with Git for Windows)" -ForegroundColor Red
        exit 1
    }
    Write-Host "== gate: $gateCmd" -ForegroundColor Cyan
    bash -c $gateCmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[GATE FAILED] nothing was committed. Fix the checks first (or drop -Gate to skip)." -ForegroundColor Red
        exit 1
    }
}

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "sync: local update " + (Get-Date -Format 'yyyy-MM-dd HH:mm')
}

Write-Host ""
Write-Host "== files to be committed:" -ForegroundColor Cyan
git status --short

git commit -m $Message
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] commit failed." -ForegroundColor Red; exit 1 }

git push $Remote $Branch
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] push failed." -ForegroundColor Red
    Write-Host "  * If it asks for a password: GitHub needs a token, not your password." -ForegroundColor Yellow
    Write-Host "    Install/run GitHub Desktop or 'gh auth login', then push again." -ForegroundColor Yellow
    Write-Host "  * If it says 'rejected': the remote branch moved. Run .\sync.ps1 first." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "== pushed to $Branch :" -ForegroundColor Green
git log -1 --oneline --decorate
