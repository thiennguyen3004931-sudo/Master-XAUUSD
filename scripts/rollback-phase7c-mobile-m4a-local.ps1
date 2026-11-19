param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDir
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================"
Write-Host "=== PHASE7C MOBILE M4-A GATEWAY-ONLY ROLLBACK ==="
Write-Host "============================================================"
Write-Host "MUTATION_SCOPE=EXACT_MOBILE_GATEWAY_ROLLBACK_AND_TASK_ONLY"
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

$GatewayDir = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-readonly-gateway"
$GatewayJs = Join-Path $GatewayDir "gateway.js"
$BackupRoot = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-gateway-backups"
$RestoreStage = "C:\ProgramData\XAUUSD-AI-MASTER\mobile-readonly-gateway.rollback-stage-$([guid]::NewGuid().ToString('N'))"
$TaskPath = "\XAUUSD-AI-MASTER\"
$TaskName = "Phase7C-Mobile-Readonly-Gateway"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$TailscaleExe = "C:\Program Files\Tailscale\tailscale.exe"

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

$ResolvedBackup = (Resolve-Path $BackupDir).Path
$ResolvedBackupRoot = (Resolve-Path $BackupRoot).Path
$BackupRootPrefix = $ResolvedBackupRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$BackupLeaf = Split-Path -Leaf $ResolvedBackup
Assert-True (-not [string]::Equals($ResolvedBackup, $ResolvedBackupRoot, [System.StringComparison]::OrdinalIgnoreCase)) "BACKUP_ROOT_NOT_ALLOWED"
Assert-True ($ResolvedBackup.StartsWith($BackupRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) "BACKUP_OUTSIDE_APPROVED_ROOT"
Assert-True ($BackupLeaf -like "m4a-predeploy-*") "BACKUP_NOT_PREDEPLOY_BUNDLE"
Assert-True (Test-Path (Join-Path $ResolvedBackup "gateway.js")) "BACKUP_GATEWAY_JS_MISSING"

$CurrentGatewayExists = Test-Path $GatewayDir
Write-Host "BACKUP_DIR=$ResolvedBackup"
Write-Host "BACKUP_GATEWAY_SHA256=$((Get-FileHash (Join-Path $ResolvedBackup 'gateway.js') -Algorithm SHA256).Hash)"
Write-Host "CURRENT_GATEWAY_DIR_EXISTS=$CurrentGatewayExists"
if ($CurrentGatewayExists -and (Test-Path (Join-Path $GatewayDir "gateway.js"))) {
    Write-Host "CURRENT_GATEWAY_SHA256=$((Get-FileHash (Join-Path $GatewayDir 'gateway.js') -Algorithm SHA256).Hash)"
} else {
    Write-Host "CURRENT_GATEWAY_SHA256=UNAVAILABLE"
}
Write-Host "BACKUP_PATH_GATE=PASS"

Write-Host ""
Write-Host "=== 1. EXACT TASK PRECHECK ==="
$Task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
$Action = $Task.Actions | Select-Object -First 1
Assert-True ([string]$Task.Principal.UserId -in @("SYSTEM", "S-1-5-18")) "TASK_NOT_SYSTEM"
Assert-True ([string]::Equals([string]$Action.Execute, $NodeExe, [System.StringComparison]::OrdinalIgnoreCase)) "TASK_NODE_PATH_MISMATCH"
Assert-True ([string]$Action.Arguments -like "*$GatewayJs*") "TASK_GATEWAY_ARGUMENT_MISMATCH"
Write-Host "TASK_PRINCIPAL=$($Task.Principal.UserId)"
Write-Host "TASK_ACTION=$($Action.Execute)"
Write-Host "TASK_ARGUMENTS=$($Action.Arguments)"
Write-Host "TASK_PRECHECK_GATE=PASS"

Write-Host ""
Write-Host "=== 2. STAGE APPROVED BACKUP ==="
Copy-Item -Path $ResolvedBackup -Destination $RestoreStage -Recurse -Force
Assert-True (Test-Path (Join-Path $RestoreStage "gateway.js")) "RESTORE_STAGE_INVALID"
Write-Host "RESTORE_STAGE=$RestoreStage"
Write-Host "RESTORE_STAGE_GATE=PASS"

Write-Host ""
Write-Host "=== 3. EXACT TASK STOP / SWAP / START ==="
Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
Wait-ForPort -Port 5791 -ShouldExist $false -Seconds 30 | Out-Null
Write-Host "CURRENT_GATEWAY_STOPPED=TRUE"

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ReplacedDir = Join-Path $BackupRoot "m4a-rollback-replaced-$Timestamp"
if (Test-Path $GatewayDir) {
    Move-Item -Path $GatewayDir -Destination $ReplacedDir
    Write-Host "REPLACED_M4_BUNDLE=$ReplacedDir"
} else {
    Write-Host "REPLACED_M4_BUNDLE=NONE_CURRENT_GATEWAY_MISSING"
}
Move-Item -Path $RestoreStage -Destination $GatewayDir
Write-Host "RESTORE_SWAP=PASS"

Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
$Listeners = @(Wait-ForPort -Port 5791 -ShouldExist $true -Seconds 30)
Assert-True ($Listeners.Count -eq 1) "RESTORED_GATEWAY_LISTENER_COUNT_INVALID"
Assert-True ($Listeners[0].LocalAddress -eq "127.0.0.1") "RESTORED_GATEWAY_NOT_LOOPBACK"
$GatewayPid = [int]$Listeners[0].OwningProcess
$Process = Get-CimInstance Win32_Process -Filter "ProcessId=$GatewayPid"
$Owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwner
Write-Host "RESTORED_GATEWAY_PID=$GatewayPid"
Write-Host "RESTORED_GATEWAY_OWNER=$($Owner.Domain)\$($Owner.User)"
Assert-True ($Owner.User -eq "SYSTEM") "RESTORED_GATEWAY_NOT_SYSTEM"
Assert-True ([string]$Process.CommandLine -like "*$GatewayDir\gateway.js*") "RESTORED_GATEWAY_COMMAND_MISMATCH"
Write-Host "ROLLBACK_HANDOFF_GATE=PASS"

Write-Host ""
Write-Host "=== 4. M2/M3 SECURITY ACCEPTANCE ==="
$Health = Invoke-WebRequest -Uri "http://127.0.0.1:5791/__m2/health" -Method GET -UseBasicParsing -TimeoutSec 5
Write-Host "HEALTH_HTTP=$($Health.StatusCode)"
Assert-True ($Health.StatusCode -eq 200) "RESTORED_HEALTH_FAILED"

$NoIdentityBlocked = $false
try {
    Invoke-WebRequest -Uri "http://127.0.0.1:5791/phase7c-mobile" -Method GET -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 403) { $NoIdentityBlocked = $true }
    elseif ($_.Exception.Message -match "403") { $NoIdentityBlocked = $true }
}
Write-Host "NO_IDENTITY_APP_GET_BLOCKED=$NoIdentityBlocked"
Assert-True $NoIdentityBlocked "RESTORED_IDENTITY_GATE_FAILED"

$PostBlocked = $false
try {
    Invoke-WebRequest -Uri "http://127.0.0.1:5791/phase7c-mobile" -Method POST -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 405) { $PostBlocked = $true }
    elseif ($_.Exception.Message -match "405") { $PostBlocked = $true }
}
Write-Host "NON_M4_POST_BLOCKED=$PostBlocked"
Assert-True $PostBlocked "RESTORED_POST_GATE_FAILED"
Write-Host "M2_M3_SECURITY_GATE=PASS"

Write-Host ""
Write-Host "=== 5. SERVE / FUNNEL / PORT ISOLATION ==="
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
Write-Host "=== M4-A ROLLBACK COMPLETE ==="
Write-Host "============================================================"
Write-Host "RESTORED_FROM=$ResolvedBackup"
Write-Host "REPLACED_M4_BUNDLE=$ReplacedDir"
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
Write-Host "RESULT=PASS"
