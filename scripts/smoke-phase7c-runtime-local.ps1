param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$WebUrl = "http://127.0.0.1:5717",
  [switch]$SkipTelegramRequirement
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-executors-local.ps1"

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
  $WorkDir = Join-Path $ProjectRoot $WorkDir
}
if (-not (Test-Path -LiteralPath $WorkDir)) {
  throw "WorkDir not found: $WorkDir"
}
$WorkDir = (Resolve-Path $WorkDir).Path
if (-not (Test-Path -LiteralPath $Verifier)) {
  throw "Phase 7C verifier not found: $Verifier"
}

$apiBase = $ControlApiUrl.TrimEnd('/')
$webBase = $WebUrl.TrimEnd('/')

# First run the canonical runtime verifier. This is read-only and validates
# executor liveness, ownership, DEMO account binding, lot safety and Telegram.
$verifyArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", ('"{0}"' -f $Verifier),
  "-WorkDir", ('"{0}"' -f $WorkDir),
  "-ControlApiUrl", ('"{0}"' -f $apiBase)
)
if (-not $SkipTelegramRequirement) {
  $verifyArgs += "-RequireTelegram"
}

& powershell.exe @verifyArgs
if ($LASTEXITCODE -ne 0) {
  throw "Phase 7C canonical verifier failed with exit code $LASTEXITCODE."
}
Write-Host "PHASE7C_SMOKE_VERIFY=PASS"

# Validate the semantic UI contract used by MT5 FINAL v5.2 and the web UI.
$semantic = Invoke-RestMethod `
  -Uri "$apiBase/api/v1/phase7c-ui?symbol=XAUUSD" `
  -Method Get `
  -TimeoutSec 10

$semanticMt5 = Invoke-WebRequest `
  -Uri "$apiBase/api/v1/phase7c-ui/mt5?symbol=XAUUSD" `
  -Method Get `
  -UseBasicParsing `
  -TimeoutSec 10

if ([int]$semantic.version -ne 2) {
  throw "Phase 7C semantic UI contract version must be 2. Actual=$($semantic.version)"
}
$validUiStates = @("WAITING", "SETUP_READY", "MANAGING")
if ($validUiStates -notcontains [string]$semantic.uiState) {
  throw "Phase 7C semantic UI state is invalid. Actual=$($semantic.uiState)"
}
if (
  [string]$semantic.safety.orderPermission -ne "NONE" -or
  [bool]$semantic.safety.readOnly -ne $true -or
  [bool]$semantic.safety.demoOnly -ne $true -or
  [bool]$semantic.safety.newPositionsOnly -ne $true
) {
  throw "Phase 7C semantic UI JSON lost its read-only DEMO safety contract."
}
if (
  $semanticMt5.Content -notmatch '(?m)^version=2\r?$' -or
  $semanticMt5.Content -notmatch '(?m)^mt5OrderPermission=NONE\r?$'
) {
  throw "Phase 7C semantic MT5 payload is missing version=2 or mt5OrderPermission=NONE."
}
Write-Host "PHASE7C_SMOKE_SEMANTIC_UI=PASS|VERSION=$($semantic.version)|STATE=$($semantic.uiState)"
Write-Host "PHASE7C_SMOKE_MT5_PANEL=PASS|ORDER_PERMISSION=NONE"

# Probe the live chart API and the actual web root without mutating trading state.
$chart = Invoke-RestMethod `
  -Uri "$apiBase/api/v1/phase7c-chart/candles?symbol=XAUUSD&count=20" `
  -Method Get `
  -TimeoutSec 10
if ($null -eq $chart) {
  throw "Phase 7C chart endpoint returned no payload."
}
Write-Host "PHASE7C_SMOKE_CHART=PASS"

$web = Invoke-WebRequest `
  -Uri "$webBase/" `
  -Method Get `
  -UseBasicParsing `
  -TimeoutSec 10
if ($web.StatusCode -lt 200 -or $web.StatusCode -ge 400) {
  throw "Phase 7C web root is unhealthy. HTTP=$($web.StatusCode)"
}
Write-Host "PHASE7C_SMOKE_WEB=PASS|HTTP=$($web.StatusCode)"

Write-Host "PHASE7C_SMOKE_STATUS=PASS"
