$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Library = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$Configurator = Join-Path $PSScriptRoot "configure-phase7c-live-risk-local.ps1"
$Status = Join-Path $PSScriptRoot "get-phase7c-live-risk-local.ps1"
$Switcher = Join-Path $PSScriptRoot "switch-phase7c-account-mode-local.ps1"

foreach ($path in @($Library, $Configurator, $Status, $Switcher)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required source file is missing: $path" }
}

. $Library

function Assert-Throws([scriptblock]$Action, [string]$Label) {
  $threw = $false
  try { & $Action } catch { $threw = $true }
  if (-not $threw) { throw "Expected failure did not occur: $Label" }
}

function Parse-Script([string]$Path) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $Path), [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "PowerShell parse failed: $Path :: $($errors -join '; ')" }
  return $ast
}

$configAst = Parse-Script $Configurator
[void](Parse-Script $Status)
[void](Parse-Script $Switcher)
[void](Parse-Script $Library)

foreach ($name in @("TrendFixedLot", "SidewayRiskPercent", "SidewayMaxLot")) {
  $parameter = @($configAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq $name }) | Select-Object -First 1
  if ($null -eq $parameter) { throw "Configurator parameter is missing: $name" }
  if ($null -ne $parameter.DefaultValue) { throw "LIVE risk parameter must not have a default value: $name" }
  $mandatory = $false
  foreach ($attribute in $parameter.Attributes) {
    if ($attribute.TypeName.FullName -ne "Parameter") { continue }
    foreach ($named in $attribute.NamedArguments) {
      if ($named.ArgumentName -eq "Mandatory" -and [string]$named.Argument -match '(?i:true)') { $mandatory = $true }
    }
  }
  if (-not $mandatory) { throw "LIVE risk parameter must be mandatory: $name" }
}

$configSource = Get-Content -LiteralPath $Configurator -Raw
$switchSource = Get-Content -LiteralPath $Switcher -Raw

foreach ($forbidden in @(
  'phase7c-lot-settings.demo.json',
  'Get-Phase7CRiskProfilePath $WorkDir "DEMO"',
  'Write-Phase7CLiveArmState',
  'MT5_TRADING_ENABLED" "true"',
  'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "true"',
  'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "1"'
)) {
  if ($configSource.Contains($forbidden)) { throw "Configurator contains forbidden LIVE-risk side effect: $forbidden" }
}

$bindingIndex = $switchSource.IndexOf('Assert-Phase7CLiveRiskProfileBinding')
$mutationIndex = $switchSource.IndexOf('$mutationStarted = $true')
if ($bindingIndex -lt 0) { throw "Account switch does not enforce LIVE risk profile binding." }
if ($mutationIndex -lt 0) { throw "Account switch mutation marker is missing." }
if ($bindingIndex -gt $mutationIndex) { throw "LIVE risk binding must be checked before account-switch mutation begins." }

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-live-risk-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $envPath = Join-Path $tempRoot ".env.phase7b-live"
  $terminalPath = "C:\Program Files\MT5-LIVE\terminal64.exe"
  $login = 987654321L
  $server = "Broker-Live"
  [System.IO.File]::WriteAllText(
    $envPath,
    (@(
      "MT5_TERMINAL_PATH=$terminalPath",
      "MT5_LOGIN=$login",
      "MT5_SERVER=$server",
      "MT5_ALLOWED_LOGINS=$login"
    ) -join "`r`n") + "`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  $fingerprint = Get-Phase7CLiveProfileFingerprint -Login $login -Server $server -TerminalPath $terminalPath
  $profile = [pscustomobject]@{
    version = 1
    accountMode = "LIVE"
    accountLogin = $login
    server = $server
    profileFingerprint = $fingerprint
    trendFixedLot = 0.03
    sidewayRiskPercent = 0.01
    sidewayMaxLot = 0.03
    appliesTo = "NEW_POSITIONS_ONLY"
    martingale = $false
    recoveryLotEscalation = $false
  }

  $bound = Assert-Phase7CLiveRiskProfileBinding -Profile $profile -LiveEnvFile $envPath
  if ($bound.profile.trendFixedLot -ne 0.03 -or $bound.login -ne $login) {
    throw "Valid LIVE risk binding did not round-trip correctly."
  }

  $wrongLogin = $profile.PSObject.Copy()
  $wrongLogin.accountLogin = $login + 1
  Assert-Throws { [void](Assert-Phase7CLiveRiskProfileBinding -Profile $wrongLogin -LiveEnvFile $envPath) } "login mismatch"

  $wrongFingerprint = $profile.PSObject.Copy()
  $wrongFingerprint.profileFingerprint = ("0" * 64)
  Assert-Throws { [void](Assert-Phase7CLiveRiskProfileBinding -Profile $wrongFingerprint -LiveEnvFile $envPath) } "terminal/profile mismatch"

  $martingale = $profile.PSObject.Copy()
  $martingale.martingale = $true
  Assert-Throws { [void](Assert-Phase7CLiveRiskProfileBinding -Profile $martingale -LiveEnvFile $envPath) } "martingale must remain disabled"

  $invalidIncrement = $profile.PSObject.Copy()
  $invalidIncrement.trendFixedLot = 0.04
  Assert-Throws { [void](Assert-Phase7CLiveRiskProfileBinding -Profile $invalidIncrement -LiveEnvFile $envPath) } "existing 0.03 lot increment guard"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "PHASE7C_LIVE_RISK_PROFILE_SOURCE_TEST=PASS"