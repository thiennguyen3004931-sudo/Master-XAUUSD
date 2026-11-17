param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$BridgeEnv = "",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$ApiRunner = Join-Path $PSScriptRoot "run-phase7b-api-runtime-local.ps1"
if (-not (Test-Path -LiteralPath $ApiRunner)) { throw "Phase 7B API runtime launcher not found: $ApiRunner" }
$JobObjectHelper = Join-Path $PSScriptRoot "lib\phase7b-windows-job-object.ps1"
if (-not (Test-Path -LiteralPath $JobObjectHelper)) { throw "Phase 7B Job Object helper not found: $JobObjectHelper" }
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-source-attestation.ps1"
if (-not (Test-Path -LiteralPath $RuntimeSourceAttestationLibrary)) { throw "Phase7C runtime source attestation library not found: $RuntimeSourceAttestationLibrary" }
$WebSourceAttestationHelper = Join-Path $PSScriptRoot "lib\phase7b-web-source-attestation.ps1"
if (-not (Test-Path -LiteralPath $WebSourceAttestationHelper)) { throw "Phase7B Web source attestation helper not found: $WebSourceAttestationHelper" }
. $JobObjectHelper
. $RuntimeSourceAttestationLibrary
. $WebSourceAttestationHelper

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
}
if (-not (Test-Path $BridgeEnv)) { throw "Phase 7B WEB autostart bridge env missing: $BridgeEnv" }
$BridgeEnv = (Resolve-Path $BridgeEnv).Path

if ($ApiPort -lt 1024 -or $ApiPort -gt 65535) { throw "ApiPort is invalid." }
if ($WebPort -lt 1024 -or $WebPort -gt 65535) { throw "WebPort is invalid." }
if ($ApiPort -eq $WebPort) { throw "ApiPort and WebPort must be different." }
if ($StartupTimeoutSeconds -lt 30 -or $StartupTimeoutSeconds -gt 300) {
  throw "StartupTimeoutSeconds must be between 30 and 300."
}

