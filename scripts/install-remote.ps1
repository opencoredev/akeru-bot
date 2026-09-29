#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Tag = $env:AKERU_VERSION,
  [switch]$NoTailscale,
  [switch]$NoAutoUpdate,
  [switch]$PrepareOnly,
  # SHA-256 from the signed release manifest, verified by the running server before an update.
  [string]$ExpectedSha256,
  [switch]$MigrateEnvironmentId
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repository = if ($env:AKERU_REMOTE_REPOSITORY) { $env:AKERU_REMOTE_REPOSITORY } else { "opencoredev/akeru-bot" }
if ($Repository -ne "opencoredev/akeru-bot" -and $env:AKERU_REMOTE_ALLOW_CUSTOM_REPOSITORY -ne "1") { throw "Custom release repositories require AKERU_REMOTE_ALLOW_CUSTOM_REPOSITORY=1." }

$InstallRoot = if ($env:AKERU_INSTALL_ROOT) { $env:AKERU_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Akeru\Remote" }
$BinDir = if ($env:AKERU_BIN_DIR) { $env:AKERU_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Akeru\bin" }
# Akeru state always lives in AKERU_HOME or ~/.akeru. The bundled server reads T3CODE_HOME, so it is
# derived here and never taken from an ambient T3 Code environment.
$RuntimeHome = if ($env:AKERU_HOME) { $env:AKERU_HOME } else { Join-Path $HOME ".akeru" }
$env:AKERU_HOME = $RuntimeHome
$env:T3CODE_HOME = $RuntimeHome
$IsAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $PrepareOnly -and -not $IsAdministrator) {
  if (-not $PSCommandPath) { throw "Save the installer to a file before running it so Windows can request administrator access." }
  $Forward = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath)
  if ($Tag) { $Forward += @("-Tag", $Tag) }
  if ($NoTailscale) { $Forward += "-NoTailscale" }
  if ($NoAutoUpdate) { $Forward += "-NoAutoUpdate" }
  if ($MigrateEnvironmentId) { $Forward += "-MigrateEnvironmentId" }
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $Forward -Wait -PassThru
  exit $process.ExitCode
}

