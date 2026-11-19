param(
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$BridgePort = 8765,
  [string]$BridgeEnv = "",
  [int]$Attempts = 6
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OwnershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-core-endpoint-ownership.ps1"
if (-not (Test-Path -LiteralPath $OwnershipLibrary)) {
  throw "Phase 7C endpoint ownership library not found: $OwnershipLibrary"
}
. $OwnershipLibrary

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
}
if (-not (Test-Path -LiteralPath $BridgeEnv)) {
  throw "Phase 7C core cleanup bridge env not found: $BridgeEnv"
}
$BridgeEnv = (Resolve-Path $BridgeEnv).Path

foreach ($port in @($ApiPort, $WebPort, $BridgePort)) {
  if ($port -lt 1024 -or $port -gt 65535) { throw "Invalid core port: $port" }
}
$uniquePorts = @(@($ApiPort, $WebPort, $BridgePort) | Sort-Object -Unique)
if ($uniquePorts.Count -ne 3) {
  throw "API, WEB and BRIDGE ports must be distinct."
}
if ($Attempts -lt 1 -or $Attempts -gt 12) { throw "Attempts must be between 1 and 12." }

function Read-EnvValue([string]$Name) {
  foreach ($raw in Get-Content -LiteralPath $BridgeEnv) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
    $key = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
    if ($key -ne $Name) { continue }
    return $line.Substring($index + 1).Trim().Trim('"').Trim("'")
  }
  return ""
}

$apiKey = Read-EnvValue "MT5_API_KEY"
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 16) {
  throw "Phase 7C core cleanup requires a valid MT5_API_KEY."
}

$apiUrl = "http://127.0.0.1:$ApiPort"
$webUrl = "http://127.0.0.1:$WebPort"
$bridgeUrl = "http://127.0.0.1:$BridgePort"

function Test-Phase7CApiEndpoint {
  try {
    $mode = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 2
    $lot = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7c/lot-settings" -Method Get -TimeoutSec 2
    return (Test-Phase7CModePayload $mode) -and (Test-Phase7CLotSettingsPayload $lot)
  } catch {
    return $false
  }
}

function Test-Phase7CWebEndpoint {
  try {
    # The Phase7B/7C web runtime is a Vite dev server. Querying its transformed
    # router source gives a project-specific, read-only fingerprint without
    # relying on the API being healthy behind the UI.
    $response = Invoke-WebRequest -Uri "$webUrl/src/router.tsx" -Method Get -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { return $false }
    return Test-Phase7CWebSource ([string]$response.Content)
  } catch {
    return $false
  }
}

function Test-Phase7CBridgeEndpoint {
  try {
    $headers = @{ "x-mt5-api-key" = $apiKey }
    $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -Headers $headers -Method Get -TimeoutSec 2
    return Test-Phase7CBridgeHealthPayload $health
  } catch {
    return $false
  }
}

function Test-EndpointOwned([int]$Port) {
  if ($Port -eq $ApiPort) { return Test-Phase7CApiEndpoint }
  if ($Port -eq $WebPort) { return Test-Phase7CWebEndpoint }
  if ($Port -eq $BridgePort) { return Test-Phase7CBridgeEndpoint }
  return $false
}

function Stop-ExactListener([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }

  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  if (Test-Path -LiteralPath $taskkill) {
    # Deliberately omit /T. Endpoint proof establishes ownership only for the
    # exact process listening on the verified localhost port, not its parent or
    # children.
    & $taskkill /PID $ProcessId /F 2>$null | Out-Null
  } else {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$corePorts = @($ApiPort, $WebPort, $BridgePort)
Write-Host "PHASE7C_CORE_ENDPOINT_CLEANUP=START"

for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
  $listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $corePorts -contains [int]$_.LocalPort }
  )

  if ($listeners.Count -eq 0) {
    Write-Host "PHASE7C_CORE_ENDPOINT_CLEANUP=PASS"
    exit 0
  }

  $stoppedAny = $false
  foreach ($listener in $listeners) {
    $port = [int]$listener.LocalPort
    $listenerPid = [int]$listener.OwningProcess
    $owned = Test-EndpointOwned $port
    $fallbackPid = Resolve-Phase7CEndpointFallbackPid -ListenerPid $listenerPid -EndpointOwned $owned

    if ($fallbackPid -gt 0) {
      Write-Host "PHASE7C_CORE_ENDPOINT_PROOF=PASS|PORT=$port|PID=$listenerPid|SCOPE=LISTENER_ONLY"
      Stop-ExactListener $fallbackPid
      $stoppedAny = $true
    } else {
      Write-Host "PHASE7C_CORE_ENDPOINT_PROOF=FAIL|PORT=$port|PID=$listenerPid|ACTION=KEEP"
    }
  }

  Start-Sleep -Milliseconds 500
  if (-not $stoppedAny) { break }
}

$remaining = @(
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $corePorts -contains [int]$_.LocalPort } |
    ForEach-Object { "PORT=$($_.LocalPort)|PID=$($_.OwningProcess)" }
)

if ($remaining.Count -eq 0) {
  Write-Host "PHASE7C_CORE_ENDPOINT_CLEANUP=PASS"
  exit 0
}

throw "Phase 7C endpoint cleanup refused to kill one or more unproven listeners. Remaining=$($remaining -join ','). Keep PAUSE and inspect those PIDs."
