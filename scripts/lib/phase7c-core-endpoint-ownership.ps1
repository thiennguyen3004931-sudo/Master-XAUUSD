Set-StrictMode -Version Latest

function Test-Phase7CModePayload($Payload) {
  if ($null -eq $Payload) { return $false }

  $payloadProperties = @($Payload.PSObject.Properties.Name)
  if ($payloadProperties -notcontains "state" -or $payloadProperties -notcontains "options") { return $false }
  if ($null -eq $Payload.state) { return $false }

  $stateProperties = @($Payload.state.PSObject.Properties.Name)
  if ($stateProperties -notcontains "mode") { return $false }

  $mode = [string]$Payload.state.mode
  $allowedModes = @("AUTO", "TREND", "SIDEWAY", "PAUSE")
  if ($allowedModes -notcontains $mode) { return $false }

  $optionValues = @($Payload.options | ForEach-Object { [string]$_ })
  foreach ($required in $allowedModes) {
    if ($optionValues -notcontains $required) { return $false }
  }

  return $true
}

function Test-Phase7CLotSettingsPayload($Payload) {
  if ($null -eq $Payload) { return $false }

  $payloadProperties = @($Payload.PSObject.Properties.Name)
  if ($payloadProperties -notcontains "state" -or $null -eq $Payload.state) { return $false }

  $propertyNames = @($Payload.state.PSObject.Properties.Name)
  foreach ($required in @("trendFixedLot", "sidewayRiskPercent", "sidewayMaxLot")) {
    if ($propertyNames -notcontains $required) { return $false }
  }

  try {
    $trend = [double]$Payload.state.trendFixedLot
    $risk = [double]$Payload.state.sidewayRiskPercent
    $maxLot = [double]$Payload.state.sidewayMaxLot
  } catch {
    return $false
  }

  if ($trend -lt 0.03 -or $trend -gt 0.30) { return $false }
  if ($risk -lt 0.01 -or $risk -gt 1.00) { return $false }
  if ($maxLot -lt 0.03 -or $maxLot -gt 0.30) { return $false }

  return $true
}

function Test-Phase7CBridgeHealthPayload($Payload) {
  if ($null -eq $Payload) { return $false }

  $propertyNames = @($Payload.PSObject.Properties.Name)
  foreach ($required in @("status", "connected", "accountMode")) {
    if ($propertyNames -notcontains $required) { return $false }
  }

  if ([string]::IsNullOrWhiteSpace([string]$Payload.status)) { return $false }

  # This project is DEMO-only. Endpoint fallback is intentionally disabled for
  # any bridge that reports a non-demo account mode, even if the response shape
  # otherwise looks familiar.
  if ([string]$Payload.accountMode -ne "demo") { return $false }

  return $true
}

function Test-Phase7CWebSource([string]$Content) {
  if ([string]::IsNullOrWhiteSpace($Content)) { return $false }

  $requiredMarkers = @(
    "Phase7CControlCenterPage",
    "phase7c-control-center",
    "Phase7BOpsPage",
    "phase7b-pattern-check"
  )

  foreach ($marker in $requiredMarkers) {
    if ($Content.IndexOf($marker, [System.StringComparison]::Ordinal) -lt 0) {
      return $false
    }
  }

  return $true
}

function Resolve-Phase7CEndpointFallbackPid(
  [int]$ListenerPid,
  [bool]$EndpointOwned
) {
  if ($ListenerPid -le 0 -or -not $EndpointOwned) { return 0 }

  # Endpoint proof can authorize only the exact listener. It can never be used
  # to infer ownership of a parent process or a broader process tree.
  return $ListenerPid
}
