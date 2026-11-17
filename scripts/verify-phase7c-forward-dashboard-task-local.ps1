param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$TaskName = "XAUUSD-Phase7C-Forward-Dashboard",
  [string]$HostAddress = "127.0.0.1",
  [int]$Port = 5727,
  [int]$HttpTimeoutSeconds = 10,
  [int]$RefreshFreshnessGraceSeconds = 120
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskRunner = Join-Path $PSScriptRoot "run-phase7c-forward-dashboard-task-runner-local.ps1"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-dashboard-task-config.json"

if (-not (Test-Path $TaskRunner)) { throw "Phase 7C forward dashboard task runner not found: $TaskRunner" }
if (-not (Test-Path $ConfigPath)) { throw "Phase 7C forward dashboard task config not found: $ConfigPath" }
if ($HostAddress -notin @("127.0.0.1", "localhost", "::1")) { throw "Dashboard verifier only accepts loopback hosts." }
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }
if ($HttpTimeoutSeconds -lt 1 -or $HttpTimeoutSeconds -gt 60) { throw "HttpTimeoutSeconds must be between 1 and 60." }
if ($RefreshFreshnessGraceSeconds -lt 0 -or $RefreshFreshnessGraceSeconds -gt 600) { throw "RefreshFreshnessGraceSeconds must be between 0 and 600." }

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([int]$config.version -ne 1) { throw "Dashboard task config version is unsupported." }
if (-not [bool]$config.readOnly) { throw "Dashboard task config reports readOnly=false." }
if ([bool]$config.mt5Mutation) { throw "Dashboard task config reports mt5Mutation=true." }
if ([string]$config.workDir -ne $WorkDir) { throw "Dashboard task config WorkDir mismatch: $($config.workDir)" }
if ([int]$config.port -ne $Port) { throw "Dashboard task config Port mismatch: $($config.port)" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1) { throw "Dashboard task must have exactly one action; found $($actions.Count)." }
$action = $actions[0]
$actionText = "$([string]$action.Execute) $([string]$action.Arguments)"
$actionOk = [string]$action.Execute -match "powershell" -and $actionText -like "*run-phase7c-forward-dashboard-task-runner-local.ps1*"
if (-not $actionOk) { throw "Dashboard task action does not match the expected Phase 7C read-only task runner." }
if ($actionText -match "(?i)(MT5_(?:API|BRIDGE_API)_KEY\s*=|ZIQ_TELEGRAM_BOT_TOKEN\s*=|x-phase7c-token)") {
  throw "Dashboard task action contains a secret-like value."
}
$bootTrigger = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" })
if ($bootTrigger.Count -lt 1) { throw "Dashboard task does not have an AtStartup trigger." }
$principal = ([string]$task.Principal.UserId).Trim()
if ($principal -notmatch '^(?i)(SYSTEM|NT AUTHORITY\\SYSTEM|S-1-5-18)$') {
  throw "Dashboard task principal is not SYSTEM: $principal"
}

$executionTimeLimitRaw = $task.Settings.ExecutionTimeLimit
$executionTimeLimit = $null
if ($executionTimeLimitRaw -is [TimeSpan]) {
  $executionTimeLimit = [TimeSpan]$executionTimeLimitRaw
} else {
  try {
    $executionTimeLimit = [System.Xml.XmlConvert]::ToTimeSpan([string]$executionTimeLimitRaw)
  }
  catch {
    throw "Dashboard task ExecutionTimeLimit could not be parsed: $executionTimeLimitRaw"
  }
}
if ($executionTimeLimit -ne [TimeSpan]::Zero) {
  throw "Dashboard task ExecutionTimeLimit is not unlimited: $executionTimeLimitRaw"
}

Write-Host "PHASE7C_DASHBOARD_VERIFY_TASK_STATE=$($task.State)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_TASK_ACTION=PASS"
Write-Host "PHASE7C_DASHBOARD_VERIFY_TASK_TRIGGER=AT_STARTUP"
Write-Host "PHASE7C_DASHBOARD_VERIFY_TASK_PRINCIPAL=$principal"
Write-Host "PHASE7C_DASHBOARD_VERIFY_EXECUTION_TIME_LIMIT=UNLIMITED"
Write-Host "PHASE7C_DASHBOARD_VERIFY_SECRETS_IN_ARGUMENTS=False"
Write-Host "PHASE7C_DASHBOARD_VERIFY_CONFIG_READ_ONLY=$([bool]$config.readOnly)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_CONFIG_MT5_MUTATION=$([bool]$config.mt5Mutation)"

