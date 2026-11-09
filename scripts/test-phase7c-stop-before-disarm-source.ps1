param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HelperPath = Join-Path $PSScriptRoot 'rollout-phase7c-production-source-transition-local.ps1'
if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    throw 'RED_TARGET: missing production source-transition rollout helper.'
}

$source = Get-Content -LiteralPath $HelperPath -Raw
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) {
    throw "Production source-transition rollout helper has PowerShell parse errors: $(@($errors | ForEach-Object Message) -join '; ')"
}

function Require-InOrder([string]$Text, [string[]]$Needles, [string]$Label) {
    $cursor = 0
    foreach ($needle in $Needles) {
        $index = $Text.IndexOf($needle, $cursor, [System.StringComparison]::Ordinal)
        if ($index -lt 0) {
            throw "$Label missing/out-of-order token: $needle"
        }
        $cursor = $index + $needle.Length
    }
}

$mutationMarker = '$mutationStarted = $false'
$mutationStart = $source.IndexOf($mutationMarker, [System.StringComparison]::Ordinal)
if ($mutationStart -lt 0) { throw 'Mutation block marker is missing.' }

$fastForwardMarker = '    Push-Location $ProjectRoot'
$fastForwardStart = $source.IndexOf($fastForwardMarker, $mutationStart, [System.StringComparison]::Ordinal)
if ($fastForwardStart -lt 0) { throw 'Fast-forward block marker is missing after runtime mutation block.' }
$runtimeMutationBlock = $source.Substring($mutationStart, $fastForwardStart - $mutationStart)

Require-InOrder -Text $runtimeMutationBlock -Label 'normal runtime mutation must STOP before DISARM' -Needles @(
    '$mutationStarted = $true',
    "if (`$ExpectedInitialRuntimeState -eq 'HEALTHY')",
    "Invoke-ApiPost '/api/v1/phase7c/lifecycle/stop'",
    'Wait-LifecycleStopped',
    'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIFECYCLE_STOP=PASS',
    "elseif (`$ExpectedInitialRuntimeState -eq 'ORPHAN_QUEUED')",
    'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIFECYCLE_STOP=SKIPPED_ALREADY_STOPPED',
    "elseif (`$ExpectedInitialRuntimeState -eq 'STOPPED_LIFECYCLE')",
    'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STOPPED_LIFECYCLE_LIFECYCLE_STOP=SKIPPED_ALREADY_STOPPED',
    "if (`$ExpectedInitialArm -eq 'ARMED')",
    "Invoke-LiveArmAction -Action 'DISARM_LIVE'",
    "Assert-Arm -Expected 'DISARMED' -Stage 'POST_DISARM'"
)

if ($runtimeMutationBlock -notmatch 'Assert-Arm\s+-Expected\s+\$ExpectedInitialArm\s+-Stage\s+[''"]POST_LIFECYCLE_STOP_PRE_DISARM[''"]') {
    throw 'Healthy STOP must prove the original ARM state is unchanged before DISARM.'
}
if ($runtimeMutationBlock -notmatch 'Assert-OrphanQueuedRuntimeState\s+-Stage\s+[''"]PRE_DISARM[''"]') {
    throw 'ORPHAN_QUEUED resume must prove lifecycle is already stopped before DISARM.'
}
if ($runtimeMutationBlock -notmatch 'Assert-StoppedLifecycleRuntimeState[^\r\n]*-Stage\s+[''"]PRE_DISARM[''"]') {
    throw 'STOPPED_LIFECYCLE resume must prove lifecycle is already stopped before DISARM.'
}

$catchMarker = "Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_FAIL_CLOSED="
$catchStart = $source.IndexOf($catchMarker, $fastForwardStart, [System.StringComparison]::Ordinal)
if ($catchStart -lt 0) { throw 'Fail-closed block marker is missing.' }
$failClosedBlock = $source.Substring($catchStart)

Require-InOrder -Text $failClosedBlock -Label 'fail-closed mutation must STOP attempt before DISARM attempt' -Needles @(
    "Invoke-ApiPost '/api/v1/phase7c/lifecycle/stop'",
    "Invoke-LiveArmAction -Action 'DISARM_LIVE'"
)

if ($source -notmatch 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_MUTATION_ORDER=STOP_THEN_DISARM') {
    throw 'Terminal mutation-order attestation is missing.'
}

Write-Output 'PHASE7C_STOP_BEFORE_DISARM_SOURCE_CONTRACT=PASS'
Write-Output 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_MUTATION_ORDER=STOP_THEN_DISARM'
