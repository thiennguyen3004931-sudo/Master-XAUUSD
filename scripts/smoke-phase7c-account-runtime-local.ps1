param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [Parameter(Mandatory = $true)] [ValidateSet("DEMO", "LIVE")] [string]$ExpectedAccountMode,
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$WebUrl = "http://127.0.0.1:5717",
  [switch]$SkipTelegramRequirement
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path
if (-not (Test-Path -LiteralPath $Verifier)) { throw "Dual-account verifier not found: $Verifier" }

$apiBase = $ControlApiUrl.TrimEnd('/')
$webBase = $WebUrl.TrimEnd('/')
$verifyArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $Verifier),
  "-WorkDir", ('"{0}"' -f $WorkDir),
  "-ExpectedAccountMode", $ExpectedAccountMode,
  "-ControlApiUrl", ('"{0}"' -f $apiBase)
)
if (-not $SkipTelegramRequirement) { $verifyArgs += "-RequireTelegram" }
& powershell.exe @verifyArgs
if ($LASTEXITCODE -ne 0) { throw "Phase7C dual-account verifier failed with exit code $LASTEXITCODE." }
Write-Host "PHASE7C_ACCOUNT_SMOKE_VERIFY=PASS"

$semantic = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c-ui?symbol=XAUUSD" -Method Get -TimeoutSec 10
$semanticMt5 = Invoke-WebRequest -Uri "$apiBase/api/v1/phase7c-ui/mt5?symbol=XAUUSD" -Method Get -UseBasicParsing -TimeoutSec 10
if ([int]$semantic.version -ne 2) { throw "Phase7C semantic UI contract version must be 2." }
if (@("WAITING", "SETUP_READY", "MANAGING") -notcontains [string]$semantic.uiState) { throw "Phase7C semantic UI state is invalid." }
$expectedDemoOnly = $ExpectedAccountMode -eq "DEMO"
if (
  [string]$semantic.safety.orderPermission -ne "NONE" -or
  [bool]$semantic.safety.readOnly -ne $true -or
  [bool]$semantic.safety.demoOnly -ne $expectedDemoOnly -or
  [bool]$semantic.safety.newPositionsOnly -ne $true -or
  [string]$semantic.safety.accountMode -ne $ExpectedAccountMode
) {
  throw "Phase7C semantic UI safety contract does not match selected account mode or read-only policy."
}
if ($semanticMt5.Content -notmatch '(?m)^version=2\r?$' -or $semanticMt5.Content -notmatch '(?m)^mt5OrderPermission=NONE\r?$') {
  throw "Phase7C semantic MT5 payload is missing version=2 or mt5OrderPermission=NONE."
}
Write-Host "PHASE7C_ACCOUNT_SMOKE_SEMANTIC_UI=PASS|MODE=$ExpectedAccountMode|STATE=$($semantic.uiState)"
Write-Host "PHASE7C_ACCOUNT_SMOKE_MT5_PANEL=PASS|ORDER_PERMISSION=NONE"

$chart = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c-chart/candles?symbol=XAUUSD&count=20" -Method Get -TimeoutSec 10
if ($null -eq $chart) { throw "Phase7C chart endpoint returned no payload." }
Write-Host "PHASE7C_ACCOUNT_SMOKE_CHART=PASS"
$web = Invoke-WebRequest -Uri "$webBase/" -Method Get -UseBasicParsing -TimeoutSec 10
if ($web.StatusCode -lt 200 -or $web.StatusCode -ge 400) { throw "Phase7C web root is unhealthy. HTTP=$($web.StatusCode)" }
Write-Host "PHASE7C_ACCOUNT_SMOKE_WEB=PASS|HTTP=$($web.StatusCode)"
Write-Host "PHASE7C_ACCOUNT_SMOKE_STATUS=PASS"