if ([string]$task.State -ne "Running") {
  throw "Dashboard scheduled task is not Running. Current state=$($task.State). Start it after stopping any manually launched dashboard."
}

$baseUrl = "http://${HostAddress}:${Port}"
$health = Invoke-RestMethod -Method Get -Uri "$baseUrl/health" -TimeoutSec $HttpTimeoutSeconds
if ([string]$health.status -ne "ok") { throw "Dashboard health status is not ok." }
if (-not [bool]$health.readOnly) { throw "Dashboard health reports readOnly=false." }
if ([bool]$health.mt5Mutation) { throw "Dashboard health reports mt5Mutation=true." }
if (-not [bool]$health.reportAvailable) { throw "Dashboard reports no forward report available." }

Write-Host "PHASE7C_DASHBOARD_VERIFY_HTTP=PASS"
Write-Host "PHASE7C_DASHBOARD_VERIFY_READ_ONLY=$([bool]$health.readOnly)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_MT5_MUTATION=$([bool]$health.mt5Mutation)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_REPORT_AVAILABLE=$([bool]$health.reportAvailable)"

$snapshot = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/dashboard" -TimeoutSec $HttpTimeoutSeconds
if (-not [bool]$snapshot.readOnly) { throw "Dashboard snapshot reports readOnly=false." }
if ([bool]$snapshot.mt5Mutation) { throw "Dashboard snapshot reports mt5Mutation=true." }
if ($null -eq $snapshot.report) { throw "Dashboard snapshot does not contain a forward report." }
$accountMode = [string]$snapshot.report.account.mode
if ($accountMode.ToLowerInvariant() -ne "demo") { throw "Dashboard report is not DEMO. account.mode=$accountMode" }

Write-Host "PHASE7C_DASHBOARD_VERIFY_ACCOUNT_LOGIN=$($snapshot.report.account.login)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_ACCOUNT_MODE=$accountMode"
Write-Host "PHASE7C_DASHBOARD_VERIFY_ACTIVE_MODE=$($snapshot.live.mode)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_REGIME=$($snapshot.live.regime)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_RECOMMENDED_MODE=$($snapshot.live.recommendedMode)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_CONFIDENCE=$($snapshot.live.confidence)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_REPORT_GENERATED=$($snapshot.report.generatedAtIso)"

$statusPath = Join-Path $WorkDir "phase7c-reports\auto-refresh-status.json"
if (-not (Test-Path $statusPath)) { throw "Auto-refresh status file not found: $statusPath" }
$status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
if ([string]$status.status -ne "PASS") { throw "Auto-refresh status is not PASS: $($status.status). Message=$($status.message)" }
if (-not [bool]$status.readOnly) { throw "Auto-refresh status reports readOnly=false." }
if ([bool]$status.mt5Mutation) { throw "Auto-refresh status reports mt5Mutation=true." }
if ([int]$status.exitCode -ne 0) { throw "Auto-refresh status exitCode=$($status.exitCode)." }

$finishedAt = [long]$status.finishedAt
$intervalSeconds = [int]$status.intervalSeconds
if ($finishedAt -le 0 -or $intervalSeconds -le 0) { throw "Auto-refresh status is missing freshness fields." }
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$ageMs = [Math]::Max(0, $nowMs - $finishedAt)
$maximumAgeMs = ([long]$intervalSeconds + [long]$RefreshFreshnessGraceSeconds) * 1000
if ($ageMs -gt $maximumAgeMs) {
  throw "Auto-refresh PASS is stale: ageMs=$ageMs maximumAgeMs=$maximumAgeMs"
}

Write-Host "PHASE7C_DASHBOARD_VERIFY_AUTO_REFRESH_STATUS=$($status.status)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_AUTO_REFRESH_INTERVAL_SECONDS=$intervalSeconds"
Write-Host "PHASE7C_DASHBOARD_VERIFY_AUTO_REFRESH_AGE_MS=$ageMs"
Write-Host "PHASE7C_DASHBOARD_VERIFY_AUTO_REFRESH_READ_ONLY=$([bool]$status.readOnly)"
Write-Host "PHASE7C_DASHBOARD_VERIFY_AUTO_REFRESH_MT5_MUTATION=$([bool]$status.mt5Mutation)"
Write-Host "PHASE7C_DASHBOARD_TASK_VERIFY=PASS"
