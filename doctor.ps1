# doctor.ps1 - one-shot health check (and optional auto-fix) for the local
# <-> Arena sync setup.
#
# Usage (inside the repo folder):
#     .\doctor.ps1             # report only
#     .\doctor.ps1 -Fix        # rebuild the fetch refspec, stash stray changes,
#                              # switch back to the configured branch and pull
#
# Prints: PowerShell / git versions, repo path, execution policy, branch vs the
# branch recorded in sync.config.json, remote URL, ahead/behind, uncommitted
# files, stash entries, LFS / big-file status and the last three commits.
# Run this first whenever "something does not sync".
#
# ASCII-only on purpose (Windows PowerShell 5.1 decodes .ps1 as ANSI/GBK).

param(
    [string]$Config = '',
    [switch]$Fix
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

function Line($label, $value, $color = 'Gray') {
    Write-Host ("{0,-14} {1}" -f $label, $value) -ForegroundColor $color
}

Write-Host "== environment" -ForegroundColor Cyan
Line 'PowerShell' $PSVersionTable.PSVersion.ToString()
Line 'git' ((git --version) 2>&1)
try { Line 'policy' (Get-ExecutionPolicy -Scope CurrentUser) } catch { Line 'policy' '(unknown)' 'Yellow' }
Line 'repo' $repo

if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    Write-Host "[ERROR] not a git repository - run this from the cloned folder" -ForegroundColor Red
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

$wantBranch = ''
$remoteName = 'origin'
if ($cfgPath) {
    $cfg = Get-Content -LiteralPath $cfgPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $wantBranch = [string]$cfg.branch
    if ($cfg.remote) { $remoteName = [string]$cfg.remote }
    Line 'config' $cfgPath
} else {
    Line 'config' '(missing - using the branch from git)' 'Yellow'
}

$verFile = Join-Path $repo 'skills\git-sync\VERSION'
if (Test-Path -LiteralPath $verFile) {
    Line 'skill' ("v" + (Get-Content -LiteralPath $verFile -Raw).Trim())
}

Write-Host ""
Write-Host "== git state" -ForegroundColor Cyan
git fetch $remoteName --quiet 2>$null

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Line 'branch' $branch
if ($wantBranch -and $branch -ne $wantBranch) {
    Line 'expected' ("$wantBranch   <-- run .\sync.ps1 (or .\doctor.ps1 -Fix)") 'Yellow'
}
Line 'remote' ((git remote get-url $remoteName) 2>&1)

# compare HEAD with the remote-tracking branch (origin/<branch>), not the
# local branch tip - comparing with the local tip made "behind" always 0
$upstream = "$remoteName/$wantBranch"
$ahead  = (git rev-list --count "$upstream..HEAD" 2>$null)
$behind = (git rev-list --count "HEAD..$upstream" 2>$null)
if ($wantBranch) {
    if ($ahead -and $ahead -ne '0') { Line 'ahead' "$ahead local commit(s) not on the remote" 'Yellow' }
    if ($behind -and $behind -ne '0') { Line 'behind' "$behind commit(s) on the remote - run .\sync.ps1" 'Yellow' }
    if ((-not $ahead -or $ahead -eq '0') -and (-not $behind -or $behind -eq '0')) { Line 'sync' 'in step with the remote' 'Green' }
}

$dirty = @(git status --porcelain)
Line 'uncommitted' ("$($dirty.Count) file(s)")
if ($dirty.Count -gt 0 -and $dirty.Count -le 10) { $dirty | ForEach-Object { Write-Host "               $_" } }
if ($dirty.Count -gt 10) { Write-Host ("               ... and {0} more" -f ($dirty.Count - 10)) }

$stash = @(git stash list)
Line 'stash' ("$($stash.Count) entr(y|ies)")
if ($stash.Count -gt 0) {
    Write-Host "               recover with: git stash pop   (or 'git stash drop' to throw away)" -ForegroundColor Yellow
}

# ----------------------------------------------------------- lfs / big files
Write-Host ""
Write-Host "== large files / lfs" -ForegroundColor Cyan
$lfsVer = (git lfs version) 2>$null
if ("$lfsVer" -match 'git-lfs') {
    Line 'lfs' (("$lfsVer").Split(' ')[0])
} else {
    Line 'lfs' 'not installed (optional - only needed for big files)' 'DarkGray'
}
$big = @(git ls-files | ForEach-Object {
    $p = Join-Path $repo $_
    if (Test-Path -LiteralPath $p) { Get-Item -LiteralPath $p -ErrorAction SilentlyContinue }
} | Where-Object { $_.Length -gt 50MB } | Select-Object -First 5)
if ($big.Count -gt 0) {
    foreach ($b in $big) {
        Line 'big file' ("{0}  ({1:N0} MB)  - consider Git LFS" -f $b.FullName.Substring($repo.Length + 1), ($b.Length / 1MB)) 'Yellow'
    }
} else {
    Line 'big file' 'none over 50 MB'
}

Write-Host ""
Write-Host "== last commits" -ForegroundColor Cyan
git log -3 --oneline --decorate

Write-Host ""
Write-Host "== next steps" -ForegroundColor Cyan
Write-Host "   .\sync.ps1                       pull the latest from the working branch"
Write-Host "   .\push.ps1 `"msg`"                commit + push local changes"
Write-Host "   .\download.ps1 -Set final        copy deliverables out of the repo"
Write-Host "   .\download.ps1 -Set final -Since 2026-09-14   only files changed since a date"
Write-Host "   .\pr.ps1                         open a PR from the working branch to main"

# ---------------------------------------------------------------------- fix
if ($Fix) {
    Write-Host ""
    Write-Host "== fixing" -ForegroundColor Cyan
    git config "remote.$remoteName.fetch" "+refs/heads/*:refs/remotes/$remoteName/*"
    Write-Host "   fetch refspec rebuilt for '$remoteName'"
    if (git status --porcelain) {
        git stash push -u -m ("doctor -Fix " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
        Write-Host "   uncommitted changes stashed  (recover: git stash pop)"
    }
    if ($wantBranch -and $branch -ne $wantBranch) {
        git checkout $wantBranch
        if ($LASTEXITCODE -eq 0) { Write-Host "   switched to $wantBranch" }
        else { Write-Host "   [ERROR] cannot check out $wantBranch" -ForegroundColor Red }
    } else {
        Write-Host "   already on the configured branch"
    }
    if ($wantBranch) {
        git pull --ff-only $remoteName $wantBranch
        if ($LASTEXITCODE -eq 0) { Write-Host "   pulled the latest" }
        else { Write-Host "   [ERROR] pull failed - see the message above" -ForegroundColor Red }
    }
} else {
    Write-Host ""
    Write-Host "tip: .\doctor.ps1 -Fix rebuilds the fetch refspec, stashes stray changes," -ForegroundColor DarkGray
    Write-Host "     switches back to the configured branch and pulls." -ForegroundColor DarkGray
}
