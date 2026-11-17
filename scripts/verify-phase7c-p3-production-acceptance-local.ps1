param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,

    [string]$ApiBaseUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Fail-P3Acceptance {
    param([string]$Message)
    throw "P3 production acceptance failed: $Message"
}

function Invoke-GetJson {
    param([string]$Uri)
    return Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ Accept = "application/json" } -TimeoutSec 120
}

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Fail-P3Acceptance "ProjectRoot does not exist: $ProjectRoot"
}

$ExpectedCommit = $ExpectedCommit.Trim().ToLowerInvariant()
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') {
    Fail-P3Acceptance "ExpectedCommit must be a 40-character Git SHA."
}

$headRaw = @(& git -C $ProjectRoot rev-parse HEAD 2>$null)
$headExitCode = $LASTEXITCODE
if ($headExitCode -ne 0 -or $headRaw.Count -ne 1) {
    Fail-P3Acceptance "could not resolve production HEAD exactly. exitCode=$headExitCode outputCount=$($headRaw.Count)"
}
$head = ([string]$headRaw[0]).Trim().ToLowerInvariant()
if ($head -ne $ExpectedCommit) {
    Fail-P3Acceptance "production HEAD mismatch. expected=$ExpectedCommit actual=$head"
}

$dirty = @(& git -C $ProjectRoot status --porcelain --untracked-files=normal 2>$null)
if ($LASTEXITCODE -ne 0) {
    Fail-P3Acceptance "could not verify clean production worktree."
}
if ($dirty.Count -ne 0) {
    Fail-P3Acceptance "production worktree is not clean."
}

$base = $ApiBaseUrl.Trim().TrimEnd('/')
if ($base -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    Fail-P3Acceptance "ApiBaseUrl must be an explicit loopback URL with port. actual=$base"
}

$attestation = Invoke-GetJson "$base/api/v1/phase7c/runtime-source-attestation"
if ([string]$attestation.overall -ne "EXACT_MATCH") {
    Fail-P3Acceptance "runtime source overall is not EXACT_MATCH. actual=$($attestation.overall)"
}
$components = @($attestation.components)
if ($components.Count -ne 8) {
    Fail-P3Acceptance "runtime source component count must be 8. actual=$($components.Count)"
}
$nonExact = @($components | Where-Object { [string]$_.verdict -ne "EXACT_MATCH" })
if ($nonExact.Count -ne 0) {
    $bad = ($nonExact | ForEach-Object { "$($_.component):$($_.verdict)" }) -join ','
    Fail-P3Acceptance "runtime source components are not all exact. $bad"
}
if ($null -eq $attestation.deployment -or [string]$attestation.deployment.sourceCommit -ne $ExpectedCommit) {
    Fail-P3Acceptance "attested deployment source commit does not match ExpectedCommit."
}

Write-Output "P3_RUNTIME_SOURCE_ATTESTATION=8/8_EXACT"

$p3 = Invoke-GetJson "$base/api/v1/phase7c/performance-effectiveness?days=90&symbol=XAUUSD&limit=100"
if ([string]$p3.schemaVersion -ne "phase7c-performance-effectiveness-v1") {
    Fail-P3Acceptance "unexpected P3 schemaVersion: $($p3.schemaVersion)"
}
if ($p3.readOnly -ne $true) {
    Fail-P3Acceptance "P3 readOnly must be true."
}
if ($null -eq $p3.safety) {
    Fail-P3Acceptance "P3 safety object is missing."
}
if ($p3.safety.readOnly -ne $true) { Fail-P3Acceptance "P3 safety.readOnly must be true." }
if ($p3.safety.runtimeMutation -ne $false) { Fail-P3Acceptance "P3 runtimeMutation must be false." }
if ($p3.safety.strategyMutation -ne $false) { Fail-P3Acceptance "P3 strategyMutation must be false." }
if ($p3.safety.riskMutation -ne $false) { Fail-P3Acceptance "P3 riskMutation must be false." }
if ($p3.safety.orderMutation -ne $false) { Fail-P3Acceptance "P3 orderMutation must be false." }
if ($p3.safety.positionMutation -ne $false) { Fail-P3Acceptance "P3 positionMutation must be false." }
if ($p3.safety.modeMutation -ne $false) { Fail-P3Acceptance "P3 modeMutation must be false." }
if ($p3.safety.armMutation -ne $false) { Fail-P3Acceptance "P3 armMutation must be false." }
if ($p3.safety.autoRetune -ne $false) { Fail-P3Acceptance "P3 autoRetune must be false." }
if ($p3.safety.liveTestOrder -ne $false) { Fail-P3Acceptance "P3 liveTestOrder must be false." }

$rows = @($p3.rows)
foreach ($row in $rows) {
    if ($null -eq $row.fastMove -or $null -eq $row.fastMove.current) {
        Fail-P3Acceptance "P3 row is missing Fast-Move current contract. tradeKey=$($row.tradeKey)"
    }
    $current = $row.fastMove.current
    if ([double]$current.activationPrice -ne 10 -or [double]$current.givebackPrice -ne 10) {
        Fail-P3Acceptance "P3 Fast-Move current contract mismatch. tradeKey=$($row.tradeKey) activation=$($current.activationPrice) giveback=$($current.givebackPrice)"
    }
    if ([string]$current.source -ne "LIVE_BID_ASK") {
        Fail-P3Acceptance "P3 Fast-Move source mismatch. tradeKey=$($row.tradeKey) source=$($current.source)"
    }
}

Write-Output "P3_SCHEMA=phase7c-performance-effectiveness-v1"
Write-Output "P3_READ_ONLY=TRUE"
Write-Output "P3_AUTO_RETUNE=FALSE"
Write-Output "P3_FAST_MOVE_CURRENT_CONTRACT=ACTIVATION_10_GIVEBACK_10"
Write-Output "P3_SAMPLE_ROWS=$($rows.Count)"
Write-Output "P3_ORDER_MUTATION=NONE"
Write-Output "P3_POSITION_MUTATION=NONE"
Write-Output "P3_MODE_MUTATION=NONE"
Write-Output "P3_ARM_MUTATION=NONE"
Write-Output "P3_LIVE_TEST_ORDER=NONE"
Write-Output "P3_HTTP_TIMEOUT_SECONDS=120"
Write-Output "P3_PRODUCTION_ACCEPTANCE=PASS"
