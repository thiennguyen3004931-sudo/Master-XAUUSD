$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw "ASSERT_TRUE failed: $Message" }
}
function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "ASSERT_EQUAL failed: $Message. Expected=$Expected Actual=$Actual" }
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Message) {
  $threw = $false
  try { & $Action } catch {
    $threw = $true
    if ($_.Exception.Message -notmatch $Pattern) {
      throw "ASSERT_THROWS wrong error: $Message. Error=$($_.Exception.Message)"
    }
  }
  if (-not $threw) { throw "ASSERT_THROWS failed: $Message" }
}
function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if (@($errors).Count -gt 0) {
    throw "PowerShell syntax errors in ${Path}: $(@($errors | ForEach-Object Message) -join ' | ')"
  }
}

if (-not (Test-Path $AccountLibrary)) { throw "Missing Phase7C account library: $AccountLibrary" }
. $AccountLibrary

$powerShellFiles = @(
  "lib\phase7c-account-mode.ps1",
  "register-phase7c-account-bridge-task-local.ps1",
  "run-phase7c-account-bridge-task-runner-local.ps1",
  "run-phase7c-executor-task-runner-local.ps1",
  "run-phase7c-executors-local.ps1",
  "run-phase7c-sideway-controller-local.ps1",
  "run-phase7c-trend-controller-local.ps1",
  "set-phase7c-account-risk-profile-local.ps1",
  "smoke-phase7c-account-runtime-local.ps1",
  "switch-phase7c-account-mode-local.ps1",
  "verify-phase7c-account-runtime-local.ps1"
)
foreach ($relative in $powerShellFiles) {
  $path = Join-Path $PSScriptRoot $relative
  Assert-True (Test-Path $path) "required dual-account PowerShell file must exist: $relative"
  Assert-PowerShellSyntax $path
}

$bridgeRun = Join-Path $ProjectRoot "packages\mt5-broker\bridge\run.ps1"
Assert-True (Test-Path $bridgeRun) "bridge run.ps1 must exist"
Assert-PowerShellSyntax $bridgeRun
$bridgeRunText = Get-Content -LiteralPath $bridgeRun -Raw
Assert-True ($bridgeRunText -match 'TrimStart\(\[char\]0xFEFF\)') "bridge env loader must normalize a UTF-8 BOM on variable names"
Assert-True ($bridgeRunText -match 'StartsWith\(''"''\).*EndsWith\(''"''\)') "bridge env loader must strip matching double quotes"
Assert-True ($bridgeRunText -match 'StartsWith\("''"\).*EndsWith\("''"\)') "bridge env loader must strip matching single quotes"

