function ConvertTo-Phase7CAccountMode([string]$Value) {
  Set-StrictMode -Version Latest
  $mode = ([string]$Value).Trim().ToUpperInvariant()
  if ($mode -notin @("DEMO", "LIVE")) {
    throw "Phase7C account mode must be DEMO or LIVE. Actual=$Value"
  }
  return $mode
}

function Get-Phase7CEnvValue([string]$Path, [string]$Name) {
  Set-StrictMode -Version Latest
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = ([string]$raw).Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
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

function Test-Phase7CTruthy([string]$Value) {
  Set-StrictMode -Version Latest
  return ([string]$Value) -match '^(?i:1|true|yes|on)$'
}

function Get-Phase7CAllowedLogins([string]$EnvFile) {
  Set-StrictMode -Version Latest
  $raw = Get-Phase7CEnvValue $EnvFile "MT5_ALLOWED_LOGINS"
  $values = @()
  foreach ($item in @($raw -split ',')) {
    $trimmed = ([string]$item).Trim()
    if (-not $trimmed) { continue }
    $parsed = 0L
    if (-not [long]::TryParse($trimmed, [ref]$parsed) -or $parsed -le 0) {
      throw "MT5_ALLOWED_LOGINS contains an invalid login value in $EnvFile."
    }
    $values += $parsed
  }
  return @($values | Sort-Object -Unique)
}

function Assert-Phase7CAccountEnv(
  [string]$EnvFile,
  [string]$AccountMode,
  [switch]$RequireTrading
) {
  Set-StrictMode -Version Latest
  $mode = ConvertTo-Phase7CAccountMode $AccountMode
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Phase7C $mode environment file not found: $EnvFile"
  }

  $apiKey = Get-Phase7CEnvValue $EnvFile "MT5_API_KEY"
  if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey -eq "CHANGE_ME_TO_A_LONG_RANDOM_SECRET") {
    throw "MT5_API_KEY must be configured locally in $EnvFile."
  }

  $hostValue = Get-Phase7CEnvValue $EnvFile "MT5_BRIDGE_HOST"
  if ([string]::IsNullOrWhiteSpace($hostValue)) { $hostValue = "127.0.0.1" }
  if ($hostValue -notin @("127.0.0.1", "localhost", "::1")) {
    throw "Phase7C account switching only supports a localhost MT5 bridge. Actual host=$hostValue"
  }

  $portValue = Get-Phase7CEnvValue $EnvFile "MT5_BRIDGE_PORT"
  if ([string]::IsNullOrWhiteSpace($portValue)) { $portValue = "8765" }
  $port = 0
  if (-not [int]::TryParse($portValue, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "MT5_BRIDGE_PORT is invalid in $EnvFile."
  }

  $allowReal = Test-Phase7CTruthy (Get-Phase7CEnvValue $EnvFile "MT5_ALLOW_REAL_ACCOUNT")
  $tradingEnabled = Test-Phase7CTruthy (Get-Phase7CEnvValue $EnvFile "MT5_TRADING_ENABLED")
  $allowedLogins = @(Get-Phase7CAllowedLogins $EnvFile)

  if ($mode -eq "DEMO" -and $allowReal) {
    throw "DEMO env must keep MT5_ALLOW_REAL_ACCOUNT=false."
  }
  if ($mode -eq "LIVE" -and -not $allowReal) {
    throw "LIVE env requires MT5_ALLOW_REAL_ACCOUNT=true."
  }
  if ($mode -eq "LIVE") {
    $trendMagicRaw = ([string](Get-Phase7CEnvValue $EnvFile "MT5_MAGIC_NUMBER")).Trim()
    $trendMagic = 0
    if (-not [int]::TryParse($trendMagicRaw, [ref]$trendMagic) -or $trendMagic -ne 270715) {
      throw "LIVE env requires MT5_MAGIC_NUMBER=270715."
    }

    $sidewayMagicRaw = ([string](Get-Phase7CEnvValue $EnvFile "ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER")).Trim()
    if (-not [string]::IsNullOrWhiteSpace($sidewayMagicRaw)) {
      $sidewayMagic = 0
      if (-not [int]::TryParse($sidewayMagicRaw, [ref]$sidewayMagic) -or $sidewayMagic -ne 270714) {
        throw "LIVE env requires ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER=270714 when configured."
      }
    }
  }
  if ($RequireTrading -and -not $tradingEnabled) {
    throw "$mode execution requires MT5_TRADING_ENABLED=true."
  }
  if ($RequireTrading -and $allowedLogins.Count -eq 0) {
    throw "$mode execution requires a non-empty MT5_ALLOWED_LOGINS allowlist."
  }

  return [pscustomobject]@{
    accountMode = $mode
    envFile = (Resolve-Path -LiteralPath $EnvFile).Path
    apiKey = $apiKey
    bridgeHost = $hostValue
    bridgePort = $port
    tradingEnabled = $tradingEnabled
    allowRealAccount = $allowReal
    allowedLogins = $allowedLogins
  }
}

