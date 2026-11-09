param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,

    [string]$ApiBaseUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Fail-Baseline {
    param([string]$Message)
    throw "Intelligence evidence quality baseline failed: $Message"
}

function Invoke-GetJson {
    param([string]$Uri)
    return Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ Accept = "application/json" } -TimeoutSec 120
}

function Write-CompactJsonMarker {
    param(
        [Parameter(Mandatory = $true)] [string]$Name,
        [Parameter(Mandatory = $true)] $Value
    )
    $json = $Value | ConvertTo-Json -Depth 12 -Compress
    Write-Output "$Name=$json"
}

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Fail-Baseline "ProjectRoot does not exist: $ProjectRoot"
}

$ExpectedCommit = $ExpectedCommit.Trim().ToLowerInvariant()
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') {
    Fail-Baseline "ExpectedCommit must be a 40-character Git SHA."
}

$headRaw = @(& git -C $ProjectRoot rev-parse HEAD 2>$null)
$headExitCode = $LASTEXITCODE
if ($headExitCode -ne 0 -or $headRaw.Count -ne 1) {
    Fail-Baseline "could not resolve production HEAD exactly. exitCode=$headExitCode outputCount=$($headRaw.Count)"
}
$head = ([string]$headRaw[0]).Trim().ToLowerInvariant()
if ($head -ne $ExpectedCommit) {
    Fail-Baseline "production HEAD mismatch. expected=$ExpectedCommit actual=$head"
}

$branchRaw = @(& git -C $ProjectRoot branch --show-current 2>$null)
$branchExitCode = $LASTEXITCODE
if ($branchExitCode -ne 0 -or $branchRaw.Count -ne 1) {
    Fail-Baseline "could not resolve production branch exactly. exitCode=$branchExitCode outputCount=$($branchRaw.Count)"
}
$branch = ([string]$branchRaw[0]).Trim()
if ($branch -ne "main") {
    Fail-Baseline "production checkout must remain on branch main. actual=$branch"
}

$dirty = @(& git -C $ProjectRoot status --porcelain --untracked-files=normal 2>$null)
if ($LASTEXITCODE -ne 0) {
    Fail-Baseline "could not verify clean production worktree."
}
if ($dirty.Count -ne 0) {
    Fail-Baseline "production worktree is not clean."
}

$base = $ApiBaseUrl.Trim().TrimEnd('/')
if ($base -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    Fail-Baseline "ApiBaseUrl must be an explicit loopback URL with port. actual=$base"
}

$attestation = Invoke-GetJson "$base/api/v1/phase7c/runtime-source-attestation"
if ([string]$attestation.overall -ne "EXACT_MATCH") {
    Fail-Baseline "runtime source overall is not EXACT_MATCH. actual=$($attestation.overall)"
}
$components = @($attestation.components)
if ($components.Count -ne 8) {
    Fail-Baseline "runtime source component count must be 8. actual=$($components.Count)"
}
foreach ($component in $components) {
    if ([string]$component.verdict -ne "EXACT_MATCH") {
        Fail-Baseline "runtime source component is not EXACT_MATCH. component=$($component.component) verdict=$($component.verdict)"
    }
}
if ($null -eq $attestation.deployment -or [string]$attestation.deployment.sourceCommit -ne $ExpectedCommit) {
    Fail-Baseline "attested deployment source commit does not match ExpectedCommit."
}
Write-Output "INTELLIGENCE_BASELINE_RUNTIME_SOURCE_ATTESTATION=8/8_EXACT"

$p3 = Invoke-GetJson "$base/api/v1/phase7c/performance-effectiveness?days=90&symbol=XAUUSD&limit=100"
if ([string]$p3.schemaVersion -ne "phase7c-performance-effectiveness-v1") {
    Fail-Baseline "unexpected P3 schemaVersion: $($p3.schemaVersion)"
}
if ($p3.readOnly -ne $true -or $null -eq $p3.safety -or $p3.safety.readOnly -ne $true) {
    Fail-Baseline "P3 must remain read-only."
}
if ($p3.safety.runtimeMutation -ne $false -or $p3.safety.strategyMutation -ne $false -or
    $p3.safety.riskMutation -ne $false -or $p3.safety.orderMutation -ne $false -or
    $p3.safety.positionMutation -ne $false -or $p3.safety.modeMutation -ne $false -or
    $p3.safety.armMutation -ne $false -or $p3.safety.autoRetune -ne $false -or
    $p3.safety.liveTestOrder -ne $false) {
    Fail-Baseline "P3 safety contract is not mutation-free."
}

