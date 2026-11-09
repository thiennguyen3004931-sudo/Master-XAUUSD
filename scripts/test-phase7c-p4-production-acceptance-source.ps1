param(
    [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$helperPath = Join-Path $ProjectRoot "scripts\verify-phase7c-p4-production-acceptance-local.ps1"

if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "RED_TARGET: missing P4 production acceptance verifier: $helperPath"
}

$source = Get-Content -LiteralPath $helperPath -Raw

function Require-Literal {
    param([string]$Needle)
    if ($source.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw "P4 production acceptance verifier missing required contract literal: $Needle"
    }
}

function Reject-Regex {
    param([string]$Pattern, [string]$Message)
    if ([regex]::IsMatch($source, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw $Message
    }
}

Require-Literal "phase7c-counterfactual-intelligence-v1"
Require-Literal "/api/v1/phase7c/runtime-source-attestation"
Require-Literal "/api/v1/phase7c/counterfactual-intelligence"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_GIT_GUARD=PASS"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_SCHEMA=PASS"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_SAFETY=PASS"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_RULE_OBSERVATION_FAIL_CLOSED=PASS"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_FAST_MOVE_EXACT_EVIDENCE=PASS"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_ORDER_MUTATION=NONE"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_POSITION_MUTATION=NONE"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_MODE_MUTATION=NONE"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_ARM_MUTATION=NONE"
Require-Literal "P4_PRODUCTION_ACCEPTANCE_LIVE_TEST_ORDER=NONE"
Require-Literal "P4_PRODUCTION_ACCEPTANCE=PASS"
Require-Literal "ORDERED_EXIT_SIDE_PRICES_COMPLETE"
Require-Literal "RULE_OBSERVATION"
Require-Literal "UNAVAILABLE"
Require-Literal "SHADOW_ONLY"
Require-Literal "-Method Get"
Require-Literal "http://127.0.0.1:3711"
Require-Literal "-TimeoutSec 120"
Require-Literal "P4_HTTP_TIMEOUT_SECONDS=120"

Reject-Regex "rev-parse\s+HEAD[^\r\n]*\|\s*Select-Object\s+-First\s+1" "P4 verifier must not pipe native git rev-parse through Select-Object -First 1 because the downstream early-stop can make LASTEXITCODE nonzero after valid output."
Reject-Regex "branch\s+--show-current[^\r\n]*\|\s*Select-Object\s+-First\s+1" "P4 verifier must not pipe native git branch through Select-Object -First 1 because the downstream early-stop can make LASTEXITCODE nonzero after valid output."
Reject-Regex "-Method\s+(Post|Put|Patch|Delete)\b" "P4 production acceptance verifier must be GET-only."
Reject-Regex "Invoke-RestMethod[^\r\n]+/(arm|auto|mode|orders?|positions?|lifecycle)\b" "P4 verifier must not call mutation/control endpoints."
Reject-Regex "Restart-(Service|Process)|Stop-Process|Start-Process|Stop-ScheduledTask|Start-ScheduledTask" "P4 verifier must not restart runtime processes or tasks."
Reject-Regex "git\s+(checkout|switch|reset|pull|merge|rebase|clean)\b" "P4 verifier must not mutate the Git worktree."

Write-Output "P4_PRODUCTION_ACCEPTANCE_SOURCE_CONTRACT=PASS"
Write-Output "P4_PRODUCTION_ACCEPTANCE_HTTP_METHODS=GET_ONLY"
Write-Output "P4_PRODUCTION_ACCEPTANCE_RUNTIME_MUTATION=NONE"
