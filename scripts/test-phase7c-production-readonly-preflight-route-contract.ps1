param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProbePath = Join-Path $PSScriptRoot 'preflight-phase7c-production-readonly-local.ps1'
if (-not (Test-Path -LiteralPath $ProbePath -PathType Leaf)) {
    throw 'RED_TARGET: missing strict production read-only preflight helper.'
}

$source = Get-Content -LiteralPath $ProbePath -Raw

$requiredAccountSwitchEndpoints = @(
    '/api/v1/phase7c-account-switch/same-mode-readiness',
    '/api/v1/phase7c-account-switch/status'
)
foreach ($endpoint in $requiredAccountSwitchEndpoints) {
    if (-not $source.Contains($endpoint)) {
        throw "Production read-only preflight must call mounted account-switch route: $endpoint"
    }
}

$forbiddenLegacyEndpoints = @(
    '/api/v1/phase7c/account-switch/same-mode-readiness',
    '/api/v1/phase7c/account-switch/status'
)
foreach ($endpoint in $forbiddenLegacyEndpoints) {
    if ($source.Contains($endpoint)) {
        throw "Production read-only preflight contains unmounted account-switch route: $endpoint"
    }
}

Write-Output 'PHASE7C_PRODUCTION_READONLY_PREFLIGHT_ROUTE_CONTRACT=PASS'
