param(
    [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$verifier = Join-Path $ProjectRoot "scripts\verify-phase7c-intelligence-evidence-quality-baseline-local.ps1"
$workflow = Join-Path $ProjectRoot ".github\workflows\phase7c-intelligence-evidence-quality-baseline-readonly.yml"

foreach ($requiredFile in @($verifier, $workflow)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Missing Intelligence evidence quality baseline source file: $requiredFile"
    }
}

$verifierText = Get-Content -LiteralPath $verifier -Raw
$workflowText = Get-Content -LiteralPath $workflow -Raw

function Require-VerifierLiteral {
    param([string]$Needle)
    if ($verifierText.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw "Baseline verifier missing required literal: $Needle"
    }
}

function Require-WorkflowLiteral {
    param([string]$Needle)
    if ($workflowText.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw "Baseline workflow missing required literal: $Needle"
    }
}

function Reject-VerifierRegex {
    param([string]$Pattern, [string]$Message)
    if ([regex]::IsMatch($verifierText, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw $Message
    }
}

function Reject-WorkflowRegex {
    param([string]$Pattern, [string]$Message)
    if ([regex]::IsMatch($workflowText, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw $Message
    }
}

foreach ($literal in @(
    "http://127.0.0.1:3711",
    "-TimeoutSec 120",
    "-Method Get",
    "/api/v1/phase7c/runtime-source-attestation",
    "/api/v1/phase7c/performance-effectiveness",
    "/api/v1/phase7c/counterfactual-intelligence",
    "/api/v1/phase7c/recommendation-intelligence",
    "INTELLIGENCE_BASELINE_P3_EVIDENCE_COVERAGE_PERCENT",
    "INTELLIGENCE_BASELINE_P4_EVIDENCE_COVERAGE_PERCENT",
    "INTELLIGENCE_BASELINE_P5_CANDIDATES",
    "INTELLIGENCE_BASELINE_HUMAN_REVIEW_ONLY=TRUE",
    "INTELLIGENCE_BASELINE_AUTO_APPLY=FALSE",
    "INTELLIGENCE_BASELINE_AUTO_RETUNE=FALSE",
    "INTELLIGENCE_BASELINE_PRODUCTION_MUTATION=NONE",
    "INTELLIGENCE_EVIDENCE_QUALITY_BASELINE=PASS"
)) {
    Require-VerifierLiteral $literal
}

foreach ($literal in @(
    "Phase7C Intelligence Evidence Quality Baseline Read-Only",
    "runs-on: [self-hosted, Windows, X64, xauusd-core-ci]",
    "contents: read",
    "EXPECTED_PRODUCTION_COMMIT: 8514fafffea7e7cde6a3bddfbb3cd23474bc20f7",
    "PRODUCTION_ROOT: F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master",
    "API_BASE_URL: http://127.0.0.1:3711",
    "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    "test-phase7c-intelligence-evidence-quality-baseline-source.ps1",
    "verify-phase7c-intelligence-evidence-quality-baseline-local.ps1",
    "INTELLIGENCE_BASELINE_WORKFLOW_PRODUCTION_MUTATION=NONE"
)) {
    Require-WorkflowLiteral $literal
}

Reject-VerifierRegex "-Method\s+(Post|Put|Patch|Delete)\b" "Baseline verifier must remain GET-only."
Reject-VerifierRegex "Invoke-RestMethod[^\r\n]+/(arm|auto|mode|orders?|positions?|lifecycle)\b" "Baseline verifier must not call control or mutation endpoints."
Reject-VerifierRegex "Restart-(Service|Process)|Stop-Process|Start-Process|Start-ScheduledTask|Stop-ScheduledTask" "Baseline verifier must not restart runtime processes or tasks."
Reject-VerifierRegex "git\s+(checkout|switch|reset|pull|merge|rebase|clean)\b" "Baseline verifier must not mutate the Git worktree."
Reject-VerifierRegex "Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item" "Baseline verifier must not write to the production filesystem."

Reject-WorkflowRegex "-Method\s+(Post|Put|Patch|Delete)\b" "Baseline workflow must remain GET-only."
Reject-WorkflowRegex "Restart-(Service|Process)|Stop-Process|Start-Process|Start-ScheduledTask|Stop-ScheduledTask" "Baseline workflow must not restart runtime processes or tasks."
Reject-WorkflowRegex "(/arm|/auto|/mode|/orders?|/positions?|/lifecycle)\b" "Baseline workflow must not call control or mutation endpoints."

Write-Output "INTELLIGENCE_EVIDENCE_QUALITY_BASELINE_SOURCE_CONTRACT=PASS"
Write-Output "INTELLIGENCE_EVIDENCE_QUALITY_BASELINE_HTTP_METHODS=GET_ONLY"
Write-Output "INTELLIGENCE_EVIDENCE_QUALITY_BASELINE_RUNTIME_MUTATION=NONE"
