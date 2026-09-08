# Run with Windows PowerShell 5.1; no network, installer process, or Pester is needed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installerScript = Join-Path $PSScriptRoot 'install-windows.ps1'
$header = Get-Content -LiteralPath $installerScript | Where-Object { $_ -like '#   $t = *' }
if (@($header).Count -ne 1) { throw 'Expected one bootstrap command in the installer header.' }
$bootstrap = $header.Substring(4)
$scratch = Join-Path ([IO.Path]::GetTempPath()) "akeru-windows-tests-$([Guid]::NewGuid())"
$originalTemp = $env:TEMP
$originalArchitecture = $env:PROCESSOR_ARCHITECTURE
$null = New-Item -ItemType Directory -Path $scratch
$testState = @{
  downloadDirectories = @()
  requests = @()
  installerFile = ''
  scenario = ''
  unblocked = $false
  started = $false
  lockedFile = $null
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Empty {
  param([string]$Path)
  Assert-True (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) "Temporary files remain in $Path"
}

# These mocks are visible only to installer invocations in this test process.
function Invoke-RestMethod {
  throw 'Unexpected release lookup: tests supply an explicit tag.'
}

function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  Assert-True $UseBasicParsing 'Downloads must avoid Internet Explorer parsing.'
  $directory = Split-Path -Parent $OutFile
  Assert-True ((Split-Path -Parent $directory) -eq $env:TEMP) 'Download escaped the private TEMP directory.'
  Assert-True (Test-Path -LiteralPath $directory -PathType Container) 'Download directory does not exist.'
  $testState.requests += $Uri
  if ($Uri -eq 'https://github.com/opencoredev/akeru-bot/releases/download/v1.2.3/Akeru-Bot-1.2.3-x64.exe') {
    $testState.downloadDirectories += $directory
    $testState.installerFile = $OutFile
    [IO.File]::WriteAllText($OutFile, 'Harmless installer fixture, never executed.')
    if ($testState.scenario -eq 'exe-download') { throw 'fixture exe download failed' }
    return
  }
  Assert-True ($Uri -eq 'https://github.com/opencoredev/akeru-bot/releases/download/v1.2.3/SHA256SUMS') "Unexpected URL: $Uri"
  Assert-True ($directory -eq (Split-Path -Parent $testState.installerFile)) 'Downloads used different directories.'
  $hash = (Get-FileHash -LiteralPath $testState.installerFile -Algorithm SHA256).Hash.ToLowerInvariant()
  $entry = "$hash *Akeru-Bot-1.2.3-x64.exe"
  switch ($testState.scenario) {
    'mismatch' { $entry = "$('0' * 64)  Akeru-Bot-1.2.3-x64.exe" }
    'missing' { $entry = "$hash  another.exe" }
    'duplicate' { $entry = "$entry`r`n$entry" }
  }
  [IO.File]::WriteAllText($OutFile, "$entry`r`n")
  if ($testState.scenario -eq 'checksum-download') { throw 'fixture checksum download failed' }
}

function Unblock-File {
  param([string]$Path)
  Assert-True ($Path -eq $testState.installerFile) 'Unblocked the wrong file.'
  Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) 'Installer disappeared before unblock.'
  $testState.unblocked = $true
  if ($testState.scenario -eq 'unblock') { throw 'fixture unblock failed' }
}

function Start-Process {
  param([string]$FilePath, [switch]$Wait, [switch]$PassThru)
  Assert-True ($FilePath -eq $testState.installerFile) 'Started the wrong file.'
  Assert-True ($Wait -and $PassThru -and $testState.unblocked) 'Installer must be unblocked and run with -Wait -PassThru.'
  $testState.started = $true
  if ($testState.scenario -eq 'launch') { throw 'fixture launch failed' }
  if ($testState.scenario -like 'cleanup-*') {
    $testState.lockedFile = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  }
  $code = 0
  if ($testState.scenario -in @('exit', 'cleanup-exit')) { $code = 37 }
  [pscustomobject]@{ ExitCode = $code }
}

