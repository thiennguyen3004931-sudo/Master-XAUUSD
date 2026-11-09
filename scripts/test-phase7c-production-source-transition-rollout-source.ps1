param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HelperPath = Join-Path $PSScriptRoot 'rollout-phase7c-production-source-transition-local.ps1'
$RecoveryPath = Join-Path $PSScriptRoot 'recover-phase7c-runtime-ready-stable-deploy-local.ps1'
$P3VerifierPath = Join-Path $PSScriptRoot 'verify-phase7c-p3-production-acceptance-local.ps1'
$P4VerifierPath = Join-Path $PSScriptRoot 'verify-phase7c-p4-production-acceptance-local.ps1'

foreach ($required in @($RecoveryPath, $P3VerifierPath, $P4VerifierPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required canonical rollout dependency is missing: $required"
    }
}

if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    throw 'RED_TARGET: missing production source-transition rollout helper.'
}

$source = Get-Content -LiteralPath $HelperPath -Raw
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) {
    throw "Production source-transition rollout helper has PowerShell parse errors: $(@($errors | ForEach-Object Message) -join '; ')"
}

function Require-Source([string]$Pattern, [string]$Label) {
    if ($source -notmatch $Pattern) {
        throw "Production source-transition rollout source contract missing: $Label"
    }
}

function Forbid-Source([string]$Pattern, [string]$Label) {
    if ($source -match $Pattern) {
        throw "Production source-transition rollout source contract forbids: $Label"
    }
}

