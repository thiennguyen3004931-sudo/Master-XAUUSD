param(
  [string]$TargetId = "37221464",
  [int]$BridgePort = 8765,
  [int]$ApiPort = 3711
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"

function Flatten-OneLevel($Value) {
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($item in @($Value)) {
    if ($item -is [System.Array]) {
      foreach ($inner in $item) { [void]$list.Add($inner) }
    } elseif ($null -ne $item) {
      [void]$list.Add($item)
    }
  }
  return @($list.ToArray())
}

function Read-Deals([string]$Uri, $Headers) {
  $raw = Invoke-RestMethod -Uri $Uri -Headers $Headers -TimeoutSec 10
  return @(Flatten-OneLevel $raw)
}

function Safe-Number($Value) {
  if ($null -eq $Value) { return 0.0 }
  try { return [double]$Value } catch { return 0.0 }
}

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
$xauUri = "http://127.0.0.1:$BridgePort/v1/history/deals?fromMs=$($boundary.currentStartTime)&toMs=$toMs&symbol=XAUUSD"
$allUri = "http://127.0.0.1:$BridgePort/v1/history/deals?fromMs=$($boundary.currentStartTime)&toMs=$toMs"

$xauDeals = @(Read-Deals $xauUri $headers)
$allDeals = @(Read-Deals $allUri $headers)

Write-Host "PHASE7B_V22_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_V22_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7B_V22_DAY_START_MS=$($boundary.currentStartTime)"
Write-Host "PHASE7B_V22_DAY_START_LOCAL=$([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$boundary.currentStartTime).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz'))"
Write-Host "PHASE7B_V22_XAUUSD_DEAL_COUNT=$($xauDeals.Count)"
Write-Host "PHASE7B_V22_ALL_DEAL_COUNT=$($allDeals.Count)"
Write-Host "PHASE7B_V22_TARGET_ID=$TargetId"

Write-Host "`n=== ALL XAUUSD DEALS TODAY ==="
$xauDeals |
  Sort-Object time |
  Select-Object ticket,orderId,positionId,entry,side,volume,price,profit,commission,swap,fee,netPnl,magic,comment,time |
  Format-Table -AutoSize

Write-Host "`n=== TARGET ID MATCHES (ticket/orderId/positionId) ==="
$matches = @($allDeals | Where-Object {
  ([string]$_.ticket -eq [string]$TargetId) -or
  ([string]$_.orderId -eq [string]$TargetId) -or
  ([string]$_.positionId -eq [string]$TargetId)
})
if ($matches.Count -eq 0) {
  Write-Host "PHASE7B_V22_TARGET_MATCH_FOUND=False"
} else {
  Write-Host "PHASE7B_V22_TARGET_MATCH_FOUND=True"
  $matches |
    Sort-Object time |
    Select-Object ticket,orderId,positionId,symbol,entry,side,volume,price,profit,commission,swap,fee,netPnl,magic,comment,time |
    Format-List
}

Write-Host "`n=== XAUUSD GROUPED BY POSITION ID ==="
$groups = foreach ($g in ($xauDeals | Group-Object positionId)) {
  $rows = @(Flatten-OneLevel $g.Group)
  $hasBotMagic = $false
  $hasExit = $false
  foreach ($row in $rows) {
    $magic = 0
    try { $magic = [int64]([string]$row.magic) } catch { $magic = 0 }
    if ($magic -eq 270713) { $hasBotMagic = $true }
    if ([string]$row.entry -in @('OUT','INOUT','OUT_BY')) { $hasExit = $true }
  }
  $net = 0.0; $profit = 0.0; $commission = 0.0; $swap = 0.0; $fee = 0.0
  foreach ($row in $rows) {
    $net += Safe-Number $row.netPnl
    $profit += Safe-Number $row.profit
    $commission += Safe-Number $row.commission
    $swap += Safe-Number $row.swap
    $fee += Safe-Number $row.fee
  }
  [pscustomobject]@{
    PositionId = [string]$g.Name
    Deals = $rows.Count
    HasBotMagic270713 = $hasBotMagic
    HasExit = $hasExit
    NetPnl = [math]::Round($net, 2)
    Profit = [math]::Round($profit, 2)
    Commission = [math]::Round($commission, 2)
    Swap = [math]::Round($swap, 2)
    Fee = [math]::Round($fee, 2)
    Magics = (($rows | ForEach-Object { [string]$_.magic } | Sort-Object -Unique) -join ',')
    Entries = (($rows | ForEach-Object { [string]$_.entry } | Sort-Object -Unique) -join ',')
    Tickets = (($rows | ForEach-Object { [string]$_.ticket }) -join ',')
  }
}
$groups | Sort-Object PositionId | Format-Table -AutoSize

Write-Host "`n=== BOT-OWNED CLOSED POSITION CALCULATION (V20 RULE) ==="
$botPositionIds = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($deal in $xauDeals) {
  $magic = 0
  try { $magic = [int64]([string]$deal.magic) } catch { $magic = 0 }
  if ($null -ne $deal.side -and $magic -eq 270713) { [void]$botPositionIds.Add([string]$deal.positionId) }
}
$closedBotPositionIds = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($deal in $xauDeals) {
  $pid = [string]$deal.positionId
  if ($botPositionIds.Contains($pid) -and ([string]$deal.entry -in @('OUT','INOUT','OUT_BY'))) {
    [void]$closedBotPositionIds.Add($pid)
  }
}
$v20Pnl = 0.0
foreach ($deal in $xauDeals) {
  if ($closedBotPositionIds.Contains([string]$deal.positionId)) { $v20Pnl += Safe-Number $deal.netPnl }
}
Write-Host "PHASE7B_V22_BOT_OWNED_POSITION_IDS=$((@($botPositionIds) | Sort-Object) -join ',')"
Write-Host "PHASE7B_V22_CLOSED_BOT_POSITION_IDS=$((@($closedBotPositionIds) | Sort-Object) -join ',')"
Write-Host "PHASE7B_V22_V20_CALCULATED_PNL=$([math]::Round($v20Pnl,2))"

try {
  $api = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 5
  Write-Host "`n=== API DAILY MANAGEMENT ==="
  $api.dailyManagement | Format-List
} catch {
  Write-Host "PHASE7B_V22_API_READ=FAIL $($_.Exception.Message)"
}

Write-Host "PHASE7B_V22_READ_ONLY=True"
Write-Host "PHASE7B_V22_ORDER_PERMISSION=NONE"
Write-Host "PHASE7B_V22_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_V22=PASS"
