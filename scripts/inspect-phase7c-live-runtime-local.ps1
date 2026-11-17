param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [ValidateSet("DEMO", "LIVE")] [string]$ExpectedRuntime = "LIVE",
  [ValidateSet("AUTO", "PAUSE", "TREND", "SIDEWAY")] [string]$ExpectedMode = "AUTO",
  [switch]$RequireArmed,
  [string]$Symbol = "XAUUSD",
  [int]$TimeoutSec = 5
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExpectedRuntime = $ExpectedRuntime.ToUpperInvariant()
$ExpectedMode = $ExpectedMode.ToUpperInvariant()
$ControlApiUrl = $ControlApiUrl.TrimEnd('/')
if ($TimeoutSec -lt 1 -or $TimeoutSec -gt 30) { throw "TimeoutSec must be between 1 and 30." }
if ([string]::IsNullOrWhiteSpace($Symbol)) { throw "Symbol is required." }
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "Phase7C work directory not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

$AccountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
$LiveArmPath = Join-Path $WorkDir "phase7c-live-arm.json"

function Read-JsonRequired([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "$Label not found: $Path" }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label is unreadable or invalid JSON: $Path. $($_.Exception.Message)" }
}

function Read-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Runtime environment file not found: $Path" }
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = ([string]$raw).Trim()
    if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { continue }
    $index = $line.IndexOf('=')
    $key = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
    if ($key -ne $Name) { continue }
    $value = $line.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
  }
  return ""
}

function Resolve-ProjectFile([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "Account state envFile is missing." }
  if (-not [System.IO.Path]::IsPathRooted($Path)) { return Join-Path $ProjectRoot $Path }
  return $Path
}

function Invoke-ObservationGet([string]$Uri, [hashtable]$Headers = @{}) {
  return Invoke-RestMethod -Uri $Uri -Headers $Headers -Method Get -TimeoutSec $TimeoutSec
}

function Read-ModeValue($Response) {
  if ($null -ne $Response.PSObject.Properties['state'] -and $null -ne $Response.state -and $null -ne $Response.state.PSObject.Properties['mode']) {
    return ([string]$Response.state.mode).Trim().ToUpperInvariant()
  }
  if ($null -ne $Response.PSObject.Properties['mode']) { return ([string]$Response.mode).Trim().ToUpperInvariant() }
  throw "Control API bot-mode response does not contain a mode."
}