Require-Source '\[string\]\$ProjectRoot' 'external ProjectRoot parameter'
Require-Source '\[string\]\$ExpectedCurrentCommit' 'exact current commit parameter'
Require-Source '\[string\]\$TargetCommit' 'exact target commit parameter'
Require-Source '\[string\]\$ExpectedRemoteMainCommit' 'independent exact remote-main pin'
Require-Source '\[string\]\$ExpectedHelperBlobSha1' 'pinned external helper blob parameter'
Require-Source '\[ValidateSet\(''ARMED'',''DISARMED''\)\]\s+\[string\]\$ExpectedInitialArm' 'explicit ARMED/DISARMED initial-arm contract'
Require-Source '\$ExpectedInitialArm\s*=\s*''ARMED''' 'backward-compatible ARMED default'
Require-Source '''https://github\.com/thiennguyen3004931-sudo/xauusd-ai-master-core''' 'canonical private HTTPS origin'
Require-Source '''https://github\.com/thiennguyen3004931-sudo/xauusd-ai-master-core\.git''' 'canonical private HTTPS .git origin'
Require-Source '''git@github\.com:thiennguyen3004931-sudo/xauusd-ai-master-core\.git''' 'canonical private SSH origin'
Forbid-Source '''https://github\.com/thiennguyen3004931-sudo/xauusd-ai-master''' 'legacy public HTTPS origin'
Forbid-Source '''https://github\.com/thiennguyen3004931-sudo/xauusd-ai-master\.git''' 'legacy public HTTPS .git origin'
Forbid-Source '''git@github\.com:thiennguyen3004931-sudo/xauusd-ai-master\.git''' 'legacy public SSH origin'
Require-Source '\[ValidateSet\(''HEALTHY'',''ORPHAN_QUEUED'',''STOPPED_LIFECYCLE''\)\]\s+\[string\]\$ExpectedInitialRuntimeState' 'explicit healthy/orphan-queued/stopped-lifecycle runtime-state contract'
Require-Source '\$ExpectedInitialRuntimeState\s*=\s*''HEALTHY''' 'backward-compatible HEALTHY runtime-state default'
Require-Source 'Assert-Arm\s+-Expected\s+\$ExpectedInitialArm\s+-Stage\s+[''\"]PREFLIGHT[''\"]' 'preflight must assert explicit initial ARM state'
Require-Source '\$ExpectedInitialArm\s+-eq\s+''ARMED''' 'armed path must remain explicit'
Require-Source '\$ExpectedInitialArm\s+-eq\s+''DISARMED''' 'fail-closed DISARMED resume path must be explicit'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_DISARM=SKIPPED_ALREADY_DISARMED' 'DISARMED resume must not ARM or redundantly mutate before source transition'
Require-Source '\$ExpectedInitialRuntimeState\s+-eq\s+''HEALTHY''' 'normal healthy runtime path must remain explicit'
Require-Source '\$ExpectedInitialRuntimeState\s+-eq\s+''ORPHAN_QUEUED''' 'orphan-queued runtime resume path must be explicit'
Require-Source '\$ExpectedInitialRuntimeState\s+-eq\s+''STOPPED_LIFECYCLE''' 'stopped-lifecycle runtime resume path must be explicit'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREFLIGHT_RUNTIME_STATE=ORPHAN_QUEUED' 'orphan-queued preflight marker'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREFLIGHT_RUNTIME_STATE=STOPPED_LIFECYCLE' 'stopped-lifecycle preflight marker'
Require-Source 'function\s+Get-Phase7CCanonicalTaskProcessCount' 'canonical task-process proof helper'
Require-Source 'function\s+Get-Phase7CRunningTaskInstanceCount' 'Task Scheduler COM instance proof helper'
Require-Source '\[string\]\$orphanTask\.State\s+-eq\s+''Queued''' 'orphan resume requires task Queued'
Require-Source '\$orphanCanonicalProcessCount\s+-eq\s+0' 'orphan resume requires zero canonical task process'
Require-Source '\$orphanRunningInstanceCount\s+-eq\s+0' 'orphan resume requires zero Task Scheduler running instance'
Require-Source '-not\s+\[bool\]\$orphanGeneration\.brokerProcessAlive' 'orphan resume requires dead previous broker'
Require-Source '-not\s+\[bool\]\$orphanGeneration\.brokerHeartbeatFresh' 'orphan resume requires stale heartbeat'
Require-Source '\$orphanGeneration\.startupRunnerLockState.*MISSING.*RELEASED' 'orphan resume requires released/missing startup lock'
Require-Source 'ORPHAN_QUEUED.*requires.*DISARMED|DISARMED.*required.*ORPHAN_QUEUED' 'orphan resume must require initial DISARMED'
Require-Source 'ORPHAN_QUEUED.*lifecycle.*stopped|lifecycle.*stopped.*ORPHAN_QUEUED' 'orphan resume must require lifecycle already stopped'
Require-Source 'runner.*blob.*unchanged|runner.*unchanged.*blob|ORPHAN_QUEUED.*runner.*unchanged' 'source transition must prove guarded runner bytes unchanged for queued resume'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORPHAN_QUEUED_CLEAR=PASS' 'orphan queued request clear proof'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORPHAN_QUEUED_BROKER_BOOT=PASS' 'temporary broker boot proof after fast-forward'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIFECYCLE_STOP=SKIPPED_ALREADY_STOPPED' 'orphan resume must not issue redundant lifecycle stop'

