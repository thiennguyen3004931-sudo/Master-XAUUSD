$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root 'scripts\ops\check-phase7c-web-recovery-eligibility-readonly.ps1'
$workflowPath = Join-Path $root '.github\workflows\phase7c-web-recovery-readonly-precheck.yml'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'PRECHECK_SOURCE_NOT_FOUND' }
if (-not (Test-Path -LiteralPath $workflowPath -PathType Leaf)) { throw 'PRECHECK_WORKFLOW_NOT_FOUND' }
$src = Get-Content -LiteralPath $sourcePath -Raw
$wf = Get-Content -LiteralPath $workflowPath -Raw
function Must([string]$Text, [string]$Pattern, [string]$Label) {
  if ($Text -notmatch $Pattern) { throw "MISSING_$Label" }
}
function MustNot([string]$Text, [string]$Pattern, [string]$Label) {
  if ($Text -match $Pattern) { throw "UNSAFE_$Label" }
}
Must $wf '(?m)^on:\s*\r?\n\s*workflow_dispatch:' 'MANUAL_ONLY'
MustNot $wf '(?m)^\s*(schedule|push|pull_request|workflow_call|repository_dispatch):' 'AUTOMATIC_RUN'
Must $wf 'operator_confirmed_read_only == true' 'OPERATOR_ACK'
Must $wf "github.ref == 'refs/heads/main'" 'MAIN_ONLY'
Must $wf 'self-hosted, Windows, X64, xauusd-core-ci' 'SELF_HOSTED_WINDOWS'
Must $wf 'cancel-in-progress: false' 'DO_NOT_CANCEL'
Must $wf 'persist-credentials: false' 'NO_GITHUB_TOKEN_PERSISTENCE'
Must $wf 'test-phase7c-web-recovery-readonly-precheck-source.ps1' 'STATIC_FIRST'
Must $wf 'check-phase7c-web-recovery-eligibility-readonly.ps1' 'READONLY_SCRIPT'
Must $wf '196a8420ff008548773f5d385cf5785a9f84e297' 'SOURCE_PIN'
Must $wf 'webRestartAuthorized -ne \$false' 'FAIL_CLOSED_RESTART_FLAG'
MustNot $wf '(?i)(Start-ScheduledTask|Stop-ScheduledTask|taskkill|Stop-Process|git\s+(fetch|checkout|reset|pull|merge)|/api/v1/phase7c/lifecycle/start|/v1/orders[^?])' 'WORKFLOW_MUTATION'
Must $src 'Assert-Phase7CAccountEnv' 'CANONICAL_BRIDGE_IDENTITY'
Must $src 'bridgeHost -notin' 'LOOPBACK_RESTRICTION'
Must $src 'health.liveArmStatus -eq ''DISARMED''' 'DIRECT_BRIDGE_DISARM'
Must $src 'health.liveExecutionArmed' 'DIRECT_BRIDGE_ARM_BOOLEAN'
Must $src 'phase7c-bot-mode\.json' 'PERSISTED_MODE'
Must $src 'mode.mode -eq ''PAUSE''' 'PAUSE_REQUIRED'
Must $src 'phase7c-live-arm\.json' 'LOCAL_ARM_FILE'
Must $src 'v1/positions\?symbol=XAUUSD' 'DIRECT_POSITIONS_GET'
Must $src 'v1/orders\?symbol=XAUUSD' 'DIRECT_PENDING_GET'
Must $src 'Get-NetTCPConnection -State Listen' 'PORT_OBSERVATION'
Must $src 'Get-ScheduledTask -TaskName' 'TASK_OBSERVATION'
Must $src 'webRestartAuthorized.*false' 'DENY_RESTART'
Must $src 'PHASE7C_RECOVERY_READONLY_ORDER_MUTATION=NONE' 'ZERO_TRADING_MUTATIONS'
MustNot $src '(?i)(Start-ScheduledTask|Stop-ScheduledTask|taskkill|Stop-Process|Restart-Service|Register-ScheduledTask|Unregister-ScheduledTask|Set-Content|Out-File|Remove-Item|git\s+-C\s+\$ProductionRoot\s+(fetch|checkout|reset|pull|merge)|-Method\s+(Post|Put|Delete|Patch))' 'PRODUCTION_MUTATION'
Write-Host 'PHASE7C_WEB_RECOVERY_READONLY_PRECHECK_SOURCE=PASS'
Write-Host 'PRODUCTION_MUTATION=NONE'
Write-Host 'BROKER_HTTP_METHODS=GET_ONLY'