Write-Output "INTELLIGENCE_BASELINE_P3_TOTAL_ROWS=$($p3.summary.totalRows)"
Write-Output "INTELLIGENCE_BASELINE_P3_EXACT_ROWS=$($p3.summary.exactRows)"
Write-Output "INTELLIGENCE_BASELINE_P3_EXCURSION_QUALIFIED_ROWS=$($p3.summary.excursionQualifiedRows)"
Write-Output "INTELLIGENCE_BASELINE_P3_MANAGEMENT_QUALIFIED_ROWS=$($p3.summary.managementQualifiedRows)"
Write-Output "INTELLIGENCE_BASELINE_P3_EVIDENCE_COVERAGE_PERCENT=$($p3.summary.evidenceCoveragePercent)"
Write-Output "INTELLIGENCE_BASELINE_P3_FASTMOVE_EXACT_SAMPLE_SIZE=$($p3.aggregates.fastMove.exactSampleSize)"
Write-Output "INTELLIGENCE_BASELINE_P3_FASTMOVE_TRIGGERED_ROWS=$($p3.aggregates.fastMove.triggeredRows)"
Write-Output "INTELLIGENCE_BASELINE_P3_FASTMOVE_HANDOFF_ROWS=$($p3.aggregates.fastMove.handoffRows)"
Write-CompactJsonMarker "INTELLIGENCE_BASELINE_P3_STRATEGY_BUCKETS" @($p3.aggregates.strategy)
Write-CompactJsonMarker "INTELLIGENCE_BASELINE_P3_ENTRY_TYPE_BUCKETS" @($p3.aggregates.entryType)
Write-CompactJsonMarker "INTELLIGENCE_BASELINE_P3_RULE_BUCKETS" @($p3.aggregates.rule)
Write-CompactJsonMarker "INTELLIGENCE_BASELINE_P3_MANAGEMENT_BUCKETS" @($p3.aggregates.management)

$p4 = Invoke-GetJson "$base/api/v1/phase7c/counterfactual-intelligence?days=90&symbol=XAUUSD&limit=100"
if ([string]$p4.schemaVersion -ne "phase7c-counterfactual-intelligence-v1") {
    Fail-Baseline "unexpected P4 schemaVersion: $($p4.schemaVersion)"
}
if ($p4.readOnly -ne $true -or $p4.shadowOnly -ne $true -or $null -eq $p4.safety) {
    Fail-Baseline "P4 must remain read-only and shadow-only."
}
if ($p4.safety.runtimeMutation -ne $false -or $p4.safety.strategyMutation -ne $false -or
    $p4.safety.riskMutation -ne $false -or $p4.safety.orderMutation -ne $false -or
    $p4.safety.positionMutation -ne $false -or $p4.safety.modeMutation -ne $false -or
    $p4.safety.armMutation -ne $false -or $p4.safety.autoApply -ne $false -or
    $p4.safety.autoRetune -ne $false -or $p4.safety.liveTestOrder -ne $false) {
    Fail-Baseline "P4 safety contract is not mutation-free."
}

Write-Output "INTELLIGENCE_BASELINE_P4_TRADE_COUNT=$($p4.summary.tradeCount)"
Write-Output "INTELLIGENCE_BASELINE_P4_SCENARIO_COUNT=$($p4.summary.scenarioCount)"
Write-Output "INTELLIGENCE_BASELINE_P4_EXACT_COUNT=$($p4.summary.exactCount)"
Write-Output "INTELLIGENCE_BASELINE_P4_BOUNDED_COUNT=$($p4.summary.boundedCount)"
Write-Output "INTELLIGENCE_BASELINE_P4_UNAVAILABLE_COUNT=$($p4.summary.unavailableCount)"
Write-Output "INTELLIGENCE_BASELINE_P4_EVIDENCE_QUALIFIED_COUNT=$($p4.summary.evidenceQualifiedCount)"
Write-Output "INTELLIGENCE_BASELINE_P4_EVIDENCE_COVERAGE_PERCENT=$($p4.summary.evidenceCoveragePercent)"
Write-CompactJsonMarker "INTELLIGENCE_BASELINE_P4_FAMILY_BUCKETS" @($p4.aggregates.family)

