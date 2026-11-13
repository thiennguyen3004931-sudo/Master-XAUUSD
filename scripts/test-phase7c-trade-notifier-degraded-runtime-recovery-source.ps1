$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Deploy = Join-Path $PSScriptRoot 'deploy-phase7c-trade-notifier-local.ps1'
if (-not (Test-Path -LiteralPath $Deploy -PathType Leaf)) {
  throw "Missing trade notifier deploy helper: $Deploy"
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Deploy, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
  throw "Deploy helper syntax error: $($errors[0].Message)"
}

$source = Get-Content -LiteralPath $Deploy -Raw

function Assert-Contains([string]$Text, [string]$Needle, [string]$Label) {
  if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing degraded-runtime recovery contract: $Label"
  }
}

function Assert-NotMatch([string]$Text, [string]$Pattern, [string]$Label) {
  if ($Text -match $Pattern) {
    throw "Forbidden degraded-runtime recovery contract: $Label"
  }
}

# Production evidence: legacy/orphan notifier Node processes can exist while the
# canonical supervisor-owned trade-notifier.pid is missing. Hot reload must recover
# that state without touching supervisor/executor/control processes.
Assert-Contains $source 'PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_RUNTIME=DETECTED' 'explicit degraded runtime classification'
Assert-Contains $source 'Get-CimInstance Win32_Process' 'exact process discovery for legacy/orphan notifier cleanup'
Assert-Contains $source 'run-phase7b-telegram-notifier-local.ps1' 'wrapper process identity'
Assert-Contains $source 'run-phase7b-telegram-notifier.mjs' 'Node process identity'
Assert-Contains $source 'PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_PROCESS_COUNT' 'discovered degraded process count'
Assert-Contains $source 'PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_PROCESS_STOP' 'per-process notifier-only cleanup marker'
Assert-Contains $source 'PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_RUNTIME_RECOVERY=PASS' 'recovery completion marker'
Assert-Contains $source 'Supervisor did not establish a healthy replacement trade notifier' 'supervisor remains sole replacement owner'

# Recovery must be scoped to this exact checkout and must not bootstrap an unmanaged
# notifier directly from the deploy helper.
Assert-Contains $source '$ProjectRoot' 'project-root scoping'
Assert-NotMatch $source '(?im)^\s*Start-Process\b' 'deploy helper must never directly launch replacement notifier'
Assert-NotMatch $source '(?im)\b(?:Start|Stop|Register|Set)-ScheduledTask\b' 'degraded recovery must not mutate Scheduled Task'
Assert-NotMatch $source '(?i)/v1/orders(?:/|\?|"|`)' 'degraded recovery must not call order endpoint'
Assert-NotMatch $source '(?i)phase7c-live-arm-control/(?:preflight|execute)' 'degraded recovery must not mutate LIVE ARM'
Assert-NotMatch $source '(?i)/api/v1/phase7c/bot-mode[^\r\n]*-Method\s+Post' 'degraded recovery must not mutate bot mode'

Write-Host 'PHASE7C_TRADE_NOTIFIER_DEGRADED_RUNTIME_RECOVERY_SOURCE_TEST=PASS'
