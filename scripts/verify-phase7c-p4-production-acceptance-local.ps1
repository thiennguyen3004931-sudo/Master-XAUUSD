param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,

    [string]$ApiBaseUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Fail-P4Acceptance {
    param([string]$Message)
    throw "P4 production acceptance failed: $Message"
}

function Invoke-GetJson {
    param([string]$Uri)
    return Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ Accept = "application/json" } -TimeoutSec 120
}

function Assert-P4Safety {
    param(
        [Parameter(Mandatory = $true)] $Safety,
        [Parameter(Mandatory = $true)] [string]$Label
    )

    if ($null -eq $Safety) { Fail-P4Acceptance "$Label safety object is missing." }
    if ($Safety.readOnly -ne $true) { Fail-P4Acceptance "$Label safety.readOnly must be true." }
    if ($Safety.shadowOnly -ne $true) { Fail-P4Acceptance "$Label safety.shadowOnly must be true." }
    if ($Safety.runtimeMutation -ne $false) { Fail-P4Acceptance "$Label runtimeMutation must be false." }
    if ($Safety.strategyMutation -ne $false) { Fail-P4Acceptance "$Label strategyMutation must be false." }
    if ($Safety.riskMutation -ne $false) { Fail-P4Acceptance "$Label riskMutation must be false." }
    if ($Safety.orderMutation -ne $false) { Fail-P4Acceptance "$Label orderMutation must be false." }
    if ($Safety.positionMutation -ne $false) { Fail-P4Acceptance "$Label positionMutation must be false." }
    if ($Safety.modeMutation -ne $false) { Fail-P4Acceptance "$Label modeMutation must be false." }
    if ($Safety.armMutation -ne $false) { Fail-P4Acceptance "$Label armMutation must be false." }
    if ($Safety.autoApply -ne $false) { Fail-P4Acceptance "$Label autoApply must be false." }
    if ($Safety.autoRetune -ne $false) { Fail-P4Acceptance "$Label autoRetune must be false." }
    if ($Safety.liveTestOrder -ne $false) { Fail-P4Acceptance "$Label liveTestOrder must be false." }
}

function Assert-NullOutcome {
    param(
        [Parameter(Mandatory = $true)] $Outcome,
        [Parameter(Mandatory = $true)] [string]$Label
    )

    if ($null -eq $Outcome) { Fail-P4Acceptance "$Label is missing." }
    foreach ($name in @("exitPrice", "netPnl", "realizedR", "lockedProfitPrice")) {
        if ($null -ne $Outcome.$name) {
            Fail-P4Acceptance "$Label.$name must remain null when counterfactual outcome is unavailable."
        }
    }
}

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Fail-P4Acceptance "ProjectRoot does not exist: $ProjectRoot"
}

$ExpectedCommit = $ExpectedCommit.Trim().ToLowerInvariant()
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') {
    Fail-P4Acceptance "ExpectedCommit must be a 40-character Git SHA."
}

$headRaw = @(& git -C $ProjectRoot rev-parse HEAD 2>$null)
$headExitCode = $LASTEXITCODE
if ($headExitCode -ne 0 -or $headRaw.Count -ne 1) {
    Fail-P4Acceptance "could not resolve production HEAD exactly. exitCode=$headExitCode outputCount=$($headRaw.Count)"
}
$head = ([string]$headRaw[0]).Trim().ToLowerInvariant()
if ($head -ne $ExpectedCommit) {
    Fail-P4Acceptance "production HEAD mismatch. expected=$ExpectedCommit actual=$head"
}

$branchRaw = @(& git -C $ProjectRoot branch --show-current 2>$null)
$branchExitCode = $LASTEXITCODE
if ($branchExitCode -ne 0 -or $branchRaw.Count -ne 1) {
    Fail-P4Acceptance "could not resolve production branch exactly. exitCode=$branchExitCode outputCount=$($branchRaw.Count)"
}
$branch = ([string]$branchRaw[0]).Trim()
if ($branch -ne "main") {
    Fail-P4Acceptance "production checkout must remain on branch main. actual=$branch"
}

$dirty = @(& git -C $ProjectRoot status --porcelain --untracked-files=normal 2>$null)
if ($LASTEXITCODE -ne 0) {
    Fail-P4Acceptance "could not verify clean production worktree."
}
if ($dirty.Count -ne 0) {
    Fail-P4Acceptance "production worktree is not clean."
}
Write-Output "P4_PRODUCTION_ACCEPTANCE_GIT_GUARD=PASS"

$base = $ApiBaseUrl.Trim().TrimEnd('/')
if ($base -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    Fail-P4Acceptance "ApiBaseUrl must be an explicit loopback URL with port. actual=$base"
}

$attestation = Invoke-GetJson "$base/api/v1/phase7c/runtime-source-attestation"
if ([string]$attestation.overall -ne "EXACT_MATCH") {
    Fail-P4Acceptance "runtime source overall is not EXACT_MATCH. actual=$($attestation.overall)"
}
if ($null -eq $attestation.deployment) {
    Fail-P4Acceptance "runtime source deployment evidence is missing."
}
if ([string]$attestation.deployment.sourceCommit -ne $ExpectedCommit) {
    Fail-P4Acceptance "attested deployment source commit does not match ExpectedCommit."
}

