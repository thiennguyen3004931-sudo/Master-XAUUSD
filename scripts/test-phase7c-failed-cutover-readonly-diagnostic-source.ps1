$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$diagnosticPath = Join-Path $root 'scripts\ops\diagnose-phase7c-failed-cutover-readonly.ps1'
$workflowPath = Join-Path $root '.github\workflows\phase7c-failed-cutover-readonly-diagnostic.yml'
foreach ($p in @($diagnosticPath, $workflowPath)) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "DIAGNOSTIC_FILE_MISSING=$p" }
}
$src = Get-Content -LiteralPath $diagnosticPath -Raw
$wf = Get-Content -LiteralPath $workflowPath -Raw
function Must([string]$Text, [string]$Regex, [string]$Name) {
  if ($Text -notmatch $Regex) { throw "FAILED_CUTOVER_DIAGNOSTIC_REQUIRED_$Name" }
}
function MustNot([string]$Text, [string]$Regex, [string]$Name) {
  if ($Text -match $Regex) { throw "FAILED_CUTOVER_DIAGNOSTIC_UNSAFE_$Name" }
}

Must $wf '(?m)^on:\s*\r?\n\s*workflow_dispatch:' 'MANUAL_ONLY'
MustNot $wf '(?m)^\s*(schedule|push|pull_request|workflow_call|repository_dispatch):' 'AUTOMATIC_TRIGGER'
Must $wf 'operator_confirmed_read_only == true' 'EXPLICIT_OPERATOR_CONFIRMATION'
Must $wf "github.ref == 'refs/heads/main'" 'MAIN_REF_ONLY'
Must $wf 'cancel-in-progress: false' 'NO_CONCURRENCY_CANCELLATION'
Must $wf 'self-hosted, Windows, X64, xauusd-core-ci' 'LOCAL_TRUSTED_RUNNER'
Must $wf 'persist-credentials: false' 'NO_GITHUB_TOKEN_PERSISTENCE'
Must $wf 'test-phase7c-failed-cutover-readonly-diagnostic-source.ps1' 'SOURCE_CONTRACT_FIRST'
Must $wf 'diagnose-phase7c-failed-cutover-readonly.ps1' 'DIAGNOSTIC_INVOKED'
Must $wf '196a8420ff008548773f5d385cf5785a9f84e297' 'PINNED_HOTFIX'
MustNot $wf '(?i)(git\s+(checkout|reset|pull|merge|fetch)|Stop-Process|taskkill|Start-ScheduledTask|Stop-ScheduledTask|Restart-Service|Invoke-RestMethod|/v1/orders)' 'WORKFLOW_MUTATION'

Must $src 'Get-NetTCPConnection -State Listen' 'TCP_LISTENER_OBSERVATION'
Must $src 'Get-CimInstance Win32_Process' 'PROCESS_OBSERVATION'
Must $src 'Get-ScheduledTask -TaskName' 'TASK_OBSERVATION'
Must $src 'Get-ScheduledTaskInfo -TaskName' 'TASK_RESULT_OBSERVATION'
Must $src 'Invoke-RestMethod -Uri' 'GET_ONLY_API_OBSERVATION'
Must $src '-Method Get' 'GET_ONLY_API_METHOD'
Must $src 'http://127\.0\.0\.1:3711' 'LOOPBACK_ONLY_API'
Must $src 'DIAGNOSTIC_LIVE_CUTOVER_ALLOWED=FALSE' 'NO_AUTO_RECOVERY'
Must $src 'DIAGNOSTIC_MT5_BRIDGE_REQUESTS=NONE' 'NO_BROKER_REQUEST'
Must $src 'DIAGNOSTIC_ARM_MUTATION=NONE' 'NO_ARM_MUTATION'
Must $src 'DIAGNOSTIC_BOT_MODE_MUTATION=NONE' 'NO_MODE_MUTATION'
Must $src 'DIAGNOSTIC_ORDER_MUTATION=NONE' 'NO_ORDER_MUTATION'
Must $src 'DIAGNOSTIC_SOURCE_MUTATION=NONE' 'NO_SOURCE_MUTATION'
Must $src 'DIAGNOSTIC_PROCESS_OR_TASK_MUTATION=NONE' 'NO_PROCESS_TASK_MUTATION'
Must $src 'PORT_OWNER_UNVERIFIED_BLOCKED' 'FAIL_CLOSED_OWNER'
Must $src 'SOURCE_DRIFT_BLOCKED' 'FAIL_CLOSED_SOURCE'
MustNot $src '(?i)(Stop-Process|taskkill|Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Disable-ScheduledTask|Restart-Service|Stop-Service|Start-Service|Remove-Item|git\s+-C\s+\$ProductionRoot\s+(checkout|reset|pull|merge|fetch)|Invoke-RestMethod[^\r\n]*-Method\s+(Post|Put|Patch|Delete)|Invoke-WebRequest[^\r\n]*-Method\s+(Post|Put|Patch|Delete))' 'RUNTIME_MUTATIONS'
Write-Host 'PHASE7C_FAILED_CUTOVER_READ_ONLY_DIAGNOSTIC_SOURCE=PASS'
Write-Host 'GITHUB_MANUAL_ONLY=TRUE'
Write-Host 'PRODUCTION_MUTATION=NONE'