function Assert-Phase7CRiskProfile($Profile, [string]$Label = "Phase7C risk profile") {
  Set-StrictMode -Version Latest
  if ($null -eq $Profile) { throw "$Label is missing." }

  $version = [int]$Profile.version
  if ($version -notin @(1, 2)) { throw "$Label version must be 1 or 2." }

  $trend = [double]$Profile.trendFixedLot
  $risk = [double]$Profile.sidewayRiskPercent
  $maxLot = [double]$Profile.sidewayMaxLot
  if ($trend -lt 0.03 -or $trend -gt 1.20) {
    throw "$Label trendFixedLot must be between 0.03 and 1.20."
  }
  if ($maxLot -lt 0.03 -or $maxLot -gt 1.20) {
    throw "$Label sidewayMaxLot must be between 0.03 and 1.20."
  }
  $trendUnits = $trend / 0.03
  if ([math]::Abs($trendUnits - [math]::Round($trendUnits)) -gt 1e-8) {
    throw "$Label trendFixedLot must use 0.03 increments."
  }
  $sidewayCapUnits = $maxLot / 0.03
  if ([math]::Abs($sidewayCapUnits - [math]::Round($sidewayCapUnits)) -gt 1e-8) {
    throw "$Label sidewayMaxLot must use 0.03 increments."
  }
  if ($risk -lt 0.01 -or $risk -gt 1.0) {
    throw "$Label sidewayRiskPercent must be between 0.01 and 1.00."
  }

  $trendFixedTpEnabled = $false
  $trendFixedTpDistance = 0.0
  $sidewayFixedTpEnabled = $false
  $sidewayFixedTpDistance = 0.0

  if ($version -eq 2) {
    $trendEnabledProperty = $Profile.PSObject.Properties["trendFixedTpEnabled"]
    $trendDistanceProperty = $Profile.PSObject.Properties["trendFixedTpDistance"]
    $sidewayEnabledProperty = $Profile.PSObject.Properties["sidewayFixedTpEnabled"]
    $sidewayDistanceProperty = $Profile.PSObject.Properties["sidewayFixedTpDistance"]

    if ($null -ne $trendEnabledProperty) {
      if ($trendEnabledProperty.Value -isnot [bool]) { throw "$Label trendFixedTpEnabled must be boolean." }
      $trendFixedTpEnabled = [bool]$trendEnabledProperty.Value
    }
    if ($null -ne $sidewayEnabledProperty) {
      if ($sidewayEnabledProperty.Value -isnot [bool]) { throw "$Label sidewayFixedTpEnabled must be boolean." }
      $sidewayFixedTpEnabled = [bool]$sidewayEnabledProperty.Value
    }
    if ($null -ne $trendDistanceProperty) { $trendFixedTpDistance = [double]$trendDistanceProperty.Value }
    if ($null -ne $sidewayDistanceProperty) { $sidewayFixedTpDistance = [double]$sidewayDistanceProperty.Value }
  }

  $trendDistanceInvalid = [double]::IsNaN($trendFixedTpDistance) -or [double]::IsInfinity($trendFixedTpDistance)
  if ($trendFixedTpEnabled -and ($trendDistanceInvalid -or $trendFixedTpDistance -le 0)) {
    throw "$Label Trend fixed TP distance must be positive when Fixed TP is enabled."
  }
  if ($trendDistanceInvalid -or $trendFixedTpDistance -lt 0) {
    throw "$Label Trend fixed TP distance must be finite and non-negative."
  }

  $sidewayDistanceInvalid = [double]::IsNaN($sidewayFixedTpDistance) -or [double]::IsInfinity($sidewayFixedTpDistance)
  if ($sidewayFixedTpEnabled -and ($sidewayDistanceInvalid -or $sidewayFixedTpDistance -le 0)) {
    throw "$Label Sideway fixed TP distance must be positive when Fixed TP is enabled."
  }
  if ($sidewayDistanceInvalid -or $sidewayFixedTpDistance -lt 0) {
    throw "$Label Sideway fixed TP distance must be finite and non-negative."
  }

  return [pscustomobject]@{
    version = 2
    trendFixedLot = $trend
    sidewayRiskPercent = $risk
    sidewayMaxLot = $maxLot
    trendFixedTpEnabled = $trendFixedTpEnabled
    trendFixedTpDistance = $trendFixedTpDistance
    sidewayFixedTpEnabled = $sidewayFixedTpEnabled
    sidewayFixedTpDistance = $sidewayFixedTpDistance
  }
}