$components = @($attestation.components)
if ($components.Count -ne 8) {
    Fail-P4Acceptance "runtime source component count must be 8. actual=$($components.Count)"
}
foreach ($component in $components) {
    if ([string]$component.verdict -ne "EXACT_MATCH") {
        Fail-P4Acceptance "runtime source component is not EXACT_MATCH. component=$($component.component) verdict=$($component.verdict)"
    }
    if ([string]$component.sourceCommit -ne $ExpectedCommit) {
        Fail-P4Acceptance "runtime source component commit mismatch. component=$($component.component) actual=$($component.sourceCommit)"
    }
}
Write-Output "P4_PRODUCTION_ACCEPTANCE_RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8"

$p4 = Invoke-GetJson "$base/api/v1/phase7c/counterfactual-intelligence?days=90&symbol=XAUUSD&limit=100"
if ([string]$p4.schemaVersion -ne "phase7c-counterfactual-intelligence-v1") {
    Fail-P4Acceptance "unexpected P4 schemaVersion: $($p4.schemaVersion)"
}
if ($p4.readOnly -ne $true) { Fail-P4Acceptance "P4 readOnly must be true." }
if ($p4.shadowOnly -ne $true) { Fail-P4Acceptance "P4 shadowOnly must be true." }
Assert-P4Safety -Safety $p4.safety -Label "P4 root"
Write-Output "P4_PRODUCTION_ACCEPTANCE_SCHEMA=PASS"
Write-Output "P4_PRODUCTION_ACCEPTANCE_SAFETY=PASS"

$scenarios = @($p4.scenarios)
$validVerdicts = @("EXACT", "BOUNDED", "UNAVAILABLE")
foreach ($scenario in $scenarios) {
    $scenarioId = [string]$scenario.scenarioId
    if ([string]::IsNullOrWhiteSpace($scenarioId)) {
        Fail-P4Acceptance "P4 scenarioId must not be empty."
    }
    if ([string]$scenario.mode -ne "SHADOW_ONLY") {
        Fail-P4Acceptance "P4 scenario mode must be SHADOW_ONLY. scenarioId=$scenarioId mode=$($scenario.mode)"
    }
    Assert-P4Safety -Safety $scenario.safety -Label "scenario $scenarioId"

    $verdict = [string]$scenario.evidence.verdict
    if ($validVerdicts -notcontains $verdict) {
        Fail-P4Acceptance "unsupported P4 evidence verdict. scenarioId=$scenarioId verdict=$verdict"
    }

    if ([string]$scenario.family -eq "RULE_OBSERVATION" -and $verdict -ne "UNAVAILABLE") {
        Fail-P4Acceptance "RULE_OBSERVATION must remain UNAVAILABLE in P4 v1. scenarioId=$scenarioId verdict=$verdict"
    }

    if ([string]$scenario.family -eq "FAST_MOVE_GIVEBACK" -and $verdict -eq "EXACT") {
        $sources = @($scenario.evidence.sources | ForEach-Object { [string]$_ })
        if ($sources -notcontains "ORDERED_EXIT_SIDE_PRICES_COMPLETE") {
            Fail-P4Acceptance "EXACT Fast-Move scenario lacks complete ordered exit-side evidence. scenarioId=$scenarioId sources=$($sources -join ',')"
        }
    }

    if ($verdict -eq "UNAVAILABLE") {
        Assert-NullOutcome -Outcome $scenario.shadowOutcome -Label "scenario $scenarioId shadowOutcome"
        Assert-NullOutcome -Outcome $scenario.delta -Label "scenario $scenarioId delta"
    }
}

Write-Output "P4_PRODUCTION_ACCEPTANCE_RULE_OBSERVATION_FAIL_CLOSED=PASS"
Write-Output "P4_PRODUCTION_ACCEPTANCE_FAST_MOVE_EXACT_EVIDENCE=PASS"
Write-Output "P4_PRODUCTION_ACCEPTANCE_SAMPLE_SCENARIOS=$($scenarios.Count)"
Write-Output "P4_PRODUCTION_ACCEPTANCE_ORDER_MUTATION=NONE"
Write-Output "P4_PRODUCTION_ACCEPTANCE_POSITION_MUTATION=NONE"
Write-Output "P4_PRODUCTION_ACCEPTANCE_MODE_MUTATION=NONE"
Write-Output "P4_PRODUCTION_ACCEPTANCE_ARM_MUTATION=NONE"
Write-Output "P4_PRODUCTION_ACCEPTANCE_LIVE_TEST_ORDER=NONE"
Write-Output "P4_HTTP_TIMEOUT_SECONDS=120"
Write-Output "P4_PRODUCTION_ACCEPTANCE=PASS"
