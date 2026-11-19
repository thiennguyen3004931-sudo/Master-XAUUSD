$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$workflowPath = Join-Path $root '.github\workflows\auto-live-manual-offline-maintenance.yml'
$helperPath = Join-Path $root 'scripts\ops\set-auto-live-monitor-offline-lease.ps1'
$classifierPath = Join-Path $root 'scripts\ops\auto-live-offline-lease.ps1'

foreach ($p in @($workflowPath, $helperPath, $classifierPath)) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "OFFLINE_MAINTENANCE_SOURCE_MISSING=$p" }
}
$wf = Get-Content -LiteralPath $workflowPath -Raw
$helper = Get-Content -LiteralPath $helperPath -Raw
$classifier = Get-Content -LiteralPath $classifierPath -Raw

function Must([string]$Pattern, [string]$Label) {
  if ($wf -notmatch $Pattern) { throw "OFFLINE_MAINTENANCE_MISSING_$Label" }
}
function MustNot([string]$Pattern, [string]$Label) {
  if ($wf -match $Pattern) { throw "OFFLINE_MAINTENANCE_UNSAFE_$Label" }
}

Must '(?m)^on:\s*\r?\n\s*workflow_dispatch:' 'MANUAL_DISPATCH'
MustNot '(?m)^\s*(schedule|push|pull_request|workflow_call|repository_dispatch):' 'AUTOMATIC_TRIGGER'
Must '(?m)^\s+operator_confirmed:' 'OPERATOR_BOOLEAN'
Must 'operator_confirmed == true' 'OPERATOR_CONFIRMATION_GUARD'
Must 'github.ref == ''refs/heads/main''' 'MAIN_ONLY'
Must 'cancel-in-progress: false' 'SERIAL_MAINTENANCE'
Must 'self-hosted, Windows, X64, xauusd-core-ci' 'TRUSTED_WINDOWS_RUNNER'
Must 'github\.sha' 'PINNED_MAIN_CHECKOUT'
Must 'persist-credentials: false' 'NO_CHECKOUT_GITHUB_CREDENTIALS'
Must 'set-auto-live-monitor-offline-lease\.ps1' 'CANONICAL_HELPER'
Must 'auto-live-offline-lease\.ps1' 'CANONICAL_CLASSIFIER'
Must 'ConfirmPlannedDowntime' 'EXPLICIT_ENABLE_ACKNOWLEDGEMENT'
Must 'Get-AutoLiveOfflineLeaseState' 'POSTCONDITION_VERIFICATION'
Must 'PRODUCTION_REPOSITORY_IDENTITY_MISMATCH' 'PRODUCTION_ORIGIN_GUARD'
Must 'PRODUCTION_RUNTIME_DIRECTORY_NOT_FOUND' 'LOCAL_RUNTIME_GUARD'
Must 'MONITOR_RUNTIME_HEALTH=NOT_VERIFIED' 'NO_FAKE_HEALTH'
Must 'MT5_BRIDGE_REQUESTS=NONE' 'NO_BRIDGE_REQUESTS'
Must 'BOT_MODE_MUTATION=NONE' 'NO_MODE_MUTATION'
Must 'ARM_MUTATION=NONE' 'NO_ARM_MUTATION'
Must 'LIVE_ORDER_MUTATION=NONE' 'NO_ORDER_MUTATION'
Must 'POSITION_MUTATION=NONE' 'NO_POSITION_MUTATION'
Must 'PRODUCTION_SOURCE_MUTATION=NONE' 'NO_CODE_MUTATION'
MustNot '(?i)(Invoke-RestMethod|Invoke-WebRequest|curl\.exe|https?://(?:127\.0\.0\.1|localhost)|git\s+-C\s+\$prod\s+(checkout|reset|merge|pull|fetch)|/v1/orders|lifecycle/start|lifecycle/stop)' 'RUNTIME_OR_NETWORK_MUTATION'
MustNot '(?m)^\s*-\s*cron:' 'CRON_SCHEDULE'

foreach ($token in @('-Enable', '-Clear', '-ConfirmPlannedDowntime', 'OFFLINE_EXPECTED')) {
  if ($token -eq 'OFFLINE_EXPECTED') {
    if ($classifier -notmatch [regex]::Escape($token)) { throw "EXPECTED_OFFLINE_CLASSIFIER_MISSING" }
  } elseif ($token -notin @('-Enable','-Clear') -and $helper -notmatch [regex]::Escape($token)) {
    throw "HELPER_CONTRACT_MISSING=$token"
  } elseif ($wf -notmatch [regex]::Escape($token)) {
    throw "WORKFLOW_HELPER_CALL_MISSING=$token"
  }
}
if ($helper -notmatch 'ValidateRange\(1, 24\)') { throw 'OFFLINE_LEASE_MAX_DURATION_NOT_BOUNDED' }
if ($classifier -notmatch 'Test-AutoLiveExpectedOffline') { throw 'OFFLINE_EXPECTED_CLASSIFIER_MISSING' }
if ($classifier -notmatch "FailureCategory -ceq 'CONNECTIVITY_FAILURE'") { throw 'CONNECTIVITY_ONLY_CONTRACT_MISSING' }

Write-Host 'AUTO_LIVE_MANUAL_OFFLINE_MAINTENANCE_CONTRACT=PASS'
Write-Host 'OFFLINE_LEASE_MANUAL_ONLY=TRUE'
Write-Host 'OPERATOR_CONFIRMATION_REQUIRED=TRUE'
Write-Host 'LIVE_BRIDGE_CALLS=NONE'
Write-Host 'SOURCE_MUTATION=NONE'
