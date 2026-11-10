# Independent V6 source-stage verification. No broker connection, process starts,
# account switches, software installation, secret reads or Phase7C writes.
# A PASS verifies archive source integrity ONLY, never LIVE readiness.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Stop-V6Stage {
    param([string]$Reason)
    Write-Host ('V6_ISOLATED_STAGE_RESULT=BLOCKED_' + $Reason)
    Write-Host 'V6_LIVE_APPROVAL=NO'
    exit 2
}

$manifestPath = Join-Path $root 'V6-ISOLATED-RELEASE-MANIFEST.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Stop-V6Stage 'MANIFEST_MISSING'
}
try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop |
        ConvertFrom-Json -ErrorAction Stop
} catch {
    Stop-V6Stage 'MANIFEST_INVALID'
}
if ($manifest.schema -ne 'xauusd-v6-isolated-source-v1' -or
    $manifest.repository -ne 'thiennguyen3004931-sudo/Master-XAUUSD' -or
    $manifest.commit -notmatch '^[0-9a-f]{40}$' -or
    $manifest.installed -ne $false -or
    $manifest.real_trading_authorized -ne $false -or
    $manifest.live_readiness_verified -ne $false -or
    $manifest.mt5_connected -ne $false -or
    $manifest.may_start_broker_or_terminal -ne $false) {
    Stop-V6Stage 'MANIFEST_BOUNDARY_INVALID'
}

# Never accept a source bundle over an existing legacy/runtime installation.
foreach ($rel in @('.git', '.runtime', 'packages\mt5-broker\bridge',
                    'phase7c-account-bridge', 'phase7c-executors')) {
    if (Test-Path -LiteralPath (Join-Path $root $rel)) {
        Stop-V6Stage 'NOT_CLEAN_INDEPENDENT_DIRECTORY'
    }
}

$expected = @(
    'apps/web/public/standalone-ui.html',
    'docs/V6-ISOLATED-SOURCE-RELEASE.md',
    'scripts/mt5-direct-probe.py',
    'scripts/v6-api-input-guards.mjs',
    'scripts/v6_daily_loss_guard.py',
    'scripts/xauusd-standalone-server.mjs',
    'scripts/xauusd_v6_trade_rules.py',
    'scripts/ops/check-v6-isolated-stage-readonly.ps1'
)
$listed = @($manifest.files_sha256.PSObject.Properties.Name | Sort-Object)
if (@(Compare-Object -ReferenceObject @($expected | Sort-Object) -DifferenceObject $listed).Count -gt 0) {
    Stop-V6Stage 'FILE_SET_MISMATCH'
}

foreach ($rel in $expected) {
    $candidate = Join-Path $root $rel
    try {
        $info = Get-Item -LiteralPath $candidate -ErrorAction Stop
        if ($info.PSIsContainer -or (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Stop-V6Stage 'SOURCE_NOT_REGULAR_FILE'
        }
        $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256 -ErrorAction Stop).Hash
        $want = [string]$manifest.files_sha256.$rel
        if ($actual -ine $want) {
            Stop-V6Stage 'SOURCE_HASH_MISMATCH'
        }
    } catch {
        Stop-V6Stage 'SOURCE_READ_ERROR'
    }
}

# Merely locate executables. Do not invoke Python, import MT5 or start Node.
$nodePresent = $null -ne (Get-Command node.exe -ErrorAction SilentlyContinue)
$pythonPresent = $null -ne (Get-Command python.exe -ErrorAction SilentlyContinue)
Write-Host ('V6_STAGE_NODE_COMMAND_PRESENT=' + $nodePresent)
Write-Host ('V6_STAGE_PYTHON_COMMAND_PRESENT=' + $pythonPresent)
foreach ($port in @(3711, 5717)) {
    try {
        $existing = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
        Write-Host ('V6_STAGE_PORT_' + $port + '_AVAILABLE=' + ($existing.Count -eq 0))
    } catch {
        Write-Host ('V6_STAGE_PORT_' + $port + '_AVAILABLE=UNVERIFIED')
    }
}
Write-Host 'V6_ISOLATED_STAGE_SOURCE_HASHES=PASS'
Write-Host 'V6_STAGE_BROKER_SESSION=NOT_CHECKED'
Write-Host 'V6_STAGE_REAL_AUTHORIZATION=DISABLED'
Write-Host 'V6_STAGE_AUTOSTART=NONE'
Write-Host 'V6_LIVE_APPROVAL=NO'
Write-Host 'V6_ISOLATED_STAGE_RESULT=SOURCE_ONLY_NOT_DEPLOYED'
