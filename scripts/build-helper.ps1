# Builds helper/SqlWayfarerSspi.exe (Windows integrated authentication) with
# the C# compiler that ships with the .NET Framework: nothing to install.
# That compiler only speaks C# 5, which the source is written in.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe (.NET Framework 4) not found.' }

$source = Join-Path $root 'helper\SqlWayfarerSspi.cs'
$output = Join-Path $root 'helper\SqlWayfarerSspi.exe'

& $csc /nologo /target:exe /platform:anycpu /optimize+ "/out:$output" `
    /r:System.dll /r:System.Core.dll /r:System.Data.dll /r:System.Web.Extensions.dll $source
if ($LASTEXITCODE -ne 0) { throw 'Building the helper failed.' }
Write-Host "Built $output"
