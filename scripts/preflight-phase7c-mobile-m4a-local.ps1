param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,

    [string]$ExpectedCurrentGatewayHash = "F4DC53D3E22738D26C762C78687ADBC4D20AD3DFAE8397C3C3A981884E8DB79A"
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================"
Write-Host "=== PHASE7C MOBILE M4-A PRODUCTION PREFLIGHT ==="
Write-Host "============================================================"
Write-Host "READ_ONLY=TRUE"
Write-Host "HTTP_METHODS=GET_ONLY"
Write-Host "GIT_MUTATION=NONE"
Write-Host "TASK_MUTATION=NONE"
Write-Host "PROCESS_MUTATION=NONE"
Write-Host "SERVE_MUTATION=NONE"
Write-Host "FUNNEL_MUTATION=NONE"
Write-Host "MODE_MUTATION=NONE"
Write-Host "ARM_MUTATION=NONE"
Write-Host "ORDER_MUTATION=NONE"
Write-Host "POSITION_MUTATION=NONE"
Write-Host "LIVE_TEST_ORDER=NONE"
Write-Host "BOT_MUTATION=NONE"
Write-Host "MT5_MUTATION=NONE"
Write-Host "PHASE7C_MUTATION=NONE"
Write-Host ""

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$GatewayDir = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-readonly-gateway"
$GatewayJs = Join-Path $GatewayDir "gateway.js"
$TaskPath = "\XAUUSD-AI-MASTER\"
$TaskName = "Phase7C-Mobile-Readonly-Gateway"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$TailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"

function Assert-True([bool]$Condition, [string]$Code) {
    if (-not $Condition) { throw $Code }
}

function Get-NonLoopbackListeners([int]$Port) {
    @(
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }
    )
}

Write-Host "=== 1. SOURCE ==="
Push-Location $RepoRoot
try {
    $Head = (git rev-parse HEAD).Trim()
    $Branch = (git branch --show-current).Trim()
    $Dirty = @(git status --porcelain)
    $OriginMain = (git rev-parse origin/main 2>$null).Trim()
} finally {
    Pop-Location
}
Write-Host "REPO_ROOT=$RepoRoot"
Write-Host "LOCAL_BRANCH=$Branch"
Write-Host "LOCAL_HEAD=$Head"
Write-Host "ORIGIN_MAIN=$OriginMain"
Write-Host "DIRTY_COUNT=$($Dirty.Count)"
Write-Host "EXPECTED_COMMIT=$ExpectedCommit"
Assert-True ($Branch -eq "main") "LOCAL_BRANCH_NOT_MAIN"
Assert-True ($Head -eq $ExpectedCommit) "EXPECTED_COMMIT_MISMATCH"
Assert-True ($OriginMain -eq $ExpectedCommit) "ORIGIN_MAIN_MISMATCH"
Assert-True ($Head -eq $OriginMain) "LOCAL_HEAD_NOT_ORIGIN_MAIN"
Assert-True ($Dirty.Count -eq 0) "LOCAL_REPO_DIRTY"
Write-Host "MERGED_SOURCE_GATE=PASS"
Write-Host "SOURCE_GATE=PASS"

Write-Host ""
Write-Host "=== 2. ACCEPTED SOURCE HASHES ==="
$RuntimeFiles = @(
    "apps\mobile-gateway\gateway.js",
    "apps\mobile-gateway\server.cjs",
    "apps\mobile-gateway\m4-contract.cjs",
    "apps\mobile-gateway\canonical-client.cjs",
    "apps\mobile-gateway\transaction-store.cjs",
    "apps\mobile-gateway\audit.cjs",
    "apps\mobile-gateway\m4-action-broker.cjs"
)
foreach ($Relative in $RuntimeFiles) {
    $SourcePath = Join-Path $RepoRoot $Relative
    Assert-True (Test-Path $SourcePath) "SOURCE_RUNTIME_FILE_MISSING:$Relative"
    $Hash = (Get-FileHash $SourcePath -Algorithm SHA256).Hash
    Write-Host "SOURCE_FILE=$Relative SHA256=$Hash"
}
Write-Host "SOURCE_HASH_GATE=PASS"

Write-Host ""
Write-Host "=== 3. CURRENT GATEWAY ==="
Assert-True (Test-Path $GatewayJs) "CURRENT_GATEWAY_MISSING"
$CurrentGatewayHash = (Get-FileHash $GatewayJs -Algorithm SHA256).Hash
Write-Host "CURRENT_GATEWAY_SHA256=$CurrentGatewayHash"
Write-Host "EXPECTED_CURRENT_GATEWAY_SHA256=$ExpectedCurrentGatewayHash"
Assert-True ($CurrentGatewayHash -eq $ExpectedCurrentGatewayHash) "CURRENT_GATEWAY_HASH_UNEXPECTED"

