param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommit,

    [Parameter(Mandatory = $true)]
    [string]$AllowedUser,

    [Parameter(Mandatory = $true)]
    [string]$AllowedOrigin,

    [string]$ExpectedCurrentGatewayHash = "F4DC53D3E22738D26C762C78687ADBC4D20AD3DFAE8397C3C3A981884E8DB79A"
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================"
Write-Host "=== PHASE7C MOBILE M4-A BOUNDED GATEWAY DEPLOY ==="
Write-Host "============================================================"
Write-Host "MUTATION_SCOPE=EXACT_MOBILE_GATEWAY_BUNDLE_AND_TASK_ONLY"
Write-Host "TAILSCALE_MUTATION=NONE"
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
Write-Host "SYSTEM_REBOOT=NONE"
Write-Host ""

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$GatewayDir = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-readonly-gateway"
$BackupRoot = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-gateway-backups"
$StageDir = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-readonly-gateway.m4a-stage-$([guid]::NewGuid().ToString('N'))"
$TaskPath = "\XAUUSD-AI-MASTER\"
$TaskName = "Phase7C-Mobile-Readonly-Gateway"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$TailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"
$Preflight = Join-Path $PSScriptRoot "preflight-phase7c-mobile-m4a-local.ps1"
$SourceContract = Join-Path $PSScriptRoot "test-phase7c-mobile-m4a-source-contract.mjs"
$RuntimeFiles = @(
    "gateway.js",
    "server.cjs",
    "m4-contract.cjs",
    "canonical-client.cjs",
    "transaction-store.cjs",
    "audit.cjs",
    "m4-action-broker.cjs"
)

function Assert-True([bool]$Condition, [string]$Code) {
    if (-not $Condition) { throw $Code }
}

function Wait-ForPort([int]$Port, [bool]$ShouldExist, [int]$Seconds = 30) {
    for ($i = 0; $i -lt $Seconds * 2; $i++) {
        $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
        if (($ShouldExist -and $Listeners.Count -gt 0) -or (-not $ShouldExist -and $Listeners.Count -eq 0)) {
            return $Listeners
        }
        Start-Sleep -Milliseconds 500
    }
    throw "PORT_${Port}_WAIT_TIMEOUT_EXPECT_EXIST=$ShouldExist"
}

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
Assert-True ($Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) "ADMIN_REQUIRED"
Assert-True ($AllowedUser -match "^[^\s@]+@[^\s@]+\.[^\s@]+$") "ALLOWED_USER_INVALID"
try { $OriginUri = [uri]$AllowedOrigin } catch { throw "ALLOWED_ORIGIN_INVALID" }
Assert-True ($OriginUri.Scheme -eq "https") "ALLOWED_ORIGIN_MUST_BE_HTTPS"
$NormalizedOrigin = $OriginUri.GetLeftPart([System.UriPartial]::Authority)

Write-Host "=== 1. READ-ONLY PREFLIGHT ==="
& $Preflight -ExpectedCommit $ExpectedCommit -ExpectedCurrentGatewayHash $ExpectedCurrentGatewayHash
if ($LASTEXITCODE -ne 0) { throw "PREFLIGHT_FAILED" }
Write-Host "PREFLIGHT_GATE=PASS"

Write-Host ""
Write-Host "=== 2. SOURCE CONTRACT ==="
& $NodeExe $SourceContract
if ($LASTEXITCODE -ne 0) { throw "SOURCE_CONTRACT_FAILED" }
Write-Host "SOURCE_CONTRACT_GATE=PASS"

Write-Host ""
Write-Host "=== 3. STAGE BUNDLE ==="
Assert-True (Test-Path $GatewayDir) "CURRENT_GATEWAY_DIR_MISSING"
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
Copy-Item -Path $GatewayDir -Destination $StageDir -Recurse -Force

$SourceDir = Join-Path $RepoRoot "apps\mobile-gateway"
$AcceptedRuntimeHashes = @{}
foreach ($File in $RuntimeFiles) {
    $Source = Join-Path $SourceDir $File
    $Destination = Join-Path $StageDir $File
    Assert-True (Test-Path $Source) "SOURCE_FILE_MISSING:$File"
    $SourceHash = (Get-FileHash $Source -Algorithm SHA256).Hash
    $AcceptedRuntimeHashes[$File] = $SourceHash
    Copy-Item $Source $Destination -Force
    $Hash = (Get-FileHash $Destination -Algorithm SHA256).Hash
    Write-Host "STAGED_FILE=$File SHA256=$Hash"
    Assert-True ($Hash -eq $SourceHash) "STAGED_SOURCE_HASH_MISMATCH:$File"
}

