param(
  [decimal[]]$RiskPercents = @(0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50),
  [decimal[]]$Balances = @(5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000, 150000, 200000),
  [decimal[]]$Stops = @(6, 8, 10),
  [decimal]$MaxAutoLot = 2.00,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$BridgeEnv = Join-Path $Root 'packages\mt5-broker\bridge\.env.phase7b-demo'
$OutDir = Join-Path $Root '.runtime\phase7b-autolot-research-v28'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { throw "Missing env file: $Path" }
  foreach ($raw in Get-Content $Path) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { continue }
    $idx = $line.IndexOf('=')
    $name = $line.Substring(0, $idx).Trim().TrimStart([char]0xFEFF)
    $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

function Round-DownStep([decimal]$Value, [decimal]$Step) {
  if ($Value -le 0 -or $Step -le 0) { return [decimal]0 }
  return [math]::Floor([double]($Value / $Step) + 1e-9) * [double]$Step
}

function Canonical-CompatibleLot([decimal]$Cap, [decimal]$MinVolume, [decimal]$Step, [decimal]$BrokerMax) {
  $effectiveCap = [math]::Min([double]$Cap, [double]$BrokerMax)
  if ($effectiveCap -le 0) { return [decimal]0 }
  $units = [int][math]::Floor($effectiveCap / [double]$Step + 1e-9)
  $minUnits = [int][math]::Ceiling([double]($MinVolume / $Step) - 1e-9)
  while ($units -ge ($minUnits * 3)) {
    if (($units % 3) -eq 0 -and ($units / 3) -ge $minUnits) {
      return [decimal]([math]::Round($units * [double]$Step, 8))
    }
    $units--
  }
  return [decimal]0
}

Import-EnvFile $BridgeEnv
if ($env:MT5_ALLOW_REAL_ACCOUNT -match '^(?i:true|1|yes|on)$') {
  throw 'V28 research refuses MT5_ALLOW_REAL_ACCOUNT=true.'
}
$key = $env:MT5_API_KEY
if ([string]::IsNullOrWhiteSpace($key)) { throw 'MT5_API_KEY missing.' }
$headers = @{ 'x-mt5-api-key' = $key }
$base = "http://127.0.0.1:$BridgePort"

$health = Invoke-RestMethod -Uri "$base/health" -Headers $headers -TimeoutSec 8
if (-not $health.connected -or $health.accountMode -ne 'demo') {
  throw "V28 requires healthy DEMO bridge. connected=$($health.connected) mode=$($health.accountMode)"
}
$spec = Invoke-RestMethod -Uri "$base/v1/symbols/XAUUSD/spec" -Headers $headers -TimeoutSec 8

$cashPerPriceUnitPerLot = [decimal]$spec.cashPerPriceUnitPerLot
if ($cashPerPriceUnitPerLot -le 0 -and [decimal]$spec.tickSize -gt 0) {
  $cashPerPriceUnitPerLot = [decimal]$spec.effectiveTickValuePerLot / [decimal]$spec.tickSize
}
if ($cashPerPriceUnitPerLot -le 0) { throw 'Broker cash-per-price-unit value unavailable.' }

$minVolume = [decimal]$spec.minVolume
$volumeStep = [decimal]$spec.volumeStep
$brokerMax = [decimal]$spec.maxVolume
$currentBalance = [decimal]$health.accountBalance
$currentEquity = [decimal]$health.accountEquity
$riskCapital = [math]::Min([double]$currentBalance, [double]$currentEquity)

$allBalances = @($Balances)
if ($riskCapital -gt 0 -and -not ($allBalances | Where-Object { [math]::Abs([double]($_ - $riskCapital)) -lt 0.01 })) {
  $allBalances += [decimal]$riskCapital
}
$allBalances = @($allBalances | Sort-Object -Unique)

$rows = New-Object System.Collections.Generic.List[object]
foreach ($riskPercent in $RiskPercents) {
  foreach ($balance in $allBalances) {
    foreach ($stop in $Stops) {
      $targetRiskUsd = [decimal]$balance * [decimal]$riskPercent / 100
      $lossAtSlOneLot = [decimal]$stop * $cashPerPriceUnitPerLot
      $rawLot = if ($lossAtSlOneLot -gt 0) { $targetRiskUsd / $lossAtSlOneLot } else { 0 }
      $cap = [math]::Min([double]$rawLot, [double]$MaxAutoLot)
      $lot = Canonical-CompatibleLot ([decimal]$cap) $minVolume $volumeStep $brokerMax
      $riskUsd = [decimal]$lot * $lossAtSlOneLot
      $actualRiskPct = if ([decimal]$balance -gt 0) { $riskUsd / [decimal]$balance * 100 } else { 0 }
      $partial = if ($lot -gt 0) { [decimal]$lot / 3 } else { 0 }
      $runner = if ($lot -gt 0) { [decimal]$lot - $partial } else { 0 }
      $rows.Add([pscustomobject]@{
        RiskPercentTarget = [math]::Round([double]$riskPercent, 4)
        Capital = [math]::Round([double]$balance, 2)
        StopDistance = [math]::Round([double]$stop, 2)
        TargetRiskUsd = [math]::Round([double]$targetRiskUsd, 2)
        RawLot = [math]::Round([double]$rawLot, 4)
        AutoLot = [math]::Round([double]$lot, 4)
        PartialOneThird = [math]::Round([double]$partial, 4)
        RunnerTwoThirds = [math]::Round([double]$runner, 4)
        ActualRiskUsd = [math]::Round([double]$riskUsd, 2)
        ActualRiskPercent = [math]::Round([double]$actualRiskPct, 4)
        Status = if ($lot -gt 0) { 'EXECUTABLE_SHADOW' } else { 'BLOCK_MIN_RISK_TOO_SMALL' }
      })
    }
  }
}

$minimumCapitalRows = New-Object System.Collections.Generic.List[object]
$minimumCompatibleLot = Canonical-CompatibleLot ([decimal]($minVolume * 3)) $minVolume $volumeStep $brokerMax
foreach ($riskPercent in $RiskPercents) {
  foreach ($stop in $Stops) {
    $riskAtMinLot = [decimal]$minimumCompatibleLot * [decimal]$stop * $cashPerPriceUnitPerLot
    $minCapital = if ([decimal]$riskPercent -gt 0) { $riskAtMinLot / ([decimal]$riskPercent / 100) } else { 0 }
    $minimumCapitalRows.Add([pscustomobject]@{
      RiskPercentTarget = [math]::Round([double]$riskPercent, 4)
      StopDistance = [math]::Round([double]$stop, 2)
      MinimumCanonicalLot = [math]::Round([double]$minimumCompatibleLot, 4)
      RiskUsdAtMinimumLot = [math]::Round([double]$riskAtMinLot, 2)
      MinimumCapitalForTargetRisk = [math]::Round([double]$minCapital, 2)
    })
  }
}

$currentRows = @($rows | Where-Object { [math]::Abs($_.Capital - [double]$riskCapital) -lt 0.02 })

$ddThrottle = @(
  [pscustomobject]@{ DrawdownBand = '0% to <2%'; RiskMultiplier = 1.00; Action = 'NORMAL' },
  [pscustomobject]@{ DrawdownBand = '2% to <4%'; RiskMultiplier = 0.75; Action = 'REDUCE' },
  [pscustomobject]@{ DrawdownBand = '4% to <6%'; RiskMultiplier = 0.50; Action = 'REDUCE_MORE' },
  [pscustomobject]@{ DrawdownBand = '>=6%'; RiskMultiplier = 0.00; Action = 'BLOCK_NEW_ENTRY' }
)

$csv = Join-Path $OutDir 'capital-ladder.csv'
$minCsv = Join-Path $OutDir 'minimum-capital.csv'
$currentCsv = Join-Path $OutDir 'current-account-grid.csv'
$ddCsv = Join-Path $OutDir 'drawdown-throttle.csv'
$json = Join-Path $OutDir 'research-summary.json'
$rows | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
$minimumCapitalRows | Export-Csv -Path $minCsv -NoTypeInformation -Encoding UTF8
$currentRows | Export-Csv -Path $currentCsv -NoTypeInformation -Encoding UTF8
$ddThrottle | Export-Csv -Path $ddCsv -NoTypeInformation -Encoding UTF8

$summary = [ordered]@{
  version = 28
  generatedAt = [DateTimeOffset]::Now.ToString('o')
  account = [ordered]@{
    login = $health.accountLogin
    mode = $health.accountMode
    server = $health.server
    balance = [math]::Round([double]$currentBalance, 2)
    equity = [math]::Round([double]$currentEquity, 2)
    riskCapital = [math]::Round([double]$riskCapital, 2)
    riskCapitalBasis = 'MIN_BALANCE_EQUITY'
  }
  broker = [ordered]@{
    symbol = $spec.brokerSymbol
    cashPerPriceUnitPerLot = [math]::Round([double]$cashPerPriceUnitPerLot, 4)
    minVolume = [double]$minVolume
    maxVolume = [double]$brokerMax
    volumeStep = [double]$volumeStep
    minimumCanonicalLot = [double]$minimumCompatibleLot
  }
  configuration = [ordered]@{
    riskPercents = @($RiskPercents | ForEach-Object { [double]$_ })
    stops = @($Stops | ForEach-Object { [double]$_ })
    maxAutoLot = [double]$MaxAutoLot
    partialCompatibility = 'EXACT_ONE_THIRD'
    compounding = 'REALIZED_CAPITAL_ONLY'
    recoveryLotEscalation = $false
    drawdownThrottle = $ddThrottle
  }
  files = [ordered]@{
    capitalLadder = $csv
    minimumCapital = $minCsv
    currentAccountGrid = $currentCsv
    drawdownThrottle = $ddCsv
  }
  safety = [ordered]@{
    executionMutation = $false
    readOnly = $true
    realAccountAllowed = $false
  }
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $json -Encoding UTF8

Write-Host "PHASE7B_V28_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_V28_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7B_V28_BALANCE=$([math]::Round([double]$currentBalance,2))"
Write-Host "PHASE7B_V28_EQUITY=$([math]::Round([double]$currentEquity,2))"
Write-Host "PHASE7B_V28_RISK_CAPITAL=$([math]::Round([double]$riskCapital,2))"
Write-Host "PHASE7B_V28_CASH_PER_PRICE_UNIT_PER_LOT=$([math]::Round([double]$cashPerPriceUnitPerLot,4))"
Write-Host "PHASE7B_V28_MIN_CANONICAL_LOT=$([math]::Round([double]$minimumCompatibleLot,4))"
Write-Host "PHASE7B_V28_COMPOUNDING=REALIZED_CAPITAL_ONLY"
Write-Host "PHASE7B_V28_RECOVERY_LOT_ESCALATION=False"
Write-Host "PHASE7B_V28_DRAWDOWN_THROTTLE=2PCT_0.75|4PCT_0.50|6PCT_BLOCK"
Write-Host "PHASE7B_V28_EXECUTION_MUTATION=False"
Write-Host "PHASE7B_V28_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_V28_OUTPUT_DIR=$OutDir"
Write-Host "`n=== CURRENT ACCOUNT AUTO-LOT GRID ==="
$currentRows | Sort-Object RiskPercentTarget,StopDistance | Format-Table RiskPercentTarget,Capital,StopDistance,TargetRiskUsd,RawLot,AutoLot,ActualRiskUsd,ActualRiskPercent,Status -AutoSize
Write-Host "`n=== MINIMUM CAPITAL TO KEEP TARGET RISK WITH 0.03 CANONICAL LOT ==="
$minimumCapitalRows | Sort-Object RiskPercentTarget,StopDistance | Format-Table -AutoSize
Write-Host "PHASE7B_V28=PASS"