function Get-Phase7CRiskProfilePath([string]$WorkDir, [string]$AccountMode) {
  Set-StrictMode -Version Latest
  $mode = (ConvertTo-Phase7CAccountMode $AccountMode).ToLowerInvariant()
  return Join-Path $WorkDir "phase7c-lot-settings.$mode.json"
}

function Get-Phase7CLiveProfileIdentity([string]$LiveEnvFile) {
  Set-StrictMode -Version Latest
  if (-not (Test-Path -LiteralPath $LiveEnvFile)) {
    throw "LIVE environment file not found: $LiveEnvFile"
  }

  $terminalPath = ([string](Get-Phase7CEnvValue $LiveEnvFile "MT5_TERMINAL_PATH")).Trim()
  $server = ([string](Get-Phase7CEnvValue $LiveEnvFile "MT5_SERVER")).Trim()
  $loginRaw = ([string](Get-Phase7CEnvValue $LiveEnvFile "MT5_LOGIN")).Trim()
  $login = 0L

  if ([string]::IsNullOrWhiteSpace($terminalPath)) { throw "LIVE MT5_TERMINAL_PATH is required." }
  if ([string]::IsNullOrWhiteSpace($server)) { throw "LIVE MT5_SERVER is required." }
  if (-not [long]::TryParse($loginRaw, [ref]$login) -or $login -le 0) {
    throw "LIVE MT5_LOGIN must be a positive account number."
  }

  $allowed = @(Get-Phase7CAllowedLogins $LiveEnvFile)
  if ($allowed.Count -eq 0 -or $allowed -notcontains $login) {
    throw "LIVE MT5_LOGIN must be present in MT5_ALLOWED_LOGINS."
  }

  return [pscustomobject]@{
    login = $login
    server = $server
    terminalPath = $terminalPath
    profileFingerprint = Get-Phase7CLiveProfileFingerprint -Login $login -Server $server -TerminalPath $terminalPath
  }
}