$p5 = Invoke-GetJson "$base/api/v1/phase7c/recommendation-intelligence?days=90&symbol=XAUUSD&limit=100"
if ([string]$p5.schemaVersion -ne "phase7c-recommendation-intelligence-v1") {
    Fail-Baseline "unexpected P5 schemaVersion: $($p5.schemaVersion)"
}
if ($p5.readOnly -ne $true -or $p5.advisoryOnly -ne $true -or $null -eq $p5.safety) {
    Fail-Baseline "P5 must remain read-only and advisory-only."
}
if ($p5.safety.runtimeMutation -ne $false -or $p5.safety.strategyMutation -ne $false -or
    $p5.safety.riskMutation -ne $false -or $p5.safety.orderMutation -ne $false -or
    $p5.safety.positionMutation -ne $false -or $p5.safety.modeMutation -ne $false -or
    $p5.safety.armMutation -ne $false -or $p5.safety.autoApply -ne $false -or
    $p5.safety.autoRetune -ne $false -or $p5.safety.liveTestOrder -ne $false) {
    Fail-Baseline "P5 safety contract is not mutation-free."
}

Write-Output "INTELLIGENCE_BASELINE_P5_MIN_SAMPLE_REVIEW=$($p5.thresholds.minSampleForReview)"
Write-Output "INTELLIGENCE_BASELINE_P5_MIN_SAMPLE_HIGH_CONFIDENCE=$($p5.thresholds.minSampleForHighConfidence)"
Write-Output "INTELLIGENCE_BASELINE_P5_CANDIDATE_COUNT=$($p5.summary.candidateCount)"
Write-Output "INTELLIGENCE_BASELINE_P5_REVIEW_CHANGE_COUNT=$($p5.summary.reviewChangeCount)"
Write-Output "INTELLIGENCE_BASELINE_P5_KEEP_CURRENT_COUNT=$($p5.summary.keepCurrentCount)"
Write-Output "INTELLIGENCE_BASELINE_P5_COLLECT_MORE_EVIDENCE_COUNT=$($p5.summary.collectMoreEvidenceCount)"
Write-Output "INTELLIGENCE_BASELINE_P5_UNAVAILABLE_COUNT=$($p5.summary.unavailableCount)"

$candidateRows = @()
foreach ($candidate in @($p5.recommendations)) {
    $candidateRows += [pscustomobject]@{
        recommendationId = [string]$candidate.recommendationId
        targetScope = [string]$candidate.targetScope
        targetKey = [string]$candidate.targetKey
        sampleSize = [int]$candidate.sampleSize
        lineageExact = [bool]$candidate.lineage.exact
        counterfactualVerdict = [string]$candidate.counterfactual.verdict
        evidenceScore = [double]$candidate.evidenceScore
        action = [string]$candidate.action
        confidence = [string]$candidate.confidence
        observedNetPnl = [double]$candidate.observed.netPnl
        observedExpectancy = [double]$candidate.observed.expectancy
        observedWinRatePercent = [double]$candidate.observed.winRatePercent
        comparableDelta = $candidate.counterfactual.comparableDelta
        reasonCodes = @($candidate.reasonCodes)
    }
}
Write-CompactJsonMarker "INTELLIGENCE_BASELINE_P5_CANDIDATES" $candidateRows

Write-Output "INTELLIGENCE_BASELINE_HTTP_TIMEOUT_SECONDS=120"
Write-Output "INTELLIGENCE_BASELINE_HTTP_METHODS=GET_ONLY"
Write-Output "INTELLIGENCE_BASELINE_HUMAN_REVIEW_ONLY=TRUE"
Write-Output "INTELLIGENCE_BASELINE_AUTO_APPLY=FALSE"
Write-Output "INTELLIGENCE_BASELINE_AUTO_RETUNE=FALSE"
Write-Output "INTELLIGENCE_BASELINE_PRODUCTION_MUTATION=NONE"
Write-Output "INTELLIGENCE_BASELINE_MODE_MUTATION=NONE"
Write-Output "INTELLIGENCE_BASELINE_ARM_MUTATION=NONE"
Write-Output "INTELLIGENCE_BASELINE_ORDER_MUTATION=NONE"
Write-Output "INTELLIGENCE_BASELINE_POSITION_MUTATION=NONE"
Write-Output "INTELLIGENCE_BASELINE_LIVE_TEST_ORDER=NONE"
Write-Output "INTELLIGENCE_EVIDENCE_QUALITY_BASELINE=PASS"