$attestationRoot = Join-Path $WorkDir "phase7c-source-attestation"
$deploymentManifestPath = Join-Path $attestationRoot "deployment.json"
$webPidPath = Join-Path $attestationRoot "web.pid"
$webAttestationEnabled = Test-Path -LiteralPath $deploymentManifestPath -PathType Leaf
$webAttestationConfigIdentity = $null
if ($webAttestationEnabled) {
  $accountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
  if (-not (Test-Path -LiteralPath $accountStatePath -PathType Leaf)) {
    throw "Web runtime source attestation requires canonical account-mode state: $accountStatePath"
  }
  try {
    $accountState = Get-Content -LiteralPath $accountStatePath -Raw | ConvertFrom-Json
  } catch {
    throw "Web runtime source attestation account-mode state is invalid JSON: $accountStatePath. $($_.Exception.Message)"
  }
  if ([int]$accountState.version -ne 1) {
    throw "Web runtime source attestation requires account-mode state version 1."
  }
  $attestedAccountMode = ([string]$accountState.accountMode).Trim().ToUpperInvariant()
  if ($attestedAccountMode -notin @("DEMO", "LIVE")) {
    throw "Web runtime source attestation accountMode must be DEMO or LIVE. Actual=$attestedAccountMode"
  }
  $attestedLiveExecutionEnabled = [bool]$accountState.liveExecutionEnabled
  if (($attestedAccountMode -eq "LIVE") -ne $attestedLiveExecutionEnabled) {
    throw "Web runtime source attestation account/live-execution context is inconsistent."
  }
  $webAttestationConfigIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
    -RuntimeRoot $WorkDir `
    -AccountMode $attestedAccountMode `
    -LiveExecutionEnabled $attestedLiveExecutionEnabled `
    -ControlApiUrl "http://127.0.0.1:$ApiPort"
  Write-Host "PHASE7B_WEB_RUNTIME_SOURCE_ATTESTATION_CONTEXT=READY|ACCOUNT_MODE=$attestedAccountMode"
} else {
  Write-Host "PHASE7B_WEB_RUNTIME_SOURCE_ATTESTATION_CONTEXT=UNKNOWN|DEPLOYMENT_MANIFEST=MISSING"
}

$runtimeJob = New-Phase7BKillOnCloseJob -Name ("Phase7B-Web-{0}-{1}" -f $PID, [guid]::NewGuid().ToString('N'))
Add-Phase7BProcessToJob -Job $runtimeJob -ProcessId $PID
Write-Host "PHASE7B_WEB_JOB_OBJECT=ACTIVE"

function Test-PortListening([int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  return $null -ne $listener
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (Test-Path -LiteralPath $taskkill) {
      & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    } else {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$apiListening = Test-PortListening $ApiPort
$webListening = Test-PortListening $WebPort
if ($apiListening -and $webListening) {
  Write-Host "PHASE7B_WEB_AUTOSTART=ALREADY_RUNNING"
  Write-Host "PHASE7B_WEB_API=http://127.0.0.1:$ApiPort/api/v1/phase7b-demo"
  Write-Host "PHASE7B_WEB_UI=http://127.0.0.1:$WebPort/phase7b-demo"
  exit 0
}
if ($apiListening -or $webListening) {
  throw "Phase 7B WEB autostart found a partial port conflict. API=$apiListening WEB=$webListening"
}

# No Web runtime owns the ports at this point. Remove only stale Web PID evidence;
# historical component JSON is retained so the API can classify it STALE/UNKNOWN
# until this launch passes both readiness probes and publishes fresh evidence.
Remove-Item -LiteralPath $webPidPath -Force -ErrorAction SilentlyContinue

$values = @{}
Get-Content $BridgeEnv | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
  $parts = $line -split "=", 2
  $name = $parts[0].Trim().TrimStart([char]0xFEFF)
  $value = $parts[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $values[$name] = $value
}

$apiKey = [string]$values["MT5_API_KEY"]
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 16) {
  throw "Phase 7B WEB autostart requires a valid MT5_API_KEY."
}

$systemMagic = [string]$values["MT5_MAGIC_NUMBER"]
if ([string]::IsNullOrWhiteSpace($systemMagic)) { $systemMagic = "270713" }
$systemMagicNumber = 0
if (-not [int]::TryParse($systemMagic, [ref]$systemMagicNumber) -or $systemMagicNumber -le 0) {
  throw "Phase 7B WEB autostart MT5_MAGIC_NUMBER is invalid."
}

$bridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
$bridgePort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { "8765" } else { [string]$values["MT5_BRIDGE_PORT"] }
$bridgeBase = "http://${bridgeHost}:${bridgePort}"
$demoDir = Join-Path $WorkDir "phase7b-demo-forward"
New-Item -ItemType Directory -Path $demoDir -Force | Out-Null
$logDir = Join-Path $WorkDir "phase7b-web"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$apiOutLog = Join-Path $logDir "api.out.log"
$apiErrLog = Join-Path $logDir "api.err.log"
$webOutLog = Join-Path $logDir "web.out.log"
$webErrLog = Join-Path $logDir "web.err.log"

$apiUrl = "http://127.0.0.1:${ApiPort}"
$webUrl = "http://127.0.0.1:${WebPort}"
$webDistIndex = Join-Path $ProjectRoot "apps\web\dist\index.html"

# Runtime serves the already-built production bundle. Build only as a recovery path
# when the dist folder is missing (normal deployments build before restarting this task).
if (-not (Test-Path -LiteralPath $webDistIndex)) {
  Write-Host "PHASE7B_WEB_PRODUCTION_BUILD=START"
  $env:VITE_API_BASE_URL = $apiUrl
  try {
    Push-Location $ProjectRoot
    & pnpm --filter '@xauusd/web' build
    if ($LASTEXITCODE -ne 0) { throw "Phase 7B WEB production build failed." }
  } finally {
    Pop-Location
    Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $webDistIndex)) {
    throw "Phase 7B WEB production build completed without dist/index.html."
  }
  Write-Host "PHASE7B_WEB_PRODUCTION_BUILD=PASS"
} else {
  Write-Host "PHASE7B_WEB_PRODUCTION_BUILD=READY"
}

$apiProcess = Start-Process powershell.exe -WindowStyle Hidden -WorkingDirectory $ProjectRoot `
  -RedirectStandardOutput $apiOutLog -RedirectStandardError $apiErrLog -PassThru -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", ('"{0}"' -f $ApiRunner),
  "-WorkDir", ('"{0}"' -f $WorkDir),
  "-BridgeEnv", ('"{0}"' -f $BridgeEnv),
  "-ApiPort", [string]$ApiPort,
  "-WebOrigin", ('"{0}"' -f $webUrl)
)

