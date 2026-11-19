$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $PSScriptRoot "reconcile-phase7c-runtime-source-generation-local.ps1"
$ResumeHelper = Join-Path $PSScriptRoot "resume-phase7c-runtime-source-generation-reconciliation-local.ps1"
$ExactBrokerHelper = Join-Path $PSScriptRoot "continue-phase7c-runtime-source-generation-reconciliation-exact-broker-local.ps1"

foreach ($required in @($Helper,$ResumeHelper,$ExactBrokerHelper)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing runtime source generation reconciliation helper: $required" }
}

$source = Get-Content -LiteralPath $Helper -Raw
$resumeSource = Get-Content -LiteralPath $ResumeHelper -Raw
$exactBrokerSource = Get-Content -LiteralPath $ExactBrokerHelper -Raw

function Require-Text([string]$Text,[string]$Needle,[string]$Message) {
  if (-not $Text.Contains($Needle)) { throw $Message }
}
function Forbid-Text([string]$Text,[string]$Needle,[string]$Message) {
  if ($Text.Contains($Needle)) { throw $Message }
}

Require-Text $source '[string]$ExpectedCommit' 'helper must require exact ExpectedCommit input'
Require-Text $source '[string]$ProjectRoot = ""' 'helper must support an explicit ProjectRoot when executed outside the repository'
Require-Text $source '$ScriptsRoot = Join-Path $ProjectRoot "scripts"' 'helper must resolve runtime libraries from the explicit production ProjectRoot'
Require-Text $source 'branch --show-current' 'helper must require canonical main branch'
Require-Text $source 'status --porcelain' 'helper must require a clean worktree'
Require-Text $source 'rev-parse HEAD' 'helper must pin the exact local commit'
Require-Text $source 'XAUUSD-Phase7C-Executors' 'helper must target only the canonical executor Scheduled Task'
Require-Text $source 'Get-Phase7CTrustedGitFileSha256' 'helper must verify the trusted Scheduled Task runner hash'
Require-Text $source 'Test-Phase7CExecutorTaskActionOwnership' 'helper must prove Scheduled Task action ownership before mutation'
Require-Text $source 'SYSTEM + ServiceAccount + Highest' 'helper must prove canonical SYSTEM task principal'
Require-Text $source '/api/v1/phase7c/runtime-source-attestation' 'helper must read canonical runtime source attestation'
Require-Text $source 'API_WEB_EXACT_PREFLIGHT=PASS' 'helper must require API and Web EXACT before generation mutation'
Require-Text $source 'SYSTEM_GENERATION_MISMATCH_PREFLIGHT=PASS' 'helper must require six SYSTEM generation mismatches'
Require-Text $source 'FULL_RUNTIME_SOURCE_ATTESTATION=PASS' 'helper must require final full runtime source attestation'
Require-Text $source 'RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8' 'helper must require all eight components exact'
Require-Text $source 'FAIL_CLOSED_MODE=PAUSE' 'normal helper failure path must remain PAUSE'
Require-Text $source 'FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT' 'normal helper failure path must remain DISARMED best effort'
Forbid-Text $source 'deploy-phase7c-web-ui-local.ps1' 'generation reconciliation must not create another Web/API deployment generation'
Forbid-Text $source 'Initialize-Phase7CRuntimeSourceDeployment' 'generation reconciliation must reuse accepted deployment identity'