function Count-Items($Value) {
  if ($null -eq $Value) { return 0 }
  return @($Value | Where-Object { $null -ne $_ }).Count
}

Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_OBSERVATION_ONLY=TRUE"
try {
  $accountState = Read-JsonRequired $AccountStatePath "Phase7C account-mode state"
  if ([int]$accountState.version -ne 1) { throw "Unsupported account-mode state version." }
  $runtime = ([string]$accountState.accountMode).Trim().ToUpperInvariant()
  if ($runtime -notin @('DEMO', 'LIVE')) { throw "Account-mode state contains invalid accountMode=$runtime" }
  if ($runtime -ne $ExpectedRuntime) { throw "Expected runtime $ExpectedRuntime but observed $runtime." }
  if ($runtime -eq 'LIVE' -and -not [bool]$accountState.liveExecutionEnabled) { throw "LIVE account-mode state is not execution-enabled." }
  if ($runtime -eq 'DEMO' -and [bool]$accountState.liveExecutionEnabled) { throw "DEMO account-mode state is internally inconsistent." }

  $envPath = Resolve-ProjectFile ([string]$accountState.envFile)
  if (-not (Test-Path -LiteralPath $envPath)) { throw "Selected runtime env file not found: $envPath" }
  $envPath = (Resolve-Path -LiteralPath $envPath).Path
  $bridgeHost = (Read-EnvValue $envPath 'MT5_BRIDGE_HOST').Trim()
  if ([string]::IsNullOrWhiteSpace($bridgeHost)) { $bridgeHost = '127.0.0.1' }
  if ($bridgeHost -notin @('127.0.0.1', 'localhost', '::1')) { throw "Inspector only permits localhost Bridge observation." }
  $bridgePortText = (Read-EnvValue $envPath 'MT5_BRIDGE_PORT').Trim()
  if ([string]::IsNullOrWhiteSpace($bridgePortText)) { $bridgePortText = '8765' }
  $bridgePort = 0
  if (-not [int]::TryParse($bridgePortText, [ref]$bridgePort) -or $bridgePort -lt 1 -or $bridgePort -gt 65535) { throw "Selected runtime Bridge port is invalid." }
  $apiKey = Read-EnvValue $envPath 'MT5_API_KEY'
  if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "Selected runtime Bridge API key is missing." }
  $bridgeBaseUrl = "http://${bridgeHost}:$bridgePort"
  $bridgeHeaders = @{ 'x-mt5-api-key' = $apiKey }

  $modeResponse = Invoke-ObservationGet "$ControlApiUrl/api/v1/phase7c/bot-mode"
  $mode = Read-ModeValue $modeResponse
  if ($mode -ne $ExpectedMode) { throw "Expected bot mode $ExpectedMode but observed $mode." }

  $health = Invoke-ObservationGet "$bridgeBaseUrl/health?reconnect=false" $bridgeHeaders
  if (-not [bool]$health.connected -or ([string]$health.status).Trim().ToLowerInvariant() -ne 'ok') { throw "Bridge health is not connected/ok." }
  $expectedBrokerMode = if ($runtime -eq 'LIVE') { 'real' } else { 'demo' }
  if (([string]$health.accountMode).Trim().ToLowerInvariant() -ne $expectedBrokerMode) { throw "Bridge accountMode does not match selected runtime." }
  if ($null -ne $health.PSObject.Properties['configuredAccountMode'] -and ([string]$health.configuredAccountMode).Trim().ToUpperInvariant() -ne $runtime) { throw "Bridge configuredAccountMode does not match selected runtime." }

  $escapedSymbol = [uri]::EscapeDataString($Symbol)
  $positions = Invoke-ObservationGet "$bridgeBaseUrl/v1/positions?symbol=$escapedSymbol&reconnect=false" $bridgeHeaders
  $orders = Invoke-ObservationGet "$bridgeBaseUrl/v1/orders?symbol=$escapedSymbol&reconnect=false" $bridgeHeaders
  $positionCount = Count-Items $positions
  $orderCount = Count-Items $orders

  $armState = $null
  if (Test-Path -LiteralPath $LiveArmPath) { $armState = Read-JsonRequired $LiveArmPath "Phase7C LIVE arm state" }
  $healthArmed = $null -ne $health.PSObject.Properties['liveExecutionArmed'] -and [bool]$health.liveExecutionArmed
  $healthArmStatus = if ($null -ne $health.PSObject.Properties['liveArmStatus']) { ([string]$health.liveArmStatus).Trim().ToUpperInvariant() } else { '' }
  $localArmVersion = if ($null -ne $armState) { [int]$armState.version } else { 0 }
  $localArmScopeValid = $localArmVersion -ne 2 -or ([string]$armState.scope).Trim().ToUpperInvariant() -eq 'BRIDGE_SESSION'
  $localArmValid = $null -ne $armState -and $localArmVersion -in @(1, 2) -and [bool]$armState.armed -and $localArmScopeValid -and ([string]$armState.accountMode).Trim().ToUpperInvariant() -eq 'LIVE'
  $armed = $runtime -eq 'LIVE' -and $localArmValid -and $healthArmed -and $healthArmStatus -eq 'ARMED'

  if ($RequireArmed) {
    if ($runtime -ne 'LIVE') { throw "RequireArmed is valid only with ExpectedRuntime LIVE." }
    if (-not $armed) { throw "LIVE runtime is not armed consistently in local state and Bridge health." }
    if ([long]$armState.accountLogin -gt 0 -and $null -ne $health.PSObject.Properties['accountLogin'] -and [long]$health.accountLogin -ne [long]$armState.accountLogin) { throw "LIVE arm login does not match Bridge health." }
    if ($null -ne $health.PSObject.Properties['bridgeSessionId'] -and -not [string]::IsNullOrWhiteSpace([string]$armState.bridgeSessionId) -and [string]$health.bridgeSessionId -ne [string]$armState.bridgeSessionId) { throw "LIVE arm Bridge session does not match current Bridge session." }
  }

  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_RUNTIME=$runtime"
  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_MODE=$mode"
  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_ARM=$(if ($armed) { 'ARMED' } else { 'DISARMED' })"
  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_XAUUSD_POSITIONS=$positionCount"
  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_XAUUSD_ORDERS=$orderCount"
  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_RESULT=PASS"
} catch {
  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_RESULT=FAIL"
  throw
}