$Config = [ordered]@{
    listenHost = "127.0.0.1"
    listenPort = 5791
    webOrigin = "http://127.0.0.1:5717"
    apiOrigin = "http://127.0.0.1:3711"
    allowedUsers = @($AllowedUser.Trim().ToLowerInvariant())
    allowedOrigin = $NormalizedOrigin
    auditPath = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-readonly-gateway\m4-audit.jsonl"
}
$ConfigPath = Join-Path $StageDir "gateway.config.json"
$Config | ConvertTo-Json -Depth 4 | Set-Content -Path $ConfigPath -Encoding UTF8
Write-Host "STAGED_CONFIG=$ConfigPath"
Write-Host "STAGED_ALLOWED_USER=$($AllowedUser.Trim().ToLowerInvariant())"
Write-Host "STAGED_ALLOWED_ORIGIN=$NormalizedOrigin"

foreach ($File in $RuntimeFiles) {
    & $NodeExe --check (Join-Path $StageDir $File)
    if ($LASTEXITCODE -ne 0) { throw "NODE_CHECK_FAILED:$File" }
}
Write-Host "STAGING_GATE=PASS"

Write-Host ""
Write-Host "=== 4. EXACT TASK HANDOFF ==="
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $BackupRoot "m4a-predeploy-$Timestamp"
Write-Host "BACKUP_DIR=$BackupDir"

$PreListener = @(Get-NetTCPConnection -State Listen -LocalPort 5791 -ErrorAction SilentlyContinue)
$PrePid = if ($PreListener.Count -eq 1) { [int]$PreListener[0].OwningProcess } else { 0 }
Write-Host "PRE_GATEWAY_PID=$PrePid"

Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
Wait-ForPort -Port 5791 -ShouldExist $false -Seconds 30 | Out-Null
Write-Host "OLD_GATEWAY_STOPPED=TRUE"

Move-Item -Path $GatewayDir -Destination $BackupDir
Move-Item -Path $StageDir -Destination $GatewayDir
Write-Host "BUNDLE_SWAP=PASS"

Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
$PostListeners = @(Wait-ForPort -Port 5791 -ShouldExist $true -Seconds 30)
Assert-True ($PostListeners.Count -eq 1) "POST_GATEWAY_LISTENER_COUNT_INVALID"
$PostListener = $PostListeners[0]
Assert-True ($PostListener.LocalAddress -eq "127.0.0.1") "POST_GATEWAY_NOT_LOOPBACK"
$PostPid = [int]$PostListener.OwningProcess
Write-Host "POST_GATEWAY_PID=$PostPid"

$Process = Get-CimInstance Win32_Process -Filter "ProcessId=$PostPid"
$Owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwner
$OwnerText = "$($Owner.Domain)\$($Owner.User)"
Write-Host "POST_GATEWAY_OWNER=$OwnerText"
Assert-True ($Owner.User -eq "SYSTEM") "POST_GATEWAY_NOT_SYSTEM"
Assert-True ([string]$Process.CommandLine -like "*$GatewayDir\gateway.js*") "POST_GATEWAY_COMMAND_MISMATCH"
Write-Host "TASK_HANDOFF_GATE=PASS"

Write-Host ""
Write-Host "=== 5. RUNTIME SOURCE ATTESTATION ==="
foreach ($File in $RuntimeFiles) {
    $RuntimePath = Join-Path $GatewayDir $File
    Assert-True (Test-Path $RuntimePath) "DEPLOYED_RUNTIME_FILE_MISSING:$File"
    $RuntimeHash = (Get-FileHash $RuntimePath -Algorithm SHA256).Hash
    $ExpectedHash = [string]$AcceptedRuntimeHashes[$File]
    Write-Host "RUNTIME_FILE=$File SHA256=$RuntimeHash EXPECTED_SHA256=$ExpectedHash"
    Assert-True ($RuntimeHash -eq $ExpectedHash) "DEPLOYED_RUNTIME_HASH_MISMATCH:$File"
}
Write-Host "RUNTIME_SOURCE_ATTESTATION=PASS"
Write-Host "RUNTIME_SOURCE_COMMIT=$ExpectedCommit"

