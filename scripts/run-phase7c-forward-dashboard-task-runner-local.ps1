param(
  [int]$RestartDelaySeconds = 15
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot "run-phase7c-forward-dashboard-local.ps1"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-dashboard-task-config.json"

if (-not (Test-Path $Launcher)) { throw "Phase 7C dashboard launcher not found: $Launcher" }
if (-not (Test-Path $ConfigPath)) { throw "Phase 7C dashboard task config not found: $ConfigPath" }
if ($RestartDelaySeconds -lt 5 -or $RestartDelaySeconds -gt 300) { throw "RestartDelaySeconds must be between 5 and 300." }

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([int]$config.version -ne 1) { throw "Unsupported dashboard task config version: $($config.version)" }
if (-not [bool]$config.readOnly) { throw "Dashboard task config must remain readOnly=true." }
if ([bool]$config.mt5Mutation) { throw "Dashboard task config must remain mt5Mutation=false." }

$hostAddress = [string]$config.hostAddress
if ($hostAddress -notin @("127.0.0.1", "localhost", "::1")) { throw "Dashboard task config must remain loopback-only." }
$port = [int]$config.port
if ($port -lt 1 -or $port -gt 65535) { throw "Dashboard task config port is invalid: $port" }

$workDir = [string]$config.workDir
$controlApiUrl = [string]$config.controlApiUrl
$envFile = [string]$config.envFile
$refreshSeconds = [int]$config.refreshSeconds
$reportRefreshSeconds = [int]$config.reportRefreshSeconds
$reportLookbackDays = [int]$config.reportLookbackDays

if (-not (Test-Path $workDir)) { throw "Dashboard task WorkDir not found: $workDir" }
if (-not (Test-Path $envFile)) { throw "Dashboard task EnvFile not found: $envFile" }

Write-Host "PHASE7C_DASHBOARD_TASK_RUNNER=RUNNING"
Write-Host "PHASE7C_DASHBOARD_TASK_RUNNER_READ_ONLY=TRUE"
Write-Host "PHASE7C_DASHBOARD_TASK_RUNNER_MT5_MUTATION=NONE"
Write-Host "PHASE7C_DASHBOARD_TASK_RUNNER_URL=http://${hostAddress}:${port}/"

while ($true) {
  try {
    & $Launcher `
      -WorkDir $workDir `
      -ControlApiUrl $controlApiUrl `
      -EnvFile $envFile `
      -HostAddress $hostAddress `
      -Port $port `
      -RefreshSeconds $refreshSeconds `
      -ReportRefreshSeconds $reportRefreshSeconds `
      -ReportLookbackDays $reportLookbackDays

    Write-Warning "Phase 7C forward dashboard launcher exited normally; restarting in $RestartDelaySeconds seconds."
  }
  catch {
    Write-Warning "Phase 7C forward dashboard launcher failed: $($_.Exception.Message). Restarting in $RestartDelaySeconds seconds."
  }

  Start-Sleep -Seconds $RestartDelaySeconds
}
