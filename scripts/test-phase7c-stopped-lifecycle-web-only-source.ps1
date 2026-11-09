$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$target = Join-Path $PSScriptRoot "deploy-phase7c-stopped-lifecycle-web-only-local.ps1"
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw "RED: stopped-lifecycle Web-only deploy entrypoint is missing: $target"
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
  throw "Stopped-lifecycle Web-only deploy has PowerShell syntax errors: $($errors[0].Message)"
}

$source = Get-Content -LiteralPath $target -Raw

function Assert-Contains([string]$Pattern, [string]$Label) {
  if ($source -notmatch $Pattern) { throw "Missing stopped-lifecycle Web-only contract: $Label" }
}
function Assert-NotContains([string]$Pattern, [string]$Label) {
  if ($source -match $Pattern) { throw "Forbidden stopped-lifecycle Web-only behavior: $Label" }
}

Assert-Contains 'XAUUSD-Phase7B-Web' 'exclusive Web scheduled task identity'
Assert-Contains 'run-phase7b-web-autostart\.ps1' 'exact canonical Web runner action proof'
Assert-Contains 'Get-ScheduledTask' 'read-only Web task definition probe'
Assert-Contains '(?i)Actions' 'Scheduled Task action inspection'
Assert-Contains '(?i)PAUSE' 'PAUSE pre/post invariant'
Assert-Contains '(?i)DISARMED' 'DISARMED pre/post invariant'
Assert-Contains '(?i)LIFECYCLE_RUNNING|lifecycle\.running|\.running' 'lifecycle stopped proof'
Assert-Contains '(?i)LIFECYCLE_READY|lifecycle\.ready|\.ready' 'lifecycle not-ready proof'
Assert-Contains '(?i)supervisor' 'supervisor remains stopped proof'
Assert-Contains '(?i)trend' 'trend executor remains stopped proof'
Assert-Contains '(?i)sideway' 'sideway executor remains stopped proof'
Assert-Contains '/v1/positions\?symbol=XAUUSD' 'GET-only XAUUSD position safety snapshot'
Assert-Contains '/v1/orders\?symbol=XAUUSD' 'GET-only XAUUSD pending-order safety snapshot'
Assert-Contains '(?i)pendingOrderCount' 'zero pending order gate'
Assert-Contains '(?i)positionCount' 'zero position gate'
Assert-Contains 'Read-Phase7CRuntimeSourceDeployment' 'accepted deployment identity read'
Assert-Contains '(?i)deploymentId' 'accepted deployment identity consistency'
Assert-Contains 'components\\api\.json' 'API component provenance record'
Assert-Contains 'components\\web\.json' 'Web component provenance record'
Assert-Contains '(?i)Phase7B-Bridge|bridgeSessionId' 'Bridge identity preservation proof'
Assert-Contains '(?i)ParentProcessId|ancestry|process tree|Descendant' 'process ancestry proof'
Assert-Contains 'Get-NetTCPConnection' 'API/Web/Bridge listener ownership proof'
Assert-Contains 'Stop-ScheduledTask' 'scoped Web task stop'
Assert-Contains 'Start-ScheduledTask' 'scoped Web task start'
Assert-Contains '(?i)status --porcelain' 'clean source worktree gate'
Assert-Contains '(?i)rev-parse HEAD' 'exact source commit gate'
Assert-Contains '(?i)HEAD\^\{tree\}|HEAD\`\^\{tree\}|rev-parse[^\r\n]+tree' 'exact source tree gate'

Assert-NotContains 'Initialize-Phase7CRuntimeSourceDeployment' 'deployment identity must be initialized by separate provenance-only step'
Assert-NotContains '(?i)deploy-phase7c-mt5-dashboard-local\.ps1' 'strict dashboard helper requires live executor generation'
Assert-NotContains '(?i)recover-phase7c-runtime|rollout-phase7c-production-source-transition' 'runtime recovery/source transition path'
Assert-NotContains '(?i)Set-BotMode|/api/bot/mode[^\r\n]*(POST|PUT|PATCH)' 'MODE mutation'
Assert-NotContains '(?i)arm-live|Set-.*Arm|Remove-Item[^\r\n]+arm|New-Item[^\r\n]+arm' 'ARM mutation'
Assert-NotContains '(?i)Enable-ScheduledTask|Disable-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask' 'Scheduled Task definition/state mutation outside stop/start reload'
Assert-NotContains '(?i)Stop-Process|taskkill\.exe' 'direct process killing; Web Job Object must own child shutdown'
Assert-NotContains '(?i)Start-ScheduledTask[^\r\n]*(Bridge|Executor|Trend|Sideway)|Stop-ScheduledTask[^\r\n]*(Bridge|Executor|Trend|Sideway)' 'non-Web task mutation'
Assert-NotContains '(?i)/v1/order(?!s\?symbol=XAUUSD)|order/send|order/close' 'order mutation endpoint'
Assert-NotContains '(?i)Invoke-RestMethod[^\r\n]+-Method\s+(Post|Put|Patch|Delete)|Invoke-WebRequest[^\r\n]+-Method\s+(Post|Put|Patch|Delete)' 'HTTP mutation'

Write-Host "PHASE7C_STOPPED_LIFECYCLE_WEB_ONLY_SOURCE_CONTRACT=PASS"
