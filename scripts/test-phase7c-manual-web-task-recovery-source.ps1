$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$recovery = Join-Path $root 'scripts\ops\recover-phase7c-web-task-guarded-local.ps1'
$precheck = Join-Path $root 'scripts\ops\check-phase7c-web-recovery-eligibility-readonly.ps1'
$workflow = Join-Path $root '.github\workflows\phase7c-manual-guarded-web-task-recovery.yml'
foreach ($p in @($recovery, $precheck, $workflow)) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "GUARDED_RECOVERY_MISSING_FILE=$p" }
}
$src = Get-Content -LiteralPath $recovery -Raw
$wf = Get-Content -LiteralPath $workflow -Raw
function Must([string]$Text, [string]$Pattern, [string]$Name) {
  if ($Text -notmatch $Pattern) { throw "MISSING_$Name" }
}
function MustNot([string]$Text, [string]$Pattern, [string]$Name) {
  if ($Text -match $Pattern) { throw "UNSAFE_$Name" }
}
Must $wf '(?m)^on:\s*\r?\n\s*workflow_dispatch:' 'MANUAL_ONLY'
MustNot $wf '(?m)^\s*(schedule|push|pull_request|workflow_call|repository_dispatch):' 'AUTOMATIC_TRIGGER'
Must $wf "github.ref == 'refs/heads/main'" 'MAIN_ONLY'
Must $wf 'operator_approved_web_task_start == true' 'OPERATOR_APPROVAL'
Must $wf 'default: false' 'NO_DEFAULT_APPROVAL'
Must $wf 'cancel-in-progress: false' 'NO_FORCE_CANCEL'
Must $wf 'self-hosted, Windows, X64, xauusd-core-ci' 'TRUSTED_RUNNER'
Must $wf 'persist-credentials: false' 'NO_GIT_TOKEN_PERSISTENCE'
Must $wf 'test-phase7c-manual-web-task-recovery-source.ps1' 'STATIC_FIRST'
Must $wf 'START_WEB_TASK_ONLY_PAUSE_DISARMED' 'EXACT_OPERATOR_CONFIRMATION'
MustNot $wf '(?i)(git\s+(fetch|pull|merge|checkout|reset)|Stop-Process|taskkill|Stop-ScheduledTask|Enable-ScheduledTask|Register-ScheduledTask|/v1/orders\?)' 'UNSAFE_WORKFLOW_WRITE'
Must $src "OperatorConfirmation -cne 'START_WEB_TASK_ONLY_PAUSE_DISARMED'" 'SCRIPT_EXPLICIT_APPROVAL'
Must $src "taskName = 'XAUUSD-Phase7B-Web'" 'CANONICAL_WEB_TASK'
Must $src 'check-phase7c-web-recovery-eligibility-readonly.ps1' 'FRESH_DIRECT_BRIDGE_PRECHECK'
Must $src 'preRecoveryChecksPass -ne \$true' 'PRECHECK_PASS_REQUIRED'
Must $src 'webRestartAuthorized -ne \$false' 'NO_PRECHECK_AUTO_AUTH'
Must $src 'Assert-OnlyCanonicalAction' 'TASK_ACTION_VERIFIED'
Must $src 'WEB_TASK_ACTION_COUNT_NOT_ONE' 'SINGLE_TASK_ACTION'
Must $src 'WEB_TASK_LAUNCHER_PATH_NOT_CANONICAL' 'TRUSTED_LAUNCHER'
Must $src 'WEB_TASK_LAUNCHER_BLOB_MISMATCH' 'EXACT_LAUNCHER_BLOB'
Must $src 'WEB_TASK_EXECUTABLE_NOT_TRUSTED_SYSTEM_POWERSHELL' 'EXACT_SYSTEM_EXE'
Must $src 'fileSwitchPattern' 'EXACT_FILE_SWITCH_ARG'
Must $src 'Assert-PortsUnbound' 'PORTS_RECHECK'
Must $src 'Start-ScheduledTask -TaskName \$taskName' 'ONLY_TASK_START'
Must $src 'POST_MODE_NOT_PAUSE' 'PAUSE_POSTCHECK'
Must $src 'POST_ARM_NOT_DISARMED' 'DISARM_POSTCHECK'
Must $src 'POST_SOURCE_ATTESTATION_MISMATCH' 'ATTESTATION_POSTCHECK'
Must $src 'POST_SOURCE_ATTESTATION_COMPONENTS_NOT_8_OF_8' 'EIGHT_OF_EIGHT_SOURCE_ATTESTATION'
Must $src 'Assert-DirectBrokerFlatAndDisarmed' 'DIRECT_BRIDGE_POSTCHECK'
Must $src 'POST_BRIDGE_NOT_DISARMED' 'POST_DIRECT_BRIDGE_DISARM'
Must $src 'POST_BROKER_EXPOSURE_OR_INVALID_LIST' 'POST_DIRECT_BRIDGE_XAU_FLAT'
Must $src 'PHASE7C_WEB_TASK_RECOVERY_STATUS=PASS' 'SUCCESS_EVIDENCE'
Must $src 'PHASE7C_WEB_TASK_RECOVERY_STATUS=FAIL' 'FAIL_CLOSED_EVIDENCE'
Must $src 'NO_AUTOMATIC_ROLLBACK_OR_ARM' 'NO_STATE_CHANGE_ON_FAIL'
Must $src 'POST_WEB_TASK_START_RUNTIME_READY_TIMEOUT' 'READY_STABLE_TIMEOUT'
MustNot $src '(?i)(Stop-Process|taskkill|Stop-ScheduledTask|Enable-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Restart-Service|Start-Service|Stop-Service|git\s+-C\s+\$ProductionRoot\s+(fetch|pull|checkout|reset|merge)|-Method\s+(Post|Put|Patch|Delete))' 'EXTRA_PRODUCTION_MUTATION'
$starts = [regex]::Matches($src, '(?m)^\s*Start-ScheduledTask\s+-TaskName\s+\$taskName\b')
if ($starts.Count -ne 1) { throw 'MUST_HAVE_EXACTLY_ONE_TASK_START' }
Write-Host 'PHASE7C_MANUAL_WEB_TASK_RECOVERY_STATIC_SAFETY=PASS'
Write-Host 'WEB_TASK_START=ONE_OPERATOR_APPROVED_ONLY'
Write-Host 'NO_ARM_OR_TRADE_MUTATION=PASS'
