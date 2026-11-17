$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Types = Join-Path $ProjectRoot "apps\web\src\phase7c-runtime-source-attestation-types.ts"
$Api = Join-Path $ProjectRoot "apps\web\src\phase7c-runtime-source-attestation-api.ts"
$Card = Join-Path $ProjectRoot "apps\web\src\ui\Phase7CRuntimeSourceAttestationCard.tsx"
$Shell = Join-Path $ProjectRoot "apps\web\src\pages\Phase7CControlCenterShellPage.tsx"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

foreach ($path in @($Types, $Api, $Card, $Shell)) {
  Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Task5 source missing: $path"
}

$typesText = (Get-Content -LiteralPath $Types -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$apiText = (Get-Content -LiteralPath $Api -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$cardText = (Get-Content -LiteralPath $Card -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$shellText = (Get-Content -LiteralPath $Shell -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

Assert-True ($typesText.Contains('Phase7CRuntimeSourceAttestationSnapshot')) "Task5 Web response type missing"
Assert-True ($apiText.Contains('getPhase7CRuntimeSourceAttestation')) "Task5 Web GET client missing"
Assert-True ($apiText.Contains('/api/v1/phase7c/runtime-source-attestation')) "Task5 Web client must use exact GET endpoint"
Assert-True ($apiText.Contains('cache: "no-store"')) "Task5 Web attestation GET must be no-store"

Assert-True ($cardText.Contains('phase7c-runtime-source-attestation')) "Task5 card query key missing"
Assert-True ($cardText.Contains('refetchInterval: 5000')) "Task5 card must refresh every 5 seconds"
Assert-True ($cardText.Contains('retry: false')) "Task5 card must not retry hidden failures"
$expectedReadOnlyWarning = "READ-ONLY WARNING $([char]0x2014) NO AUTOMATIC ACTION TAKEN"
Assert-True ($cardText.Contains($expectedReadOnlyWarning)) "Task5 exact read-only warning copy missing"
foreach ($component in @('api','lifecycle-broker','supervisor','trend','sideway','telegram','regime-notifier')) {
  Assert-True ($cardText.Contains($component)) "Task5 card missing component row token: $component"
}
foreach ($forbidden in @('useMutation', 'setPhase7CBotMode', 'runPhase7CLifecycleAction', 'ARM_LIVE', 'DISARM_LIVE', 'fetch(', 'method: "POST"')) {
  Assert-True (-not $cardText.Contains($forbidden)) "Task5 card contains forbidden mutation/action token: $forbidden"
}

# P1 Control Center presentation contract: source attestation belongs at the bottom,
# defaults collapsed, keeps overall status/warnings/errors visible, and expands
# read-only deployment/process details only on demand.
Assert-True ($cardText.Contains('useState(false)')) "P1 card must default to collapsed"
$showDetailsLabel = "Hi$([char]0x1EC7)n chi ti$([char]0x1EBF)t"
$hideDetailsLabel = "$([char]0x1EA8)n chi ti$([char]0x1EBF)t"
Assert-True ($cardText.Contains($showDetailsLabel)) "P1 collapsed card must expose exact show-details label"
Assert-True ($cardText.Contains($hideDetailsLabel)) "P1 expanded card must expose exact hide-details label"
Assert-True ($cardText.Contains('aria-expanded={showDetails}')) "P1 details toggle must expose expansion state"

$detailsGateToken = 'snapshot && showDetails ? ('
$detailsGateIndex = $cardText.IndexOf($detailsGateToken, [System.StringComparison]::Ordinal)
Assert-True ($detailsGateIndex -ge 0) "P1 deployment/process details must be gated by showDetails"

$acceptedCommitIndex = $cardText.IndexOf('Accepted commit', [System.StringComparison]::Ordinal)
$deploymentIdIndex = $cardText.IndexOf('Deployment ID', [System.StringComparison]::Ordinal)
$componentRowsIndex = $cardText.IndexOf('COMPONENTS.map', [System.StringComparison]::Ordinal)
Assert-True ($acceptedCommitIndex -gt $detailsGateIndex) "P1 Accepted commit must render only inside expanded details"
Assert-True ($deploymentIdIndex -gt $detailsGateIndex) "P1 Deployment ID must render only inside expanded details"
Assert-True ($componentRowsIndex -gt $detailsGateIndex) "P1 process rows must render only inside expanded details"

$overallChipIndex = $cardText.IndexOf('label={snapshot.overall}', [System.StringComparison]::Ordinal)
$errorIndex = $cardText.IndexOf('query.isError ? (', [System.StringComparison]::Ordinal)
$warningIndex = $cardText.IndexOf('snapshot.overall !== "EXACT_MATCH"', [System.StringComparison]::Ordinal)
Assert-True ($overallChipIndex -ge 0 -and $overallChipIndex -lt $detailsGateIndex) "P1 overall status must remain visible while details are collapsed"
Assert-True ($errorIndex -ge 0 -and $errorIndex -lt $detailsGateIndex) "P1 load error must remain visible while details are collapsed"
Assert-True ($warningIndex -ge 0 -and $warningIndex -lt $detailsGateIndex) "P1 mismatch/stale/unknown warning must remain visible while details are collapsed"

$authIndex = $shellText.IndexOf('<Phase7CExecutionAuthorizationCard />', [System.StringComparison]::Ordinal)
$controlIndex = $shellText.IndexOf('<Phase7CControlCenterPage />', [System.StringComparison]::Ordinal)
$cardIndex = $shellText.IndexOf('<Phase7CRuntimeSourceAttestationCard />', [System.StringComparison]::Ordinal)
Assert-True ($authIndex -ge 0 -and $controlIndex -gt $authIndex -and $cardIndex -gt $controlIndex) "P1 card must mount at the bottom after authorization and control content"

Write-Host "PHASE7C_RUNTIME_SOURCE_ATTESTATION_WEB_SOURCE_TEST=PASS"
