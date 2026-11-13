$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $PSScriptRoot "initialize-phase7c-runtime-source-deployment-local.ps1"

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw "RED: provenance-only runtime source initializer is missing: $target"
}

$source = Get-Content -LiteralPath $target -Raw

function Assert-Contains([string]$Pattern, [string]$Label) {
  if ($source -notmatch $Pattern) { throw "Missing required provenance-only contract: $Label" }
}
function Assert-NotContains([string]$Pattern, [string]$Label) {
  if ($source -match $Pattern) { throw "Forbidden mutation in provenance-only initializer: $Label" }
}

Assert-Contains 'phase7c-runtime-source-attestation\.ps1' 'canonical runtime source attestation library'
Assert-Contains 'Get-Phase7CRuntimeSourceConfigIdentity' 'canonical config identity'
Assert-Contains 'Initialize-Phase7CRuntimeSourceDeployment' 'canonical deployment initializer'
Assert-Contains 'git[^\r\n]+status[^\r\n]+--porcelain' 'clean worktree proof'
Assert-Contains 'git[^\r\n]+rev-parse[^\r\n]+HEAD' 'exact source commit proof'
Assert-Contains 'rev-parse[^\r\n]+\^\{tree\}' 'exact source tree proof'
Assert-Contains 'PHASE7C_RUNTIME_SOURCE_DEPLOYMENT_ID' 'deployment id output'
Assert-Contains 'PHASE7C_RUNTIME_SOURCE_COMMIT' 'source commit output'
Assert-Contains 'PHASE7C_RUNTIME_SOURCE_TREE' 'source tree output'

Assert-NotContains '(?i)Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask' 'Scheduled Task mutation'
Assert-NotContains '(?i)Start-Process|Stop-Process|taskkill\.exe' 'process mutation'
Assert-NotContains '(?i)Set-BotMode|/api/bot/mode[^\r\n]*(POST|PUT|PATCH)|Invoke-RestMethod[^\r\n]+-Method\s+(Post|Put|Patch|Delete)' 'MODE/HTTP mutation'
Assert-NotContains '(?i)arm-live|disarm|Set-.*Arm|Remove-Item[^\r\n]+arm|New-Item[^\r\n]+arm' 'ARM mutation'
Assert-NotContains '(?i)/v1/order|order/send|order/close|LIVE_TEST_ORDER' 'order mutation path'
Assert-NotContains '(?i)Phase7B-Bridge|phase7c-executor|trend-executor|sideway-executor' 'Bridge/executor runtime coupling'
Assert-NotContains '(?i)deploy-phase7c-mt5-dashboard|recover-phase7c|refresh-phase7c-web' 'runtime deployment/recovery delegation'

Write-Host "PHASE7C_RUNTIME_SOURCE_INITIALIZE_ONLY_SOURCE_CONTRACT=PASS"
