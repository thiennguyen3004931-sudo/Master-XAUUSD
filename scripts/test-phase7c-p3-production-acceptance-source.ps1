param(
    [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$helperPath = Join-Path $ProjectRoot "scripts\verify-phase7c-p3-production-acceptance-local.ps1"

if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "RED_TARGET: missing P3 production acceptance verifier: $helperPath"
}

$source = Get-Content -LiteralPath $helperPath -Raw

function Require-Literal {
    param([string]$Needle)
    if ($source.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw "P3 production acceptance verifier missing required contract literal: $Needle"
    }
}

function Reject-Regex {
    param([string]$Pattern, [string]$Message)
    if ([regex]::IsMatch($source, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw $Message
    }
}

Require-Literal "phase7c-performance-effectiveness-v1"
Require-Literal "/api/v1/phase7c/runtime-source-attestation"
Require-Literal "/api/v1/phase7c/performance-effectiveness"
Require-Literal "P3_PRODUCTION_ACCEPTANCE=PASS"
Require-Literal "P3_RUNTIME_SOURCE_ATTESTATION=8/8_EXACT"
Require-Literal "P3_SCHEMA=phase7c-performance-effectiveness-v1"
Require-Literal "P3_READ_ONLY=TRUE"
Require-Literal "P3_AUTO_RETUNE=FALSE"
Require-Literal "P3_FAST_MOVE_CURRENT_CONTRACT=ACTIVATION_10_GIVEBACK_10"
Require-Literal "P3_ORDER_MUTATION=NONE"
Require-Literal "P3_POSITION_MUTATION=NONE"
Require-Literal "P3_MODE_MUTATION=NONE"
Require-Literal "P3_ARM_MUTATION=NONE"
Require-Literal "P3_LIVE_TEST_ORDER=NONE"
Require-Literal "-Method Get"
Require-Literal "http://127.0.0.1:3711"
Require-Literal "-TimeoutSec 120"
Require-Literal "P3_HTTP_TIMEOUT_SECONDS=120"

Reject-Regex "rev-parse\s+HEAD[^\r\n]*\|\s*Select-Object\s+-First\s+1" "P3 verifier must not pipe native git rev-parse through Select-Object -First 1 because the downstream early-stop can make LASTEXITCODE nonzero after valid output."
Reject-Regex "-Method\s+(Post|Put|Patch|Delete)\b" "P3 production acceptance verifier must be GET-only."
Reject-Regex "Invoke-RestMethod[^\r\n]+/(arm|auto|mode|orders?|positions?)\b" "P3 verifier must not call mutation/control endpoints."
Reject-Regex "Restart-(Service|Process)|Stop-Process|Start-Process|Stop-ScheduledTask|Start-ScheduledTask" "P3 verifier must not restart runtime processes or tasks."

Write-Output "P3_PRODUCTION_ACCEPTANCE_SOURCE_CONTRACT=PASS"
Write-Output "P3_PRODUCTION_ACCEPTANCE_HTTP_METHODS=GET_ONLY"
Write-Output "P3_PRODUCTION_ACCEPTANCE_RUNTIME_MUTATION=NONE"