Require-Text $resumeSource '[string]$ExpectedCommit' 'resume helper must pin accepted runtime commit'
Require-Text $resumeSource '[string]$ProjectRoot = ""' 'resume helper must support external Downloads execution'
Require-Text $resumeSource 'RESUME_FAIL_CLOSED_PREFLIGHT=PASS' 'resume helper must prove PAUSE + DISARMED + stopped lifecycle before mutation'
Require-Text $resumeSource 'API_WEB_EXACT_PREFLIGHT=PASS' 'resume helper must require API and Web exact'
Require-Text $resumeSource 'SYSTEM_GENERATION_MISMATCH_PREFLIGHT=PASS' 'resume helper must retain strict six-SYSTEM generation mismatch gate'
Require-Text $resumeSource 'SOURCE_COMMIT_MISMATCH' 'resume helper must require source commit mismatch reason'
Require-Text $resumeSource 'SOURCE_TREE_MISMATCH' 'resume helper must require source tree mismatch reason'
Require-Text $resumeSource 'DEPLOYMENT_ID_MISMATCH' 'resume helper must require deployment mismatch reason'
Require-Text $resumeSource 'BROKER_IDENTITY_PREFLIGHT=' 'resume helper must publish broker identity proof'
Require-Text $resumeSource 'ATTESTED_PROCESS_ALIVE' 'resume helper must support live attested broker provenance'
Require-Text $resumeSource 'ATTESTED_PROCESS_ABSENT' 'resume helper must support already-exited attested broker state'
Require-Text $resumeSource 'Get-Phase7CProcessCommandLine' 'resume helper must bind a live broker to canonical task command provenance'
Require-Text $resumeSource 'Get-Phase7CReadOnlyLockState' 'resume helper must use startup-runner lock as ownership evidence'
Require-Text $resumeSource 'BROKER_TASK_STOP=NOOP_ALREADY_STOPPED' 'resume helper must safely handle already-stopped broker task'
Require-Text $resumeSource 'Stop-ScheduledTask' 'resume helper must stop an attested live broker task'
Require-Text $resumeSource 'Start-ScheduledTask' 'resume helper must launch a fresh SYSTEM broker generation'
Require-Text $resumeSource 'lifecycle-broker.json' 'resume helper must verify fresh lifecycle broker attestation'
Require-Text $resumeSource '/api/v1/phase7c/lifecycle/start' 'resume helper must restart lifecycle while still DISARMED'
Require-Text $resumeSource 'READY_STABLE_MS=5000' 'resume helper must require stable lifecycle ready'
Require-Text $resumeSource 'RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8' 'resume helper must require 8/8 exact before ARM'
Require-Text $resumeSource 'FULL_RUNTIME_SOURCE_ATTESTATION=PASS' 'resume helper must prove full attestation'
Require-Text $resumeSource 'ARM_LIVE' 'resume helper may restore ARM only after full exact proof'
Require-Text $resumeSource 'FINAL_MODE=PAUSE' 'resume helper must finish PAUSE'
Require-Text $resumeSource 'FINAL_ARM=ARMED' 'resume helper must finish ARMED on success'
Require-Text $resumeSource 'BRIDGE_RESTART=NONE' 'resume helper must not restart Bridge'
Require-Text $resumeSource 'WEB_API_RESTART=NONE' 'resume helper must not restart Web/API'
Require-Text $resumeSource 'ORDER_MUTATION=NONE' 'resume helper must not mutate orders'
Require-Text $resumeSource 'POSITION_MUTATION=NONE' 'resume helper must not mutate positions'
Require-Text $resumeSource 'LIVE_TEST_ORDER=NONE' 'resume helper must never send LIVE test order'
Require-Text $resumeSource 'FAIL_CLOSED_MODE=PAUSE' 'resume failure path must remain PAUSE'
Require-Text $resumeSource 'FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT' 'resume failure path must remain DISARMED best effort'
Forbid-Text $resumeSource '"/api/v1/phase7c/lifecycle/stop"' 'fail-closed resume must not issue lifecycle STOP again'
Forbid-Text $resumeSource 'deploy-phase7c-web-ui-local.ps1' 'resume must not create another Web/API deployment generation'
Forbid-Text $resumeSource 'Initialize-Phase7CRuntimeSourceDeployment' 'resume must reuse accepted deployment identity'

