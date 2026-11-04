$ErrorActionPreference = 'Stop'

$date = Get-Date -Format 'yyyy-MM-dd'
$commitMsg = Read-Host "Commit message (Enter = $date)"
if ([string]::IsNullOrWhiteSpace($commitMsg)) { $commitMsg = $date }

# Everything is staged, except what looks like a secret: "git add -A" picks
# up whatever lies in the folder, and a .env or a key file must never end up
# in a commit that is pushed.
& git add -A -- . ':(exclude).env' ':(exclude).env.*' ':(exclude)*.pem' ':(exclude)*.key' ':(exclude)*.pfx' ':(exclude)*.p12'
if (-not $?) { throw "git add failed" }

# What is about to be committed is shown, so a file that should not be there
# is caught before it is pushed.
$staged = & git diff --cached --name-only
if ($staged) {
    Write-Host "Files to commit:"
    $staged | ForEach-Object { Write-Host "  $_" }
}

& git commit -m $commitMsg
if (-not $?) { throw "git commit failed" }
& git push
if (-not $?) { throw "git push failed" }
