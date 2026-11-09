$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$workflowPath = Join-Path $root '.github\workflows\phase7c-one-shot-web-recovery-evidence-readonly.yml'
$taskPath = Join-Path $root 'scripts\ops\snapshot-phase7c-web-task-readonly.ps1'
$brokerPath = Join-Path $root 'scripts\ops\check-phase7c-web-recovery-eligibility-readonly.ps1'
foreach ($p in @($workflowPath, $taskPath, $brokerPath)) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "ONE_SHOT_READONLY_MISSING=$p" }
}
$wf = Get-Content -LiteralPath $workflowPath -Raw
$src = Get-Content -LiteralPath $taskPath -Raw
$broker = Get-Content -LiteralPath $brokerPath -Raw
function Must([string]$Text,[string]$Pattern,[string]$Label) {
  if ($Text -notmatch $Pattern) { throw "ONE_SHOT_READONLY_MISSING_$Label" }
}
function MustNot([string]$Text,[string]$Pattern,[string]$Label) {
  if ($Text -match $Pattern) { throw "ONE_SHOT_READONLY_UNSAFE_$Label" }
}
foreach ($p in @($taskPath,$brokerPath)) {
  $tok = $null
  $err = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tok, [ref]$err)
  if (@($err).Count -gt 0) { throw "ONE_SHOT_READONLY_PARSE_ERROR=$p" }
}
Must $wf '(?m)^on:\s*\r?\n\s*push:' 'ON_PUSH'
Must $wf '(?m)^\s*branches:\s*\[main\]' 'MAIN_ONLY'
Must $wf "phase7c-one-shot-web-recovery-evidence-readonly\.yml" 'SELF_PATH_FILTER'
MustNot $wf '(?m)^\s*(workflow_dispatch|schedule|pull_request|workflow_call|repository_dispatch):' 'UNCONTROLLED_WORKFLOW_TRIGGER'
Must $wf 'cancel-in-progress: false' 'NO_RUN_CANCEL'
Must $wf 'persist-credentials: false' 'NO_GIT_TOKEN_PERSISTENCE'
Must $wf 'self-hosted, Windows, X64, xauusd-core-ci' 'TRUSTED_WINDOWS'
Must $wf 'test-phase7c-one-shot-web-evidence-readonly-source\.ps1' 'STATIC_FIRST'
Must $wf 'check-phase7c-web-recovery-eligibility-readonly\.ps1' 'INDEPENDENT_MT5_READONLY'
Must $wf 'snapshot-phase7c-web-task-readonly\.ps1' 'WEB_TASK_READONLY'
Must $wf 'PRODUCTION_SOURCE_MUTATION=NONE' 'NO_SOURCE_MUTATION_DECLARATION'
Must $wf 'WEB_TASK_START_STOP=NONE' 'NO_TASK_MUTATION_DECLARATION'
Must $wf 'MT5_TRADE_MUTATION=NONE' 'NO_TRADING_DECLARATION'
MustNot $wf '(?i)(Start-ScheduledTask|Stop-ScheduledTask|Enable-ScheduledTask|taskkill|Stop-Process|Invoke-RestMethod[^ \r\n]*-Method\s+(?:POST|PUT|PATCH|DELETE)|git\s+(?:pull|fetch|reset|checkout|merge))' 'WORKFLOW_MUTATION'
Must $src 'Get-ScheduledTask -TaskName' 'WEB_TASK_READ'
Must $src 'phase7c' 'PHASE7C'
Must $src 'webTaskActionTrusted' 'WEB_TASK_TRUST_STATUS'
Must $src 'operationalRestartAuthorized = \$false' 'RESTART_DENIED'
Must $src 'launcherBlobExact' 'CANONICAL_BLOB_CHECK'
Must $src 'PHASE7C_WEB_TASK_EVIDENCE_RESTART_AUTHORIZED=FALSE' 'FAIL_CLOSED_PRINT'
MustNot $src '(?im)^\s*(Start-ScheduledTask|Stop-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Stop-Process|Start-Process|taskkill|Restart-Service|Set-Service|Remove-Item|Set-Content|Move-Item|git\s+(?:pull|fetch|reset|checkout|merge))\b' 'TASK_SCRIPT_MUTATION'
Must $broker 'preRecoveryChecksPass' 'BRIDGE_SAFE_PRECHECK'
Must $broker 'webRestartAuthorized.*false' 'BRIDGE_RESTART_DENIED'
Must $broker 'health.liveArmStatus -eq ''DISARMED''' 'DIRECT_MT5_DISARM_PROOF'
Must $broker 'v1/positions\?symbol=XAUUSD' 'DIRECT_POSITIONS'
Must $broker 'v1/orders\?symbol=XAUUSD' 'DIRECT_PENDING'
MustNot $broker '(?im)^\s*(Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|taskkill|Stop-Process|Start-Process|Invoke-RestMethod\s+.*-Method\s+(?:POST|PUT|PATCH|DELETE))\b' 'BROKER_SCRIPT_MUTATION'
Write-Host 'PHASE7C_ONE_SHOT_WEB_EVIDENCE_STATIC_CONTRACT=PASS'
Write-Host 'PHASE7C_ONE_SHOT_WEB_EVIDENCE_PRODUCTION_READS=NONE_CI'
Write-Host 'PHASE7C_ONE_SHOT_WEB_EVIDENCE_PRODUCTION_MUTATION=NONE'
