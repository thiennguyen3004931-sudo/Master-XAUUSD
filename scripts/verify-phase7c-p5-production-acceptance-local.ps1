param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,

    [string]$ApiBaseUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Fail-P5Acceptance {
    param([string]$Message)
    throw "P5 production acceptance failed: $Message"
}

function Invoke-GetJson {
    param([string]$Uri)
    return Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ Accept = "application/json" } -TimeoutSec 120
}

function Assert-P5Safety {
    param(
        [Parameter(Mandatory = $true)] $Safety,
        [Parameter(Mandatory = $true)] [string]$Label
    )

    if ($null -eq $Safety) { Fail-P5Acceptance "$Label safety object is missing." }
    if ($Safety.readOnly -ne $true) { Fail-P5Acceptance "$Label READ_ONLY must be true." }
    if ($Safety.advisoryOnly -ne $true) { Fail-P5Acceptance "$Label ADVISORY_ONLY must be true." }
    if ($Safety.runtimeMutation -ne $false) { Fail-P5Acceptance "$Label runtimeMutation must be false." }
    if ($Safety.strategyMutation -ne $false) { Fail-P5Acceptance "$Label strategyMutation must be false." }
    if ($Safety.riskMutation -ne $false) { Fail-P5Acceptance "$Label riskMutation must be false." }
    if ($Safety.orderMutation -ne $false) { Fail-P5Acceptance "$Label orderMutation must be false." }
    if ($Safety.positionMutation -ne $false) { Fail-P5Acceptance "$Label positionMutation must be false." }
    if ($Safety.modeMutation -ne $false) { Fail-P5Acceptance "$Label modeMutation must be false." }
    if ($Safety.armMutation -ne $false) { Fail-P5Acceptance "$Label armMutation must be false." }
    if ($Safety.autoApply -ne $false) { Fail-P5Acceptance "$Label AUTO_APPLY must be false." }
    if ($Safety.autoRetune -ne $false) { Fail-P5Acceptance "$Label AUTO_RETUNE must be false." }
    if ($Safety.liveTestOrder -ne $false) { Fail-P5Acceptance "$Label liveTestOrder must be false." }
}

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Fail-P5Acceptance "ProjectRoot does not exist: $ProjectRoot"
}

$ExpectedCommit = $ExpectedCommit.Trim().ToLowerInvariant()
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') {
    Fail-P5Acceptance "ExpectedCommit must be a 40-character Git SHA."
}

$headRaw = @(& git -C $ProjectRoot rev-parse HEAD 2>$null)
$headExitCode = $LASTEXITCODE
if ($headExitCode -ne 0 -or $headRaw.Count -ne 1) {
    Fail-P5Acceptance "could not resolve production HEAD exactly. exitCode=$headExitCode outputCount=$($headRaw.Count)"
}
$head = ([string]$headRaw[0]).Trim().ToLowerInvariant()
if ($head -ne $ExpectedCommit) {
    Fail-P5Acceptance "production HEAD mismatch. expected=$ExpectedCommit actual=$head"
}

$branchRaw = @(& git -C $ProjectRoot branch --show-current 2>$null)
$branchExitCode = $LASTEXITCODE
if ($branchExitCode -ne 0 -or $branchRaw.Count -ne 1) {
    Fail-P5Acceptance "could not resolve production branch exactly. exitCode=$branchExitCode outputCount=$($branchRaw.Count)"
}
$branch = ([string]$branchRaw[0]).Trim()
if ($branch -ne "main") {
    Fail-P5Acceptance "production checkout must remain on branch main. actual=$branch"
}

$dirty = @(& git -C $ProjectRoot status --porcelain --untracked-files=normal 2>$null)
if ($LASTEXITCODE -ne 0) {
    Fail-P5Acceptance "could not verify clean production worktree."
}
if ($dirty.Count -ne 0) {
    Fail-P5Acceptance "production worktree is not clean."
}
Write-Output "P5_PRODUCTION_ACCEPTANCE_GIT_GUARD=PASS"

