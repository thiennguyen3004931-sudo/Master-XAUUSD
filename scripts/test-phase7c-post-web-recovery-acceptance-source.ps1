$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$scriptFile = Join-Path $root 'scripts\ops\accept-phase7c-recovered-web-readonly.ps1'
$wfFile = Join-Path $root '.github\workflows\phase7c-post-web-recovery-acceptance-once.yml'
foreach ($p in @($scriptFile,$wfFile)) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "RECOVERY_ACCEPTANCE_SOURCE_MISSING=$p" }
}
$src = Get-Content -LiteralPath $scriptFile -Raw
$wf = Get-Content -LiteralPath $wfFile -Raw
function Must([string]$Text,[string]$Pattern,[string]$Label) {
  if ($Text -notmatch $Pattern) { throw "RECOVERY_ACCEPTANCE_MISSING_$Label" }
}
function MustNot([string]$Text,[string]$Pattern,[string]$Label) {
  if ($Text -match $Pattern) { throw "RECOVERY_ACCEPTANCE_UNSAFE_$Label" }
}
foreach ($p in @($scriptFile)) {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$tokens,[ref]$errors)
  if (@($errors).Count -gt 0) { throw "RECOVERY_ACCEPTANCE_POWERSHELL_PARSE_FAILED=$p" }
}
Must $wf '(?m)^on:\s*\r?\n\s*push:' 'ONCE_ON_PUSH'
Must $wf '(?m)^\s*branches:\s*\[main\]' 'MAIN_ONLY'
Must $wf "phase7c-post-web-recovery-acceptance-once\.yml" 'WORKFLOW_OWN_PATH_FILTER'
MustNot $wf '(?m)^\s*(schedule|workflow_dispatch|pull_request|workflow_call|repository_dispatch):' 'AUTOMATIC_OR_EXTRA_TRIGGER'
Must $wf 'cancel-in-progress: false' 'NON_CANCELLING'
Must $wf 'persist-credentials: false' 'NO_PERSISTENT_CREDENTIALS'
Must $wf 'self-hosted, Windows, X64, xauusd-core-ci' 'HOSTED_RUNTIME'
Must $wf 'test-phase7c-post-web-recovery-acceptance-source\.ps1' 'STATIC_FIRST'
Must $wf 'accept-phase7c-recovered-web-readonly\.ps1' 'ACCEPTANCE_INVOKED'
Must $wf '196a8420ff008548773f5d385cf5785a9f84e297' 'PINNED_TARGET'
Must $wf 'result\.pass -ne \$true' 'BLOCK_INVALID_RESULT'
Must $wf 'restartAuthorized -ne \$false' 'NEVER_AUTHORIZE_RESTART'
Must $wf 'liveTradingAuthorized -ne \$false' 'NEVER_AUTHORIZE_LIVE'
MustNot $wf '(?i)(Start-ScheduledTask|Stop-ScheduledTask|taskkill|Stop-Process|Enable-ScheduledTask|git\s+(?:pull|fetch|checkout|reset|merge)|-Method\s+(?:Post|Put|Patch|Delete))' 'WORKFLOW_MUTATIONS'
Must $src 'api/v1/phase7c/bot-mode' 'MODE_STATE_CHECK'
Must $src 'Get-ScheduledTask -TaskName' 'TASK_OBSERVATION'
Must $src "webTask.State -eq 'Running'" 'WEB_TASK_RUNNING'
Must $src "execTask.State -eq 'Running'" 'EXECUTOR_RUNNING'
Must $src 'WEB_TASK_ACTION_NOT_CANONICAL' 'TASK_PROVENANCE'
Must $src 'WEB_TASK_LAUNCHER_BLOB_NOT_EXACT' 'EXACT_SOURCE_BLOB'
Must $src "5717/phase7b-demo" 'WEB_HTTP_PROBE'
Must $src 'phase7c/runtime-source-attestation' 'SOURCE_ATTESTATION'
Must $src 'sourceAttestation8of8' 'EIGHT_OF_EIGHT'
Must $src 'phase7c-live-arm-control/capability' 'ARM_GET'
Must $src 'v1/positions\?symbol=XAUUSD' 'BROKER_POSITIONS_GET'
Must $src 'v1/orders\?symbol=XAUUSD' 'BROKER_PENDING_GET'
Must $src "brokerDisarmed" 'BROKER_DISARM'
Must $src 'runtimeReadyStable' 'STABLE_READINESS'
Must $src 'restartAuthorized = \$false' 'DENY_RESTART'
Must $src 'liveTradingAuthorized = \$false' 'DENY_LIVE'
Must $src 'BROKER_HTTP_METHODS=GET_ONLY' 'GET_ONLY'
MustNot $src '(?im)^\s*(Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Start-Process|Stop-Process|taskkill|Restart-Service|Start-Service|Stop-Service|Set-Content|Remove-Item|Move-Item|git\s+(?:pull|fetch|checkout|reset|merge))\b' 'RUNTIME_MUTATIONS'
MustNot $src '(?i)-Method\s+(Post|Put|Patch|Delete)' 'HTTP_WRITE_METHOD'
Write-Host 'PHASE7C_POST_RECOVERY_READONLY_SOURCE_CONTRACT=PASS'
Write-Host 'PRODUCTION_MUTATION=NONE'
Write-Host 'MT5_HTTP_METHODS=GET_ONLY'