Write-Host ""
Write-Host "=== 6. LOCAL SECURITY ACCEPTANCE ==="
$Health = Invoke-WebRequest -Uri "http://127.0.0.1:5791/__m2/health" -Method GET -UseBasicParsing -TimeoutSec 5
Write-Host "HEALTH_HTTP=$($Health.StatusCode)"
Assert-True ($Health.StatusCode -eq 200) "M4_HEALTH_FAILED"

$NoIdentityBlocked = $false
try {
    Invoke-WebRequest -Uri "http://127.0.0.1:5791/phase7c-mobile" -Method GET -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 403) { $NoIdentityBlocked = $true }
    elseif ($_.Exception.Message -match "403") { $NoIdentityBlocked = $true }
}
Write-Host "NO_IDENTITY_APP_GET_BLOCKED=$NoIdentityBlocked"
Assert-True $NoIdentityBlocked "NO_IDENTITY_GATE_FAILED"

$PostBlocked = $false
try {
    Invoke-WebRequest -Uri "http://127.0.0.1:5791/phase7c-mobile" -Method POST -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 405) { $PostBlocked = $true }
    elseif ($_.Exception.Message -match "405") { $PostBlocked = $true }
}
Write-Host "NON_M4_POST_BLOCKED=$PostBlocked"
Assert-True $PostBlocked "NON_M4_POST_GATE_FAILED"
Write-Host "LOCAL_SECURITY_GATE=PASS"

Write-Host ""
Write-Host "=== 7. SERVE / FUNNEL / PORT ISOLATION ==="
$Serve = (& $TailscaleExe serve status 2>&1 | Out-String)
$Funnel = (& $TailscaleExe funnel status 2>&1 | Out-String)
$ServeGate = ($Serve -match "8443") -and ($Serve -match "127\.0\.0\.1:5791") -and ($Serve -match "tailnet only")
$PublicFunnel = $Funnel -match "Available on the internet"
Write-Host "SERVE_GATE=$ServeGate"
Write-Host "PUBLIC_FUNNEL_ACTIVE=$PublicFunnel"
Assert-True $ServeGate "SERVE_CHANGED_OR_MISSING"
Assert-True (-not $PublicFunnel) "PUBLIC_FUNNEL_ACTIVE"

foreach ($Port in @(3711, 5717, 5791, 8765)) {
    $Bad = @(
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }
    )
    Write-Host "PORT_${Port}_NON_LOOPBACK=$($Bad.Count)"
    Assert-True ($Bad.Count -eq 0) "NON_LOOPBACK_EXPOSURE_PORT_$Port"
}
Write-Host "NETWORK_ISOLATION_GATE=PASS"

Write-Host ""
Write-Host "============================================================"
Write-Host "=== M4-A GATEWAY DEPLOY COMPLETE ==="
Write-Host "============================================================"
Write-Host "BACKUP_DIR=$BackupDir"
Write-Host "DEPLOYED_COMMIT=$ExpectedCommit"
Write-Host "GATEWAY_PID=$PostPid"
Write-Host "GATEWAY_OWNER=$OwnerText"
Write-Host "RUNTIME_SOURCE_ATTESTATION=PASS"
Write-Host "TAILSCALE_MUTATION=NONE"
Write-Host "SERVE_MUTATION=NONE"
Write-Host "FUNNEL_MUTATION=NONE"
Write-Host "BOT_MUTATION=NONE"
Write-Host "MT5_MUTATION=NONE"
Write-Host "PHASE7C_MUTATION=NONE"
Write-Host "MODE_MUTATION=NONE"
Write-Host "ARM_MUTATION=NONE"
Write-Host "ORDER_MUTATION=NONE"
Write-Host "POSITION_MUTATION=NONE"
Write-Host "LIVE_TEST_ORDER=NONE"
Write-Host "NEXT_GATE=LOCAL_M4_SAFE_ACCEPTANCE_THEN_PHONE"
Write-Host "RESULT=PASS"