$Release = if ($Tag) {
  Invoke-RestMethod -Headers @{ "User-Agent" = "Akeru-Remote-Installer" } "https://api.github.com/repos/$Repository/releases/tags/$Tag"
} else {
  Invoke-RestMethod -Headers @{ "User-Agent" = "Akeru-Remote-Installer" } "https://api.github.com/repos/$Repository/releases/latest"
}
$Tag = [string]$Release.tag_name
if ($Tag -notmatch '^v[0-9]') { throw "Could not resolve the latest Akeru release." }
$Version = $Tag.Substring(1)
# Releases publish Akeru Remote for Windows x64 only.
$Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { throw "Akeru Remote releases are not published for Windows arm64 yet. Use Docker or build from source." } elseif ([Environment]::Is64BitOperatingSystem) { "x64" } else { throw "Akeru Remote requires 64-bit Windows." }
$ArchiveName = "Akeru-Remote-$Version-win32-$Architecture.zip"
$Asset = $Release.assets | Where-Object name -eq $ArchiveName | Select-Object -First 1
if (-not $Asset) { throw "Release $Tag does not include $ArchiveName." }
if (([string]$Asset.digest) -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw "GitHub did not provide a SHA-256 digest for $ArchiveName." }
$ExpectedHash = $Matches[1].ToLowerInvariant()
$Temporary = Join-Path ([IO.Path]::GetTempPath()) ("akeru-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Temporary | Out-Null
try {
  $Archive = Join-Path $Temporary $ArchiveName
  Invoke-WebRequest -UseBasicParsing -Uri $Asset.browser_download_url -OutFile $Archive
  $ActualHash = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
  if ($ActualHash -ne $ExpectedHash) { throw "SHA-256 verification failed for $ArchiveName." }
  if ($ExpectedSha256 -and $ActualHash -ne $ExpectedSha256.ToLowerInvariant()) { throw "The archive does not match the signed release manifest for $ArchiveName." }
  $Expanded = Join-Path $Temporary "expanded"
  Expand-Archive -LiteralPath $Archive -DestinationPath $Expanded
  $Source = Join-Path $Expanded "akeru"
  if (-not (Test-Path (Join-Path $Source "akeru.cmd"))) { throw "The Akeru Remote archive is incomplete." }
  $Versions = Join-Path $InstallRoot "versions"
  $Target = Join-Path $Versions $Version
  New-Item -ItemType Directory -Force -Path $Versions, $BinDir | Out-Null
  if (-not (Test-Path $Target)) { Move-Item -LiteralPath $Source -Destination $Target }
  if ($PrepareOnly) { Write-Host "Prepared Akeru Remote $Version for a transactional service update."; exit 0 }

  New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeHome "userdata") | Out-Null
  if ($MigrateEnvironmentId) { $env:AKERU_REMOTE_ALLOW_IDENTITY_MIGRATION = "1" }
  & (Join-Path $Target "node\node.exe") (Join-Path $Target "initialize-remote-identity.cjs")
  if ($LASTEXITCODE -ne 0) { throw "Could not initialize the remote environment identity." }

  $Current = Join-Path $InstallRoot "current"
  $Previous = Join-Path $InstallRoot "previous"
  if (Test-Path $Current) {
    $oldTarget = (Get-Item $Current).Target
    Remove-Item $Previous -Force -ErrorAction SilentlyContinue
    if ($oldTarget) { New-Item -ItemType Junction -Path $Previous -Target $oldTarget | Out-Null }
    Remove-Item $Current -Force
  }
  New-Item -ItemType Junction -Path $Current -Target $Target | Out-Null
  $StableLauncher = "@echo off`r`ncall `"$Current\akeru.cmd`" %*`r`n"
  Set-Content -LiteralPath (Join-Path $BinDir "akeru.cmd") -Value $StableLauncher -Encoding Ascii
  if (($env:PATH -split ';') -notcontains $BinDir) { $env:PATH = "$BinDir;$env:PATH" }
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($UserPath -split ';') -notcontains $BinDir) { [Environment]::SetEnvironmentVariable("Path", (($UserPath.TrimEnd(';') + ";" + $BinDir).TrimStart(';')), "User") }
  Set-Content -LiteralPath (Join-Path $Target "REMOTE_MODE") -Value $(if ($NoTailscale) { "direct" } else { "tailscale" }) -Encoding Ascii

  $Tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
  if (-not $NoTailscale) {
    if (-not (Test-Path $Tailscale)) {
      $PackagePage = (Invoke-WebRequest -UseBasicParsing "https://pkgs.tailscale.com/stable/").Content
      $TailscaleArchitecture = if ($Architecture -eq "arm64") { "arm64" } else { "amd64" }
      $match = [regex]::Match($PackagePage, "tailscale-setup-([0-9.]+)-$TailscaleArchitecture\.msi")
      if (-not $match.Success) { throw "Could not resolve the current Tailscale Windows installer." }
      $MsiName = $match.Value
      $Msi = Join-Path $Temporary $MsiName
      Invoke-WebRequest -UseBasicParsing "https://pkgs.tailscale.com/stable/$MsiName" -OutFile $Msi
      $PublishedHash = ((Invoke-WebRequest -UseBasicParsing "https://pkgs.tailscale.com/stable/$MsiName.sha256").Content -split '\s+')[0].ToLowerInvariant()
      if ((Get-FileHash -Algorithm SHA256 $Msi).Hash.ToLowerInvariant() -ne $PublishedHash) { throw "Tailscale installer verification failed." }
      $msi = Start-Process msiexec.exe -ArgumentList @("/i", "`"$Msi`"", "/qn", "TS_UNATTENDEDMODE=always", "TS_INSTALLUPDATES=always") -Wait -PassThru
      if ($msi.ExitCode -notin @(0, 3010)) { throw "Tailscale installation failed with exit code $($msi.ExitCode)." }
    }
    & $Tailscale up --unattended=true
    if ($LASTEXITCODE -ne 0) { throw "Tailscale sign-in did not finish." }
    $env:AKERU_TAILSCALE_PATH = $Tailscale
    $env:T3CODE_TAILSCALE_SERVE = "true"
  }
  $Runtime = Join-Path $RuntimeHome "runtime"
  $Pinned = Join-Path $Runtime "versions\$Version"
  $StatePath = Join-Path $Runtime "service-state.json"
  if (Test-Path $StatePath) {
    $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if ($State.update.status -eq "pending") { throw "A service update is pending. Finish it before reinstalling." }
  }
  $TaskName = "Akeru Remote"
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName
  }
  New-Item -ItemType Directory -Force -Path $Runtime, (Join-Path $Runtime "versions"), (Join-Path $RuntimeHome "userdata\logs") | Out-Null
  if (-not (Test-Path $Pinned)) { Copy-Item -LiteralPath $Target -Destination $Pinned -Recurse }
  Set-Content -LiteralPath (Join-Path $Pinned ".install-complete") -Value $Version -Encoding Ascii
  Copy-Item -LiteralPath (Join-Path $Target "node_modules\akeru-bot\dist\service-launcher.mjs") -Destination $Runtime -Force
  $ServiceState = @{ protocol = 2; activeVersion = $Version } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($StatePath, "$ServiceState`n", [Text.UTF8Encoding]::new($false))
  function Quote-PowerShellLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
  $TaskEnvironment = @(
    "`$env:AKERU_HOME = $(Quote-PowerShellLiteral $RuntimeHome)",
    "`$env:T3CODE_HOME = $(Quote-PowerShellLiteral $RuntimeHome)",
    "`$env:AKERU_SERVICE_RUNTIME_ROOT = $(Quote-PowerShellLiteral $Target)",
    "`$env:AKERU_INSTALL_ROOT = $(Quote-PowerShellLiteral $InstallRoot)",
    "`$env:PATH = $(Quote-PowerShellLiteral $env:PATH)",
    "`$env:AKERU_TAILSCALE_PATH = $(Quote-PowerShellLiteral $Tailscale)",
    "`$env:T3CODE_TAILSCALE_SERVE = $(Quote-PowerShellLiteral $(if ($NoTailscale) { 'false' } else { 'true' }))"
  )
  $ServiceScript = Join-Path $Runtime "start-remote.ps1"
  $ServiceCommand = "& $(Quote-PowerShellLiteral (Join-Path $Target 'node\node.exe')) $(Quote-PowerShellLiteral (Join-Path $Runtime 'service-launcher.mjs')) *>> $(Quote-PowerShellLiteral (Join-Path $RuntimeHome 'userdata\logs\boot-service.log'))"
  Set-Content -LiteralPath $ServiceScript -Value ($TaskEnvironment + $ServiceCommand) -Encoding UTF8
  $PowerShell = Join-Path $PSHOME "powershell.exe"
  $Principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
  $ServiceAction = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ServiceScript`""
  $ServiceTrigger = New-ScheduledTaskTrigger -AtStartup
  $ServiceSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $ServiceAction -Trigger $ServiceTrigger -Settings $ServiceSettings -Principal $Principal -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  $RemoteEndpoint = $null
  if (-not $NoTailscale) {
    $Status = (& $Tailscale status --json | ConvertFrom-Json)
    $DnsName = [string]$Status.Self.DNSName
    if ($DnsName) { $RemoteEndpoint = "https://" + $DnsName.TrimEnd('.') }
  }
  $Healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      if ($RemoteEndpoint) { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $RemoteEndpoint | Out-Null; $Healthy = $true; break }
      $state = Get-Content (Join-Path $RuntimeHome "userdata\server-runtime.json") -Raw | ConvertFrom-Json
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$($state.port)/" | Out-Null; $Healthy = $true; break
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $Healthy) { throw "The Akeru service did not become healthy. Run `akeru remote doctor` for details." }
  if ($RemoteEndpoint) {
    $RuntimePort = (Get-Content (Join-Path $RuntimeHome "userdata\server-runtime.json") -Raw | ConvertFrom-Json).port
    $EnvironmentId = (Get-Content (Join-Path $RuntimeHome "userdata\environment-id") -Raw).Trim()
    $ServeRecord = @{ environmentId = $EnvironmentId; endpoint = $RemoteEndpoint; httpsPort = 443; proxyTarget = "http://127.0.0.1:$RuntimePort" } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $RuntimeHome "userdata\remote-serve.json"), "$ServeRecord`n", [Text.UTF8Encoding]::new($false))
  }
  if (-not $NoAutoUpdate) {
    $Launcher = Join-Path $BinDir "akeru.cmd"
    $UpdateScript = Join-Path $Runtime "update-remote.ps1"
    Set-Content -LiteralPath $UpdateScript -Value ($TaskEnvironment + "& $(Quote-PowerShellLiteral $Launcher) remote update" + 'exit $LASTEXITCODE') -Encoding UTF8
    $UpdateAction = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$UpdateScript`""
    $UpdateTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName "Akeru Remote Update" -Action $UpdateAction -Trigger $UpdateTrigger -Principal $Principal -Force | Out-Null
  }
  Write-Host "`nAkeru Remote $Version is installed."
  if ($RemoteEndpoint) { Write-Host "Direct URL: $RemoteEndpoint" }
  Write-Host "Diagnostics: akeru remote doctor"
} finally {
  Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
}
