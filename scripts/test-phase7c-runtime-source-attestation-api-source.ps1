$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ApiRuntime = Join-Path $ProjectRoot "scripts\run-phase7b-api-runtime-local.ps1"
$ApiIndex = Join-Path $ProjectRoot "apps\api\src\index.ts"
$ApiApp = Join-Path $ProjectRoot "apps\api\src\app.ts"
$ApiService = Join-Path $ProjectRoot "apps\api\src\services\phase7c-runtime-source-attestation.service.ts"
$ApiRoute = Join-Path $ProjectRoot "apps\api\src\routes\phase7c-runtime-source-attestation.route.ts"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

foreach ($path in @($ApiRuntime, $ApiIndex, $ApiApp, $ApiService, $ApiRoute)) {
  Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Task4 source missing: $path"
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($ApiRuntime, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
  throw "Task4 API runtime PowerShell syntax invalid: $($errors[0].Message)"
}

$runtimeText = (Get-Content -LiteralPath $ApiRuntime -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
foreach ($marker in @(
  'PHASE7C_SOURCE_ATTESTATION_ROOT',
  'PHASE7C_SOURCE_ATTESTATION_API_LAUNCHER',
  'PHASE7C_SOURCE_ATTESTATION_ACCOUNT_MODE',
  'PHASE7C_SOURCE_ATTESTATION_LIVE_EXECUTION_ENABLED',
  'PHASE7C_SOURCE_ATTESTATION_CONTROL_API_URL'
)) {
  Assert-True ($runtimeText.Contains($marker)) "Task4 API runtime missing non-secret startup context: $marker"
}
Assert-True ($runtimeText.Contains('$env:PHASE7C_SOURCE_ATTESTATION_API_LAUNCHER = $PSCommandPath')) "Task4 must attest the actual API wrapper launcher"
Assert-True ($runtimeText.Contains('PHASE7B_API_RUNTIME_SOURCE_ATTESTATION_CONTEXT=UNKNOWN|SOURCE=TASK_FALLBACK')) "Task4 fallback must degrade to UNKNOWN instead of inventing identity"

$indexText = (Get-Content -LiteralPath $ApiIndex -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
Assert-True ($indexText.Contains('writePhase7CApiRuntimeSourceAttestation')) "Task4 API index must call self-attestation writer"
$listenIndex = $indexText.IndexOf('app.listen(', [System.StringComparison]::Ordinal)
$writerIndex = $indexText.IndexOf('writePhase7CApiRuntimeSourceAttestation()', [System.StringComparison]::Ordinal)
Assert-True ($listenIndex -ge 0 -and $writerIndex -gt $listenIndex) "Task4 API writer must run only inside/after successful listen callback"
Assert-True ($indexText.Contains('PHASE7C_RUNTIME_SOURCE_API_ATTESTATION=UNKNOWN')) "Task4 API writer failure must be non-fatal and observable"

$appText = (Get-Content -LiteralPath $ApiApp -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
Assert-True ($appText.Contains('/api/v1/phase7c/runtime-source-attestation')) "Task4 exact GET endpoint mount missing"

$routeText = (Get-Content -LiteralPath $ApiRoute -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
Assert-True ($routeText.Contains('router.get("/"')) "Task4 route must be GET-only"
Assert-True ($routeText.Contains('Runtime source attestation is restricted to localhost.')) "Task4 route must reject non-loopback requests"
Assert-True ($routeText.Contains('cache-control')) "Task4 route must disable caching"
Assert-True ($routeText.Contains('getPhase7CRuntimeSourceAttestationSnapshot')) "Task4 route must return P1 snapshot"
foreach ($forbidden in @('router.post(', 'router.put(', 'router.patch(', 'router.delete(', 'phase7CBotModeService', 'startPhase7CFromWeb', 'stopPhase7C', '/v1/orders', 'child_process', 'exec(', 'spawn(', 'git ')) {
  Assert-True (-not $routeText.Contains($forbidden)) "Task4 route contains forbidden mutation/process/Git token: $forbidden"
}

$serviceText = (Get-Content -LiteralPath $ApiService -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
foreach ($component in @('api','lifecycle-broker','supervisor','trend','sideway','telegram','regime-notifier')) {
  $needle = 'component: "' + $component + '"'
  Assert-True ($serviceText.Contains($needle)) "Task4 aggregator missing component mapping: $component"
}
Assert-True ($serviceText.Contains('process.kill(pid, 0)')) "Task4 liveness must use signal 0 only"
Assert-True ($serviceText.Contains('EPERM')) "P1 liveness must distinguish permission-denied process probes from dead PIDs"
Assert-True ($serviceText.Contains('ESRCH')) "P1 liveness must distinguish missing/dead PIDs explicitly"
Assert-True ($serviceText.Contains('PID_LIVENESS_UNAVAILABLE')) "P1 unexpected liveness probe errors must remain fail-closed as UNKNOWN evidence"
foreach ($forbidden in @('child_process', 'exec(', 'spawn(', 'ARM_LIVE', 'phase7CBotModeService', 'startPhase7CFromWeb', 'stopPhase7C', '/v1/orders', 'simple-git', 'git rev-parse')) {
  Assert-True (-not $serviceText.Contains($forbidden)) "Task4 service contains forbidden mutation/process/Git token: $forbidden"
}
Assert-True ($serviceText.Contains('readOnly: true')) "Task4 snapshot must declare readOnly=true"
Assert-True ($serviceText.Contains('modeMutation: false')) "Task4 snapshot must declare no mode mutation"
Assert-True ($serviceText.Contains('armMutation: false')) "Task4 snapshot must declare no ARM mutation"
Assert-True ($serviceText.Contains('orderMutation: false')) "Task4 snapshot must declare no order mutation"

Write-Host "PHASE7C_RUNTIME_SOURCE_ATTESTATION_API_SOURCE_TEST=PASS"