Require-Text $exactBrokerSource '[string]$ExpectedCommit' 'exact-broker continuation must pin accepted runtime commit'
Require-Text $exactBrokerSource '[string]$ProjectRoot = ""' 'exact-broker continuation must support external Downloads execution'
Require-Text $exactBrokerSource 'CONTINUATION_PREFLIGHT=PASS' 'exact-broker continuation must prove fail-closed preflight before mutation'
Require-Text $exactBrokerSource 'API_WEB_EXACT_PREFLIGHT=PASS' 'exact-broker continuation must require API and Web exact'
Require-Text $exactBrokerSource 'BROKER_SOURCE_STATE=EXACT_MATCH_REUSE' 'exact-broker continuation must explicitly classify the already exact broker for reuse'
Require-Text $exactBrokerSource 'SYSTEM_GENERATION_PARTIAL_PREFLIGHT=PASS' 'exact-broker continuation must require remaining executor generation mismatch'
Require-Text $exactBrokerSource 'BROKER_TASK_RESTART=NOOP_ALREADY_EXACT' 'exact-broker continuation must not restart an already exact broker'
Require-Text $exactBrokerSource 'SOURCE_COMMIT_MISMATCH' 'exact-broker continuation must require source commit mismatch reason for unreconciled executors'
Require-Text $exactBrokerSource 'SOURCE_TREE_MISMATCH' 'exact-broker continuation must require source tree mismatch reason for unreconciled executors'
Require-Text $exactBrokerSource 'DEPLOYMENT_ID_MISMATCH' 'exact-broker continuation must require deployment mismatch reason for unreconciled executors'
Require-Text $exactBrokerSource 'Get-Phase7CProcessCommandLine' 'exact-broker continuation must bind broker PID to canonical task command provenance'
Require-Text $exactBrokerSource 'Get-Phase7CReadOnlyLockState' 'exact-broker continuation must require startup-runner lock ownership'
Require-Text $exactBrokerSource '/api/v1/phase7c/lifecycle/start' 'exact-broker continuation must start lifecycle while still DISARMED'
Require-Text $exactBrokerSource 'READY_STABLE_MS=5000' 'exact-broker continuation must require stable lifecycle ready'
Require-Text $exactBrokerSource 'BROKER_REUSED=PASS' 'exact-broker continuation must prove broker PID was preserved'
Require-Text $exactBrokerSource 'EXECUTOR_GENERATION_REPLACED=PASS|COUNT=5' 'exact-broker continuation must prove five executor PIDs were replaced'
Require-Text $exactBrokerSource 'RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8' 'exact-broker continuation must require 8/8 exact before ARM'
Require-Text $exactBrokerSource 'FULL_RUNTIME_SOURCE_ATTESTATION=PASS' 'exact-broker continuation must prove full attestation'
Require-Text $exactBrokerSource 'ARM_LIVE' 'exact-broker continuation may restore ARM only after full exact proof'
Require-Text $exactBrokerSource 'FINAL_MODE=PAUSE' 'exact-broker continuation must finish PAUSE'
Require-Text $exactBrokerSource 'FINAL_ARM=ARMED' 'exact-broker continuation must finish ARMED on success'
Require-Text $exactBrokerSource 'BRIDGE_RESTART=NONE' 'exact-broker continuation must not restart Bridge'
Require-Text $exactBrokerSource 'WEB_API_RESTART=NONE' 'exact-broker continuation must not restart Web/API'
Require-Text $exactBrokerSource 'ORDER_MUTATION=NONE' 'exact-broker continuation must not mutate orders'
Require-Text $exactBrokerSource 'POSITION_MUTATION=NONE' 'exact-broker continuation must not mutate positions'
Require-Text $exactBrokerSource 'LIVE_TEST_ORDER=NONE' 'exact-broker continuation must never send LIVE test order'
Require-Text $exactBrokerSource 'FAIL_CLOSED_MODE=PAUSE' 'exact-broker continuation failure path must remain PAUSE'
Require-Text $exactBrokerSource 'FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT' 'exact-broker continuation failure path must remain DISARMED best effort'
Forbid-Text $exactBrokerSource 'Stop-ScheduledTask' 'exact-broker continuation must not stop the already exact broker task'
Forbid-Text $exactBrokerSource 'Start-ScheduledTask' 'exact-broker continuation must not restart the already exact broker task'
Forbid-Text $exactBrokerSource '"/api/v1/phase7c/lifecycle/stop"' 'exact-broker continuation must not issue lifecycle STOP again'
Forbid-Text $exactBrokerSource 'deploy-phase7c-web-ui-local.ps1' 'exact-broker continuation must not create another Web/API deployment generation'
Forbid-Text $exactBrokerSource 'Initialize-Phase7CRuntimeSourceDeployment' 'exact-broker continuation must reuse accepted deployment identity'

Write-Host 'PHASE7C_RUNTIME_SOURCE_GENERATION_RECONCILIATION_SOURCE_CONTRACT=PASS'
Write-Host 'PHASE7C_RUNTIME_SOURCE_GENERATION_RECONCILIATION_FAIL_CLOSED_RESUME_CONTRACT=PASS'
Write-Host 'PHASE7C_RUNTIME_SOURCE_GENERATION_RECONCILIATION_EXACT_BROKER_CONTINUATION_CONTRACT=PASS'
