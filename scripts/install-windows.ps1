# One-line Windows installer for Akeru Bot (x64).
#
#   $t = (Invoke-RestMethod https://api.github.com/repos/opencoredev/akeru-bot/releases/latest -ErrorAction Stop).tag_name; if ($t -match '^v\d+\.\d+\.\d+$') { $f = Join-Path $env:TEMP $("akeru-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-windows.ps1" -OutFile $f -ErrorAction Stop; try { & $f -Tag $t } finally { Remove-Item $f } } else { throw "Could not resolve the latest Akeru Bot release." }
#   install-windows.ps1 -Tag v1.2.3
#
# Downloads the GitHub exe for the latest stable tag (or -Tag), checks
# SHA256SUMS, unblocks the file, then runs the self-installer.
param(
  [string]$Tag = '',
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Write-Output 'usage: install-windows.ps1 [-Tag vX.Y.Z]'
  exit 0
}

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw "install-windows.ps1: Windows x64 (AMD64) only; detected '$($env:PROCESSOR_ARCHITECTURE)'. ARM64 and x86 are not supported."
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if (-not $Tag) {
  $Tag = (Invoke-RestMethod -Uri 'https://api.github.com/repos/opencoredev/akeru-bot/releases/latest').tag_name
}
if (-not $Tag) {
  throw 'install-windows.ps1: could not resolve a release tag.'
}
if ($Tag -notmatch '^v\d+\.\d+\.\d+$') {
  throw "install-windows.ps1: invalid tag '$Tag'. Expected vX.Y.Z."
}

$version = $Tag.Substring(1)
Write-Output "Installing Akeru Bot $Tag for Windows (x64)..."

$asset = "Akeru-Bot-$version-x64.exe"
$base = "https://github.com/opencoredev/akeru-bot/releases/download/$Tag"
$installerPath = Join-Path $env:TEMP $asset
$checksumPath = Join-Path $env:TEMP 'SHA256SUMS'
Invoke-WebRequest -Uri "$base/$asset" -OutFile $installerPath
Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $checksumPath

Write-Output 'Verifying checksum...'
$entries = @(Select-String -Path $checksumPath -Pattern ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($asset) + '$'))
if ($entries.Count -ne 1) {
  throw "install-windows.ps1: SHA256SUMS must contain exactly one entry for '$asset'."
}
$expected = ($entries[0].Line -split '\s+')[0]
$actual = (Get-FileHash -Path $installerPath -Algorithm SHA256).Hash
if ($actual -ne $expected) {
  throw "install-windows.ps1: checksum mismatch for '$asset'."
}

Unblock-File -Path $installerPath

Write-Output 'Installing...'
$proc = Start-Process -FilePath $installerPath -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  throw "install-windows.ps1: installer exited with code $($proc.ExitCode)."
}
Write-Output "Installed Akeru Bot $Tag."
