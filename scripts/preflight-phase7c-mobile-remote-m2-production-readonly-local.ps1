param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedMainCommit,
  [int]$WebPort = 5717,
  [int]$GatewayPort = 5791,
  [int]$TailscaleHttpsPort = 8443,
  [int]$HttpTimeoutSeconds = 8
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LoopbackHost = "127.0.0.1"
$WebBaseUrl = "http://${LoopbackHost}:$WebPort"

Write-Host "============================================================"
Write-Host "=== PHASE7C MOBILE REMOTE M2 — PRODUCTION READ-ONLY PREFLIGHT ==="
Write-Host "============================================================"
Write-Host "READ_ONLY=TRUE"
Write-Host "HTTP_METHODS=GET_ONLY"
Write-Host "TAILSCALE_SERVE_MUTATION=NONE"
Write-Host "TAILSCALE_FUNNEL_MUTATION=NONE"
Write-Host "GATEWAY_START_STOP=NONE"
Write-Host "FIREWALL_MUTATION=NONE"
Write-Host "TASK_MUTATION=NONE"
Write-Host "PROCESS_MUTATION=NONE"
Write-Host "BOT_RESTART=NONE"
Write-Host "WEB_RESTART=NONE"
Write-Host "API_RESTART=NONE"
Write-Host "MT5_RESTART=NONE"
Write-Host "MODE_MUTATION=NONE"
Write-Host "ARM_MUTATION=NONE"
Write-Host "ORDER_MUTATION=NONE"
Write-Host "POSITION_MUTATION=NONE"
Write-Host "SL_TP_MUTATION=NONE"
Write-Host "LIVE_TEST_ORDER=NONE"

foreach ($port in @($WebPort, $GatewayPort, $TailscaleHttpsPort)) {
  if ($port -lt 1024 -or $port -gt 65535) {
    throw "Preflight port is invalid: $port"
  }
}
if ($WebPort -eq $GatewayPort) {
  throw "WebPort and GatewayPort must be different."
}
if ($HttpTimeoutSeconds -lt 2 -or $HttpTimeoutSeconds -gt 30) {
  throw "HttpTimeoutSeconds must be between 2 and 30."
}

$sourceAttestation = "FAIL"
$localMobileWeb = "FAIL"
$readOnlyApiSet = "FAIL"
$tailscaleBackend = "UNKNOWN"
$servePortState = "UNKNOWN"
$gatewayPortState = "UNKNOWN"
$publicFunnel = "UNKNOWN"
$reasons = [System.Collections.Generic.List[string]]::new()

function Add-Failure([string]$Message) {
  if (-not [string]::IsNullOrWhiteSpace($Message)) {
    [void]$script:reasons.Add(($Message -replace '[\r\n]+', ' '))
  }
}

function Invoke-ReadOnlyGet([string]$Uri) {
  return Invoke-WebRequest -Uri $Uri -Method Get -UseBasicParsing -TimeoutSec $HttpTimeoutSeconds
}

function Test-HttpSuccess([object]$Response) {
  return ($null -ne $Response -and [int]$Response.StatusCode -ge 200 -and [int]$Response.StatusCode -lt 400)
}

function Test-ServePortConfigured([object]$Value, [int]$Port) {
  if ($null -eq $Value) { return $false }
  if ($Value -is [string] -or $Value -is [System.ValueType]) { return $false }

  if ($Value -is [System.Array]) {
    foreach ($item in $Value) {
      if (Test-ServePortConfigured -Value $item -Port $Port) { return $true }
    }
    return $false
  }

  foreach ($property in @($Value.PSObject.Properties)) {
    if ($property.Name -eq "TCP" -and $null -ne $property.Value) {
      foreach ($endpoint in @($property.Value.PSObject.Properties)) {
        if ([string]$endpoint.Name -eq [string]$Port) { return $true }
      }
    }

    if ($property.Name -eq "Web" -and $null -ne $property.Value) {
      $portSuffix = ":$Port"
      foreach ($endpoint in @($property.Value.PSObject.Properties)) {
        $endpointName = [string]$endpoint.Name
        if ($endpointName.EndsWith($portSuffix, [System.StringComparison]::OrdinalIgnoreCase)) {
          return $true
        }
      }
    }

    if (Test-ServePortConfigured -Value $property.Value -Port $Port) { return $true }
  }

  return $false
}

function Test-FunnelEnabled([object]$Value) {
  if ($null -eq $Value) { return $false }
  if ($Value -is [string] -or $Value -is [System.ValueType]) { return $false }

  if ($Value -is [System.Array]) {
    foreach ($item in $Value) {
      if (Test-FunnelEnabled -Value $item) { return $true }
    }
    return $false
  }

  foreach ($property in @($Value.PSObject.Properties)) {
    if ($property.Name -eq "AllowFunnel" -and $null -ne $property.Value) {
      foreach ($endpoint in @($property.Value.PSObject.Properties)) {
        if ($endpoint.Value -eq $true) { return $true }
      }
    }

    if (Test-FunnelEnabled -Value $property.Value) { return $true }
  }

  return $false
}