$base = $ApiBaseUrl.Trim().TrimEnd('/')
if ($base -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    Fail-P5Acceptance "ApiBaseUrl must be an explicit loopback URL with port. actual=$base"
}

$attestation = Invoke-GetJson "$base/api/v1/phase7c/runtime-source-attestation"
if ([string]$attestation.overall -ne "EXACT_MATCH") {
    Fail-P5Acceptance "runtime source overall is not EXACT_MATCH. actual=$($attestation.overall)"
}
if ($null -eq $attestation.deployment) {
    Fail-P5Acceptance "runtime source deployment evidence is missing."
}
if ([string]$attestation.deployment.sourceCommit -ne $ExpectedCommit) {
    Fail-P5Acceptance "attested deployment source commit does not match ExpectedCommit."
}

$components = @($attestation.components)
if ($components.Count -ne 8) {
    Fail-P5Acceptance "runtime source component count must be 8. actual=$($components.Count)"
}
foreach ($component in $components) {
    if ([string]$component.verdict -ne "EXACT_MATCH") {
        Fail-P5Acceptance "runtime source component is not EXACT_MATCH. component=$($component.component) verdict=$($component.verdict)"
    }
    if ([string]$component.sourceCommit -ne $ExpectedCommit) {
        Fail-P5Acceptance "runtime source component commit mismatch. component=$($component.component) actual=$($component.sourceCommit)"
    }
}
Write-Output "P5_PRODUCTION_ACCEPTANCE_RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8"

$p5 = Invoke-GetJson "$base/api/v1/phase7c/recommendation-intelligence?days=90&symbol=XAUUSD&limit=100"
if ([string]$p5.schemaVersion -ne "phase7c-recommendation-intelligence-v1") {
    Fail-P5Acceptance "unexpected P5 schemaVersion: $($p5.schemaVersion)"
}
if ($p5.readOnly -ne $true) { Fail-P5Acceptance "P5 READ_ONLY must be true." }
if ($p5.advisoryOnly -ne $true) { Fail-P5Acceptance "P5 ADVISORY_ONLY must be true." }
if ($p5.evidenceScoreIsNotProbability -ne $true) {
    Fail-P5Acceptance "P5 evidenceScoreIsNotProbability must be true."
}
Assert-P5Safety -Safety $p5.safety -Label "P5 root"
if ([int]$p5.thresholds.minSampleForReview -ne 10) {
    Fail-P5Acceptance "P5 minSampleForReview must be 10."
}
if ([int]$p5.thresholds.minSampleForHighConfidence -ne 30) {
    Fail-P5Acceptance "P5 minSampleForHighConfidence must be 30."
}
Write-Output "P5_PRODUCTION_ACCEPTANCE_SCHEMA=PASS"
Write-Output "P5_PRODUCTION_ACCEPTANCE_READ_ONLY=PASS"
Write-Output "P5_PRODUCTION_ACCEPTANCE_ADVISORY_ONLY=PASS"
Write-Output "P5_PRODUCTION_ACCEPTANCE_AUTO_APPLY=FALSE"
Write-Output "P5_PRODUCTION_ACCEPTANCE_AUTO_RETUNE=FALSE"

$validActions = @("KEEP_CURRENT", "REVIEW_CHANGE", "COLLECT_MORE_EVIDENCE", "UNAVAILABLE")
$validConfidences = @("HIGH", "MEDIUM", "LOW", "NONE")
$validVerdicts = @("EXACT", "BOUNDED", "UNAVAILABLE")
$candidates = @($p5.recommendations)

