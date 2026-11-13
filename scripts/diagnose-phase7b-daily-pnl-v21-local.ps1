param(
  [string]$TargetPositionId = "37221464",
  [int]$BridgePort = 8765,
  [int]$ApiPort = 3711
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"

if (-not (Test-Path $BridgeEnv)) { throw "Missing Bridge DEMO env: $BridgeEnv" }
$keyLine = Get-Content $BridgeEnv | Where-Object { $_ -match '^\s*MT5_API_KEY=' } | Select-Object -First 1
if (-not $keyLine) { throw "MT5_API_KEY missing from Bridge DEMO env." }
$key = (($keyLine -split '=', 2)[1]).Trim().Trim('"').Trim("'")
$headers = @{ 'x-mt5-api-key' = $key }

$health = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/health" -Headers $headers -TimeoutSec 5
if (-not $health.connected -or $health.accountMode -ne 'demo') {
  throw "Bridge is not healthy DEMO. connected=$($health.connected) mode=$($health.accountMode)"
}

$boundary = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/v1/session/day-boundary/XAUUSD" -Headers $headers -TimeoutSec 5
$toMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$deals = @(Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/v1/history/deals?fromMs=$($boundary.currentStartTime)&toMs=$toMs&symbol=XAUUSD" -Headers $headers -TimeoutSec 10)

Write-Host "PHASE7B_V21_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_V21_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7B_V21_DAY_START_MS=$($boundary.currentStartTime)"
Write-Host "PHASE7B_V21_DAY_START_LOCAL=$([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$boundary.currentStartTime).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz'))"
Write-Host "PHASE7B_V21_DEAL_COUNT=$($deals.Count)"
Write-Host "PHASE7B_V21_TARGET_POSITION=$TargetPositionId"

Write-Host "`n=== ALL XAUUSD DEALS TODAY ==="
$deals |
  Sort-Object time |
  Select-Object ticket,positionId,entry,side,volume,price,profit,commission,swap,fee,netPnl,magic,comment,time |
  Format-Table -AutoSize

Write-Host "`n=== TARGET POSITION DEALS ==="
$target = @($deals | Where-Object { [string]$_.positionId -eq [string]$TargetPositionId })
if ($target.Count -eq 0) {
  Write-Host "PHASE7B_V21_TARGET_FOUND=False"
} else {
  Write-Host "PHASE7B_V21_TARGET_FOUND=True"
  $target |
    Sort-Object time |
    Select-Object ticket,positionId,entry,side,volume,price,profit,commission,swap,fee,netPnl,magic,comment,time |
    Format-List
  $targetNet = ($target | Measure-Object -Property netPnl -Sum).Sum
  Write-Host "PHASE7B_V21_TARGET_NET_PNL=$([math]::Round([double]$targetNet,2))"
}

Write-Host "`n=== GROUPED BY POSITION ID ==="
$groups = foreach ($g in ($deals | Group-Object positionId)) {
  $rows = @($g.Group)
  $hasBotMagic = @($rows | Where-Object { [int64]$_.magic -eq 270713 }).Count -gt 0
  $hasExit = @($rows | Where-Object { $_.entry -in @('OUT','INOUT','OUT_BY') }).Count -gt 0
  [pscustomobject]@{
    PositionId = [string]$g.Name
    Deals = $rows.Count
    HasBotMagic270713 = $hasBotMagic
    HasExit = $hasExit
    NetPnl = [math]::Round([double](($rows | Measure-Object -Property netPnl -Sum).Sum),2)
    Profit = [math]::Round([double](($rows | Measure-Object -Property profit -Sum).Sum),2)
    Commission = [math]::Round([double](($rows | Measure-Object -Property commission -Sum).Sum),2)
    Magics = (($rows | ForEach-Object { [string]$_.magic } | Sort-Object -Unique) -join ',')
    Entries = (($rows | ForEach-Object { [string]$_.entry } | Sort-Object -Unique) -join ',')
  }
}
$groups | Sort-Object PositionId | Format-Table -AutoSize

try {
  $api = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 5
  Write-Host "`n=== API DAILY MANAGEMENT ==="
  $api.dailyManagement | Format-List
} catch {
  Write-Host "PHASE7B_V21_API_READ=FAIL $($_.Exception.Message)"
}

Write-Host "PHASE7B_V21_READ_ONLY=True"
Write-Host "PHASE7B_V21_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_V21=PASS"
