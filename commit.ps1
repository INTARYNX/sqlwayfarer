$ErrorActionPreference = 'Stop'

$date = Get-Date -Format 'yyyy-MM-dd'
$commitMsg = Read-Host "Commit message (Enter = $date)"
if ([string]::IsNullOrWhiteSpace($commitMsg)) { $commitMsg = $date }

& git add -A
if (-not $?) { throw "git add failed" }
& git commit -m $commitMsg
if (-not $?) { throw "git commit failed" }