foreach ($candidate in $candidates) {
    $id = [string]$candidate.recommendationId
    if ([string]::IsNullOrWhiteSpace($id)) {
        Fail-P5Acceptance "recommendationId must not be empty."
    }
    if ([string]$candidate.schemaVersion -ne "phase7c-recommendation-intelligence-v1") {
        Fail-P5Acceptance "candidate schemaVersion mismatch. recommendationId=$id"
    }
    if ($candidate.evidenceScoreIsNotProbability -ne $true) {
        Fail-P5Acceptance "candidate evidence score must be marked as non-probability. recommendationId=$id"
    }
    Assert-P5Safety -Safety $candidate.safety -Label "candidate $id"

    $action = [string]$candidate.action
    $confidence = [string]$candidate.confidence
    $verdict = [string]$candidate.counterfactual.verdict
    $sampleSize = [int]$candidate.sampleSize
    $score = [double]$candidate.evidenceScore

    if ($validActions -notcontains $action) {
        Fail-P5Acceptance "unsupported action. recommendationId=$id action=$action"
    }
    if ($validConfidences -notcontains $confidence) {
        Fail-P5Acceptance "unsupported confidence. recommendationId=$id confidence=$confidence"
    }
    if ($validVerdicts -notcontains $verdict) {
        Fail-P5Acceptance "unsupported P4 verdict. recommendationId=$id verdict=$verdict"
    }
    if ($score -lt 0 -or $score -gt 100) {
        Fail-P5Acceptance "evidenceScore must be within 0..100. recommendationId=$id score=$score"
    }

    if ($confidence -eq "HIGH") {
        if ($verdict -ne "EXACT") {
            Fail-P5Acceptance "HIGH confidence requires EXACT P4 evidence. recommendationId=$id verdict=$verdict"
        }
        if ($sampleSize -lt 30) {
            Fail-P5Acceptance "HIGH confidence requires sample >= 30. recommendationId=$id sample=$sampleSize"
        }
    }

    if ($verdict -eq "BOUNDED" -and $confidence -eq "HIGH") {
        Fail-P5Acceptance "BOUNDED evidence can never produce HIGH confidence. recommendationId=$id"
    }

    if ($action -eq "REVIEW_CHANGE") {
        if ($sampleSize -lt 10) {
            Fail-P5Acceptance "REVIEW_CHANGE requires sample >= 10. recommendationId=$id sample=$sampleSize"
        }
        if ($candidate.lineage.exact -ne $true) {
            Fail-P5Acceptance "REVIEW_CHANGE requires exact lineage. recommendationId=$id"
        }
        if ($verdict -eq "UNAVAILABLE") {
            Fail-P5Acceptance "REVIEW_CHANGE cannot use UNAVAILABLE P4 evidence. recommendationId=$id"
        }
        if ($candidate.counterfactual.conflict -eq $true) {
            Fail-P5Acceptance "REVIEW_CHANGE cannot contain conflicting directional evidence. recommendationId=$id"
        }
        if ($null -eq $candidate.counterfactual.comparableDelta) {
            Fail-P5Acceptance "REVIEW_CHANGE requires explicit comparable delta. recommendationId=$id"
        }
        if ([double]$candidate.counterfactual.comparableDelta -le 0) {
            Fail-P5Acceptance "REVIEW_CHANGE requires positive comparable delta. recommendationId=$id delta=$($candidate.counterfactual.comparableDelta)"
        }
    }
}

if ([int]$p5.summary.candidateCount -ne $candidates.Count) {
    Fail-P5Acceptance "summary candidateCount mismatch. summary=$($p5.summary.candidateCount) actual=$($candidates.Count)"
}

Write-Output "P5_PRODUCTION_ACCEPTANCE_CANDIDATE_GATES=PASS"
Write-Output "P5_PRODUCTION_ACCEPTANCE_SAMPLE_CANDIDATES=$($candidates.Count)"
Write-Output "P5_PRODUCTION_ACCEPTANCE_ORDER_MUTATION=NONE"
Write-Output "P5_PRODUCTION_ACCEPTANCE_POSITION_MUTATION=NONE"
Write-Output "P5_PRODUCTION_ACCEPTANCE_MODE_CHANGE=NONE"
Write-Output "P5_PRODUCTION_ACCEPTANCE_ARM_CHANGE=NONE"
Write-Output "P5_PRODUCTION_ACCEPTANCE_LIVE_TEST_ORDER=NONE"
Write-Output "P5_HTTP_TIMEOUT_SECONDS=120"
Write-Output "P5_PRODUCTION_ACCEPTANCE=PASS"
