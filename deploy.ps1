param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump = 'patch'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pkgFile = Join-Path $root 'package.json'

function Fail($msg) { Write-Error $msg; exit 1 }

# Check vsce is available
if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
    Fail "vsce not found. Run: npm install -g @vscode/vsce"
}

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

# Switch main to dist for packaging
$content = Get-Content $pkgFile -Raw
$content = $content -replace '"main": "./extension.js"', '"main": "./dist/extension.js"'
$content = $content -replace "`"version`": `"$($pkg.version)`"", "`"version`": `"$newVersion`""
Set-Content $pkgFile $content -Encoding utf8

try {
    # Build
    Write-Host "Building..."
    & npm run build
    if (-not $?) { Fail "Build failed" }

    # Publish
    Write-Host "Publishing v$newVersion..."
    & vsce publish
    if (-not $?) { Fail "Publish failed" }

    Write-Host "Published v$newVersion successfully."
} finally {
    # Always restore main to source for development
    $content = Get-Content $pkgFile -Raw
    $content = $content -replace '"main": "./dist/extension.js"', '"main": "./extension.js"'
    Set-Content $pkgFile $content -Encoding utf8
    Write-Host "Restored main to ./extension.js"
}