Require-Source 'function\s+Assert-StoppedLifecycleRuntimeState' 'stopped-lifecycle runtime proof helper'
Require-Source 'function\s+Assert-StoppedLifecycleAttestationShape' 'stopped-lifecycle partial-generation attestation proof helper'
Require-Source 'STOPPED_LIFECYCLE.*requires.*DISARMED|DISARMED.*required.*STOPPED_LIFECYCLE' 'stopped-lifecycle resume must require initial DISARMED'
Require-Source 'STOPPED_LIFECYCLE.*lifecycle.*stopped|lifecycle.*stopped.*STOPPED_LIFECYCLE' 'stopped-lifecycle resume must require lifecycle already stopped'
Require-Source '\[string\]\$stoppedTask\.State\s+-eq\s+''Running''' 'stopped-lifecycle resume requires task Running'
Require-Source '\$stoppedCanonicalProcessCount\s+-eq\s+1' 'stopped-lifecycle resume requires exactly one canonical task process'
Require-Source '\$stoppedRunningInstanceCount\s+-eq\s+1' 'stopped-lifecycle resume requires exactly one Task Scheduler running instance'
Require-Source '\[bool\]\$stoppedGeneration\.brokerProcessAlive' 'stopped-lifecycle resume requires live broker process'
Require-Source '\[bool\]\$stoppedGeneration\.brokerHeartbeatFresh' 'stopped-lifecycle resume requires fresh broker heartbeat'
Require-Source '\$stoppedGeneration\.startupRunnerLockState\s+-eq\s+''HELD''' 'stopped-lifecycle resume requires HELD startup lock'
Require-Source 'desiredExecutorState.*STOPPED|STOPPED.*desiredExecutorState' 'stopped-lifecycle resume requires broker desired executor state STOPPED'
Require-Source 'lifecycle-broker.*EXACT_MATCH|EXACT_MATCH.*lifecycle-broker' 'stopped-lifecycle resume requires lifecycle-broker exact current generation'
Require-Source 'SOURCE_COMMIT_MISMATCH' 'stopped-lifecycle partial generation must validate source commit mismatch reason'
Require-Source 'SOURCE_TREE_MISMATCH' 'stopped-lifecycle partial generation must validate source tree mismatch reason'
Require-Source 'DEPLOYMENT_ID_MISMATCH' 'stopped-lifecycle partial generation must validate deployment mismatch reason'
Require-Source 'api.*web.*supervisor.*trend.*sideway.*telegram.*regime-notifier' 'stopped-lifecycle resume must account for all seven old-generation components'
Require-Source 'STOPPED_LIFECYCLE.*runner.*unchanged|runner.*unchanged.*STOPPED_LIFECYCLE' 'source transition must prove guarded runner bytes unchanged for stopped-lifecycle resume'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STOPPED_LIFECYCLE_POST_FAST_FORWARD=PASS' 'stopped-lifecycle state must be re-proven after fast-forward'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STOPPED_LIFECYCLE_LIFECYCLE_STOP=SKIPPED_ALREADY_STOPPED' 'stopped-lifecycle resume must not issue redundant lifecycle stop'

