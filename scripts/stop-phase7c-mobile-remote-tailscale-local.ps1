param(
  [string]$WorkDir = ".runtime",
  [int]$GatewayPort = 5791,
  [int]$WebPort = 5717,
  [int]$TailscaleHttpsPort = 8443
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$GatewayHost = "127.0.0.1"

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
  $WorkDir = Join-Path $ProjectRoot $WorkDir
}
$RemoteRuntimeDir = Join-Path $WorkDir "phase7c-mobile-remote-m2"
$PidPath = Join-Path $RemoteRuntimeDir "gateway.pid"
$GatewayMarker = "run-phase7c-mobile-readonly-gateway.mjs"
$GatewayUrl = "http://${GatewayHost}:$GatewayPort"

foreach ($port in @($GatewayPort, $WebPort, $TailscaleHttpsPort)) {
  if ($port -lt 1024 -or $port -gt 65535) { throw "M2 port is invalid: $port" }
}
if ($GatewayPort -eq $WebPort) { throw "GatewayPort and WebPort must be different." }

$tailscale = Get-Command tailscale -ErrorAction Stop

function Get-ProcessCommandLine([int]$ProcessId) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return "" }
  return [string]$process.CommandLine
}

function Test-OwnedGatewayProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }
  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
  return (
    $commandLine.IndexOf($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf($GatewayMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

function Test-ServeWebOwnership([object]$Node, [int]$Port, [string]$ExpectedProxy) {
  if ($null -eq $Node) { return $false }

  if ($Node -is [System.Array]) {
    foreach ($item in $Node) {
      if (Test-ServeWebOwnership -Node $item -Port $Port -ExpectedProxy $ExpectedProxy) { return $true }
    }
    return $false
  }

  if ($Node -isnot [pscustomobject]) { return $false }

  $webProperty = $Node.PSObject.Properties["Web"]
  if ($null -ne $webProperty -and $null -ne $webProperty.Value) {
    foreach ($endpoint in $webProperty.Value.PSObject.Properties) {
      if (-not $endpoint.Name.EndsWith(":$Port", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      $handlersProperty = $endpoint.Value.PSObject.Properties["Handlers"]
      if ($null -eq $handlersProperty -or $null -eq $handlersProperty.Value) { continue }
      foreach ($handler in $handlersProperty.Value.PSObject.Properties) {
        if ($null -eq $handler.Value) { continue }
        $proxyProperty = $handler.Value.PSObject.Properties["Proxy"]
        if ($null -ne $proxyProperty -and [string]::Equals(
          [string]$proxyProperty.Value,
          $ExpectedProxy,
          [System.StringComparison]::OrdinalIgnoreCase
        )) {
          return $true
        }
      }
    }
  }

  foreach ($property in $Node.PSObject.Properties) {
    if ($property.Name -eq "Web") { continue }
    if (Test-ServeWebOwnership -Node $property.Value -Port $Port -ExpectedProxy $ExpectedProxy) { return $true }
  }
  return $false
}

$gatewayPid = 0
$gatewayAlive = $false
if (Test-Path -LiteralPath $PidPath -PathType Leaf) {
  $rawPid = (Get-Content -LiteralPath $PidPath -Raw).Trim()
  if (-not [int]::TryParse($rawPid, [ref]$gatewayPid) -or $gatewayPid -le 0) {
    throw "M2 gateway PID file is invalid. Refusing rollback before ownership is proven."
  }

  $existing = Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    if (-not (Test-OwnedGatewayProcess -ProcessId $gatewayPid)) {
      throw "M2 gateway PID=$gatewayPid does not match $GatewayMarker. Refusing rollback before Serve mutation."
    }
    $gatewayAlive = $true
    Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_OWNERSHIP=PASS|PID=$gatewayPid"
  } else {
    Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_OWNERSHIP=STALE_PID|PID=$gatewayPid"
  }
} else {
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_OWNERSHIP=NO_PID_FILE"
}

$serveStatusRaw = (& $tailscale.Source serve status --json | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Tailscale Serve status ownership preflight failed. No Serve or gateway mutation was performed."
}
try {
  $serveStatus = if ([string]::IsNullOrWhiteSpace($serveStatusRaw)) { [pscustomobject]@{} } else { $serveStatusRaw | ConvertFrom-Json }
} catch {
  throw "Tailscale Serve status returned invalid JSON. No Serve or gateway mutation was performed."
}

$serveOwned = Test-ServeWebOwnership -Node $serveStatus -Port $TailscaleHttpsPort -ExpectedProxy $GatewayUrl
$httpsArg = "--https=$TailscaleHttpsPort"
$serveDisableError = $null
if ($serveOwned) {
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_SERVE_OWNERSHIP=PASS|HTTPS_PORT=$TailscaleHttpsPort|PROXY=$GatewayUrl"
  try {
    & $tailscale.Source serve $httpsArg off
    if ($LASTEXITCODE -ne 0) {
      $serveDisableError = "Tailscale Serve disable returned exit code $LASTEXITCODE."
    } else {
      Write-Host "PHASE7C_MOBILE_REMOTE_M2_SERVE_DISABLE=PASS"
    }
  } catch {
    $serveDisableError = $_.Exception.Message
  }
} else {
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_SERVE_OWNERSHIP=NOT_OWNED|HTTPS_PORT=$TailscaleHttpsPort|EXPECTED_PROXY=$GatewayUrl"
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_SERVE_DISABLE=SKIPPED_NOT_OWNED"
}

if ($gatewayAlive) {
  Stop-Process -Id $gatewayPid -Force -ErrorAction Stop
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_STOP=PASS|PID=$gatewayPid"
} elseif ($gatewayPid -gt 0) {
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_STOP=ALREADY_STOPPED|PID=$gatewayPid"
} else {
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_STOP=NO_PID_FILE"
}
if (Test-Path -LiteralPath $PidPath -PathType Leaf) {
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
}

$localWebUrl = "http://${GatewayHost}:$WebPort/phase7c-mobile"
try {
  $web = Invoke-WebRequest -Uri $localWebUrl -Method Get -UseBasicParsing -TimeoutSec 8
  if ($web.StatusCode -lt 200 -or $web.StatusCode -ge 400) {
    throw "Unexpected status $($web.StatusCode)."
  }
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_LOCAL_WEB_AFTER_ROLLBACK=PASS"
} catch {
  throw "Remote rollback completed but canonical localhost Web is not healthy: $($_.Exception.Message)"
}

Write-Host "PHASE7C_MOBILE_REMOTE_M2_ROLLBACK=PASS"
Write-Host "REMOTE_LAYER=DISABLED_OR_NOT_OWNED"
Write-Host "CANONICAL_WEB_MUTATION=NONE"
Write-Host "CANONICAL_TASK_MUTATION=NONE"
Write-Host "TRADING_PROCESS_MUTATION=NONE"
Write-Host "MODE_MUTATION=NONE"
Write-Host "ARM_MUTATION=NONE"
Write-Host "ORDER_MUTATION=NONE"
Write-Host "POSITION_MUTATION=NONE"

if (-not [string]::IsNullOrWhiteSpace([string]$serveDisableError)) {
  throw "M2 gateway cleanup completed, but owned Serve disable could not be attested: $serveDisableError"
}
