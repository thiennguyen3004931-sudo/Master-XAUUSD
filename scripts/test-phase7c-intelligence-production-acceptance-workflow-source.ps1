param(
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$workflow = Join-Path $ProjectRoot ".github\workflows\phase7c-intelligence-production-acceptance-readonly.yml"
if (-not (Test-Path -LiteralPath $workflow -PathType Leaf)) {
  throw "Missing intelligence production acceptance workflow."
}

$text = Get-Content -LiteralPath $workflow -Raw

function Require-Literal {
  param([string]$Needle)
  if ($text.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Workflow missing required literal: $Needle"
  }
}

function Reject-Regex {
  param([string]$Pattern, [string]$Message)
  if ([regex]::IsMatch($text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    throw $Message
  }
}

Require-Literal "Phase7C Intelligence Production Acceptance Read-Only"
Require-Literal "runs-on: [self-hosted, Windows, X64, xauusd-core-ci]"
Require-Literal "contents: read"
Require-Literal "EXPECTED_PRODUCTION_COMMIT: 8514fafffea7e7cde6a3bddfbb3cd23474bc20f7"
Require-Literal "PRODUCTION_ROOT: F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master"
Require-Literal "API_BASE_URL: http://127.0.0.1:3711"
Require-Literal "if: github.event_name == 'push' && github.ref == 'refs/heads/main'"
Require-Literal "test-phase7c-p3-production-acceptance-source.ps1"
Require-Literal "test-phase7c-p4-production-acceptance-source.ps1"
Require-Literal "test-phase7c-p5-production-acceptance-source.ps1"
Require-Literal "verify-phase7c-p3-production-acceptance-local.ps1"
Require-Literal "verify-phase7c-p4-production-acceptance-local.ps1"
Require-Literal "verify-phase7c-p5-production-acceptance-local.ps1"
Require-Literal "INTELLIGENCE_PRODUCTION_ACCEPTANCE_HTTP_METHODS=GET_ONLY"
Require-Literal "INTELLIGENCE_PRODUCTION_MUTATION=NONE"
Require-Literal "INTELLIGENCE_MODE_MUTATION=NONE"
Require-Literal "INTELLIGENCE_ARM_MUTATION=NONE"
Require-Literal "INTELLIGENCE_ORDER_MUTATION=NONE"
Require-Literal "INTELLIGENCE_POSITION_MUTATION=NONE"
Require-Literal "INTELLIGENCE_LIVE_TEST_ORDER=NONE"

Reject-Regex "API_BASE_URL:\s*http://127\.0\.0\.1:3001\b" "Workflow must target canonical Phase7C loopback port 3711, not 3001."
Reject-Regex "-Method\s+(Post|Put|Patch|Delete)\b" "Workflow must not contain production mutation HTTP methods."
Reject-Regex "Restart-(Service|Process)|Stop-Process|Start-Process|Start-ScheduledTask|Stop-ScheduledTask" "Workflow must not restart runtime processes/tasks."
Reject-Regex "(/arm|/auto|/mode|/orders?|/positions?)\b" "Workflow must not call mutation/control endpoints."
Reject-Regex "Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item" "Workflow must not write into production filesystem."

Write-Output "INTELLIGENCE_PRODUCTION_ACCEPTANCE_WORKFLOW_SOURCE_CONTRACT=PASS"
Write-Output "INTELLIGENCE_PRODUCTION_ACCEPTANCE_API_BASE=http://127.0.0.1:3711"
Write-Output "INTELLIGENCE_PRODUCTION_ACCEPTANCE_HTTP_METHODS=GET_ONLY"
Write-Output "INTELLIGENCE_PRODUCTION_ACCEPTANCE_RUNTIME_MUTATION=NONE"
