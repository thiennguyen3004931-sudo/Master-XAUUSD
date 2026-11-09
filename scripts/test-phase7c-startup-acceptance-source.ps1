$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-startup-acceptance-local.ps1"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

if (-not (Test-Path -LiteralPath $Verifier)) {
  throw "Missing startup acceptance verifier: $Verifier"
}

Assert-PowerShellSyntax $Verifier
$text = Get-Content -LiteralPath $Verifier -Raw

Assert-True ($text -match 'Get-ScheduledTask') "acceptance verifier must inspect Scheduled Task state"
Assert-True ($text -match 'Test-Phase7CExecutorTaskActionOwnership') "acceptance verifier must validate exact task ownership"
Assert-True ($text -match 'Get-Phase7CExecutorTaskDrift') "acceptance verifier must reject canonical task drift"
Assert-True ($text -match 'Principal\.UserId') "acceptance verifier must inspect Scheduled Task principal user"
Assert-True ($text -match '(?i)SYSTEM') "acceptance verifier must require SYSTEM principal"
Assert-True ($text -match 'Principal\.RunLevel') "acceptance verifier must inspect Highest run level"
Assert-True ($text -match 'startup-runner-status\.json') "acceptance verifier must read startup runner status"
Assert-True ($text -match 'Get-Phase7CStartupRunnerLockState') "acceptance verifier must inspect singleton lock state"
Assert-True ($text -match 'supervisorPid') "acceptance verifier must verify the supervisor PID from runner status"
Assert-True ($text -match 'trend\.pid') "acceptance verifier must verify Trend PID state"
Assert-True ($text -match 'sideway\.pid') "acceptance verifier must verify Sideway PID state"
Assert-True ($text -match 'startup-supervisor\.out\.log') "acceptance verifier must inspect the current supervisor startup log"
Assert-True ($text -match 'PHASE7C_STARTUP_BOT_MODE=PAUSE') "acceptance verifier must require the runtime PAUSE marker"
Assert-True ($text -match 'PHASE7C_STARTUP_BOT_MODE_SOURCE=startup-scheduled-task') "acceptance verifier must require startup PAUSE provenance marker"
Assert-True ($text -match 'PHASE7C_TREND_PID=') "acceptance verifier must locate Trend launch marker"
Assert-True ($text -match 'PHASE7C_SIDEWAY_PID=') "acceptance verifier must locate Sideway launch marker"
Assert-True ($text -match '(?s)IndexOf\([^\)]*PHASE7C_STARTUP_BOT_MODE=PAUSE.*IndexOf\([^\)]*PHASE7C_TREND_PID=') "acceptance verifier must compare PAUSE and Trend marker order"
Assert-True ($text -match '(?s)IndexOf\([^\)]*PHASE7C_STARTUP_BOT_MODE=PAUSE.*IndexOf\([^\)]*PHASE7C_SIDEWAY_PID=') "acceptance verifier must compare PAUSE and Sideway marker order"
Assert-True ($text -match '/api/v1/phase7c/bot-mode') "acceptance verifier must read canonical bot mode API"
Assert-True ($text -match '(?s)Invoke-RestMethod.*?/api/v1/phase7c/bot-mode.*?-Method\s+Get') "canonical bot mode check must be read-only GET"
Assert-True ($text -match 'state\.mode') "acceptance verifier must inspect canonical mode"
Assert-True ($text -match 'state\.updatedBy') "acceptance verifier must inspect canonical mode provenance"
Assert-True ($text -match '(?i)PAUSE') "acceptance verifier must require PAUSE mode"
Assert-True ($text -match 'startup-scheduled-task') "acceptance verifier must require startup-scheduled-task provenance"
Assert-True ($text -match 'accountMode') "acceptance verifier must report runner account mode"
Assert-True ($text -match '(?s)DEMO.*LIVE|(?s)LIVE.*DEMO') "acceptance verifier must accept both DEMO and LIVE runner status"

$forbidden = @(
  'Start-ScheduledTask',
  'Stop-ScheduledTask',
  'Register-ScheduledTask',
  'Unregister-ScheduledTask',
  'Set-ScheduledTask',
  '(?i)-Method\s+(Post|Put|Patch|Delete)',
  '(?i)/v1/orders',
  '(?i)/v1/order'
)
foreach ($pattern in $forbidden) {
  Assert-True (-not ($text -match $pattern)) "acceptance verifier must remain read-only; forbidden pattern=$pattern"
}

Write-Host "PHASE7C_STARTUP_ACCEPTANCE_SOURCE_TEST=PASS"
