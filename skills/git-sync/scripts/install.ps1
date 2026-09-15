# install.ps1 - copy the sync toolkit into another repo and write its config.
#
# Usage (from anywhere):
#     .\install.ps1 -Target C:\MyProject
#     .\install.ps1 -Target C:\MyProject -Branch main -DownloadDir "C:\out"
#     .\install.ps1 -Target E:\0github\git-sync\zhongqi -Branch arena/01a09d79-zhongqi
#
# It installs into the target repo:
#     skills\git-sync\...        the complete skill (docs + scripts + templates)
#     sync.ps1 push.ps1 ...      the 8 user-side scripts at the repo root
#     sync.config.json           created, or KEPT when upgrading (only the
#                                branch moves; sets / upload_map / gate stay)
# and creates code\check_all.sh (the gate) when the target has none.
#
# The .ps1 files stay ASCII; only the JSON carries folder names.
#
# ASCII-only on purpose (Windows PowerShell 5.1 decodes .ps1 as ANSI/GBK).

param(
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Branch      = '',
    [string]$Remote      = 'origin',
    [string]$DownloadDir = ''
)

$ErrorActionPreference = 'Stop'

$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$src  = Resolve-Path (Join-Path $here '..').Path          # the skill folder

if (-not (Test-Path -LiteralPath $Target)) {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
}

Write-Host "source : $src"
Write-Host "target : $Target"

# 1. the complete skill folder
$skillDst = Join-Path $Target 'skills\git-sync'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $skillDst) | Out-Null
Copy-Item -Recurse -Force -LiteralPath $src -Destination $skillDst
Write-Host "  copied skills\git-sync (docs + scripts + templates)"

# 2. the user-side scripts at the repo root
$files = @('sync.ps1', 'push.ps1', 'upload.ps1', 'download.ps1',
           'doctor.ps1', 'pack.ps1', 'bootstrap.ps1', 'pr.ps1',
           'hardware.ps1', 'watch.ps1')
foreach ($f in $files) {
    $from = Join-Path $src ('scripts\' + $f)
    if (Test-Path -LiteralPath $from) {
        Copy-Item -Force -LiteralPath $from -Destination (Join-Path $Target $f)
        Write-Host "  copied $f"
    } else {
        Write-Host "  MISSING $f" -ForegroundColor Yellow
    }
}

# 3. the gate (only when the target repo has none of its own)
$gateSrc = Join-Path $src 'templates\check_all.sh'
$gateDst = Join-Path $Target 'code\check_all.sh'
if ((Test-Path -LiteralPath $gateSrc) -and -not (Test-Path -LiteralPath $gateDst)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Target 'code') | Out-Null
    Copy-Item -Force -LiteralPath $gateSrc -Destination $gateDst
    Write-Host "  created code\check_all.sh (gate)"
}

# 4. the config: create, or keep an existing one on upgrade
$cfgSrc = Join-Path $src 'sync.config.json'
$cfgDst = Join-Path $Target 'sync.config.json'
if (Test-Path -LiteralPath $cfgDst) {
    # upgrade: never throw away the target's sets / upload_map / gate
    $cfg = Get-Content -LiteralPath $cfgDst -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($Branch) { $cfg.branch = $Branch }
    if ($DownloadDir) { $cfg.download_dir = $DownloadDir }
    if (-not $cfg.PSObject.Properties.Match('receipt')) {
        $cfg | Add-Member -NotePropertyName receipt -NotePropertyValue 'results/sync/last_sync.md'
    }
    $cfg | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $cfgDst -Encoding UTF8
    Write-Host "  kept   sync.config.json (existing sets / map / gate kept, branch updated)"
} elseif (Test-Path -LiteralPath $cfgSrc) {
    $cfg = Get-Content -LiteralPath $cfgSrc -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($Branch)      { $cfg.branch = $Branch }
    if ($Remote)      { $cfg.remote = $Remote }
    if ($DownloadDir) { $cfg.download_dir = $DownloadDir }
    $cfg | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $cfgDst -Encoding UTF8
    Write-Host "  wrote  sync.config.json"
} else {
    Write-Host "  sync.config.json template missing - skipped" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "== next steps in $Target" -ForegroundColor Cyan
Write-Host "   .\bootstrap.ps1                 first-time setup (policy, identity, branch)"
Write-Host "   .\sync.ps1 / .\push.ps1         pull / commit+push"
Write-Host "   .\upload.ps1 / .\download.ps1   put attachments in / copy deliverables out"
Write-Host "   .\download.ps1 -List            show the download sets"
Write-Host "   .\doctor.ps1 (-Fix)             health check (and auto-fix)"
Write-Host "   .\pr.ps1                        open a PR to main (needs GitHub CLI)"
Write-Host "   edit sync.config.json to change the branch, sets or download folder"