$bridgeRegister = Join-Path $PSScriptRoot "register-phase7c-account-bridge-task-local.ps1"
$bridgeRegisterText = Get-Content -LiteralPath $bridgeRegister -Raw
Assert-True ($bridgeRegisterText -match 'System32\\WindowsPowerShell\\v1\.0\\powershell\.exe') "bridge task registration must use an absolute Windows PowerShell executable"
Assert-True ($bridgeRegisterText -notmatch '-Execute\s+"powershell\.exe"') "bridge task registration must not use a PATH-dependent powershell.exe action"
Assert-True ($bridgeRegisterText -match 'registeredAction\.Execute\s+-ne\s+\$PowerShellExe') "bridge task registration must verify the persisted executable path"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-dual-account-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $demoEnv = Join-Path $tempRoot "demo.env"
  $liveEnv = Join-Path $tempRoot "live.env"
  $badDemoEnv = Join-Path $tempRoot "bad-demo.env"
  $badLiveEnv = Join-Path $tempRoot "bad-live.env"
  $missingLiveMagicEnv = Join-Path $tempRoot "missing-live-magic.env"
  $wrongLiveMagicEnv = Join-Path $tempRoot "wrong-live-magic.env"
  $wrongSidewayMagicEnv = Join-Path $tempRoot "wrong-sideway-magic.env"
  $common = @(
    "MT5_API_KEY=unit-test-shared-key-123456789",
    "MT5_BRIDGE_HOST=127.0.0.1",
    "MT5_BRIDGE_PORT=8765",
    "MT5_TRADING_ENABLED=true",
    "MT5_ALLOWED_LOGINS=123456"
  )
  Set-Content -LiteralPath $demoEnv -Value (@($common) + "MT5_ALLOW_REAL_ACCOUNT=false") -Encoding utf8
  Set-Content -LiteralPath $liveEnv -Value (@($common) + @("MT5_ALLOW_REAL_ACCOUNT=true", "MT5_MAGIC_NUMBER=270715")) -Encoding utf8
  Set-Content -LiteralPath $badDemoEnv -Value (@($common) + "MT5_ALLOW_REAL_ACCOUNT=true") -Encoding utf8
  Set-Content -LiteralPath $badLiveEnv -Value (@($common) + @("MT5_ALLOW_REAL_ACCOUNT=false", "MT5_MAGIC_NUMBER=270715")) -Encoding utf8
  Set-Content -LiteralPath $missingLiveMagicEnv -Value (@($common) + "MT5_ALLOW_REAL_ACCOUNT=true") -Encoding utf8
  Set-Content -LiteralPath $wrongLiveMagicEnv -Value (@($common) + @("MT5_ALLOW_REAL_ACCOUNT=true", "MT5_MAGIC_NUMBER=270999")) -Encoding utf8
  Set-Content -LiteralPath $wrongSidewayMagicEnv -Value (@($common) + @("MT5_ALLOW_REAL_ACCOUNT=true", "MT5_MAGIC_NUMBER=270715", "ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER=270999")) -Encoding utf8

  $demo = Assert-Phase7CAccountEnv -EnvFile $demoEnv -AccountMode DEMO -RequireTrading
  $live = Assert-Phase7CAccountEnv -EnvFile $liveEnv -AccountMode LIVE -RequireTrading
  Assert-Equal $demo.accountMode "DEMO" "DEMO env must validate as DEMO"
  Assert-Equal $live.accountMode "LIVE" "LIVE env must validate as LIVE"
  Assert-Equal $demo.apiKey $live.apiKey "DEMO/LIVE test envs should share bridge API key"
  Assert-Throws { Assert-Phase7CAccountEnv -EnvFile $badDemoEnv -AccountMode DEMO -RequireTrading } "must keep MT5_ALLOW_REAL_ACCOUNT=false" "DEMO must reject real-account permission"
  Assert-Throws { Assert-Phase7CAccountEnv -EnvFile $badLiveEnv -AccountMode LIVE -RequireTrading } "requires MT5_ALLOW_REAL_ACCOUNT=true" "LIVE must require explicit real-account permission"
  Assert-Throws { Assert-Phase7CAccountEnv -EnvFile $missingLiveMagicEnv -AccountMode LIVE -RequireTrading } "LIVE env requires MT5_MAGIC_NUMBER=270715" "LIVE must reject a missing canonical Trend magic"
  Assert-Throws { Assert-Phase7CAccountEnv -EnvFile $wrongLiveMagicEnv -AccountMode LIVE -RequireTrading } "LIVE env requires MT5_MAGIC_NUMBER=270715" "LIVE must reject a drifting Trend magic"
  Assert-Throws { Assert-Phase7CAccountEnv -EnvFile $wrongSidewayMagicEnv -AccountMode LIVE -RequireTrading } "LIVE env requires ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER=270714 when configured" "LIVE must reject a drifting Sideway magic override"

  $validRisk = Assert-Phase7CRiskProfile ([pscustomobject]@{
    version = 1
    trendFixedLot = 0.12
    sidewayRiskPercent = 1
    sidewayMaxLot = 0.30
  }) "unit risk"
  Assert-Equal $validRisk.trendFixedLot 0.12 "valid Trend lot"
  Assert-Equal $validRisk.sidewayRiskPercent 1 "valid Sideway risk"
  Assert-Equal $validRisk.sidewayMaxLot 0.30 "valid Sideway max lot"
  Assert-Throws { Assert-Phase7CRiskProfile ([pscustomobject]@{ version = 1; trendFixedLot = 0.10; sidewayRiskPercent = 1; sidewayMaxLot = 0.30 }) "bad risk" } "0.03 increments" "managed lot must keep exact one-third compatibility"
  Assert-Throws { Assert-Phase7CRiskProfile ([pscustomobject]@{ version = 1; trendFixedLot = 0.12; sidewayRiskPercent = 1.01; sidewayMaxLot = 0.30 }) "bad risk" } "between 0.01 and 1.00" "Sideway risk cap must remain 1%"

  $switchText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "switch-phase7c-account-mode-local.ps1") -Raw
  Assert-True ($switchText -match 'ConfirmLiveExecution') "LIVE switch must require explicit confirmation"
  Assert-True ($switchText -match 'FINAL_BOT_MODE=PAUSE') "account switch must finish PAUSE"
  Assert-True ($switchText -match 'Account switch requires zero open XAUUSD positions') "account switch must require flat broker state"
  Assert-True ($switchText -match 'Wait-ExclusiveLockReleased') "account switch must wait for runner lock handoff"
  Assert-True ($switchText -match 'SCOPE=LISTENER_ONLY') "bridge cleanup must kill only proven listener"

  $supervisorText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1") -Raw
  Assert-True ($supervisorText -match 'DecisionRuntimeBase') "decision audit must have a base directory"
  Assert-True ($supervisorText -match 'AccountMode\.ToLowerInvariant') "decision audit must be isolated by account mode"
  Assert-True ($supervisorText -match 'ZIQ_PHASE7C_DECISION_DIR') "executors must pass selected decision audit directory"
  Assert-True ($supervisorText -match 'accountMode = \$AccountMode') "active lot settings must record account mode"

  $verifierText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1") -Raw
  Assert-True ($verifierText -match 'mt5OrderPermission=NONE') "strict verifier must preserve read-only MT5 panel"
  Assert-True ($verifierText -match 'ExpectedAccountMode') "strict verifier must bind account mode"
  Assert-True ($verifierText -match 'allowedLogins') "strict verifier must enforce login allowlist"

  $node = Get-Command node -ErrorAction Stop
  & $node.Source (Join-Path $PSScriptRoot "test-phase7c-dual-account-mode.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Dual-account Node test failed with exit code $LASTEXITCODE." }

  Write-Host "PHASE7C_DUAL_ACCOUNT_POWERSHELL_TEST=PASS"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
