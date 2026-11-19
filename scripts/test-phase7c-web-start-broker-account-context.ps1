$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$BrokerRunner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message actual=$Actual expected=$Expected" }
}

foreach ($required in @($AccountLibrary, $BrokerRunner)) {
  Assert-True (Test-Path -LiteralPath $required) "Missing source dependency: $required"
}
. $AccountLibrary

$tokens = $null
$errors = $null
$runnerAst = [System.Management.Automation.Language.Parser]::ParseFile($BrokerRunner, [ref]$tokens, [ref]$errors)
Assert-Equal $errors.Count 0 "SYSTEM lifecycle broker runner must parse"
$readLaunchConfigAst = $runnerAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Read-Phase7CCanonicalLaunchConfig"
}, $true)
Assert-True ($null -ne $readLaunchConfigAst) "Read-Phase7CCanonicalLaunchConfig must exist"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-web-start-broker-context-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $runtimeRoot = Join-Path $tempRoot ".runtime"
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

  $workDir = $runtimeRoot
  $ConfigPath = Join-Path $runtimeRoot "phase7c-executor-task-config.json"
  $AccountStatePath = Join-Path $runtimeRoot "phase7c-account-mode.json"
  $demoEnvFile = Join-Path $tempRoot "demo.env"
  $liveEnvFile = Join-Path $tempRoot "live.env"
  $telegramEnvFile = Join-Path $tempRoot "telegram.env"
  $nodePath = Join-Path $tempRoot "node.exe"
  $pnpmPath = Join-Path $tempRoot "pnpm.cmd"

  @(
    "MT5_API_KEY=synthetic-demo-key",
    "MT5_BRIDGE_HOST=127.0.0.1",
    "MT5_BRIDGE_PORT=8765",
    "MT5_ALLOW_REAL_ACCOUNT=false",
    "MT5_TRADING_ENABLED=true",
    "MT5_ALLOWED_LOGINS=123456"
  ) | Set-Content -LiteralPath $demoEnvFile -Encoding ASCII

  @(
    "MT5_API_KEY=synthetic-live-key",
    "MT5_BRIDGE_HOST=127.0.0.1",
    "MT5_BRIDGE_PORT=8765",
    "MT5_ALLOW_REAL_ACCOUNT=true",
    "MT5_TRADING_ENABLED=true",
    "MT5_ALLOWED_LOGINS=123456",
    "MT5_MAGIC_NUMBER=270715"
  ) | Set-Content -LiteralPath $liveEnvFile -Encoding ASCII

  "synthetic" | Set-Content -LiteralPath $telegramEnvFile -Encoding ASCII
  "synthetic" | Set-Content -LiteralPath $nodePath -Encoding ASCII
  "synthetic" | Set-Content -LiteralPath $pnpmPath -Encoding ASCII

  [pscustomobject]@{
    version = 1
    trendFixedLot = 0.03
    sidewayRiskPercent = 0.25
    sidewayMaxLot = 0.03
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $workDir "phase7c-lot-settings.json") -Encoding UTF8

  # Deliberately stale SYSTEM task config: DEMO.
  [pscustomobject]@{
    version = 2
    armed = $true
    accountMode = "DEMO"
    liveExecutionEnabled = $false
    demoOnly = $true
    workDir = $workDir
    controlApiUrl = "http://127.0.0.1:3711"
    envFile = $demoEnvFile
    telegramEnvFile = $telegramEnvFile
    nodePath = $nodePath
    pnpmPath = $pnpmPath
    trendFixedVolume = 0.03
    sidewayRiskPercent = 0.25
    sidewayMaxLot = 0.03
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

  # Canonical account state after guarded Web auto-selection: LIVE.
  [pscustomobject]@{
    version = 1
    accountMode = "LIVE"
    liveExecutionEnabled = $true
    envFile = $liveEnvFile
    updatedAt = "2026-08-30T00:00:00.000Z"
    updatedBy = "web-auto-detect:LIVE"
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $AccountStatePath -Encoding UTF8

  # Keep the production function isolated while preserving its real file/config behavior.
  $ProjectRoot = $tempRoot
  Invoke-Expression $readLaunchConfigAst.Extent.Text
  $resolved = Read-Phase7CCanonicalLaunchConfig

  Assert-Equal ([string]$resolved.accountMode) "LIVE" "SYSTEM launch config must use canonical Web-selected account mode instead of stale task config"
  Assert-Equal ([bool]$resolved.liveExecutionEnabled) $true "SYSTEM launch config must carry canonical LIVE execution capability"
  Assert-Equal ([string]$resolved.envFile) ([string](Resolve-Path -LiteralPath $liveEnvFile).Path) "SYSTEM launch config must use the canonical Web-selected account env"

  Write-Host "PHASE7C_WEB_START_BROKER_ACCOUNT_CONTEXT_TEST=PASS"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