function Test-Payload {
  param([string]$Scenario, [string]$ExpectedError = '', [bool]$Unblocked = $false, [bool]$Started = $false)
  $testState.scenario = $Scenario
  $testState.requests = @()
  $testState.installerFile = ''
  $testState.unblocked = $false
  $testState.started = $false
  $failure = $null
  $output = @()
  try { $output = @(& $installerScript -Tag v1.2.3) } catch { $failure = $_ }
  if ($Scenario -like 'cleanup-*') {
    Assert-True (Test-Path -LiteralPath $testState.installerFile) 'Fixture did not keep the installer locked during cleanup.'
    $testState.lockedFile.Dispose()
    $testState.lockedFile = $null
    Remove-Item -LiteralPath (Split-Path -Parent $testState.installerFile) -Recurse -Force
  }
  if ($ExpectedError) {
    Assert-True ($null -ne $failure) "$Scenario unexpectedly succeeded."
    Assert-True ($failure.Exception.Message.Contains($ExpectedError)) "$Scenario failed for the wrong reason: $failure"
  } else {
    Assert-True ($null -eq $failure) "$Scenario failed: $failure"
    Assert-True ($output -contains 'Installed Akeru Bot v1.2.3.') 'Success message missing.'
  }
  $requestCount = 2
  if ($Scenario -eq 'exe-download') { $requestCount = 1 }
  Assert-True ($testState.requests.Count -eq $requestCount) "$Scenario made unexpected downloads."
  Assert-True ($testState.unblocked -eq $Unblocked) "$Scenario had unexpected unblock behavior."
  Assert-True ($testState.started -eq $Started) "$Scenario had unexpected launch behavior."
  Assert-Empty $env:TEMP
  Write-Output "PASS payload: $Scenario"
}

function Test-Bootstrap {
  param([string]$Scenario, [int]$FixtureExit = 0)
  $caseDirectory = Join-Path $scratch "bootstrap-$Scenario"
  $tempDirectory = Join-Path $caseDirectory 'temp'
  $null = New-Item -ItemType Directory -Path $tempDirectory -Force
  $fixture = @'
param([string]$Tag)
$ErrorActionPreference = 'Stop'
if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') { throw 'Fixture did not run under Bypass.' }
if ($Tag -ne 'v1.2.3') { throw 'Bootstrap did not forward the release tag.' }
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $env:TEMP) 'executed'), $PSCommandPath)
exit __EXIT__
'@
  $fixture = $fixture.Replace('__EXIT__', [string]$FixtureExit)
  $child = @'