Require-Source 'hash-object' 'external helper blob provenance proof'
Require-Source 'branch --show-current' 'main branch guard'
Require-Source 'status --porcelain' 'clean worktree guard'
Require-Source 'ls-remote' 'canonical remote main proof'
Require-Source 'remoteMain\s+-ne\s+\$ExpectedRemoteMainCommit' 'remote main must match independent pin'
Require-Source 'fetch.*refs/heads/main' 'pre-stage exact remote main before LIVE mutation'
Require-Source 'merge-base.*--is-ancestor\s+\$ExpectedCurrentCommit\s+\$TargetCommit' 'current-to-target fast-forward ancestry proof'
Require-Source 'merge-base.*--is-ancestor\s+\$TargetCommit\s+\$ExpectedRemoteMainCommit' 'target must remain reachable from pinned remote main'
Require-Source 'remoteHelperParts\s*=.*-split\s+[''\"]\\s\+[''\"]' 'portable ls-tree token parsing across PS7 and PS5.1'
Require-Source 'merge.*--ff-only' 'exact fast-forward transition'
Require-Source 'rev-parse HEAD' 'post-transition exact HEAD proof'
Require-Source 'runtime-source-attestation' 'runtime-source pre/post attestation'
Require-Source 'overall.*EXACT_MATCH|EXACT_MATCH.*overall' '8/8 exact runtime-source guard'
Require-Source '\$snapshot\.deployment\.sourceTree' 'deployment-level source tree proof'
Require-Source '\$component\.deploymentId\s+-ne\s+\$deploymentId' 'component must be tied to exact deployment identity'
Require-Source 'bot-mode' 'canonical PAUSE control path'
Require-Source 'DISARM_LIVE' 'canonical LIVE disarm path'
Require-Source 'lifecycle/stop' 'lifecycle stop before normal source transition'
Require-Source 'recover-phase7c-runtime-ready-stable-deploy-local\.ps1' 'canonical recovery deploy delegation'
Require-Source 'verify-phase7c-p3-production-acceptance-local\.ps1' 'P3 production acceptance'
Require-Source 'verify-phase7c-p4-production-acceptance-local\.ps1' 'P4 production acceptance'
Require-Source 'ARM_LIVE' 'ARM restore only after acceptance'
Require-Source 'bridgeSessionId' 'Bridge session continuity proof'
Require-Source 'positions\?symbol=XAUUSD' 'flat-position proof'
Require-Source 'orders\?symbol=XAUUSD' 'flat-pending-order proof'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORDER_MUTATION=NONE' 'no order mutation attestation'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_POSITION_MUTATION=NONE' 'no position mutation attestation'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIVE_TEST_ORDER=NONE' 'no LIVE test order attestation'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_FINAL_MODE=PAUSE' 'final PAUSE contract'
Require-Source 'if\s*\(\$ExpectedInitialArm\s+-eq\s+''ARMED''\)\s*\{' 'ARM restore must be conditional on initial ARMED state'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ARM_RESTORE=PERFORMED' 'armed path must report ARM restore'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ARM_RESTORE=SKIPPED_INITIAL_DISARMED' 'initial DISARMED path must skip ARM restore'
Require-Source 'Assert-Arm\s+-Expected\s+\$ExpectedInitialArm\s+-Stage\s+[''\"]FINAL[''\"]' 'final ARM state must equal initial ARM state'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_FINAL_ARM=\$ExpectedInitialArm' 'final ARM audit marker must preserve initial ARM state'
Forbid-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_FINAL_ARM=ARMED' 'hard-coded final ARMED state'
Require-Source 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STATUS=PASS' 'terminal PASS marker'

Forbid-Source '\$component\.sourceTree' 'component result sourceTree property absent from runtime-source API contract'
Forbid-Source 'remoteMain\s+-ne\s+\$TargetCommit' 'self-referential remote-main equals rollout-target gate'
Forbid-Source '\.Split\(\@\(' 'ambiguous multi-separator String.Split overload for ls-tree parsing'
Forbid-Source 'git\s+pull|&\s*\$gitExe\s+pull' 'git pull'
Forbid-Source 'reset\s+--hard' 'git reset --hard'
Forbid-Source 'checkout\s+--force|checkout\s+-f' 'forced checkout'
Forbid-Source 'Register-ScheduledTask' 'task re-registration from production rollout helper'
Forbid-Source 'Restart-Service' 'Task Scheduler service restart from production rollout helper'
Forbid-Source 'function\s+Invoke-Bridge(Post|Put|Patch|Delete)' 'Bridge mutation helper'
Forbid-Source '/v1/(orders?|positions?)[^"''\r\n]*(send|close|cancel|modify|delete)' 'direct Bridge order/position mutation route'

Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_SOURCE_CONTRACT=PASS'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_GIT_MODE=EXACT_FF_ONLY'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_REMOTE_MAIN=INDEPENDENT_PIN'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LS_TREE_PARSE=PORTABLE'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_EXTERNAL_HELPER_PROVENANCE=PINNED_BLOB'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_RUNTIME_SOURCE_SCHEMA=DEPLOYMENT_TREE_COMPONENT_DEPLOYMENT_ID'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_INITIAL_ARM=ARMED_OR_EXPLICIT_DISARMED_RESUME'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_INITIAL_RUNTIME_STATE=HEALTHY_OR_ORPHAN_QUEUED_OR_STOPPED_LIFECYCLE'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIVE_TEST_ORDER=NONE'
