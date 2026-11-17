Set-StrictMode -Version Latest

$script:Phase7CLifecycleBrokerActions = @("START", "STOP", "RESTART")
$script:Phase7CLifecycleBrokerSources = @("WEB_CONTROL_CENTER", "LOCAL_LIFECYCLE_API")
$script:Phase7CLifecycleBrokerReasons = @("USER_START", "USER_STOP", "LOT_SETTINGS_CHANGED", "RECOVERY_START")
$script:Phase7CLifecycleBrokerRequestFields = @("version", "requestId", "action", "requestedAt", "source", "reason")
$script:Phase7CLifecycleBrokerFreshnessMs = 120000L

function New-Phase7CLifecycleBrokerDecision([bool]$Allowed, [string]$ReasonCode, [string]$Message = "") {
  return [pscustomobject]@{
    allowed = $Allowed
    valid = $Allowed
    reasonCode = $ReasonCode
    message = $Message
  }
}

function Test-Phase7CLifecycleBrokerRequest {
  param(
    [Parameter(Mandatory = $true)] $Request,
    [long]$NowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  )

  if ($null -eq $Request) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Request is null."
  }

  $propertyNames = @($Request.PSObject.Properties | ForEach-Object { [string]$_.Name })
  if ($propertyNames.Count -ne $script:Phase7CLifecycleBrokerRequestFields.Count) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Request field count is invalid."
  }
  foreach ($name in $propertyNames) {
    if ($script:Phase7CLifecycleBrokerRequestFields -notcontains $name) {
      return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Unknown request field: $name"
    }
  }
  foreach ($required in $script:Phase7CLifecycleBrokerRequestFields) {
    if ($propertyNames -notcontains $required) {
      return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Missing request field: $required"
    }
  }

  try { $version = [int]$Request.version } catch { $version = 0 }
  if ($version -ne 1) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Unsupported request version."
  }

  $requestId = [string]$Request.requestId
  $guid = [Guid]::Empty
  if ([string]::IsNullOrWhiteSpace($requestId) -or -not [Guid]::TryParse($requestId, [ref]$guid)) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "requestId must be a UUID."
  }

  $action = ([string]$Request.action).Trim().ToUpperInvariant()
  if ($script:Phase7CLifecycleBrokerActions -notcontains $action) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Unsupported lifecycle action."
  }

  $source = ([string]$Request.source).Trim().ToUpperInvariant()
  if ($script:Phase7CLifecycleBrokerSources -notcontains $source) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Unsupported request source."
  }

  $reason = ([string]$Request.reason).Trim().ToUpperInvariant()
  if ($script:Phase7CLifecycleBrokerReasons -notcontains $reason) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "Unsupported request reason."
  }

  try { $requestedAt = [long]$Request.requestedAt } catch { $requestedAt = 0L }
  if ($requestedAt -le 0L) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_INVALID" "requestedAt must be a positive epoch timestamp."
  }
  $ageMs = $NowMs - $requestedAt
  if ($ageMs -gt $script:Phase7CLifecycleBrokerFreshnessMs -or $ageMs -lt -5000L) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_REQUEST_STALE" "Request is outside the freshness window."
  }

  return New-Phase7CLifecycleBrokerDecision $true "OK" "Request accepted."
}

function Get-Phase7CLifecycleBrokerRequestDisposition {
  param(
    [Parameter(Mandatory = $true)] [string]$RequestId,
    [AllowNull()] [string]$ActiveRequestId,
    [bool]$ExistingResult
  )

  if ($ExistingResult) { return "REJECT_REQUEST_DUPLICATE" }
  if (-not [string]::IsNullOrWhiteSpace($ActiveRequestId)) { return "REJECT_BROKER_BUSY" }
  return "ACCEPT"
}

function Get-Phase7CLifecycleBrokerInitialState {
  return [pscustomobject]@{
    state = "IDLE"
    desiredExecutorState = "STOPPED"
    botMode = "PAUSE"
  }
}

function Get-Phase7CContextValue($Context, [string]$Name, $Default = $null) {
  if ($null -eq $Context) { return $Default }
  $property = $Context.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Test-Phase7CLifecycleBrokerSafetyGate {
  param(
    [Parameter(Mandatory = $true)] [ValidateSet("START", "STOP", "RESTART")] [string]$Action,
    [Parameter(Mandatory = $true)] $Context
  )

  $botMode = ([string](Get-Phase7CContextValue $Context "botMode" "")).Trim().ToUpperInvariant()
  if ($botMode -ne "PAUSE") {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_BOT_NOT_PAUSED" "Lifecycle mutation requires PAUSE."
  }

  $bridgeReachable = [bool](Get-Phase7CContextValue $Context "bridgeReachable" $false)
  $positionsKnown = [bool](Get-Phase7CContextValue $Context "positionsKnown" $false)
  if (-not $bridgeReachable -or -not $positionsKnown) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_BRIDGE_UNAVAILABLE" "MT5/position state is not verifiable."
  }

  $openPositions = [int](Get-Phase7CContextValue $Context "openXauusdPositions" -1)
  if ($openPositions -ne 0) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_OPEN_XAUUSD_POSITION" "Lifecycle mutation requires zero XAUUSD positions."
  }

  if ($Action -eq "STOP") {
    return New-Phase7CLifecycleBrokerDecision $true "OK" "STOP safety gates passed."
  }

  if (-not [bool](Get-Phase7CContextValue $Context "accountValid" $false)) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_ACCOUNT_INVALID" "Configured account state is invalid."
  }
  if (-not [bool](Get-Phase7CContextValue $Context "accountModeMatchesConfigured" $false)) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_ACCOUNT_INVALID" "MT5 broker account mode does not match configured lifecycle account mode."
  }
  foreach ($flag in @("tradingEnabled", "terminalTradeAllowed", "expertTradeAllowed", "telegramConfigured", "taskConfigValid")) {
    if (-not [bool](Get-Phase7CContextValue $Context $flag $false)) {
      $reason = if ($flag -eq "telegramConfigured" -or $flag -eq "taskConfigValid") { "REJECT_ACCOUNT_INVALID" } else { "REJECT_BRIDGE_UNAVAILABLE" }
      return New-Phase7CLifecycleBrokerDecision $false $reason "START/RESTART safety flag failed: $flag"
    }
  }

  $accountMode = ([string](Get-Phase7CContextValue $Context "accountMode" "")).Trim().ToUpperInvariant()
  if ($accountMode -notin @("DEMO", "LIVE")) {
    return New-Phase7CLifecycleBrokerDecision $false "REJECT_ACCOUNT_INVALID" "Account mode must be DEMO or LIVE."
  }
  if ($accountMode -eq "LIVE") {
    if (-not [bool](Get-Phase7CContextValue $Context "liveExecutionEnabled" $false) -or
        -not [bool](Get-Phase7CContextValue $Context "liveAuthorizationValid" $false)) {
      return New-Phase7CLifecycleBrokerDecision $false "REJECT_LIVE_AUTH_INVALID" "LIVE durable authorization is invalid."
    }
    # Intentionally do not inspect sessionArmValid here. Session ARM belongs to AUTO activation.
  }

  return New-Phase7CLifecycleBrokerDecision $true "OK" "$Action safety gates passed."
}
