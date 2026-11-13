param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$Verifier = Join-Path $ProjectRoot 'scripts\verify-phase7c-p5-production-acceptance-local.ps1'

if (-not (Test-Path -LiteralPath $Verifier -PathType Leaf)) {
    throw 'Missing P5 production acceptance verifier.'
}

$text = Get-Content -LiteralPath $Verifier -Raw
foreach ($required in @(
    'P5_PRODUCTION_ACCEPTANCE',
    'phase7c-recommendation-intelligence-v1',
    'READ_ONLY',
    'ADVISORY_ONLY',
    'AUTO_APPLY',
    'AUTO_RETUNE',
    'runtime-source-attestation',
    'recommendation-intelligence',
    'EXACT_MATCH',
    'BOUNDED',
    'HIGH',
    'REVIEW_CHANGE',
    'ORDER_MUTATION=NONE',
    'POSITION_MUTATION=NONE',
    'MODE_CHANGE=NONE',
    'ARM_CHANGE=NONE',
    'LIVE_TEST_ORDER=NONE',
    'http://127.0.0.1:3711',
    '-TimeoutSec 120',
    'P5_HTTP_TIMEOUT_SECONDS=120'
)) {
    if (-not $text.Contains($required)) {
        throw "Missing required verifier marker: $required"
    }
}

foreach ($forbidden in @(
    'Invoke-RestMethod -Method Post',
    'Invoke-RestMethod -Method Put',
    'Invoke-RestMethod -Method Patch',
    'Invoke-RestMethod -Method Delete',
    'Invoke-WebRequest -Method Post',
    'Invoke-WebRequest -Method Put',
    'Invoke-WebRequest -Method Patch',
    'Invoke-WebRequest -Method Delete',
    'Start-ScheduledTask',
    'Stop-ScheduledTask',
    '/apply',
    '/retune'
)) {
    if ($text -match [regex]::Escape($forbidden)) {
        throw "Forbidden mutation in verifier: $forbidden"
    }
}

Write-Output 'P5_PRODUCTION_ACCEPTANCE_SOURCE_CONTRACT=PASS'