function Assert-Phase7CLiveRiskProfileBinding(
  $Profile,
  [string]$LiveEnvFile,
  [string]$Label = "LIVE risk profile"
) {
  Set-StrictMode -Version Latest
  $risk = Assert-Phase7CRiskProfile $Profile $Label
  $identity = Get-Phase7CLiveProfileIdentity $LiveEnvFile

  $modeProperty = $Profile.PSObject.Properties["accountMode"]
  $loginProperty = $Profile.PSObject.Properties["accountLogin"]
  $serverProperty = $Profile.PSObject.Properties["server"]
  $fingerprintProperty = $Profile.PSObject.Properties["profileFingerprint"]
  $appliesToProperty = $Profile.PSObject.Properties["appliesTo"]
  $martingaleProperty = $Profile.PSObject.Properties["martingale"]
  $recoveryProperty = $Profile.PSObject.Properties["recoveryLotEscalation"]

  if ($null -eq $modeProperty -or (ConvertTo-Phase7CAccountMode ([string]$modeProperty.Value)) -ne "LIVE") {
    throw "$Label must be explicitly bound to accountMode LIVE."
  }
  if ($null -eq $loginProperty -or [long]$loginProperty.Value -ne [long]$identity.login) {
    throw "$Label accountLogin does not match the configured LIVE MT5 profile."
  }
  if ($null -eq $serverProperty -or -not [string]::Equals(([string]$serverProperty.Value).Trim(), $identity.server, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label server does not match the configured LIVE MT5 profile."
  }
  if ($null -eq $fingerprintProperty -or ([string]$fingerprintProperty.Value).Trim().ToLowerInvariant() -ne $identity.profileFingerprint) {
    throw "$Label profileFingerprint does not match the configured LIVE terminal/login/server."
  }
  if ($null -eq $appliesToProperty -or ([string]$appliesToProperty.Value).Trim().ToUpperInvariant() -ne "NEW_POSITIONS_ONLY") {
    throw "$Label appliesTo must be NEW_POSITIONS_ONLY."
  }
  if ($null -eq $martingaleProperty -or [bool]$martingaleProperty.Value) {
    throw "$Label must keep martingale=false."
  }
  if ($null -eq $recoveryProperty -or [bool]$recoveryProperty.Value) {
    throw "$Label must keep recoveryLotEscalation=false."
  }

  return [pscustomobject]@{
    profile = $risk
    login = $identity.login
    server = $identity.server
    terminalPath = $identity.terminalPath
    profileFingerprint = $identity.profileFingerprint
  }
}

function Write-Phase7CAccountJsonAtomic([string]$Path, $Value, [int]$Depth = 8) {
  Set-StrictMode -Version Latest
  $directory = Split-Path -Parent $Path
  if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  $token = "$PID.$([guid]::NewGuid().ToString('N'))"
  $tempPath = "$Path.$token.tmp"
  $backupPath = "$Path.$token.bak"
  try {
    $json = $Value | ConvertTo-Json -Depth $Depth
    [System.IO.File]::WriteAllText($tempPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
    if ([System.IO.File]::Exists($Path)) {
      [System.IO.File]::Replace($tempPath, $Path, $backupPath)
      if ([System.IO.File]::Exists($backupPath)) { [System.IO.File]::Delete($backupPath) }
    } else {
      [System.IO.File]::Move($tempPath, $Path)
    }
  } finally {
    foreach ($candidate in @($tempPath, $backupPath)) {
      if ([System.IO.File]::Exists($candidate)) {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Get-Phase7CLiveAuthorizationPath([string]$WorkDir) {
  Set-StrictMode -Version Latest
  if ([string]::IsNullOrWhiteSpace($WorkDir)) { throw "WorkDir is required for durable LIVE authorization." }
  return Join-Path $WorkDir "phase7c-live-authorization.json"
}

function Write-Phase7CLiveAuthorizationState(
  [string]$WorkDir,
  [string]$LiveEnvFile,
  [string]$AuthorizedBy = "switch-phase7c-account-mode-local"
) {
  Set-StrictMode -Version Latest
  $identity = Get-Phase7CLiveProfileIdentity $LiveEnvFile
  $record = [pscustomobject]@{
    version = 1
    authorized = $true
    accountMode = "LIVE"
    accountLogin = [long]$identity.login
    server = [string]$identity.server
    profileFingerprint = [string]$identity.profileFingerprint
    authorizedAt = [DateTimeOffset]::UtcNow.ToString("o")
    authorizedBy = $AuthorizedBy
  }
  Write-Phase7CAccountJsonAtomic -Path (Get-Phase7CLiveAuthorizationPath $WorkDir) -Value $record -Depth 5
  return $record
}

function Get-Phase7CLiveArmPath([string]$WorkDir) {
  Set-StrictMode -Version Latest
  if ([string]::IsNullOrWhiteSpace($WorkDir)) { throw "WorkDir is required for LIVE arm state." }
  return Join-Path $WorkDir "phase7c-live-arm.json"
}

function Read-Phase7CLiveArmState([string]$WorkDir) {
  Set-StrictMode -Version Latest
  $path = Get-Phase7CLiveArmPath $WorkDir
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  } catch {
    throw "LIVE arm state is unreadable or invalid JSON: $path"
  }
}

function Clear-Phase7CLiveArmState([string]$WorkDir, [string]$Reason = "operator-disarm") {
  Set-StrictMode -Version Latest
  $path = Get-Phase7CLiveArmPath $WorkDir
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
  Write-Host "PHASE7C_LIVE_ARM=DISARMED|REASON=$Reason"
}

function Get-Phase7CLiveProfileFingerprint(
  [long]$Login,
  [string]$Server,
  [string]$TerminalPath
) {
  Set-StrictMode -Version Latest
  if ($Login -le 0) { throw "LIVE profile fingerprint requires a positive login." }
  if ([string]::IsNullOrWhiteSpace($Server)) { throw "LIVE profile fingerprint requires server." }
  if ([string]::IsNullOrWhiteSpace($TerminalPath)) { throw "LIVE profile fingerprint requires terminal path." }
  $terminal = ([string]$TerminalPath).Trim().Replace('/', '\').ToLowerInvariant()
  $serverValue = ([string]$Server).Trim().ToLowerInvariant()
  $payload = "LIVE|$Login|$serverValue|$terminal"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $hash = $sha.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Write-Phase7CLiveArmState(
  [string]$WorkDir,
  [string]$BridgeSessionId,
  [long]$Login,
  [string]$Server,
  [string]$TerminalPath,
  [string]$ArmedBy = "local-operator"
) {
  Set-StrictMode -Version Latest
  if ([string]::IsNullOrWhiteSpace($BridgeSessionId)) { throw "BridgeSessionId is required to arm LIVE." }
  $now = [DateTimeOffset]::UtcNow
  $state = [pscustomobject]@{
    version = 2
    armed = $true
    scope = "BRIDGE_SESSION"
    accountMode = "LIVE"
    bridgeSessionId = $BridgeSessionId
    accountLogin = $Login
    server = $Server
    profileFingerprint = Get-Phase7CLiveProfileFingerprint -Login $Login -Server $Server -TerminalPath $TerminalPath
    armedAt = $now.ToUnixTimeMilliseconds()
    armedBy = $ArmedBy
  }
  Write-Phase7CAccountJsonAtomic -Path (Get-Phase7CLiveArmPath $WorkDir) -Value $state -Depth 5
  return $state
}
