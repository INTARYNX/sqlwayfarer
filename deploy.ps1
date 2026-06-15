param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump = 'patch'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pkgFile = Join-Path $root 'package.json'
$vsce = "$env:APPDATA\npm\vsce.cmd"

function Fail($msg) { Write-Error $msg; exit 1 }

# Bump version in package.json
$pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
$parts = $pkg.version -split '\.'
switch ($Bump) {
    'major' { $parts[0] = [int]$parts[0] + 1; $parts[1] = 0; $parts[2] = 0 }
    'minor' { $parts[1] = [int]$parts[1] + 1; $parts[2] = 0 }
    'patch' { $parts[2] = [int]$parts[2] + 1 }
}
$newVersion = $parts -join '.'
Write-Host "Bumping version: $($pkg.version) -> $newVersion"

$content = Get-Content $pkgFile -Raw
$content = $content -replace "`"version`": `"$($pkg.version)`"", "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($pkgFile, $content, [System.Text.UTF8Encoding]::new($false))

# Build
Write-Host "Building..."
& npm run build
if (-not $?) { Fail "Build failed" }

# Publish
Write-Host "Publishing v$newVersion..."
& $vsce publish
if (-not $?) { Fail "Publish failed" }

Write-Host "Published v$newVersion successfully."