Write-Host ""
Write-Host "=== SOURCE / RUNTIME ATTESTATION ==="
try {
  $git = Get-Command git -ErrorAction Stop
  $branch = (& $git.Source -C $ProjectRoot rev-parse --abbrev-ref HEAD | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "git branch read failed" }
  $head = (& $git.Source -C $ProjectRoot rev-parse HEAD | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "git HEAD read failed" }
  $dirty = (& $git.Source -C $ProjectRoot status --porcelain | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "git status read failed" }

  Write-Host "LOCAL_BRANCH=$branch"
  Write-Host "LOCAL_HEAD=$head"
  Write-Host "EXPECTED_MAIN=$ExpectedMainCommit"
  Write-Host "LOCAL_DIRTY=$([bool](-not [string]::IsNullOrWhiteSpace($dirty)))"

  $localSourceOk = (
    $branch -eq "main" -and
    $head -eq $ExpectedMainCommit -and
    [string]::IsNullOrWhiteSpace($dirty)
  )
  if (-not $localSourceOk) {
    Add-Failure "Local source is not clean canonical main at the expected commit."
  }

  $attestationUri = "$WebBaseUrl/api/v1/phase7c/runtime-source-attestation"
  $attestationResponse = Invoke-ReadOnlyGet -Uri $attestationUri
  if (-not (Test-HttpSuccess -Response $attestationResponse)) {
    throw "Runtime source attestation HTTP status is not successful."
  }
  $attestationText = [string]$attestationResponse.Content
  try {
    $attestationObject = $attestationText | ConvertFrom-Json
    $attestationCompact = $attestationObject | ConvertTo-Json -Depth 30 -Compress
  } catch {
    throw "Runtime source attestation did not return valid JSON."
  }
  $runtimeSourceOk = $attestationCompact.IndexOf(
    $ExpectedMainCommit,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0
  if (-not $runtimeSourceOk) {
    Add-Failure "Runtime source attestation does not contain the expected canonical commit."
  }

  if ($localSourceOk -and $runtimeSourceOk) {
    $sourceAttestation = "PASS"
  }
} catch {
  Add-Failure "Source attestation check failed: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "=== LOCAL MOBILE WEB ==="
try {
  $mobileResponse = Invoke-ReadOnlyGet -Uri "$WebBaseUrl/phase7c-mobile"
  if (Test-HttpSuccess -Response $mobileResponse) {
    $localMobileWeb = "PASS"
  } else {
    Add-Failure "Local mobile page returned HTTP $([int]$mobileResponse.StatusCode)."
  }
} catch {
  Add-Failure "Local mobile page probe failed: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "=== READ-ONLY API SET ==="
$readOnlyApiUris = @(
  "$WebBaseUrl/api/v1/mt5/status?symbol=XAUUSD",
  "$WebBaseUrl/api/v1/phase7c/decision-monitor/mt5?symbol=XAUUSD",
  "$WebBaseUrl/api/v1/phase7c-ui?symbol=XAUUSD",
  "$WebBaseUrl/api/v1/phase7c/lifecycle",
  "$WebBaseUrl/api/v1/phase7c/account-risk?riskPercent=1&maxLot=0.3",
  "$WebBaseUrl/api/v1/phase7c/lot-settings",
  "$WebBaseUrl/api/v1/phase7c-account-switch/same-mode-readiness",
  "$WebBaseUrl/api/v1/phase7c-live-arm-control/capability",
  "$WebBaseUrl/api/v1/phase7c/runtime-source-attestation"
)
$apiFailures = 0
foreach ($uri in $readOnlyApiUris) {
  try {
    $response = Invoke-ReadOnlyGet -Uri $uri
    if (-not (Test-HttpSuccess -Response $response)) {
      $apiFailures++
      Add-Failure "Read-only API returned HTTP $([int]$response.StatusCode): $uri"
    }
  } catch {
    $apiFailures++
    Add-Failure "Read-only API probe failed: $uri :: $($_.Exception.Message)"
  }
}
if ($apiFailures -eq 0) {
  $readOnlyApiSet = "PASS"
}
Write-Host "READONLY_API_COUNT=$($readOnlyApiUris.Count)"
Write-Host "READONLY_API_FAILURES=$apiFailures"

Write-Host ""
Write-Host "=== TAILSCALE READ-ONLY STATUS ==="
try {
  $tailscale = Get-Command tailscale -ErrorAction Stop

  $statusRaw = (& $tailscale.Source status --json | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($statusRaw)) {
    throw "tailscale status --json failed or returned no data."
  }
  try {
    $tailStatus = $statusRaw | ConvertFrom-Json
  } catch {
    throw "tailscale status --json returned invalid JSON."
  }
  $backendState = ([string]$tailStatus.BackendState).Trim()
  if ([string]::IsNullOrWhiteSpace($backendState)) {
    $tailscaleBackend = "UNKNOWN"
    Add-Failure "Tailscale BackendState is unavailable."
  } else {
    $tailscaleBackend = $backendState.ToUpperInvariant()
    if ($backendState -ne "Running") {
      Add-Failure "Tailscale backend is not Running. Current=$backendState"
    }
  }

  $serveStatusRaw = (& $tailscale.Source serve status --json | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($serveStatusRaw)) {
    Add-Failure "tailscale serve status --json failed or returned no data."
    $servePortState = "UNKNOWN"
  } else {
    try {
      $serveStatusObject = $serveStatusRaw | ConvertFrom-Json
      if (Test-ServePortConfigured -Value $serveStatusObject -Port $TailscaleHttpsPort) {
        $servePortState = "OCCUPIED"
        Add-Failure "Tailscale Serve HTTPS port $TailscaleHttpsPort is already configured."
      } else {
        $servePortState = "FREE"
      }
    } catch {
      $servePortState = "UNKNOWN"
      Add-Failure "tailscale serve status --json returned invalid JSON."
    }
  }

  $funnelStatusRaw = (& $tailscale.Source funnel status --json | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($funnelStatusRaw)) {
    $publicFunnel = "UNKNOWN"
    Add-Failure "tailscale funnel status --json is unavailable or empty."
  } else {
    try {
      $funnelStatusObject = $funnelStatusRaw | ConvertFrom-Json
      if (Test-FunnelEnabled -Value $funnelStatusObject) {
        $publicFunnel = "DETECTED"
        Add-Failure "Public Tailscale Funnel configuration is present."
      } else {
        $publicFunnel = "NONE"
      }
    } catch {
      $publicFunnel = "UNKNOWN"
      Add-Failure "tailscale funnel status --json returned invalid JSON."
    }
  }
} catch {
  Add-Failure "Tailscale read-only status check failed: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "=== LOCAL GATEWAY PORT ==="
try {
  [void](Get-Command Get-NetTCPConnection -ErrorAction Stop)
  $listener = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $listener) {
    $gatewayPortState = "FREE"
  } else {
    $gatewayPortState = "OCCUPIED"
    $ownerPid = [int]$listener.OwningProcess
    $ownerName = "UNKNOWN"
    $ownerCommandLine = "UNKNOWN"
    $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -ne $ownerProcess) { $ownerName = [string]$ownerProcess.ProcessName }
    $ownerCim = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
    if ($null -ne $ownerCim -and -not [string]::IsNullOrWhiteSpace([string]$ownerCim.CommandLine)) {
      $ownerCommandLine = ([string]$ownerCim.CommandLine -replace '[\r\n]+', ' ')
    }
    Write-Host "GATEWAY_5791_OWNER_PID=$ownerPid"
    Write-Host "GATEWAY_5791_OWNER_PROCESS=$ownerName"
    Write-Host "GATEWAY_5791_OWNER_COMMAND=$ownerCommandLine"
    Add-Failure "Gateway port $GatewayPort is occupied by PID=$ownerPid."
  }
} catch {
  $gatewayPortState = "UNKNOWN"
  Add-Failure "Gateway listener check failed: $($_.Exception.Message)"
}

$ready = (
  $sourceAttestation -eq "PASS" -and
  $localMobileWeb -eq "PASS" -and
  $readOnlyApiSet -eq "PASS" -and
  $tailscaleBackend -eq "RUNNING" -and
  $servePortState -eq "FREE" -and
  $gatewayPortState -eq "FREE" -and
  $publicFunnel -eq "NONE"
)

Write-Host ""
Write-Host "=== M2 PRODUCTION PREFLIGHT RESULT ==="
Write-Host "SOURCE_ATTESTATION=$sourceAttestation"
Write-Host "LOCAL_MOBILE_WEB=$localMobileWeb"
Write-Host "READONLY_API_SET=$readOnlyApiSet"
Write-Host "TAILSCALE_BACKEND=$tailscaleBackend"
Write-Host "SERVE_8443=$servePortState"
Write-Host "GATEWAY_5791=$gatewayPortState"
Write-Host "PUBLIC_FUNNEL=$publicFunnel"
if ($ready) {
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_PRODUCTION_PREFLIGHT=PASS"
  Write-Host "READY_FOR_M2_ACTIVATION=TRUE"
  exit 0
}

Write-Host "PHASE7C_MOBILE_REMOTE_M2_PRODUCTION_PREFLIGHT=FAIL"
Write-Host "READY_FOR_M2_ACTIVATION=FALSE"
for ($i = 0; $i -lt $reasons.Count; $i++) {
  Write-Host "FAIL_REASON_$($i + 1)=$($reasons[$i])"
}
exit 2