$ErrorActionPreference = 'Stop'
$env:TEMP = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__TEMP__'))
$caseDirectory = Split-Path -Parent $env:TEMP
try {
  if ((Get-ExecutionPolicy -Scope Process) -ne 'Restricted') { throw 'Bootstrap parent must be Restricted.' }
  function Invoke-RestMethod {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Uri)
    if ($Uri -ne 'https://api.github.com/repos/opencoredev/akeru-bot/releases/latest') { throw 'Unexpected release URL.' }
    [pscustomobject]@{ tag_name = 'v1.2.3' }
  }
  function Invoke-WebRequest {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    if (-not $UseBasicParsing) { throw 'Bootstrap must avoid Internet Explorer parsing.' }
    if ($Uri -ne 'https://raw.githubusercontent.com/opencoredev/akeru-bot/v1.2.3/scripts/install-windows.ps1') { throw 'Unexpected script URL.' }
    if ((Split-Path -Parent $OutFile) -ne $env:TEMP) { throw 'Bootstrap escaped private TEMP.' }
    [IO.File]::WriteAllText((Join-Path $caseDirectory 'download-path'), $OutFile)
    $fixture = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__FIXTURE__'))
    [IO.File]::WriteAllText($OutFile, $fixture)
    if ('__SCENARIO__' -eq 'download-failure') { throw 'fixture script download failed' }
  }
  $bootstrap = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__BOOTSTRAP__'))
  & ([scriptblock]::Create($bootstrap))
  exit 0
} catch {
  [IO.File]::WriteAllText((Join-Path $caseDirectory 'failure'), $_.Exception.Message)
  exit 1
}
'@
  $child = $child.Replace('__TEMP__', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($tempDirectory)))
  $child = $child.Replace('__FIXTURE__', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($fixture)))
  $child = $child.Replace('__BOOTSTRAP__', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap)))
  $child = $child.Replace('__SCENARIO__', $Scenario)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
  # Inline commands can run under Restricted; a downloaded script still needs the child Bypass.
  $command = "& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$encoded'))))"
  & "$PSHOME\powershell.exe" -NoProfile -ExecutionPolicy Restricted -Command $command
  $exitCode = $LASTEXITCODE
  $failurePath = Join-Path $caseDirectory 'failure'
  $failure = ''
  if (Test-Path -LiteralPath $failurePath) { $failure = [IO.File]::ReadAllText($failurePath) }
  if ($Scenario -eq 'download-failure') {
    Assert-True ($exitCode -ne 0 -and $failure.Contains('fixture script download failed')) "Download failure was not propagated: $failure"
  } elseif ($FixtureExit -ne 0) {
    Assert-True ($exitCode -ne 0 -and $failure.Contains("installer failed with exit code $FixtureExit")) "Child failure was not propagated: $failure"
  } else {
    Assert-True ($exitCode -eq 0 -and -not $failure) "Bootstrap failed: $failure"
  }
  $downloadPath = [IO.File]::ReadAllText((Join-Path $caseDirectory 'download-path'))
  Assert-True ((Split-Path -Leaf $downloadPath) -match '^akeru-install-[0-9a-f-]{36}\.ps1$') 'Bootstrap did not use a GUID filename.'
  $executedPath = Join-Path $caseDirectory 'executed'
  if ($Scenario -eq 'download-failure') {
    Assert-True (-not (Test-Path -LiteralPath $executedPath)) 'Executed a failed script download.'
  } else {
    Assert-True ([IO.File]::ReadAllText($executedPath) -eq $downloadPath) 'The downloaded fixture did not execute.'
  }
  Assert-Empty $tempDirectory
  Write-Host "PASS bootstrap: $Scenario"
  return (Split-Path -Leaf $downloadPath)
}

try {
  $env:TEMP = Join-Path $scratch 'payload'
  $null = New-Item -ItemType Directory -Path $env:TEMP
  $env:PROCESSOR_ARCHITECTURE = 'AMD64'
  Test-Payload 'success' '' $true $true
  Test-Payload 'success-again' '' $true $true
  Test-Payload 'exe-download' 'fixture exe download failed'
  Test-Payload 'checksum-download' 'fixture checksum download failed'
  Test-Payload 'mismatch' 'checksum mismatch'
  Test-Payload 'missing' 'must contain exactly one entry'
  Test-Payload 'duplicate' 'must contain exactly one entry'
  Test-Payload 'unblock' 'fixture unblock failed' $true
  Test-Payload 'launch' 'fixture launch failed' $true $true
  Test-Payload 'exit' 'installer exited with code 37' $true $true
  Test-Payload 'cleanup-success' '' $true $true
  Test-Payload 'cleanup-exit' 'installer exited with code 37' $true $true
  Assert-True ($testState.downloadDirectories.Count -eq 12) 'Missing payload runs.'
  Assert-True (@($testState.downloadDirectories | Select-Object -Unique).Count -eq 12) 'Payload runs reused a temporary directory.'
  foreach ($directory in $testState.downloadDirectories) {
    Assert-True ((Split-Path -Leaf $directory) -match '^akeru-install-[0-9a-f-]{36}$') 'Payload did not use a GUID directory.'
  }
  $bootstrapPaths = @(
    Test-Bootstrap 'success'
    Test-Bootstrap 'success-again'
    Test-Bootstrap 'nonzero' 37
    Test-Bootstrap 'download-failure'
  )
  Assert-True ($bootstrapPaths.Count -eq 4 -and @($bootstrapPaths | Select-Object -Unique).Count -eq 4) 'Bootstrap runs reused a temporary filename.'
  Write-Output 'PASS all Windows installer behavioral tests'
} finally {
  if ($null -ne $testState.lockedFile) { $testState.lockedFile.Dispose() }
  $env:TEMP = $originalTemp
  $env:PROCESSOR_ARCHITECTURE = $originalArchitecture
  Remove-Item -LiteralPath $scratch -Recurse -Force
}
