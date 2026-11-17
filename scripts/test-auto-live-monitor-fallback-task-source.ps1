$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkflowPath = Join-Path $ProjectRoot '.github\workflows\auto-live-monitor-windows-fallback.yml'
$InstallPath = Join-Path $ProjectRoot 'scripts\ops\install-auto-live-monitor-fallback-task.ps1'
$TriggerPath = Join-Path $ProjectRoot 'scripts\ops\trigger-auto-live-monitor-workflow.ps1'

foreach ($path in @($WorkflowPath, $InstallPath, $TriggerPath)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "WINDOWS_FALLBACK_SOURCE_MISSING=$path"
  }
}

$Workflow = Get-Content -LiteralPath $WorkflowPath -Raw
$Install = Get-Content -LiteralPath $InstallPath -Raw
$Trigger = Get-Content -LiteralPath $TriggerPath -Raw

[void][scriptblock]::Create($Install)
[void][scriptblock]::Create($Trigger)

function Assert-Literal {
  param([string]$Source, [string]$Text, [string]$Label)
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing Windows fallback contract literal: $Label"
  }
}

function Assert-NotMatch {
  param([string]$Source, [string]$Pattern, [string]$Label)
  if ($Source -match $Pattern) {
    throw "Forbidden Windows fallback pattern: $Label"
  }
}

Assert-Literal $Workflow 'name: AUTO LIVE Windows 5m Fallback Clock' 'workflow identity'
Assert-Literal $Workflow 'runs-on: [self-hosted, Windows, X64, xauusd-core-ci]' 'canonical self-hosted runner'
Assert-Literal $Workflow 'contents: read' 'read-only repository permission'
Assert-Literal $Workflow 'scripts/test-auto-live-monitor-fallback-task-source.ps1' 'static safety test'
Assert-Literal $Workflow '-CheckPrerequisitesOnly' 'PR persistent-auth prerequisite'
Assert-Literal $Workflow '-Prime' 'post-merge dispatch proof'
Assert-Literal $Workflow "github.event_name == 'push'" 'install only on merged main push'

Assert-Literal $Install '[string]$TaskName = ''XAUUSD-AUTO-LIVE-ReadOnly-Monitor-Clock''' 'dedicated task name'
Assert-Literal $Install '[int]$IntervalMinutes = 5' 'five-minute interval'
Assert-Literal $Install 'FALLBACK_INTERVAL_MUST_BE_5_MINUTES' 'interval hard guard'
Assert-Literal $Install '-RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)' 'task recurrence'
Assert-Literal $Install '-LogonType Interactive -RunLevel Limited' 'least-privilege task principal'
Assert-Literal $Install '-MultipleInstances IgnoreNew' 'overlap protection'
Assert-Literal $Install '_xauusd-auto-live-monitor' 'durable runner-local install root'
Assert-Literal $Install 'GH_PERSISTENT_AUTH=PASS' 'persistent auth prerequisite'
Assert-Literal $Install 'WINDOWS_FALLBACK_MONITOR_DISPATCH_ONLY=TRUE' 'dispatch-only boundary'
Assert-Literal $Install '[System.Security.Principal.WindowsIdentity]::GetCurrent()' 'current Windows identity source'
Assert-Literal $Install 'Resolve-PrincipalSid' 'principal SID normalization'
Assert-Literal $Install 'New-Object System.Security.Principal.NTAccount($DefaultDomain, $Account)' 'domain-preserving local account resolution'
Assert-Literal $Install '[System.Security.Principal.SecurityIdentifier]' 'SID translation'
Assert-Literal $Install 'TASK_PRINCIPAL_SID_MISMATCH' 'principal mismatch fail closed'
Assert-Literal $Install 'WINDOWS_FALLBACK_TASK_PRINCIPAL_SID=' 'principal SID evidence'

Assert-Literal $Trigger "Get-Process -Name 'Runner.Listener'" 'runner-online guard'
Assert-Literal $Trigger "'run', 'list'" 'existing-run query'
Assert-Literal $Trigger "'queued', 'in_progress', 'waiting', 'pending', 'requested'" 'active-run guard'
Assert-Literal $Trigger '[int]$MinGapMinutes = 4' 'recent-run gap guard'
Assert-Literal $Trigger '''workflow'', ''run'', $Workflow' 'canonical workflow dispatch'
Assert-Literal $Trigger "'-f', 'notify=true'" 'notification persistence enabled'
Assert-Literal $Trigger 'FALLBACK_DISPATCH=SKIP_RUNNER_NOT_LISTENING' 'offline no-backlog guard'
Assert-Literal $Trigger 'FALLBACK_DISPATCH=SKIP_ACTIVE_RUN' 'duplicate active-run guard'
Assert-Literal $Trigger 'FALLBACK_DISPATCH=SKIP_RECENT_RUN' 'recent-run duplicate guard'
Assert-Literal $Trigger 'PRODUCTION_HTTP_METHODS=NONE' 'clock has no production HTTP'
Assert-Literal $Trigger 'PRODUCTION_MUTATION=NONE' 'clock has no production mutation'

foreach ($source in @($Workflow, $Install, $Trigger)) {
  Assert-NotMatch $source '(?i)F:\\Project\\XAUUSD_AI_MASTER|127\.0\.0\.1:3711|/api/v1/phase7c|/v1/orders|/v1/positions' 'direct production access'
  Assert-NotMatch $source '(?i)secrets\.[A-Za-z0-9_]*TOKEN|GH_TOKEN\s*:|GITHUB_TOKEN\s*:' 'persisted or injected token'
  Assert-NotMatch $source '(?i)bot-mode|live-arm-control|ARM_LIVE|DISARM|order_send|position_close' 'trading/control mutation surface'
}

Write-Host 'AUTO_LIVE_WINDOWS_FALLBACK_SOURCE_CONTRACT=PASS'
Write-Host 'WINDOWS_FALLBACK_INTERVAL_MINUTES=5'
Write-Host 'WINDOWS_FALLBACK_PRODUCTION_ACCESS=NONE'
Write-Host 'WINDOWS_FALLBACK_MONITOR_DISPATCH_ONLY=TRUE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