$GatewayListeners = @(Get-NetTCPConnection -State Listen -LocalPort 5791 -ErrorAction SilentlyContinue)
Write-Host "GATEWAY_5791_LISTENER_COUNT=$($GatewayListeners.Count)"
Assert-True ($GatewayListeners.Count -eq 1) "GATEWAY_5791_LISTENER_COUNT_INVALID"
Write-Host "GATEWAY_ADDRESS=$($GatewayListeners[0].LocalAddress)"
Write-Host "GATEWAY_PID=$($GatewayListeners[0].OwningProcess)"
Assert-True ($GatewayListeners[0].LocalAddress -eq "127.0.0.1") "GATEWAY_NOT_IPV4_LOOPBACK"

$Health = Invoke-WebRequest -Uri "http://127.0.0.1:5791/__m2/health" -Method GET -UseBasicParsing -TimeoutSec 5
Write-Host "GATEWAY_HEALTH_HTTP=$($Health.StatusCode)"
Assert-True ($Health.StatusCode -eq 200) "GATEWAY_HEALTH_FAILED"
Write-Host "CURRENT_GATEWAY_GATE=PASS"

Write-Host ""
Write-Host "=== 4. SCHEDULED TASK ==="
$Task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
$TaskInfo = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName
$Action = $Task.Actions | Select-Object -First 1
$BootTriggers = @($Task.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" })
Write-Host "TASK_STATE=$($Task.State)"
Write-Host "TASK_PRINCIPAL=$($Task.Principal.UserId)"
Write-Host "TASK_ACTION=$($Action.Execute)"
Write-Host "TASK_ARGUMENTS=$($Action.Arguments)"
Write-Host "TASK_WORKDIR=$($Action.WorkingDirectory)"
Write-Host "TASK_BOOT_TRIGGER_COUNT=$($BootTriggers.Count)"
Write-Host "TASK_LAST_RUN=$($TaskInfo.LastRunTime)"
Write-Host "TASK_LAST_RESULT=$($TaskInfo.LastTaskResult)"
Assert-True ([string]$Task.Principal.UserId -in @("SYSTEM", "S-1-5-18")) "TASK_NOT_SYSTEM"
Assert-True ($BootTriggers.Count -eq 1) "TASK_BOOT_TRIGGER_INVALID"
Assert-True ([string]::Equals([string]$Action.Execute, $NodeExe, [System.StringComparison]::OrdinalIgnoreCase)) "TASK_NODE_PATH_MISMATCH"
Assert-True ([string]$Action.Arguments -like "*$GatewayJs*") "TASK_GATEWAY_ARGUMENT_MISMATCH"
Write-Host "TASK_GATE=PASS"

Write-Host ""
Write-Host "=== 5. TAILSCALE / SERVE ==="
Assert-True (Test-Path $TailscaleExe) "TAILSCALE_CLI_MISSING"
$TsStatus = (& $TailscaleExe status --json | Out-String) | ConvertFrom-Json
Write-Host "TAILSCALE_BACKEND=$($TsStatus.BackendState)"
Write-Host "TAILSCALE_ONLINE=$($TsStatus.Self.Online)"
Assert-True ($TsStatus.BackendState -eq "Running") "TAILSCALE_BACKEND_NOT_RUNNING"
Assert-True ($TsStatus.Self.Online -eq $true) "TAILSCALE_SELF_OFFLINE"

$Serve = (& $TailscaleExe serve status 2>&1 | Out-String)
$Funnel = (& $TailscaleExe funnel status 2>&1 | Out-String)
Write-Host "--- SERVE ---"
Write-Host $Serve
Write-Host "--- FUNNEL ---"
Write-Host $Funnel
$ServeGate = ($Serve -match "8443") -and ($Serve -match "127\.0\.0\.1:5791") -and ($Serve -match "tailnet only")
$PublicFunnel = $Funnel -match "Available on the internet"
Write-Host "SERVE_GATE=$ServeGate"
Write-Host "PUBLIC_FUNNEL_ACTIVE=$PublicFunnel"
Assert-True $ServeGate "TAILSCALE_SERVE_UNEXPECTED"
Assert-True (-not $PublicFunnel) "PUBLIC_FUNNEL_ACTIVE"
Write-Host "TAILNET_GATE=PASS"

Write-Host ""
Write-Host "=== 6. LOCALHOST ISOLATION ==="
foreach ($Port in @(3711, 5717, 5791, 8765)) {
    $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    foreach ($Listener in $Listeners) {
        Write-Host "PORT=$Port ADDRESS=$($Listener.LocalAddress) PID=$($Listener.OwningProcess)"
    }
    $Bad = @(Get-NonLoopbackListeners $Port)
    Write-Host "PORT_${Port}_NON_LOOPBACK=$($Bad.Count)"
    Assert-True ($Bad.Count -eq 0) "NON_LOOPBACK_EXPOSURE_PORT_$Port"
}
Write-Host "LOCALHOST_ISOLATION_GATE=PASS"

Write-Host ""
Write-Host "============================================================"
Write-Host "=== M4-A PREFLIGHT COMPLETE ==="
Write-Host "============================================================"
Write-Host "READY_FOR_M4A_GATEWAY_DEPLOY=TRUE"
Write-Host "RESULT=PASS"
