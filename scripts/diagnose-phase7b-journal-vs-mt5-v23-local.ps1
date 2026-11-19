param(
  [string]$TargetId = "37221464",
  [int]$BridgePort = 8765,
  [int]$ApiPort = 3711,
  [int]$LookbackHours = 72
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$Journal = Join-Path $Root ".runtime\phase7b-demo-forward\phase7b-demo-events.jsonl"

function Expand-JsonArray($Value) {
  if ($null -eq $Value) { return @() }
  if ($Value -is [System.Array] -and $Value.Count -eq 1 -and $Value[0] -is [System.Array]) {
    return @($Value[0])
  }
  return @($Value)
}

function To-LocalTimestamp($Milliseconds) {
  try {
    return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Milliseconds).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss.fff zzz")
  } catch {
    return "INVALID"
  }
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
$fromExtendedMs = $toMs - ([int64]$LookbackHours * 60 * 60 * 1000)

$dayRaw = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/v1/history/deals?fromMs=$($boundary.currentStartTime)&toMs=$toMs&symbol=XAUUSD" -Headers $headers -TimeoutSec 10
$extendedRaw = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/v1/history/deals?fromMs=$fromExtendedMs&toMs=$toMs" -Headers $headers -TimeoutSec 10
$dayDeals = @(Expand-JsonArray $dayRaw)
$extendedDeals = @(Expand-JsonArray $extendedRaw)

Write-Host "PHASE7B_V23_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_V23_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7B_V23_SERVER=$($health.server)"
Write-Host "PHASE7B_V23_ACCOUNT_BALANCE=$($health.accountBalance)"
Write-Host "PHASE7B_V23_DAY_START_LOCAL=$(To-LocalTimestamp $boundary.currentStartTime)"
Write-Host "PHASE7B_V23_NOW_LOCAL=$(To-LocalTimestamp $toMs)"
Write-Host "PHASE7B_V23_DAY_XAUUSD_DEALS=$($dayDeals.Count)"
Write-Host "PHASE7B_V23_EXTENDED_ALL_DEALS=$($extendedDeals.Count)"
Write-Host "PHASE7B_V23_LOOKBACK_HOURS=$LookbackHours"
Write-Host "PHASE7B_V23_TARGET_ID=$TargetId"

Write-Host "`n=== CURRENT BROKER-DAY XAUUSD DEALS ==="
$dayRows = foreach ($deal in $dayDeals) {
  [pscustomobject]@{
    LocalTime = To-LocalTimestamp $deal.timestamp
    Ticket = [string]$deal.ticket
    OrderId = [string]$deal.orderId
    PositionId = [string]$deal.positionId
    Entry = [string]$deal.entry
    Side = [string]$deal.side
    Volume = $deal.volume
    Price = $deal.price
    Profit = $deal.profit
    Commission = $deal.commission
    Swap = $deal.swap
    Fee = $deal.fee
    NetPnl = $deal.netPnl
    Magic = $deal.magic
    Comment = [string]$deal.comment
  }
}
$dayRows | Sort-Object LocalTime | Format-Table -AutoSize

Write-Host "`n=== TARGET IN EXTENDED MT5 HISTORY ==="
$targetDeals = @(
  $extendedDeals | Where-Object {
    [string]$_.ticket -eq [string]$TargetId -or
    [string]$_.orderId -eq [string]$TargetId -or
    [string]$_.positionId -eq [string]$TargetId
  }
)
if ($targetDeals.Count -eq 0) {
  Write-Host "PHASE7B_V23_TARGET_MT5_FOUND=False"
} else {
  Write-Host "PHASE7B_V23_TARGET_MT5_FOUND=True"
  foreach ($deal in $targetDeals) {
    [pscustomobject]@{
      LocalTime = To-LocalTimestamp $deal.timestamp
      Ticket = [string]$deal.ticket
      OrderId = [string]$deal.orderId
      PositionId = [string]$deal.positionId
      Entry = [string]$deal.entry
      Side = [string]$deal.side
      Volume = $deal.volume
      Price = $deal.price
      Profit = $deal.profit
      Commission = $deal.commission
      NetPnl = $deal.netPnl
      Magic = $deal.magic
      Comment = [string]$deal.comment
    }
  } | Format-List
}

Write-Host "`n=== JOURNAL EVENTS MATCHING TARGET ==="
$journalMatches = @()
if (Test-Path $Journal) {
  foreach ($line in Get-Content $Journal) {
    if ($line -notmatch [regex]::Escape($TargetId)) { continue }
    try {
      $event = $line | ConvertFrom-Json
      $journalMatches += [pscustomobject]@{
        Timestamp = [string]$event.timestamp
        Type = [string]$event.type
        Ticket = [string]$event.ticket
        SignalId = [string]$event.signalId
        PositionTicket = [string]$event.position.ticket
        PositionEntry = $event.position.entry
        PositionSide = [string]$event.position.side
        PositionVolume = $event.position.volume
        StopLoss = $event.position.stopLoss
        Reason = [string]$event.reason
      }
    } catch {}
  }
}
if ($journalMatches.Count -eq 0) {
  Write-Host "PHASE7B_V23_TARGET_JOURNAL_FOUND=False"
} else {
  Write-Host "PHASE7B_V23_TARGET_JOURNAL_FOUND=True"
  $journalMatches | Format-Table -AutoSize
}

Write-Host "`n=== CURRENT DAY GROUPED BY POSITION ID ==="
$groups = foreach ($group in ($dayDeals | Group-Object positionId)) {
  $rows = @($group.Group)
  $hasBotMagic = @($rows | Where-Object { [string]$_.magic -eq "270713" }).Count -gt 0
  $hasExit = @($rows | Where-Object { $_.entry -in @('OUT','INOUT','OUT_BY') }).Count -gt 0
  [pscustomobject]@{
    PositionId = [string]$group.Name
    Deals = $rows.Count
    HasBotMagic270713 = $hasBotMagic
    HasExit = $hasExit
    NetPnl = [math]::Round([double](($rows | Measure-Object -Property netPnl -Sum).Sum), 2)
    Profit = [math]::Round([double](($rows | Measure-Object -Property profit -Sum).Sum), 2)
    Commission = [math]::Round([double](($rows | Measure-Object -Property commission -Sum).Sum), 2)
    Magics = (($rows | ForEach-Object { [string]$_.magic } | Sort-Object -Unique) -join ',')
    Entries = (($rows | ForEach-Object { [string]$_.entry } | Sort-Object -Unique) -join ',')
  }
}
$groups | Sort-Object PositionId | Format-Table -AutoSize

Write-Host "`n=== V20 DAILY PNL RE-CALCULATION ==="
$botOwnedPositionIds = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($deal in $dayDeals) {
  if ($null -ne $deal.side -and [string]$deal.magic -eq "270713") {
    [void]$botOwnedPositionIds.Add([string]$deal.positionId)
  }
}
$closedBotPositionIds = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($deal in $dayDeals) {
  $positionKey = [string]$deal.positionId
  if ($botOwnedPositionIds.Contains($positionKey) -and $deal.entry -in @('OUT','INOUT','OUT_BY')) {
    [void]$closedBotPositionIds.Add($positionKey)
  }
}
$v20Rows = @($dayDeals | Where-Object { $closedBotPositionIds.Contains([string]$_.positionId) })
$v20Pnl = if ($v20Rows.Count -gt 0) { [double](($v20Rows | Measure-Object -Property netPnl -Sum).Sum) } else { 0.0 }
Write-Host "PHASE7B_V23_V20_POSITION_COUNT=$($closedBotPositionIds.Count)"
Write-Host "PHASE7B_V23_V20_REALIZED_PNL=$([math]::Round($v20Pnl,2))"

try {
  $api = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 5
  Write-Host "`n=== API DAILY MANAGEMENT ==="
  $api.dailyManagement | Format-List
} catch {
  Write-Host "PHASE7B_V23_API_READ=FAIL $($_.Exception.Message)"
}

Write-Host "PHASE7B_V23_READ_ONLY=True"
Write-Host "PHASE7B_V23_ORDER_PERMISSION=NONE"
Write-Host "PHASE7B_V23_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_V23=PASS"