# The preview server serves the Vite production bundle. The proxy target is set at
# process startup so relative /api requests go straight to the local Control API.
$env:VITE_API_BASE_URL = $apiUrl
$env:VITE_DEV_API_PROXY_TARGET = $apiUrl
$webCommand = "Set-Location '$ProjectRoot'; pnpm --filter @xauusd/web preview -- --host 127.0.0.1 --port $WebPort --strictPort"
$webProcess = Start-Process powershell.exe -WindowStyle Hidden -WorkingDirectory $ProjectRoot `
  -RedirectStandardOutput $webOutLog -RedirectStandardError $webErrLog -PassThru -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-Command", $webCommand
)
Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:VITE_DEV_API_PROXY_TARGET -ErrorAction SilentlyContinue

Write-Host "PHASE7B_WEB_AUTOSTART=STARTING"
Write-Host "PHASE7B_WEB_RUNTIME=PRODUCTION_PREVIEW"
Write-Host "PHASE7B_WEB_API_PID=$($apiProcess.Id)"
Write-Host "PHASE7B_WEB_UI_PID=$($webProcess.Id)"
Write-Host "PHASE7B_WEB_API=$apiUrl/api/v1/phase7b-demo"
Write-Host "PHASE7B_WEB_UI=$webUrl/phase7b-demo"
Write-Host "PHASE7B_WEB_OPS=$webUrl/phase7b-ops"
Write-Host "PHASE7B_WEB_BROWSER_AUTO_OPEN=OFF"
Write-Host "PHASE7B_WEB_API_OUT_LOG=$apiOutLog"
Write-Host "PHASE7B_WEB_API_ERR_LOG=$apiErrLog"
Write-Host "PHASE7B_WEB_UI_OUT_LOG=$webOutLog"
Write-Host "PHASE7B_WEB_UI_ERR_LOG=$webErrLog"
Write-Host "PHASE7B_WEB_STARTUP_TIMEOUT_SECONDS=$StartupTimeoutSeconds"

$apiReady = $false
$webReady = $false
$apiLastError = "API has not answered yet."
$webLastError = "Web UI has not answered yet."
$startupDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
while ((Get-Date) -lt $startupDeadline) {
  Start-Sleep -Milliseconds 500
  $apiProcess.Refresh()
  $webProcess.Refresh()
  if ($apiProcess.HasExited -or $webProcess.HasExited) { break }
  if (-not $apiReady) {
    try {
      $snapshot = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7b-demo" -Method Get -TimeoutSec 2
      if ($snapshot) { $apiReady = $true }
    } catch { $apiLastError = $_.Exception.Message }
  }
  if (-not $webReady) {
    try {
      $response = Invoke-WebRequest -Uri "$webUrl/phase7b-ops" -Method Get -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { $webReady = $true }
    } catch { $webLastError = $_.Exception.Message }
  }
  if ($apiReady -and $webReady) { break }
}

if (-not $apiReady -or -not $webReady) {
  $apiProcess.Refresh()
  $webProcess.Refresh()
  $apiExited = $apiProcess.HasExited
  $webExited = $webProcess.HasExited
  Write-Host "PHASE7B_WEB_AUTOSTART_API_LAST_ERROR=$apiLastError"
  Write-Host "PHASE7B_WEB_AUTOSTART_UI_LAST_ERROR=$webLastError"
  Write-Host "PHASE7B_WEB_AUTOSTART_API_EXITED=$apiExited"
  Write-Host "PHASE7B_WEB_AUTOSTART_UI_EXITED=$webExited"
  Stop-ProcessTree $apiProcess.Id
  Stop-ProcessTree $webProcess.Id
  throw "Phase 7B WEB autostart self-test failed. API=$apiReady WEB=$webReady API_EXITED=$apiExited WEB_EXITED=$webExited. Logs: $logDir"
}

Write-Host "PHASE7B_WEB_AUTOSTART_API=PASS"
Write-Host "PHASE7B_WEB_AUTOSTART_UI=PASS"

try {
  if ($webAttestationEnabled) {
    [void](New-Item -ItemType Directory -Force -Path $attestationRoot)
    Set-Content -LiteralPath $webPidPath -Value ([string]$PID) -Encoding ASCII -NoNewline
    $webAttestation = Write-Phase7BWebRuntimeSourceAttestation `
      -RuntimeRoot $WorkDir `
      -ProcessId $PID `
      -LauncherPath $PSCommandPath `
      -ConfigIdentity $webAttestationConfigIdentity
    Write-Host "PHASE7B_WEB_RUNTIME_SOURCE_ATTESTATION=PASS|PID=$PID|DEPLOYMENT_ID=$($webAttestation.deploymentId)|SOURCE_COMMIT=$($webAttestation.sourceCommit)"
  } else {
    Write-Host "PHASE7B_WEB_RUNTIME_SOURCE_ATTESTATION=UNKNOWN|DEPLOYMENT_MANIFEST=MISSING"
  }

  Write-Host "PHASE7B_WEB_AUTOSTART_STATUS=RUNNING"

  while ($true) {
    Start-Sleep -Seconds 5
    $apiProcess.Refresh()
    $webProcess.Refresh()
    if ($apiProcess.HasExited -or $webProcess.HasExited) {
      throw "Phase 7B WEB child process exited. API_EXITED=$($apiProcess.HasExited) WEB_EXITED=$($webProcess.HasExited)"
    }
  }
}
finally {
  Remove-Item -LiteralPath $webPidPath -Force -ErrorAction SilentlyContinue
  Stop-ProcessTree $apiProcess.Id
  Stop-ProcessTree $webProcess.Id
}
