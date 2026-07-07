param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump = 'patch'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pkgFile = Join-Path $root 'package.json'
$versionFile = Join-Path $root 'version.json'
$vsce = "$env:APPDATA\npm\vsce.cmd"

function Fail($msg) { Write-Error $msg; exit 1 }

# version.json is the source of truth. Edit it manually to jump (e.g. to 0.9.0):
# if it differs from package.json we publish that version as-is (no bump),
# otherwise we bump it per $Bump.
$pkgVersion = (Get-Content $pkgFile -Raw | ConvertFrom-Json).version
if (Test-Path $versionFile) {
    $currentVersion = (Get-Content $versionFile -Raw | ConvertFrom-Json).version
} else {
    $currentVersion = $pkgVersion
}

if ($currentVersion -ne $pkgVersion) {
    # version.json was edited manually -> use it as-is
    $newVersion = $currentVersion
    Write-Host "Using manual version from version.json: $newVersion (no bump)"
} else {
    # version.json untouched -> bump it
    $parts = $currentVersion -split '\.'
    switch ($Bump) {
        'major' { $parts[0] = [int]$parts[0] + 1; $parts[1] = 0; $parts[2] = 0 }
        'minor' { $parts[1] = [int]$parts[1] + 1; $parts[2] = 0 }
        'patch' { $parts[2] = [int]$parts[2] + 1 }
    }
    $newVersion = $parts -join '.'
    Write-Host "Bumping version: $currentVersion -> $newVersion"
}

# Write version.json
[System.IO.File]::WriteAllText($versionFile, "{`n  `"version`": `"$newVersion`"`n}`n", [System.Text.UTF8Encoding]::new($false))

# Write package.json (replace current on-disk version)
$content = Get-Content $pkgFile -Raw
$content = $content -replace "`"version`": `"$pkgVersion`"", "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($pkgFile, $content, [System.Text.UTF8Encoding]::new($false))

# Build
Write-Host "Building..."
& npm run build
if (-not $?) { Fail "Build failed" }

# Publish
Write-Host "Publishing v$newVersion..."
& $vsce publish
if (-not $?) { Fail "Publish failed" }

# Commit
Write-Host "Committing v$newVersion..."
& (Join-Path $root 'commit.ps1')
if (-not $?) { Fail "Commit failed" }

Write-Host "Published and committed v$newVersion successfully."
